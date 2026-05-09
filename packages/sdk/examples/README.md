# Cookbook

Each example is a complete, runnable script. Set
`TEXTRAL_API_KEY` (or `TEXTRAL_PROFILE`) and `TEXTRAL_NAMESPACE`
(default: `cookbook`).

```bash
export TEXTRAL_API_KEY="tx_live_..."
npx tsx 01-quick-start.ts
```

| File | Concept | Outline § |
|---|---|---|
| `01-quick-start.ts` | One query, one cited answer | §2 |
| `02-ingest-and-query.ts` | Single-file ingest pipeline | §3 |
| `03-bulk-ingest.ts` | Bulk orchestrator | §4 |
| `04-streaming.ts` | SSE streaming | §5 |
| `05-profiles.ts` | `~/.textral/profiles.toml` | §6 |
| `06-retry-and-cancel.ts` | Retry policy + cancellation | §7 |
| `07-paginate-events.ts` | Pagination iterators | §8 |

Sample data lives under `data/` — public-domain texts on the
Library of Alexandria.

For the full cookbook spec see
[`SDK_COOKBOOK_OUTLINE.md`](../../../docs/development/sdks/SDK_COOKBOOK_OUTLINE.md).

## Seeding the namespace

Examples 01, 04, 06, and 07 query against a populated namespace.
Run `03-bulk-ingest.ts` once to seed the `cookbook` namespace with
the 4 markdown files in `data/`. Subsequent runs are cheap —
`on_existing: skip_if_unchanged` makes them no-op.
