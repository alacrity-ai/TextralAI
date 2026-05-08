# Tenant Self-Service Registration — Implementation Steps

> Companion to `docs/TENANT_REGISTRATION_DESIGN.md`. Concrete, ordered
> steps. Three independently-mergeable phases (A, B, C). At completion,
> anyone with an email address can register a Textral tenant against
> the Cloudflare deployment, mint a first API key, and recover a lost
> key — without operator intervention.

---

**At completion, you will have:**

- Two new D1 + Postgres migrations: `owner_email` on `tenants`,
  `email_verifications` table.
- A short-circuiting Mailgun service module that works against
  `mg.alacrity.ai` in prod and no-ops in dev.
- Three new public endpoints: `POST /v1/auth/register`,
  `POST /v1/auth/recover`, `POST /v1/auth/redeem`.
- New error codes: `TOKEN_EXPIRED`, `TOKEN_ALREADY_USED`,
  `INVALID_EMAIL`, `TENANT_REGISTRATION_DISABLED`.
- A redesigned sandbox landing page with **Sign in** / **Register** tabs,
  a `/redeem/:token` post-email page, and a `/recover` "forgot key" page.
- A new Scalar docs tag — **Auth** — with the full self-service flow
  documented inline.
- Vitest coverage on token mechanics, redeem races, rate limits, and
  Mailgun short-circuit behavior.
- A live, manually-verified end-to-end run from a real inbox.

By the end of this plan, the user can share `https://textral.alacrity.ai`
with a friend, the friend registers, clicks the email link, and lands in
the sandbox with a working API key — with no admin involvement.

---

## What this plan specifically does NOT do

- **No users / passwords / sessions.** Decided in
  `TENANT_REGISTRATION_DESIGN.md` §"Decision". One owner email per tenant.
- **No multi-user tenants, invites, or RBAC.** Future work; the schema
  doesn't preclude it.
- **No auto-revoke of prior API keys on `recover`.** Non-destructive by
  default. A "revoke other keys?" toggle is a follow-up.
- **No CAPTCHA / bot-detection / disposable-email blocking.** Deferred
  to operator WAF + the email step itself.
- **No changes to `POST /v1/admin/bootstrap`.** It stays exactly as-is
  for self-host operators and tests.
- **No marketing email / templates beyond the two transactional emails.**

---

## Prerequisites

- `mg.alacrity.ai` Mailgun domain verified (DNS records in place;
  user-confirmed).
- Mailgun sending key available (recorded in `DO_NOT_COMMIT.md`).
- D1 + Postgres migration tooling working (`make migrate-dev`,
  `make selfhost-migrate-up`).
- Existing `make seed-dev` / `make seed-self-host` paths green.
- `cloudflare_dep` branch is the staging integration branch — all 10
  prior commits already queued.

---

## Locked-in technology choices

| Concern | Choice | Rationale |
|---|---|---|
| Token entropy | **`crypto.getRandomValues(32)` → base64url** | Web-platform; works identically on CF Worker + Node. 256 bits is overkill but cheap. |
| Token storage | **`SHA-256(cleartext)` hex, unique-indexed** | Cleartext only in-flight; DB compromise reveals nothing redeemable. Mirrors home-app. |
| Token TTL | **1 hour** | Long enough to survive an inbox-wait; short enough that abandoned tokens don't accumulate. Same as home-app reset tokens. |
| Single-use enforcement | **Atomic conditional update on `consumed_at IS NULL`** | Lock-free; double-click race naturally degrades to second-call 410. |
| Mailgun mode | **Single POST to `/v3/{domain}/messages`, FormData multipart** | Works on `fetch` everywhere. No SDK dependency. |
| Mailgun absence | **Short-circuit to `console.log`** | Local dev needs no creds; mirrors home-app pattern verbatim. |
| Email send timing | **`executionCtx.waitUntil(...)` (CF) / fire-and-forget Promise (Node)** | Routes return 202 in <50 ms. |
| Email template format | **Inline HTML in TS string literals; no template engine** | One template, one file, no Handlebars/MJML/etc. dependency. |
| Public base URL | **`TEXTRAL_PUBLIC_BASE` env var** | Decouples API from a specific hostname; self-host operators set their own. |
| Rate-limit storage | **Existing `admin_rate_limits` keyed on synthetic `tenant_id = 'anon-' + sha256(salt+ip).slice(0,16)`** | No schema change. Caps: 5 register/10 min, 3 recover/10 min per IP. |
| Frontend routing | **Add `react-router-dom` routes; keep `ApiKeyGate` for the auth-walled subtree** | Smallest delta; existing context is untouched. |
| Tenant creation timing | **At redeem, not register** | No stale rows from abandoned signups. Single-use token kills the race. |
| Default namespace on register | **Yes — `slug='default'`, vectorize on CF / qdrant on Node** | Matches `bootstrap.ts:69-79` defaulting; first-run experience. |
| Auto-revoke on recover | **No** (non-destructive) | If recovery email is unintended, no harm. User revokes manually post-redeem. |
| Display-name uniqueness | **Not enforced** | Tenant ID + owner_email is the real identity. Avoids future regret. |

