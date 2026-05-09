# Cookbook (Python)

Each example is a complete, runnable script. Set
`TEXTRAL_API_KEY` (or `TEXTRAL_PROFILE`) and `TEXTRAL_NAMESPACE`
(default: `cookbook`).

```bash
export TEXTRAL_API_KEY="tx_live_..."
python 01_quick_start.py
```

| File | Concept | Outline § |
|---|---|---|
| `01_quick_start.py` | One query, one cited answer | §2 |
| `02_ingest_and_query.py` | Single-file ingest pipeline | §3 |
| `03_bulk_ingest.py` | Bulk orchestrator | §4 |
| `04_streaming.py` | SSE streaming (async) | §5 |
| `05_profiles.py` | `~/.textral/profiles.toml` | §6 |
| `06_retry_and_cancel.py` | Retry policy + cancellation | §7 |
| `07_paginate_events.py` | Pagination iterators | §8 |

Sample data lives under `data/` — public-domain texts on the
Library of Alexandria. The same files seed the Node cookbook;
the corpus is shared, the SDKs are separate.

For the full cookbook spec see
[`SDK_COOKBOOK_OUTLINE.md`](../../../docs/development/sdks/SDK_COOKBOOK_OUTLINE.md).

## Seeding the namespace

Examples 01, 04, 06, and 07 query against a populated namespace.
Run `03_bulk_ingest.py` once to seed the `cookbook` namespace
with the 4 markdown files in `data/`. Subsequent runs are cheap —
`on_existing="skip_if_unchanged"` makes them no-op.
