// /v1/auth/* — self-service tenant registration and API-key recovery.
//
// Three public endpoints:
//   POST /v1/auth/register  — issue a confirmation email
//   POST /v1/auth/recover   — issue a recovery email
//   POST /v1/auth/redeem    — consume the email's token; mint a key
//
// register + recover are intentionally non-informative — both return
// 202 {ok:true} once the body validates, regardless of whether the
// email is known. /redeem is the single endpoint that can fail
// informatively (TOKEN_EXPIRED / TOKEN_ALREADY_USED).
//
// Token lifecycle owned by `auth/email-tokens.ts` + the
// `email_verifications` table. Mailgun dispatch lives in
// `services/mailgun.ts`. The route layer is the seam.

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { TextralError, newId } from '@textral/contracts';
import type { Env, Variables } from '../types.js';
import {
  AuthOkResponseSchema,
  RecoverRequestSchema,
  RedeemRequestSchema,
  RedeemResponseSchema,
  RegisterRequestSchema,
} from '../openapi/components.js';
import { Responses } from '../openapi/registry.js';
import {
  buildRedeemUrl,
  generateToken,
  hashToken,
  isExpired,
  tokenTtlMs,
} from '../auth/email-tokens.js';
import { generateApiKey } from '../auth/api-key.js';
import { readPepper } from '../auth/pepper.js';
import {
  consumeIfUnconsumed,
  findByTokenHash,
  insertEmailVerification,
  supersedePriorActive,
} from '../db/email-verifications.js';
import { findTenantByOwnerEmail, insertTenant } from '../db/tenants.js';
import { insertApiKey } from '../db/api-keys.js';
import { insertNamespace } from '../db/namespaces.js';
import { bumpAndCheck } from '../db/admin-rate-limits.js';
import { sendMail } from '../services/mailgun.js';
import { renderRecoverEmail, renderRegisterEmail } from '../services/email-templates.js';
import { inferDimensionsFromProfile } from './namespaces.js';
import { resolveVectorBinding } from '../auth/infra-key-resolver.js';
import type { VectorBackend } from '../retrieval/vector-store.js';

export const authRoute = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();

const DEFAULT_NAMESPACE_SLUG = 'default';
const DEFAULT_EMBEDDING_PROFILE = 'openai-text-embedding-3-large';
const DEFAULT_CORPUS_PROFILE = 'generic';
const DEFAULT_API_KEY_SCOPES: string[] = ['*'];

const REGISTER_RATE_LIMIT_PER_MIN = 5;
const RECOVER_RATE_LIMIT_PER_MIN = 3;

// ── POST /v1/auth/register ─────────────────────────────────────────────

const registerOp = createRoute({
  method: 'post',
  path: '/register',
  tags: ['Auth'],
  summary: 'Request a tenant-registration email',
  description:
    "Issues a confirmation email containing a single-use token (TTL 1h). The tenant + first API key are minted only at /v1/auth/redeem time, so abandoned signups leave no rows. Always returns 202 once the body validates — never reveals whether the email is already registered.",
  request: {
    body: { content: { 'application/json': { schema: RegisterRequestSchema } } },
  },
  responses: {
    202: {
      description: 'Email accepted for delivery (or short-circuited in dev).',
      content: { 'application/json': { schema: AuthOkResponseSchema } },
    },
    400: Responses.badRequest,
    429: Responses.rateLimited,
    503: Responses.serviceUnavailable,
  },
});