---

## Naming and locations

```
apps/api/
├── migrations/
│   ├── sqlite/
│   │   ├── 0012_tenant_owner_email.sql        ← NEW (Phase A)
│   │   └── 0013_email_verifications.sql       ← NEW (Phase A)
│   └── postgres/
│       ├── 0012_tenant_owner_email.sql        ← NEW (Phase A)
│       └── 0013_email_verifications.sql       ← NEW (Phase A)
├── src/
│   ├── auth/
│   │   └── email-tokens.ts                    ← NEW (Phase A)
│   ├── services/
│   │   ├── mailgun.ts                         ← NEW (Phase A)
│   │   └── email-templates.ts                 ← NEW (Phase A)
│   ├── db/
│   │   ├── email-verifications.ts             ← NEW (Phase A)
│   │   └── tenants.ts                         ← MODIFIED (owner_email)
│   ├── routes/
│   │   └── auth.ts                            ← NEW (Phase B)
│   └── openapi/
│       ├── components.ts                      ← MODIFIED (Phase B)
│       └── tag-descriptions.ts                ← MODIFIED (Phase B)
└── test/
    ├── auth/
    │   ├── email-tokens.test.ts               ← NEW (Phase A)
    │   ├── mailgun.test.ts                    ← NEW (Phase A)
    │   ├── register.test.ts                   ← NEW (Phase B)
    │   ├── recover.test.ts                    ← NEW (Phase B)
    │   └── redeem.test.ts                     ← NEW (Phase B)
packages/contracts/src/
├── auth.ts                                    ← NEW (Phase B)
├── error.ts                                   ← MODIFIED (Phase B)
└── index.ts                                   ← MODIFIED (re-export)
apps/sandbox/src/
├── pages/
│   ├── Landing.tsx                            ← NEW (Phase C, replaces gate as root)
│   ├── Redeem.tsx                             ← NEW (Phase C)
│   └── Recover.tsx                            ← NEW (Phase C)
├── api/
│   ├── auth.ts                                ← NEW (Phase C)
│   └── types.ts                               ← MODIFIED (Phase C)
├── auth/
│   └── ApiKeyGate.tsx                         ← MODIFIED (no longer the public root)
└── App.tsx                                    ← MODIFIED (routing)
docs/
├── TENANT_REGISTRATION_DESIGN.md              ← (already exists)
└── TENANT_REGISTRATION_IMPLEMENTATION.md      ← THIS FILE
```

---

# Phase A — schema + auth library

Lays down everything the routes need without exposing any user-visible
surface. Mergeable on its own; tested independently. No client changes.

### Step A.1 — Migration `0012_tenant_owner_email.sql`

**A.1.1** SQLite migration:

```sql
ALTER TABLE tenants ADD COLUMN owner_email TEXT;
CREATE INDEX idx_tenants_owner_email_active
  ON tenants(owner_email)
  WHERE deleted_at IS NULL AND owner_email IS NOT NULL;
```

**A.1.2** Postgres mirror at `migrations/postgres/0012_tenant_owner_email.sql`:

```sql
ALTER TABLE tenants ADD COLUMN owner_email TEXT;
CREATE INDEX idx_tenants_owner_email_active
  ON tenants(owner_email)
  WHERE deleted_at IS NULL AND owner_email IS NOT NULL;
```

