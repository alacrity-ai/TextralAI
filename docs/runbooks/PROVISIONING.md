# PROVISIONING — Cloudflare resource setup

> One-time per environment. Run these commands as a Cloudflare account
> admin. After each command, paste the printed UUIDs / IDs into
> `apps/api/wrangler.toml` where marked `<PASTE_..._HERE>`.

---

## Prerequisites

- Workers Paid plan on the account (Containers + Vectorize V2 require it).
- `npx wrangler login` already run.
- The user running these commands has permission to create D1 / R2 /
  Queues / Vectorize / KV / Secrets Store / AI Gateway.

---

## 0. Pick an environment

```bash
export ENV=dev    # or prod for prod
```

The naming convention is fixed: every resource is suffixed with the env.

---

## 1. D1

```bash
npx wrangler d1 create "textral-${ENV}"
# → prints database_id (UUID). Paste into wrangler.toml.
```

Verify:
```bash
npx wrangler d1 list
```

---

## 2. R2

```bash
npx wrangler r2 bucket create "textral-blobs-${ENV}"
```

Verify:
```bash
npx wrangler r2 bucket list
```

---

## 3. Queues

Both the main ingestion queue and its DLQ. The DLQ name MUST end in
`-dlq` (matches the wrangler.toml `dead_letter_queue` reference).

```bash
npx wrangler queues create "textral-ingest-${ENV}"
npx wrangler queues create "textral-ingest-${ENV}-dlq"
```

Verify:
```bash
npx wrangler queues list
```

---

## 4. Vectorize

Phase 1 provisions one index — the OpenAI 3-large profile (3072 dim).
Additional embedding-profile indexes get created during Phase 5
alongside their corpus profiles.

```bash
INDEX="textral-${ENV}-openai-text-embedding-3-large-3072-cosine"

npx wrangler vectorize create "$INDEX" --dimensions=3072 --metric=cosine

# Pre-declare metadata indexes. These are filterable at query time and
# CANNOT be added later without recreating the index. We declare all
# five up front. (Limit is 10 per index; we have 5 free for future use.)
for prop in tenant_id namespace_id document_id version_id artifact_type; do
  npx wrangler vectorize create-metadata-index "$INDEX" \
    --property-name="$prop" --type=string
done
```

Verify:
```bash
npx wrangler vectorize list
npx wrangler vectorize list-metadata-index "$INDEX"
# → 5 metadata indexes listed
```

---

## 5. KV (tenant cache)

```bash
npx wrangler kv namespace create "textral-cache-${ENV}"
# → prints namespace id. Paste into wrangler.toml.
```

---

## 6. Secrets Store

```bash
npx wrangler secrets-store store create "textral-secrets-${ENV}"
# → prints store id. Paste into wrangler.toml.
```

Then put the API-key pepper (a 32-byte random hex string, different
per env):

```bash
PEPPER=$(openssl rand -hex 32)

npx wrangler secrets-store secret put api-key-pepper \
  --store "textral-secrets-${ENV}" \
  --value "$PEPPER"

# Save $PEPPER somewhere out-of-band ONLY if you need to validate
# behavior locally; otherwise discard it. The Worker fetches it at
# runtime via the binding.
```

Verify:
```bash
npx wrangler secrets-store secret list --store "textral-secrets-${ENV}"
# → contains api-key-pepper
```

---

## 7. AI Gateway

Created via the dashboard for now (no first-class wrangler command yet):

1. Cloudflare dashboard → **AI** → **AI Gateway** → **Create Gateway**.
2. Name: `textral-${ENV}`.
3. Authentication: off (we add an authenticated gateway later).

The gateway URL takes the form:
```
https://gateway.ai.cloudflare.com/v1/{ACCOUNT_ID}/textral-${ENV}/{provider}/...
```

Note the `ACCOUNT_ID` and gateway name (`textral-${ENV}`) — both go in
`apps/api/wrangler.toml` under `[env.${ENV}.vars]`.

---

## 8. Container application

Containers are provisioned the first time `wrangler deploy` runs with
a `[[env.X.containers]]` block. There's nothing to do here pre-deploy
except confirm the image builds locally:

```bash
make build-ingest
```

Then deploy:

```bash
make push-ingest
make deploy-${ENV}
```

The first deploy creates the Container application named
`textral-ingest` (Workers Paid required).

---

## 9. Bootstrap token (Worker secret)

Set the one-time admin bootstrap token used by `make seed-dev`:

```bash
make secret-put-${ENV} NAME=ADMIN_BOOTSTRAP_TOKEN
# Paste a 32-char random value when prompted.
```

After seeding, rotate or delete this secret (it's only needed for
the very first tenant creation).

---

## 10. End-to-end verification

```bash
make migrate-${ENV}                      # apply 0001_baseline.sql
make deploy-${ENV}

curl https://textral-api-${ENV}.<your-subdomain>.workers.dev/healthz
# → {"status":"ok",...}

curl https://textral-api-${ENV}.<your-subdomain>.workers.dev/dev/ingest-ping
# (dev only) round-trips through Container; first call may take 5–10 s
# (cold start), subsequent calls < 200 ms.
```

If any of these fail, inspect:
```bash
npx wrangler tail textral-api-${ENV} --env ${ENV}
```

---

## 12. Token permissions (combined-token deploy)

`wrangler deploy` validates every binding's permissions against ONE
token in a single API call — fan-out auth doesn't work. For full
deployment, mint a single API token with these permissions:

```
Account:
  Workers Scripts:        Edit       (deploy + secret put)
  Workers KV Storage:     Edit       (KV namespace bindings)
  D1:                     Edit       (D1 bindings + migrations)
  Workers R2 Storage:     Edit       (R2 bindings)
  Queues:                 Edit       (queue producer/consumer bindings)
  Vectorize:              Edit       (Vectorize bindings)
  Workers AI:             Edit       (AI binding)
  AI Gateway:             Edit       (per-tenant tag routing in Phase 2)
  Workers Containers:     Edit       (Container binding + DO migration)
  Cloudchamber:           Edit       (Container build + image registration; may be folded
                                       into Workers Containers depending on dashboard rollout)
```

**Account Resources**: scope to your single account — not "All accounts."

This is the AI token in `tools/wrangler-env.sh`; the env-loader sources
it as `CLOUDFLARE_API_TOKEN` by default. The earlier "primary" token is
kept as a backup but is missing Containers/Cloudchamber, so it can't
deploy the Container binding.

## 11. Capturing IDs for the wrangler.toml

After all the steps above, you'll have these IDs in hand:

| Variable | From command | Goes into |
|---|---|---|
| D1 database_id | step 1 | `[[env.X.d1_databases]] database_id` |
| KV id | step 5 | `[[env.X.kv_namespaces]] id` |
| Secrets Store id | step 6 | `[[env.X.secrets_store_secrets]] store_id` |
| Cloudflare account_id | dashboard right-sidebar | `[env.X.vars] CF_ACCOUNT_ID` |
| AI Gateway id | step 7 | `[env.X.vars] AI_GATEWAY_ID` |

The wrangler.toml has each location marked with a `<PASTE_..._HERE>`
placeholder; search the file for that string.

Once filled in, commit the IDs (they're not secrets — they're public
binding identifiers).
