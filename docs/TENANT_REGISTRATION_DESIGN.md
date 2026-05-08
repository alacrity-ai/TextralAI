# Tenant Self-Service Registration — Design

## Context

Today the only way to mint a Textral tenant is `POST /v1/admin/bootstrap`, gated
by `ADMIN_BOOTSTRAP_TOKEN` (a Worker secret only the operator holds). The
sandbox lands users on `ApiKeyGate.tsx`, which asks for an existing API key
with no path to obtain one. That's fine for self-host but blocks the use case
the user actually wants: linking the Cloudflare deployment to friends so they
can self-serve a tenant against the platform.

We have a Mailgun domain set up at `mg.alacrity.ai` and a working reference
implementation in `~/textral/reference_repos/home-app/` to copy patterns from.

## Goals

1. Anyone with a valid email can register a tenant via the public landing page.
2. A Mailgun-delivered confirmation link is the proof-of-email step.
3. On confirmation, the API mints the tenant + a default namespace + the first
   API key and shows the raw key **once**.
4. A user who loses their API key can recover access by re-validating their
   email, without operator intervention.
5. Self-host (`runtime: 'node'`) keeps working with `make seed-self-host` —
   the new flow is additive and Mailgun is optional.

## Non-goals

- **Passwords / sessions / cookies.** Textral remains API-key-first. The email
  is the recovery anchor, not a login credential.
- **Multi-user tenants / teams / RBAC.** One owner email per tenant. We can
  bolt `tenant_users` + `invites` on later if needed; the schema chosen here
  doesn't preclude it.
- **Plans, billing, quotas.** Out of scope. New tenants land on `plan: 'free'`
  exactly as bootstrap does today.
- **CAPTCHA / paid-anti-abuse vendors.** We rely on rate limits + the email
  step itself. Cloudflare's WAF is the operator's responsibility.

## Decision: enrich the API-key surface, do not introduce users/RBAC

The user's prompt asked the question. Recommendation: **stay API-key-first.
Add an `owner_email` to `tenants`. That's it.** Reasoning:

- Email is needed regardless (Mailgun has to send *somewhere*). Putting it on
  the tenant is the smallest possible schema change.
- A `users` table only earns its weight when more than one human authenticates
  per tenant. Today the answer is one. Adding the join now buys nothing.
- API keys are already revocable, listable, scope-bearing — they're an
  excellent auth surface for an API product. We don't gain from layering
  passwords on top.
- "Forgot my key" becomes a trivial flow: same email, same token, mint a new
  key. No new auth concepts.

If we later want shared tenants, the migration is mechanical: add `users`,
`tenant_users(tenant_id, user_id, role)`, move `owner_email` → `users.email`,
keep `tenants.owner_user_id` for the bootstrap relationship.

## Data model

### Migration `0012_tenant_owner_email.sql`

```sql
ALTER TABLE tenants ADD COLUMN owner_email TEXT;
-- Index lets the recover flow look up "which tenant owns this email" in O(1).
CREATE INDEX idx_tenants_owner_email_active
  ON tenants(owner_email)
  WHERE deleted_at IS NULL AND owner_email IS NOT NULL;
```

`owner_email` is nullable. Existing tenants (admin-bootstrapped) stay
nullable; only tenants minted through the new flow have it. SQLite/D1 doesn't
permit `ADD COLUMN NOT NULL` on a non-empty table without a default, so this
is the only sane choice. Postgres parity in `migrations/postgres/0012_*.sql`.

### Migration `0013_email_verifications.sql`

```sql
CREATE TABLE email_verifications (
    id            TEXT PRIMARY KEY,
    purpose       TEXT NOT NULL,        -- 'register' | 'recover'
    email         TEXT NOT NULL,
    display_name  TEXT,                 -- carried for 'register'; NULL for 'recover'
    tenant_id     TEXT,                 -- NULL for 'register'; set for 'recover'
    token_hash    TEXT NOT NULL UNIQUE, -- sha256(cleartext) hex
    expires_at    INTEGER NOT NULL,     -- ms epoch; TTL = 1 hour
    consumed_at   INTEGER,              -- single-use flag
    created_at    INTEGER NOT NULL,
    ip_hash       TEXT                  -- sha256(salt+ip) for abuse forensics; nullable
);
-- Active-token lookup by (email, purpose) for the "supersede prior unconsumed
-- token when the user re-requests" flow.
CREATE INDEX idx_email_verifications_active
  ON email_verifications(email, purpose) WHERE consumed_at IS NULL;
```