authRoute.openapi(registerOp, async (c) => {
  const data = c.req.valid('json');

  await rateLimit(c, 'auth_register', REGISTER_RATE_LIMIT_PER_MIN);
  ensureRegistrationEnabled(c.env);

  // Pre-mark prior unconsumed tokens for this (email, register) so a
  // user who lost the first email can hit "Resend" without having two
  // valid tokens in flight.
  await supersedePriorActive(c.env.db, data.email, 'register');

  const { raw, hash } = await generateToken();
  const id = newId('evf');
  await insertEmailVerification(c.env.db, {
    id,
    purpose: 'register',
    email: data.email,
    display_name: data.display_name,
    token_hash: hash,
    expires_at: Date.now() + tokenTtlMs(),
    ip_hash: await hashIp(c),
  });

  const redeemUrl = buildRedeemUrl(c.env, raw);
  const mail = renderRegisterEmail({ redeemUrl, displayName: data.display_name });
  c.env.bg.spawn(sendMail(c.env, { ...mail, to: data.email }));

  return c.json({ ok: true } as const, 202);
});

// ── POST /v1/auth/recover ──────────────────────────────────────────────

const recoverOp = createRoute({
  method: 'post',
  path: '/recover',
  tags: ['Auth'],
  summary: 'Request an API-key recovery email',
  description:
    "Issues a recovery email containing a single-use token. The token mints a fresh API key for the tenant whose `owner_email` matches; existing keys are not auto-revoked. Always returns 202 — unknown emails write no row and dispatch no email, but the response shape is identical so the endpoint can't be used to enumerate registered emails.",
  request: {
    body: { content: { 'application/json': { schema: RecoverRequestSchema } } },
  },
  responses: {
    202: {
      description: 'Email accepted for delivery (or no-op for unknown email).',
      content: { 'application/json': { schema: AuthOkResponseSchema } },
    },
    400: Responses.badRequest,
    429: Responses.rateLimited,
    503: Responses.serviceUnavailable,
  },
});

authRoute.openapi(recoverOp, async (c) => {
  const data = c.req.valid('json');

  await rateLimit(c, 'auth_recover', RECOVER_RATE_LIMIT_PER_MIN);
  ensureRegistrationEnabled(c.env);

  const tenant = await findTenantByOwnerEmail(c.env.db, data.email);
  if (!tenant) {
    // No leak — return the same 202 the happy path returns.
    return c.json({ ok: true } as const, 202);
  }

  await supersedePriorActive(c.env.db, data.email, 'recover');

  const { raw, hash } = await generateToken();
  const id = newId('evf');
  await insertEmailVerification(c.env.db, {
    id,
    purpose: 'recover',
    email: data.email,
    tenant_id: tenant.id,
    token_hash: hash,
    expires_at: Date.now() + tokenTtlMs(),
    ip_hash: await hashIp(c),
  });

  const redeemUrl = buildRedeemUrl(c.env, raw);
  const mail = renderRecoverEmail({ redeemUrl });
  c.env.bg.spawn(sendMail(c.env, { ...mail, to: data.email }));

  return c.json({ ok: true } as const, 202);
});

// ── POST /v1/auth/redeem ───────────────────────────────────────────────

const redeemOp = createRoute({
  method: 'post',
  path: '/redeem',
  tags: ['Auth'],
  summary: 'Redeem an email-confirmation token',
  description:
    "Consumes the single-use token from a confirmation/recovery email. For `purpose='register'`: mints a tenant + default namespace + first API key. For `purpose='recover'`: mints a fresh API key for the existing tenant. The raw API key is returned ONCE in the response body — store it now or call /recover again. 410 if the token is unknown, expired, or already consumed.",
  request: {
    body: { content: { 'application/json': { schema: RedeemRequestSchema } } },
  },
  responses: {
    200: {
      description: 'Tenant + (optional) namespace + freshly-minted API key.',
      content: { 'application/json': { schema: RedeemResponseSchema } },
    },
    400: Responses.badRequest,
    410: Responses.gone,
  },
});