**A.1.3** Update `apps/api/src/db/tenants.ts` Tenant row type to include
`owner_email: string | null`. Update `insertTenant` to accept it; default
`null` when omitted (preserves existing bootstrap-call signature). No
existing callers need to change.

**Exit criteria for A.1**
- `make migrate-dev` (D1) and `make selfhost-migrate-up` (Postgres) both
  apply cleanly.
- `pnpm test --filter @textral/api` green; existing tenant tests
  unaffected.

---

### Step A.2 — Migration `0013_email_verifications.sql`

**A.2.1** SQLite migration:

```sql
CREATE TABLE email_verifications (
    id            TEXT PRIMARY KEY,
    purpose       TEXT NOT NULL,
    email         TEXT NOT NULL,
    display_name  TEXT,
    tenant_id     TEXT,
    token_hash    TEXT NOT NULL UNIQUE,
    expires_at    INTEGER NOT NULL,
    consumed_at   INTEGER,
    created_at    INTEGER NOT NULL,
    ip_hash       TEXT
);
CREATE INDEX idx_email_verifications_active
  ON email_verifications(email, purpose) WHERE consumed_at IS NULL;
```

**A.2.2** Postgres mirror — same DDL, with `INTEGER` → `BIGINT` for
millisecond timestamps consistent with prior Postgres migrations.

**A.2.3** New `apps/api/src/db/email-verifications.ts` exposing:

```ts
export interface EmailVerificationRow { ... }
export async function insertEmailVerification(db: Db, row: { ... }): Promise<void>;
export async function findActiveByTokenHash(db: Db, hash: string): Promise<EmailVerificationRow | null>;
export async function consumeIfUnconsumed(db: Db, id: string): Promise<boolean>; // atomic
export async function supersedePriorActive(db: Db, email: string, purpose: 'register' | 'recover'): Promise<void>;
```

The `consumeIfUnconsumed` query uses
`UPDATE ... SET consumed_at = ?, ... WHERE id = ? AND consumed_at IS NULL`
and returns `result.changes > 0` (D1) / `rowCount > 0` (PG). That's the
race-safe single-use mechanic.

**Exit criteria for A.2**
- Both migrations apply cleanly.
- Unit test in `db/email-verifications.test.ts` proves the conditional
  update returns false on the second call.

---

### Step A.3 — Token library `auth/email-tokens.ts`

**A.3.1** New module exposing four functions:

```ts
export async function generateToken(): Promise<{ raw: string; hash: string }>;
//   raw  = base64url(crypto.getRandomValues(new Uint8Array(32)))
//   hash = hex(sha256(raw))

export async function hashToken(raw: string): Promise<string>;
//   For verifying inbound tokens.

export function tokenTtlMs(): number; //  60 * 60 * 1000

export function buildRedeemUrl(env: Env, token: string): string;
//   Joins TEXTRAL_PUBLIC_BASE + '/redeem/' + token. Throws if the env
//   var isn't set in prod (env.ENV === 'prod').
```

All `crypto.subtle.digest` calls are awaited; works identically on CF
Worker + Node.

**A.3.2** Test `email-tokens.test.ts`:
- 1M `generateToken()` draws → assert zero collisions on `raw`.
- `hashToken(raw)` is deterministic.
- `buildRedeemUrl` throws when `TEXTRAL_PUBLIC_BASE` is missing in prod
  but falls back to `http://localhost:5173` in dev.

**Exit criteria for A.3**
- Both tests green.
- No `node:crypto` import — only `globalThis.crypto`.

---

### Step A.4 — Mailgun service `services/mailgun.ts`

**A.4.1** Implement per `TENANT_REGISTRATION_DESIGN.md` §Mailgun:

```ts
export interface MailParams { to: string; subject: string; text: string; html: string; tag?: string; }
export async function sendMail(env: Env, p: MailParams): Promise<{ ok: boolean }>;
```

Short-circuit when `MAILGUN_API_KEY` or `MAILGUN_DOMAIN` is missing —
log to `console.log('[mailgun:short-circuit]', ...)` with the recipient
**redacted via the existing redaction middleware** and return `{ok: true}`.

**A.4.2** Add the new env fields to `apps/api/src/types.ts` `Env`
interface:

```ts
MAILGUN_API_KEY?: string;
MAILGUN_DOMAIN?: string;
MAILGUN_FROM?: string;
MAILGUN_BASE_URL?: string;
TEXTRAL_PUBLIC_BASE?: string;
RATE_LIMIT_IP_SALT?: string;     // for ip_hash anonymization
```

**A.4.3** `wrangler.toml` `[vars]` block:

```toml
MAILGUN_DOMAIN = "mg.alacrity.ai"
TEXTRAL_PUBLIC_BASE = "https://textral.alacrity.ai"
```

(Adjust the public base to whatever the deployed Pages URL ends up being.
The user-facing domain may differ — confirm at deploy time.)

**A.4.4** Document required Worker secrets in
`docs/runbooks/DEPLOY.md`:

```bash
wrangler secret put MAILGUN_API_KEY        # use the value from DO_NOT_COMMIT.md
wrangler secret put RATE_LIMIT_IP_SALT     # any 32-byte hex string
```

**A.4.5** Self-host parity — `apps/api/.env.example` gains the same names
with comments describing the short-circuit behavior.

**A.4.6** Test `mailgun.test.ts`:
- `sendMail` with no key → returns `{ok: true}`, no fetch call (spy on
  `globalThis.fetch`).
- `sendMail` with key + mocked 200 → returns `{ok: true}`, fetch called
  exactly once with the right URL + Authorization header.
- `sendMail` with mocked 4xx → returns `{ok: false}`, no throw.

**Exit criteria for A.4**
- All three test scenarios green.
- Manual smoke: `wrangler dev` with `MAILGUN_API_KEY` set, hit a debug
  route that calls `sendMail` to a real inbox — receive the email.

---

### Step A.5 — Email templates `services/email-templates.ts`

**A.5.1** Two functions, each returning `{subject, text, html}`:

```ts
export function renderRegisterEmail(opts: { redeemUrl: string; displayName: string }): MailParams;
export function renderRecoverEmail(opts: { redeemUrl: string }): MailParams;
```

**A.5.2** HTML uses inline styles only (most webmail clients strip
`<style>` blocks). Structure:

```
┌─────────────────────────────────────┐
│  TEXTRAL  (display-font wordmark)   │
│                                     │
│  Confirm your tenant                │
│  ───────────────────                │
│  We received a request to create    │
│  a Textral tenant for {displayName}. │
│  Click below within the next hour:  │
│                                     │
│       [ Confirm tenant ]            │
│                                     │
│  If you didn't request this, ignore │
│  this email.                        │
│                                     │
│  — The Textral team                 │
└─────────────────────────────────────┘
```

Subjects:
- register → `"Confirm your Textral tenant"`
- recover → `"Recover your Textral API key"`

**A.5.3** Plain-text fallback: same content, no markup, just the URL.
Mailgun's deliverability scoring rewards having both.

**Exit criteria for A.5**
- Snapshot test for both renderers.
- Manual: render the HTML in a browser tab, eyeball it, send to Gmail
  + Outlook.com to verify rendering.

---

# Phase B — routes, contracts, OpenAPI

User-visible API surface lights up. Without Phase C, the routes are
callable by anyone holding curl + an inbox.

### Step B.1 — Contracts `packages/contracts/src/auth.ts`

**B.1.1** New file with Zod schemas:

```ts
import { z } from 'zod';

const Email = z.string().email().max(254).transform((s) => s.toLowerCase().trim());

export const RegisterRequest = z.object({
  email: Email,
  display_name: z.string().min(2).max(80),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const RecoverRequest = z.object({ email: Email });
export type RecoverRequest = z.infer<typeof RecoverRequest>;

export const RedeemRequest = z.object({ token: z.string().min(20).max(64) });
export type RedeemRequest = z.infer<typeof RedeemRequest>;

export const AuthOkResponse = z.object({ ok: z.literal(true) });

export const RedeemResponse = z.object({
  tenant: z.object({ id: z.string(), display_name: z.string(), owner_email: z.string() }),
  namespace: z.object({ id: z.string(), slug: z.string() }).optional(),
  api_key: z.object({
    id: z.string(),
    raw: z.string(),
    prefix: z.string(),
    scopes: z.array(z.string()),
  }),
});
```

**B.1.2** Re-export from `packages/contracts/src/index.ts`.

**B.1.3** Add error codes to `error.ts`:

```ts
'TOKEN_EXPIRED', 'TOKEN_ALREADY_USED', 'INVALID_EMAIL',
'TENANT_REGISTRATION_DISABLED'
```

**Exit criteria for B.1**
- `pnpm build --filter @textral/contracts` green.
- Existing consumers (sdk, mcp) compile unchanged.

---

### Step B.2 — Routes `routes/auth.ts`

**B.2.1** New `OpenAPIHono` sub-app with three routes. Each is registered
under tag `Auth`. None require `ApiKeyAuth` security.

**B.2.2** `POST /v1/auth/register`:
1. `c.req.valid('json')` → `{email, display_name}`.
2. Compute `ip_hash = sha256(env.RATE_LIMIT_IP_SALT + cf.connecting_ip)`.
3. Increment + check rate-limit bucket
   `('anon-' + ip_hash.slice(0,16), 'auth_register', minute_window)`
   via the existing `admin_rate_limits` helper. If exceeded → 429
   `RATE_LIMITED`.
4. `supersedePriorActive(db, email, 'register')`.
5. `const {raw, hash} = await generateToken();`
6. `insertEmailVerification({ id: newId('ver'), purpose: 'register',
   email, display_name, token_hash: hash, expires_at: now + 1h, ... })`.
7. `c.executionCtx.waitUntil(sendMail(env, renderRegisterEmail({
   redeemUrl: buildRedeemUrl(env, raw), displayName: display_name })))`.
8. Return `202 { ok: true }`.

**B.2.3** `POST /v1/auth/recover`:
- Same rate-limit pattern (bucket key `'auth_recover'`, lower cap).
- Look up `tenants.owner_email = email AND deleted_at IS NULL`.
- If not found → still proceed to `return c.json({ok:true}, 202)` after
  inserting **no row, sending no email**. Constant-time return is fine
  here because we don't gate on the lookup result.
- If found → supersede prior `recover` tokens, generate, insert with
  `tenant_id` set, dispatch email, return 202.

**B.2.4** `POST /v1/auth/redeem`:
1. `const hash = await hashToken(token)`.
2. `const row = await findActiveByTokenHash(db, hash)`.
3. If null / `expires_at < now` / `consumed_at != null` → 410
   `TOKEN_EXPIRED`.
4. `const ok = await consumeIfUnconsumed(db, row.id);`
5. If `!ok` → 410 `TOKEN_ALREADY_USED` (lost the race).
6. Branch:
   - **register:** `insertTenant({id, display_name, owner_email})` →
     `insertNamespace({slug:'default', vector_backend: cfDefault})` →
     mint API key (mirror the `bootstrap.ts:134-141` pattern). On CF,
     also call `ensureBackingExists` for non-vectorize backends — for
     v1 we hardcode `vectorize` so this doesn't apply.
   - **recover:** mint API key for `tenant_id`. No tenant insert.
7. Return `200 RedeemResponse`. Set `cache-control: no-store` headers.

**B.2.5** Error handling: all `TextralError` instances flow through the
existing global error formatter. New codes get HTTP status mapping in
`error-catalog.ts`.

**B.2.6** Wire into `apps/api/src/index.ts`:

```ts
app.route('/v1/auth', authRoute);
```

Place it **before** the API-key middleware so it stays public.

**Exit criteria for B.2**
- `register.test.ts`: rate-limit trips at 6th call within 10 min;
  always 202; sendMail called exactly once per accepted call.
- `recover.test.ts`: unknown email → 202 + no DB row; known email → 202
  + row + email.
- `redeem.test.ts`:
  - happy path register → tenant + namespace + key minted; raw key
    present in body.
  - happy path recover → key minted; tenant unchanged.
  - expired token → 410 TOKEN_EXPIRED.
  - already-consumed token → 410 TOKEN_ALREADY_USED.
  - **double-click race**: two `Promise.all([redeem, redeem])` → exactly
    one 200, exactly one 410.
- All tests green on D1 (vitest-pool-workers) and Postgres (the
  existing `--node` test target).

---

### Step B.3 — OpenAPI components + tag wiring

**B.3.1** `apps/api/src/openapi/components.ts` — register the three
request/response schemas as components so they show up in Scalar with
named refs (mirrors how `ApiKeyCreateResponse` is registered).

