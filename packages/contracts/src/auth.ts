// Self-service tenant registration + key recovery contracts.
//
// Three public endpoints back the flow:
//   POST /v1/auth/register  — email + display_name → 202 (always)
//   POST /v1/auth/recover   — email                → 202 (always)
//   POST /v1/auth/redeem    — token                → 200 RedeemResponse
//
// The first two never reveal whether the email is known to the system —
// they always return AuthOkResponse on a well-formed body. /redeem is
// the only endpoint that can fail informatively (TOKEN_EXPIRED /
// TOKEN_ALREADY_USED).

import { z } from 'zod';

// Local copy of the email validator — `.email()` + a 254-char ceiling
// (RFC 5321) + lowercase/trim normalization so `Foo@BAR.com` and
// `foo@bar.com` collide at the (email, purpose) supersession layer.
//
// `preprocess` runs the trim+lowercase BEFORE `.email()` so leading /
// trailing whitespace doesn't fail the format check. Zod's `.email()`
// is strict about whitespace.
const Email = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
  z.string().email().max(254),
);

export const RegisterRequest = z.object({
  email: Email,
  display_name: z.string().min(2).max(120),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const RecoverRequest = z.object({ email: Email });
export type RecoverRequest = z.infer<typeof RecoverRequest>;

/** The cleartext token the email link carries. base64url(32 bytes) is
 *  exactly 43 chars; we widen the bounds a little to allow for the
 *  off chance Mailgun mangles it (it doesn't, but pinning at exactly
 *  43 would be a paper cut for no benefit). */
export const RedeemRequest = z.object({
  token: z.string().min(20).max(64),
});
export type RedeemRequest = z.infer<typeof RedeemRequest>;

export const AuthOkResponse = z.object({ ok: z.literal(true) });
export type AuthOkResponse = z.infer<typeof AuthOkResponse>;

/** Mirrors the ApiKey shape from `routes/api-keys.ts` post-creation
 *  + adds `scopes`. The `raw` value is shown exactly once; never
 *  persisted, never returned again. */
export const RedeemApiKey = z.object({
  id: z.string(),
  raw: z
    .string()
    .describe('Returned exactly once on redemption; never persisted in cleartext.'),
  prefix: z.string(),
  scopes: z.array(z.string()),
});
export type RedeemApiKey = z.infer<typeof RedeemApiKey>;

export const RedeemTenant = z.object({
  id: z.string(),
  display_name: z.string(),
  owner_email: z.string(),
});
export type RedeemTenant = z.infer<typeof RedeemTenant>;

/** Slim form of `Namespace` — at redeem-time we only mint a
 *  vectorize-backed default namespace; the full `NamespaceSchema` carries
 *  vector_index_name + vector_namespace which are null on this default,
 *  so we expose only the fields the sandbox needs to land in the UI. */
export const RedeemNamespace = z.object({
  id: z.string(),
  slug: z.string(),
});
export type RedeemNamespace = z.infer<typeof RedeemNamespace>;

export const RedeemResponse = z.object({
  tenant: RedeemTenant,
  /** Present only when the token's `purpose='register'`. The tenant
   *  pre-existed for `purpose='recover'`. */
  namespace: RedeemNamespace.optional(),
  api_key: RedeemApiKey,
});
export type RedeemResponse = z.infer<typeof RedeemResponse>;