**No `users` table. No `passwords`. No `sessions`.** That's the whole schema delta.

## API surface

Three new routes under `/v1/auth/*`. All public (no `X-Textral-Api-Key`).

### `POST /v1/auth/register`

**Body:** `{ email: string, display_name: string }`

**Behavior:**
1. Validate email shape + length, normalize (lowercase + trim).
2. Rate-limit by IP hash (see §Rate limiting).
3. Soft-supersede any prior unconsumed `register` token for this email
   (set `consumed_at` so the old link 410s).
4. Generate token (`crypto.getRandomValues(32)` → b64url), insert
   `email_verifications` row with `purpose='register'`, `expires_at = now + 1h`.
5. Dispatch confirmation email via Mailgun (fire-and-forget through
   `executionCtx.waitUntil`).
6. **Always** return `202 { ok: true }` regardless of any internal failure
   downstream of validation. We never leak whether the email exists, whether
   Mailgun failed, etc.

**Idempotency note:** the tenant is **not** created here. It's created at
`/redeem` time. That avoids stale-tenant garbage when a user abandons
confirmation, and avoids a race when two clicks arrive for the same token.

### `POST /v1/auth/recover`

**Body:** `{ email: string }`

**Behavior:**
1. Validate + normalize email.
2. Rate-limit by IP hash.
3. Look up `tenants.owner_email = email` (single active row). If none, no-op
   (return 202 anyway — no enumeration leak).
4. Soft-supersede prior unconsumed `recover` tokens.
5. Generate token, insert `email_verifications` with `purpose='recover'`,
   `tenant_id` set, 1h TTL.
6. Dispatch recovery email.
7. Return `202 { ok: true }`.

### `POST /v1/auth/redeem`

**Body:** `{ token: string }`

This is the **single endpoint the email link points to.** Switches on stored
`purpose`. Returns the freshly-minted API key — once.

**Behavior:**
1. Hash `token`, look up active row by `token_hash`.
2. Reject if not found / expired / already consumed → `410 TOKEN_EXPIRED`
   or `410 TOKEN_ALREADY_USED`.
3. Mark `consumed_at = now` (atomic: condition on `consumed_at IS NULL`).
   If the conditional update affects 0 rows, return 410 — handles double-click.
4. Branch on `purpose`:
   - **`register`:** create tenant (`owner_email`, `display_name`,
     `plan='free'`), create one default namespace (slug derived from
     display_name → `default`, vector backend `vectorize` on CF / `qdrant`
     on Node — same defaulting `bootstrap.ts:69-79` already does), mint API key.
   - **`recover`:** mint a new API key for `tenant_id`. Existing keys are
     **not** automatically revoked — the user can revoke them via
     `DELETE /v1/api-keys/{id}` after they're back in. Keeps recovery
     non-destructive: if the email click was unintended, no harm done.
5. Return `200 { tenant, namespace?, api_key: { id, raw, prefix, scopes } }`
   where `namespace` is present only on `register`.

**Response shape (register):**
```json
{
  "tenant": { "id": "ten_...", "display_name": "...", "owner_email": "..." },
  "namespace": { "id": "ns_...", "slug": "default", ... },
  "api_key": {
    "id": "key_...",
    "raw": "tx_live_...",
    "prefix": "tx_live_xxxx",
    "scopes": ["*"]
  }
}
```

`raw` is shown once, in flight, never returned again. Mirrors the existing
`POST /v1/api-keys` semantics.

### Status codes / error catalog additions

```
TENANT_REGISTRATION_DISABLED  503  // when MAILGUN_API_KEY missing in prod
TOKEN_EXPIRED                 410
TOKEN_ALREADY_USED            410
INVALID_EMAIL                 400
RATE_LIMITED                  429
```

`TENANT_REGISTRATION_DISABLED` exists so self-host operators who haven't
configured Mailgun get a clear error instead of "your email never arrived."
Dev mode (`ENV=dev`) short-circuits Mailgun (logs to console — see below)
without surfacing this error, so local development needs no email creds.

## Mailgun integration

Mirrors `home-app/apps/api/src/services/mailgun.ts` — the simplest pattern
that works:

### Env vars (Worker secrets + plain vars)

```
MAILGUN_API_KEY        // Worker secret. Absence ⇒ short-circuit to console.log.
MAILGUN_DOMAIN         // 'mg.alacrity.ai'. Plain wrangler var.
MAILGUN_FROM           // optional, defaults to 'Textral <noreply@mg.alacrity.ai>'
MAILGUN_BASE_URL       // optional, defaults to 'https://api.mailgun.net'
TEXTRAL_PUBLIC_BASE    // 'https://textral.alacrity.ai' — prepended to /confirm/{token}
                       //   in email bodies. Required in prod, dev infers from request.
```

### Service module — `apps/api/src/services/mailgun.ts`

```ts
export interface MailParams {
  to: string;
  subject: string;
  text: string;
  html: string;
  tag?: string;
}

export async function sendMail(env: Env, p: MailParams): Promise<{ ok: boolean }> {
  if (!env.MAILGUN_API_KEY || !env.MAILGUN_DOMAIN) {
    console.log('[mailgun:short-circuit]', { to: redact(p.to), subject: p.subject });
    return { ok: true };
  }
  const form = new FormData();
  form.set('from', env.MAILGUN_FROM ?? `Textral <noreply@${env.MAILGUN_DOMAIN}>`);
  form.set('to', p.to);
  form.set('subject', p.subject);
  form.set('text', p.text);
  form.set('html', p.html);
  if (p.tag) form.set('o:tag', p.tag);
  const res = await fetch(
    `${env.MAILGUN_BASE_URL ?? 'https://api.mailgun.net'}/v3/${env.MAILGUN_DOMAIN}/messages`,
    { method: 'POST', headers: { Authorization: `Basic ${btoa(`api:${env.MAILGUN_API_KEY}`)}` }, body: form },
  );
  return { ok: res.ok };
}
```

- Fire-and-forget at the call site: `c.executionCtx.waitUntil(sendMail(env, ...))`
  so the route returns 202 in <50ms.
- No retry; Mailgun's own retry queue handles transient failures.
- Short-circuits in dev so local development needs no creds.
- Works on both runtimes — it's `fetch + FormData`, no CF-specific APIs.

### Email templates

Two templates, plain inline HTML (no template engine). Both contain:
- Display-font headline ("Confirm your Textral tenant" / "Recover your API key")
- One-paragraph body
- Single CTA button → `${TEXTRAL_PUBLIC_BASE}/confirm/{token}` or `/recover/{token}`
  (or unify under `/redeem/{token}` — see frontend §below)
- Footer: "This link expires in 1 hour." + "If you didn't request this, ignore this email."

Subjects:
- `register` → `"Confirm your Textral tenant"`
- `recover` → `"Recover your Textral API key"`

## Token mechanics

- 32 random bytes via `crypto.getRandomValues(new Uint8Array(32))`
- Encode as base64url for the URL
- Store SHA-256 of the cleartext as hex; cleartext never persisted
- TTL: 1 hour
- Single-use: `consumed_at` flag, set atomically on redeem
- Supersession: on a fresh register/recover request for the same `(email, purpose)`,
  pre-mark prior unconsumed tokens as consumed so old links 410 instead of
  competing with the new one
- The `email_verifications.id` is its own ULID; the cleartext token is unrelated
- No background cleanup task — expired rows stay until a manual prune. Volume
  is low; the unique index on `token_hash` is the only thing that matters

## Frontend (sandbox)

### Routing changes

Add three public routes (no `ApiKeyGate` wrapper):

```
/                  → Login + Register hybrid (replaces today's API-Key gate)
/redeem/:token     → Token-redemption page (handles both register & recover)
/recover           → "Forgot your key?" form (target of footer link)
```

Authenticated routes stay behind `ApiKeyGate` exactly as today.

### Landing page redesign — `pages/Landing.tsx` (replaces `ApiKeyGate.tsx` as the public entry)

Two-column / two-tab layout. The current `ApiKeyGate` is preserved verbatim
under one tab; the other holds the registration form.