**B.3.2** `apps/api/src/openapi/tag-descriptions.ts` — add:

```ts
'Auth': `**Self-service tenant registration and key recovery.** ...`
```

with a concrete example flow inline. The block belongs in the
**Onboarding** group of `TAG_GROUPS` (place it ahead of `API Keys`
since it's the prerequisite step).

**B.3.3** `routes/docs.ts` — make sure the Scalar bundle picks up the
new tag (no code change needed if `TAG_GROUPS` is the source of truth).

**Exit criteria for B.3**
- `GET /docs` renders the Auth tag with all three endpoints under it.
- The Scalar "Try it out" panel can hit `/v1/auth/register` against
  `wrangler dev`.

---

### Step B.4 — Error catalog + Scalar error display

**B.4.1** `apps/api/src/routes/error-catalog.ts` — add entries for the
four new codes, each with HTTP status, description, retriable boolean,
and an example response body.

**B.4.2** Verify the existing `__redaction_check.ts` test still passes —
new error messages must not leak email addresses or token contents.

**Exit criteria for B.4**
- Error catalog test green.
- Redaction check green.

---

### Step B.5 — Live verification (staging)

**B.5.1** Deploy `cloudflare_dep` to `textral-api-dev`. Set the two new
secrets:

```bash
wrangler secret put MAILGUN_API_KEY    --env dev
wrangler secret put RATE_LIMIT_IP_SALT --env dev
```

**B.5.2** From a curl shell:

```bash
curl -X POST https://textral-api-dev.workers.dev/v1/auth/register \
     -H 'content-type: application/json' \
     -d '{"email":"<your-real-inbox>","display_name":"Smoke Test"}'
# Expect: 202 {"ok":true}, an email arrives within ~10s
```

**B.5.3** Click the link in the email. The redeem URL points to the
sandbox (Phase C); for Phase B verification, manually extract the token
and POST:

```bash
curl -X POST https://textral-api-dev.workers.dev/v1/auth/redeem \
     -H 'content-type: application/json' \
     -d '{"token":"<extracted>"}'
# Expect: 200 with tenant + namespace + raw API key
```

**B.5.4** Use the returned key against `GET /v1/me` — expect 200 with
the new tenant.

**Exit criteria for B.5**
- Real inbox receives the email from `noreply@mg.alacrity.ai`.
- Redeem returns a usable key.
- That key authenticates `GET /v1/me`.

---

# Phase C — sandbox UI

The user-facing landing experience. Routing change is the biggest delta.

### Step C.1 — API client wrappers `api/auth.ts`

**C.1.1** New module:

```ts
export async function register(email: string, displayName: string): Promise<{ok: true}>;
export async function recover(email: string): Promise<{ok: true}>;
export async function redeem(token: string): Promise<RedeemResponse>;
```

Each calls `apiUrl('/v1/auth/...')` with `fetch` + JSON body. No API
key header. Throws on non-2xx with the parsed error body.

**C.1.2** Mirror `RedeemResponse` shape in `api/types.ts` (sandbox does
hand-typed contracts; same convention as `Tenant`, `Namespace`, etc.).

**Exit criteria for C.1**
- Type-check clean.
- Unit test against a stubbed `fetch` confirming the three URL +
  body shapes.

---

### Step C.2 — Routing changes in `App.tsx`

**C.2.1** Three new public routes, all **outside** `<ApiKeyGate>`:

```tsx
<Routes>
  <Route path="/redeem/:token" element={<Redeem />} />
  <Route path="/recover" element={<Recover />} />
  <Route
    path="/*"
    element={
      <ApiKeyGate publicLanding={<Landing />}>
        <Layout>{/* existing app */}</Layout>
      </ApiKeyGate>
    }
  />
</Routes>
```

`ApiKeyGate` is modified to render its `publicLanding` prop (instead of
the bare API-key input) when no key is set. This keeps the sign-in
surface inside the gate so all the localStorage/setKey wiring stays
identical.

**Exit criteria for C.2**
- Hot-reload of the dev server shows the new landing on `/`.
- Navigating to `/redeem/foo` while logged in still hits the redeem
  page (it doesn't get hijacked by the gate-walled subtree).

---

### Step C.3 — `pages/Landing.tsx`

**C.3.1** Tabbed layout. Reuses the Card/Input/Button components from
`components/ui/`. Two tabs:

- **Sign in** — verbatim copy of today's `ApiKeyGate` form (paste key →
  validate via `GET /v1/me` → setKey). Footer link "Forgot your key?"
  → navigates to `/recover`.
- **Register** — two-field form (email, display name). On submit:
  - `await register(email, displayName)`
  - swap to a "Check your email" success panel showing the email
    address, the "expires in 1 hour" hint, and a `[Resend]` button
    (calls `register()` again — server side it just supersedes the
    prior token).

**C.3.2** Tab state is purely local (`useState`); no URL persistence.
Default tab is "Sign in" (existing users hit it most).

**C.3.3** Aesthetic carry-over: same display-font headline, IBM Plex
Mono labels, ruled hr separator. Pure additive design — doesn't redo
the visual language, just extends it.

**Exit criteria for C.3**
- Both tabs render and submit successfully against `wrangler dev`.
- Visual review by the user (manual).

---

### Step C.4 — `pages/Redeem.tsx`

**C.4.1** Reads `:token` via `useParams()`. On mount: `await redeem(token)`.

**C.4.2** Render states:
- **Loading** — "Redeeming your link..."
- **Success** — large monospace block showing `raw` key with a copy
  button; warning callout: *"Save this somewhere safe — we will never
  show it again."*; primary CTA: "Continue to sandbox" → `setKey(raw);
  navigate('/')`.
- **Error 410** — "This link is invalid or has expired" + link back to
  `/`. Suggest registering again or using `/recover`.

**C.4.3** The success state also shows the tenant display_name and
default namespace slug as confirmation context.

**C.4.4** No retry button on success; the link is single-use, retrying
would 410.

**Exit criteria for C.4**
- All three states render.
- Copy button writes to clipboard.
- Continue → sandbox loads with the new key.

---

### Step C.5 — `pages/Recover.tsx`

**C.5.1** Single-field form (email). On submit:
- `await recover(email)`
- Always swap to the same success panel: "If an account exists for
  *email@...*, we sent a recovery link." (No oracle.)

**C.5.2** Footer link back to `/`.

**Exit criteria for C.5**
- Submitting an unknown email shows the success panel without leaking.
- Submitting a known email triggers the email; clicking it lands on
  `/redeem/:token`; redeem succeeds; new key works.

---

### Step C.6 — Visual polish pass

**C.6.1** Read the current `ApiKeyGate.tsx` styling and apply the same
tokens (`fonts`, `colors`, `spacing`, `radii`) consistently across
Landing / Redeem / Recover. The three new pages should feel
indistinguishable from the existing app aesthetic.

**C.6.2** Keyboard handling: Enter submits the active form on all three
pages. Escape on Redeem success copies the key (small power-user touch).

**C.6.3** Loading / error states use `Toast` (if it exists) or inline
red-tinted text via `colors.error`.

**Exit criteria for C.6**
- User-driven visual review. No "AI slop" feel — distinctive and
  consistent with the existing sandbox.

---

### Step C.7 — End-to-end manual run

**C.7.1** Deploy `cloudflare_dep` (Worker + Pages). Verify Worker
secrets + Pages env vars are set:
- Worker: `MAILGUN_API_KEY`, `RATE_LIMIT_IP_SALT`.
- Pages: `VITE_API_BASE` pointing at the dev Worker.

**C.7.2** From a fresh incognito window, navigate to the sandbox URL:
1. Click Register tab, enter email + name, submit.
2. Receive email at the inbox.
3. Click link → land on `/redeem/:token` → see API key → click Continue.
4. Land in the sandbox with the namespace `default` selectable.
5. Register a Voyage / OpenAI provider key. Ingest a small document.
   Run a query. End-to-end works.

**C.7.3** Recover flow:
1. Sign-out (clear localStorage). Go to `/recover`.
2. Enter the same email. Receive the recover email.
3. Click → land on `/redeem/:token` → mint a second API key.
4. Both keys work for `/v1/me`.

**C.7.4** Negative paths:
1. Click an expired link → see "invalid or expired".
2. Click the same link twice → first 200, second "invalid or expired".
3. Submit a malformed email on `/register` → inline validation error,
   no request issued.

**Exit criteria for C.7**
- All happy + negative paths green.
- User signs off (Slack message or PR comment).

---

## Cross-phase work

### Step X.1 — Self-host parity check

**X.1.1** Run the new tests against the Node runtime
(`pnpm test --filter @textral/api -- --node`). All pass.

**X.1.2** `make selfhost-up` + `make selfhost-migrate-up`. Hit
`POST /v1/auth/register` with `MAILGUN_API_KEY` unset — expect 202 +
console log of the would-be email.

**X.1.3** Set `MAILGUN_API_KEY` in `.env`, restart, retry — receive a
real email pointing at `http://localhost:5173/redeem/{token}`.

**X.1.4** Confirm `make seed-self-host` (admin bootstrap) still works
unchanged.

**Exit criteria for X.1**
- Three sub-cases pass; no regression in self-host.

---

### Step X.2 — Documentation updates

**X.2.1** `docs/QUICKSTART.md` — add a "Self-service registration"
section near the top: "Don't have an API key? Register a tenant at
`https://textral.alacrity.ai`."

**X.2.2** `docs/SELF_HOSTING.md` — document the new env vars and the
short-circuit behavior, plus a note that `/v1/admin/bootstrap` is still
supported for ops who want to mint tenants without email.

**X.2.3** `docs/API.md` — add an Auth subsection.

**X.2.4** `README.md` top-level — one new bullet under "What's new":
"Self-service tenant registration via email confirmation."

**Exit criteria for X.2**
- Markdown links resolve.
- Docs reviewed by user.

---

### Step X.3 — Sign-off + push

**X.3.1** Squash-merge into one commit per phase (A, B, C, X), each
with a `Co-Authored-By: Claude ...` footer following the standard
Textral convention.

**X.3.2** Push to `cloudflare_dep` (alongside the 10 prior commits).

**X.3.3** User opens the PR against `main` once all four phases are
merged into `cloudflare_dep`. Body cites the design doc + this
implementation doc.

**X.3.4** After merge, deploy to prod and confirm one external user
(the user's friend) can register end-to-end.

**Exit criteria for X.3**
- PR opened, reviewed, merged.
- Prod deploy verified by an external user.
- This implementation doc gets a `STATUS: shipped` line at the top.

---

## Risks + mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Mailgun credentials leaked into a log line | Low | Existing redaction middleware blocks the API key shape; the short-circuit log redacts recipient. Verify in `mailgun.test.ts`. |
| Email lands in spam | Medium | `mg.alacrity.ai` is verified by the user. SPF/DKIM/DMARC alignment confirmed at DNS level. Plain-text + HTML body raises deliverability score. |
| Token brute-force | Low | 256 bits of entropy. 1-hour TTL. No timing oracle (single redeem path uses a unique-indexed lookup). |
| Two registrations for the same email | Low | Supersession at register time + unique active token by `(email, purpose)` partial index. The latter token wins. |
| `TEXTRAL_PUBLIC_BASE` misconfigured → broken email links | Medium | Throw at `buildRedeemUrl` when missing in prod. Catch at register-time, return 503 `TENANT_REGISTRATION_DISABLED` with a clear operator message. |
| User registers, can't find email, registers 5 more times | Low | Rate-limit caps; 6th attempt 429s. The "resend" button on the success panel is just another `register()` call → benefits from supersession. |
| Friend tenant accumulates Vectorize / D1 quota against the operator | Medium | Free-plan default + future quota work tracked separately. Not blocked on this PR; document in README that all registrants share the operator's CF resources. |

---

## Out of scope / future work

- **Multi-user tenants** (invite a colleague to my tenant). Adds
  `users` + `tenant_users` + the existing invite mechanic. Same
  Mailgun + token plumbing.
- **Email change** ("I want to move my tenant to a different email").
  `PATCH /v1/me/owner-email` with a re-confirmation step. Trivial to
  add on top of this work.
- **Operator dashboard** showing register/recover volume, top emails,
  abuse signals. Wires off the existing AE metrics sink.
- **Disposable-domain blocklist** if abuse becomes real.
- **Auto-revoke other keys on recover** as a checkbox in the redeem UI.
- **Plan upgrade flow** (free → pro) — independent of this work, but
  needs the email anchor we're adding here.