authRoute.openapi(redeemOp, async (c) => {
  const { token } = c.req.valid('json');
  const hash = await hashToken(token);
  const row = await findByTokenHash(c.env.db, hash);

  // 410 branches, ordered by user-facing precedence:
  //   * unknown / expired / superseded → TOKEN_EXPIRED (get a fresh email)
  //   * already-redeemed (consumed_at > 0) → TOKEN_ALREADY_USED
  // Supersession uses the sentinel `-1` (distinct from a real timestamp)
  // so we can tell apart "user lost the email and re-registered" from
  // "user already minted a key from this exact link".
  if (!row || isExpired(row.expires_at)) {
    throw new TextralError(
      'TOKEN_EXPIRED',
      410,
      'Token is unknown or expired. Request a fresh email.',
    );
  }
  if (row.consumed_at !== null && row.consumed_at < 0) {
    throw new TextralError(
      'TOKEN_EXPIRED',
      410,
      'Token was superseded by a more recent request. Use the most recent email.',
    );
  }
  if (row.consumed_at !== null) {
    throw new TextralError(
      'TOKEN_ALREADY_USED',
      410,
      'Token has already been redeemed. The earlier call returned the only API key.',
    );
  }

  // Atomic single-use enforcement for the concurrent-redeem race —
  // both clicks load consumed_at=null; only one's UPDATE actually
  // flips the row.
  const consumed = await consumeIfUnconsumed(c.env.db, row.id, Date.now());
  if (!consumed) {
    throw new TextralError(
      'TOKEN_ALREADY_USED',
      410,
      'Token was redeemed concurrently by another request.',
    );
  }

  const pepper = await readPepper(c.env);
  const newKey = await generateApiKey(pepper);

  if (row.purpose === 'register') {
    if (!row.display_name) {
      // Defensive: shouldn't happen — register inserts always carry one.
      throw new TextralError('INTERNAL', 500, 'Verification row is missing display_name');
    }
    const tenantId = newId('ten');
    await insertTenant(c.env.db, {
      id: tenantId,
      display_name: row.display_name,
      owner_email: row.email,
    });

    // Mirrors `routes/admin/bootstrap.ts:69-79` — vectorize on CF,
    // qdrant on self-host. v1 keeps Pinecone behind a manual flow
    // (registrants hit /v1/infra-keys after redeem if they want it).
    const isSelfHost = c.env.runtime === 'node';
    const backend: VectorBackend = isSelfHost ? 'qdrant' : 'vectorize';
    const dimensions = inferDimensionsFromProfile(DEFAULT_EMBEDDING_PROFILE);
    const vectorIndexName = isSelfHost ? `textral-${DEFAULT_NAMESPACE_SLUG}` : null;

    const ns = await insertNamespace(c.env.db, {
      id: newId('ns'),
      tenant_id: tenantId,
      slug: DEFAULT_NAMESPACE_SLUG,
      corpus_profile: DEFAULT_CORPUS_PROFILE,
      default_embedding_profile: DEFAULT_EMBEDDING_PROFILE,
      embedding_dimensions: dimensions,
      default_inference_model: null,
      default_prompt_template_id: null,
      vector_backend: backend,
      vector_index_name: backend === 'vectorize' ? null : vectorIndexName,
      vector_namespace: null,
    });

    if (backend !== 'vectorize') {
      const binding = await resolveVectorBinding(c.env, tenantId, {
        backend: ns.vector_backend,
        index_name: ns.vector_index_name,
        embedding_dimensions: dimensions,
        namespace: ns.vector_namespace,
      });
      const store = c.env.vectors.forBinding(binding);
      if (store.ensureBackingExists) {
        await store.ensureBackingExists();
      }
    }

    await insertApiKey(c.env.db, tenantId, {
      id: newKey.id,
      key_hash: newKey.hash,
      key_prefix: newKey.prefix,
      scopes: DEFAULT_API_KEY_SCOPES,
    });

    return c.json(
      {
        tenant: { id: tenantId, display_name: row.display_name, owner_email: row.email },
        namespace: { id: ns.id, slug: ns.slug },
        api_key: {
          id: newKey.id,
          raw: newKey.raw,
          prefix: newKey.prefix,
          scopes: DEFAULT_API_KEY_SCOPES,
        },
      },
      200,
    );
  }

  // purpose === 'recover'
  if (!row.tenant_id) {
    throw new TextralError('INTERNAL', 500, 'Recovery row is missing tenant_id');
  }
  await insertApiKey(c.env.db, row.tenant_id, {
    id: newKey.id,
    key_hash: newKey.hash,
    key_prefix: newKey.prefix,
    scopes: DEFAULT_API_KEY_SCOPES,
  });
  // The tenant must still exist — soft-deletes are rare; if it's
  // gone, treat as TOKEN_EXPIRED (a stale recovery flow against a
  // tenant the operator removed).
  const tenant = await findTenantByOwnerEmail(c.env.db, row.email);
  if (!tenant) {
    throw new TextralError(
      'TOKEN_EXPIRED',
      410,
      'The tenant attached to this token no longer exists.',
    );
  }
  return c.json(
    {
      tenant: {
        id: tenant.id,
        display_name: tenant.display_name,
        owner_email: tenant.owner_email ?? row.email,
      },
      api_key: {
        id: newKey.id,
        raw: newKey.raw,
        prefix: newKey.prefix,
        scopes: DEFAULT_API_KEY_SCOPES,
      },
    },
    200,
  );
});

