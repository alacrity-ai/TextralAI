# Python SDK (`textral` on PyPI)

We currently ship `@textral/contracts`, `@textral/sdk`, and `@textral/mcp` to npm. The TS surface is great if you're a TS shop. **It is also a hard ceiling.** The data-science and ML community lives in Python. Every prospect who asks "how do I integrate Textral into my pipeline?" and gets pointed at TS will quietly bounce.

A first-class Python SDK is table-stakes parity with Pinecone, Vectara, and the OpenAI/Anthropic SDKs.

## Why

- **Distribution.** PyPI is where the audience is. `pip install textral` is the install incantation 80% of evaluators expect.
- **Notebooks.** Jupyter / Colab / Databricks workflows want a Python client.
- **MLOps stacks.** Airflow, Prefect, Dagster — Python-native. Glueing TS into these is friction.
- **Eval pipelines.** Anyone running ground-truth evaluation against Textral will write Python by default.

## Scope

In:
- `textral` package on PyPI; mirror `@textral/sdk` surface 1:1.
- Both sync and async clients (`Client` + `AsyncClient`), httpx-based.
- Pydantic v2 models for every contract type (mirror `@textral/contracts`).
- `~/.textral/profiles.toml` reading parity with the MCP, so the SDK can switch profiles the same way.
- Type stubs that pass `mypy --strict`.

Out (for v1):
- Python MCP server. The Node MCP is canonical; a Python one is a separate roadmap item if demand emerges.
- Rich CLI (`textral query "..."`). Possible v2 — out of scope here.

## Sketch

- New package directory: `packages/sdk-python/` (Hatch or Poetry; pyproject.toml; src layout).
- Generate Pydantic models from contracts. Two paths:
  1. Hand-mirror — easier short-term, drift risk long-term.
  2. JSON Schema export from `@textral/contracts` Zod → `datamodel-code-generator` → Pydantic. More setup, lower drift.
  Recommendation: option 2, with a CI check that fails the build if the generated models drift from the source.
- httpx client; pluggable transport for tests; retry/backoff matching the TS SDK's behavior.
- Streaming query (`client.query.stream(...)`) returns an async iterator over server-sent events.
- Profile resolver: same precedence chain as MCP (env vars → profiles.toml → flags).

## Acceptance Criteria

- `pip install textral` from PyPI works.
- `from textral import Client; c = Client(profile="hosted-dev"); c.namespaces.list()` works against `~/.textral/profiles.toml`.
- 100% surface parity with `@textral/sdk@latest` (every method, every option).
- Async equivalents for every sync method.
- mypy strict + py.typed marker.
- README in PyPI with the same depth as `@textral/sdk`'s README.
- Releases lockstep with TS packages (same version number; one bump-and-publish flow).

## Open Questions

- **Codegen vs hand-maintained?** Codegen is sturdier; hand-maintained is faster to ship v1.
- **Is `textral` available on PyPI?** Need to confirm. `textral-ai` and `textral-py` are fallbacks but lose discoverability.
- **Pydantic v1 fallback?** Many enterprise stacks are still on v1. Probably not worth it for a fresh SDK; require v2.
- **Where does the Python release live in the runbook?** `docs/runbooks/MCP_RELEASE.md` covers npm; Python publish is a separate ritual that needs documenting.

## Related

- [`docs/runbooks/MCP_RELEASE.md`](../runbooks/MCP_RELEASE.md) — TS publish runbook; Python parallel needed.
- [`EVAL_AS_A_SERVICE.md`](./EVAL_AS_A_SERVICE.md) — eval pipelines will be the first big consumer.