```
┌─────────────────────────────────────────────────┐
│  TEXTRAL · SANDBOX                              │
│                                                 │
│  ┌─[ Sign in ]─[ Register ]──────────────────┐  │
│  │                                            │  │
│  │  (Sign in tab — existing API-key paste)    │  │
│  │  [tx_live_...                          ]   │  │
│  │  [    Continue    ]                        │  │
│  │  ─────────────────                         │  │
│  │  Forgot your key? → /recover               │  │
│  │                                            │  │
│  │  (Register tab — email + display_name)     │  │
│  │  [you@example.com                      ]   │  │
│  │  [Tenant name (e.g., 'Acme RAG')       ]   │  │
│  │  [    Send confirmation email    ]         │  │
│  │                                            │  │
│  └────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

Post-submit on Register: swap the tab body to a "Check your email"
confirmation panel ("We sent a link to *you@example.com*. Click it within
the next hour to mint your tenant. Didn't get it? Check spam, or [resend]").

### `pages/Redeem.tsx`

- Reads `:token` from the URL.
- POSTs `{ token }` to `/v1/auth/redeem` on mount.
- On 200: renders a one-time API-key reveal with copy button + "Save this
  somewhere safe — we will never show it again" warning, and a "Continue to
  sandbox" CTA. Stuffs the key into `localStorage` via `useApiKey()` so
  Continue lands them straight in the gate-passed UI.
- On 410: renders "This link is invalid or has expired" + a "Start over"
  link to `/`.

### `pages/Recover.tsx`

- Email input + "Send recovery email" button.
- POSTs to `/v1/auth/recover`. Always shows the same success state
  ("If an account with that email exists, we've sent a link.")
- Footer link from Sign-in tab takes you here.

## Rate limiting / abuse

Two endpoints to protect: `POST /v1/auth/register` and `POST /v1/auth/recover`.
The existing `admin_rate_limits` table is keyed on `tenant_id`, which we don't
have at register time. Two options:

**v1 (this PR):** synthesize `tenant_id = 'anon-' + sha256(salt+ip).slice(0,16)`
and reuse the same table + middleware. Cap: 5 register requests / 10 minutes,
3 recover / 10 minutes per IP. Simple, no schema change.

**v2 (future):** separate `public_rate_limits(ip_hash, bucket_key, ...)` table
if we discover the synthetic-tenant key collides with admin endpoints. Defer
until that's observed.

Other defenses already in scope:
- The email step itself — registration is rate-limited by the email provider's
  own infrastructure (a flood would burn Mailgun reputation, not our system).
- 1-hour token TTL.
- Single-use enforcement.
- Always-202 from `/register` and `/recover` (no oracle for which emails exist).
- Lowercase + trim email before all comparisons (so `Foo@BAR.com` and
  `foo@bar.com` collide).

Punted to operator/WAF: bot detection, disposable-email-domain blocklist,
geo-fencing.

## Wrangler / runtime config

`apps/api/wrangler.toml` (or `.jsonc`) gains:

```toml
[vars]
MAILGUN_DOMAIN     = "mg.alacrity.ai"
TEXTRAL_PUBLIC_BASE = "https://textral.alacrity.ai"
# MAILGUN_FROM      optional; default 'Textral <noreply@{MAILGUN_DOMAIN}>'
```

Worker secrets to set:

```
wrangler secret put MAILGUN_API_KEY    # production only
```

Self-host (`apps/api/.env.example`) gets the same names. If absent, the
service short-circuits, registration returns
`503 TENANT_REGISTRATION_DISABLED` in prod / logs in dev.

## Backwards compatibility

- `POST /v1/admin/bootstrap` is unchanged. Operator-driven tenant creation
  still works for self-host setups and tests.
- `tenants.owner_email` is nullable. All existing tenant rows + the
  bootstrap path stay valid. Recovery just doesn't work for them
  (operator can `UPDATE tenants SET owner_email = ?` if they want to
  enable it after the fact).
- The sandbox's `ApiKeyContext` + `localStorage` storage of the key is
  unchanged — the new redeem page just stuffs the key the same way the
  old gate did.
- MCP, Python SDK, OpenAPI consumers see only additive changes (new routes
  + new error codes). No breaking shape changes to existing endpoints.

## OpenAPI / Scalar docs

Add a new tag — `Auth` — under the **Onboarding** group in
`apps/api/src/openapi/tag-descriptions.ts`. Block:

> **Auth — self-service tenant registration and key recovery.** Two flows:
> *register* (email + display name → confirmation link → tenant + first
> API key) and *recover* (email → recovery link → fresh API key for the
> tenant that owns the email). Email delivery is via Mailgun; the operator
> sets `MAILGUN_API_KEY` as a Worker secret. Self-host deployments without
> Mailgun configured can still mint tenants via `/v1/admin/bootstrap`.

`Responses.tokenExpired`, `Responses.invalidEmail`, etc. wired through the
shared registry.

## Testing plan

Unit (Vitest, both runtimes):
- Token generation collision-resistance (statistical sanity, ≥1M draws).
- `email_verifications` insert + unique-token-hash + supersession behavior.
- `redeem` happy path for both purposes.
- `redeem` double-click race → second call gets 410.
- `redeem` expired token → 410.
- `register` always returns 202 even when Mailgun returns 4xx.
- Rate-limit threshold tripping by synthetic IP.

Integration (test-fixtures harness):
- End-to-end `register → redeem → query` smoke. Mailgun stubbed to capture
  the token from the dispatched body.
- `recover` for an existing `owner_email` mints a usable key; the original
  key still works (no auto-revoke).
- `recover` for an unknown email returns 202 with no DB write.

Manual / staging:
- Real Mailgun against `mg.alacrity.ai`, real inbox, real link click,
  on both production worker and self-host. (User-driven step before merge.)

## Implementation phases

Three commits, each independently revertable:

**Phase A — schema + auth library**
- Migrations 0012 + 0013 (sqlite + postgres)
- `apps/api/src/auth/email-tokens.ts` (generate / hash / verify / supersede)
- `apps/api/src/services/mailgun.ts` (short-circuit pattern)
- Email templates (HTML + text)

**Phase B — routes + contracts**
- `apps/api/src/routes/auth.ts` with the three endpoints
- Contract types in `packages/contracts/src/auth.ts`
- Error catalog additions
- OpenAPI components + tag wiring
- Wrangler vars + `.env.example` updates

**Phase C — sandbox**
- `pages/Landing.tsx` (Sign-in / Register tabs, replaces ApiKeyGate as router root)
- `pages/Redeem.tsx`
- `pages/Recover.tsx`
- Routing changes in `App.tsx`
- API-client wrappers in `api/auth.ts`

Each phase is mergeable on its own — Phase A leaves no user-visible surface,
Phase B without Phase C is API-only-usable, Phase C without B fails closed
because the routes don't exist yet (CI catches the broken import).

## Open questions

1. **Auto-revoke prior keys on `recover`?** Current proposal says no
   (non-destructive). Alternative: revoke all but the new one, since the
   most likely reason to recover is the old key leaked. Argument for:
   security default. Argument against: locks out automated systems still
   using the old key. **Recommendation:** keep non-destructive in v1; add
   a "revoke other keys?" checkbox on the redeem page in a follow-up.

2. **Should `register` auto-create a default namespace?** Bootstrap does;
   matching that behavior is a nicer first-run experience. Confirmed in
   §API §redeem above — yes, namespace `slug='default'`, vectorize backend
   on CF.

3. **Public base URL configuration.** Hardcoding `textral.alacrity.ai` in
   the email body would couple the API to a specific deployment. Use
   `TEXTRAL_PUBLIC_BASE` env var, default to the request's `Origin` header
   in dev. Self-host operators set it to whatever they're deploying behind.

4. **Display-name uniqueness?** Today `tenants.display_name` is not unique.
   The new flow doesn't change that — two tenants can have the same
   display_name with different owner_emails. We could enforce uniqueness on
   `(display_name)` to avoid impostor tenant names but that bites later if
   we want to allow it. **Recommendation:** keep non-unique; trust that the
   tenant ID + owner-email pair is the actual identity.

## Work-product checklist

- [ ] Migrations 0012 + 0013 (sqlite + postgres), tests passing
- [ ] `mailgun.ts` service module with short-circuit + redaction
- [ ] `email-tokens.ts` library
- [ ] Email templates (HTML + text)
- [ ] `routes/auth.ts` with register / recover / redeem
- [ ] Error catalog entries + Scalar docs `Auth` tag
- [ ] `packages/contracts/src/auth.ts` schemas
- [ ] Sandbox: `Landing.tsx`, `Redeem.tsx`, `Recover.tsx`, routing wire-up
- [ ] Wrangler vars + `.env.example`
- [ ] Vitest coverage on token + redeem flows
- [ ] Manual end-to-end against `mg.alacrity.ai` from prod CF Worker