// ── helpers ────────────────────────────────────────────────────────────

/** Operator gate. Production deploys must have Mailgun + a public base
 *  URL set or the route refuses to issue tokens (the email link would
 *  be unclickable). Dev short-circuits Mailgun in `services/mailgun.ts`,
 *  so dev never hits this. */
function ensureRegistrationEnabled(env: Env): void {
  if (env.ENV === 'prod') {
    if (!env.MAILGUN_API_KEY || !env.MAILGUN_DOMAIN || !env.TEXTRAL_PUBLIC_BASE) {
      throw new TextralError(
        'TENANT_REGISTRATION_DISABLED',
        503,
        'Self-service tenant registration is not configured on this deploy. Operator: set MAILGUN_API_KEY, MAILGUN_DOMAIN, and TEXTRAL_PUBLIC_BASE.',
      );
    }
  }
}

/** Per-IP rate limit. Reuses the `admin_rate_limits` table by
 *  synthesizing a tenant_id of `anon-{ip-hash-prefix}`. The collision
 *  surface with admin-tenant keys is null because `anon-` is not a
 *  valid ULID prefix (the `_` is required). */
async function rateLimit(
  c: Parameters<typeof authRoute.openapi>[1] extends (...a: infer A) => unknown
    ? A[0]
    : never,
  scope: string,
  perMinute: number,
): Promise<void> {
  const ipHash = await hashIp(c);
  const synthetic = `anon-${(ipHash ?? 'unknown').slice(0, 16)}`;
  const { allowed } = await bumpAndCheck(c.env.db, synthetic, scope, perMinute);
  if (!allowed) {
    throw new TextralError(
      'RATE_LIMITED',
      429,
      `Too many ${scope.replace('auth_', '')} requests. Wait one minute and retry.`,
    );
  }
}

/** sha256(salt + ip) hex. Returns null when neither salt nor IP is
 *  available — self-host without `RATE_LIMIT_IP_SALT` falls into this
 *  path, and the rate-limit bucket degrades to a single shared
 *  "anon-unknown" tenant_id. Acceptable in v1: self-host operators
 *  who care about abuse mitigation set the salt. */
async function hashIp(
  c: Parameters<typeof authRoute.openapi>[1] extends (...a: infer A) => unknown
    ? A[0]
    : never,
): Promise<string | null> {
  const ip =
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    null;
  if (!ip) return null;
  const salt = c.env.RATE_LIMIT_IP_SALT ?? '';
  const data = new TextEncoder().encode(salt + ip);
  const sig = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(sig);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}
