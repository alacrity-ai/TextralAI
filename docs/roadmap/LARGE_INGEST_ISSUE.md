# MCP Ingestion Doesn't Scale to Real Workloads

> **Status:** problem statement + proposal. Surfaced 2026-05-06 while
> trying to ingest the 66 markdown files under `./docs` into a
> `textral-docs` namespace via the MCP server.
> **Companion to:** `TEXTRAL_MCP_DESIGN.md`,
> `TEXTRAL_MCP_IMPLEMENTATION.md`.

---

## 1. Problem

The current `textral.ingest_file` MCP tool requires the file content
inline as a base64-encoded string in the `bytes` parameter:

```jsonc
{
  "namespace": "textral-docs",
  "title":     "1-DESIGN.md",
  "bytes":     "<base64 of the entire file>",   // required
  "embedding": { ... }
}
```

The tool description even calls this out explicitly:

> *"bytes: Base64-encoded file contents. **The MCP server never reads
> from the local filesystem.**"*

This is fine for a single small file. It breaks down hard the moment
either dimension grows:

### 1.1 Large single documents

A 60 KB markdown file → ~80 KB of base64 → has to be embedded *in the
tool-call JSON* the agent emits. For an LLM agent driving the MCP
server, that means:

- The base64 has to materialize as a literal string in the model's
  output (it's a tool-call arg, not a file reference).
- Reading the bytes back from disk into the conversation (so they can
  be inlined into the next tool call) hits the harness's per-tool-output
  size limit. In our case `cat file.b64` for a 60 KB markdown doc
  produced a 78 KB response that the harness truncated and persisted to
  a side-file the agent can't easily splice into a follow-up tool call.
- Every retry, every parallel call, every restart re-pays the same
  base64-in-context cost.

### 1.2 Many documents

The `./docs` tree has 66 markdown files totalling ~700 KB. Round-tripping
that through base64 + tool-call args is roughly **1 MB of literal
string** the agent has to emit. Best-case that's ~250 K tokens of
"useless ballast" — bytes the agent had on disk, base64-encoded, only
to hand them right back to a server running on the same machine.

Practically, it also forces a chatty 2-message-per-file dance:

1. `Bash: cat /tmp/<n>.b64` — read the base64 back into the conversation
2. `ingest_file({ bytes: "<that base64>" })` — paste it into the next
   tool call

…repeated 66 times, in batches small enough not to truncate, with the
agent losing context to base64 noise.

### 1.3 What this implies for agent UX

Right now an LLM agent **cannot** answer the obvious request:

> "Ingest the PDFs in `./contracts` into a `vendor-contracts`
> namespace."

— without writing a per-file shell loop, hitting tool-output limits,
and burning context. That's exactly the prompt
`docs/mcp/TEXTRAL_MCP_DESIGN.md §1` advertises as the flagship use
case. The current ingest tool can't deliver it.

---

## 2. Intent

We want MCP-driven ingestion to be a **first-class bulk operation**:

- An agent points at one or more files (or a directory, or a glob) on
  the filesystem the MCP server can see.
- The MCP server reads the bytes itself, runs them through the same
  `apps/api` ingest pipeline every other path uses, and returns
  per-file `document_id` / `version_id` / `job_id` results.
- The agent's context cost is O(file count × small-metadata), not
  O(total bytes × 1.33 base64).
- Large files don't need a separate "go fish for the bytes via Bash"
  ritual.

The contract should still be:

- The MCP layer is an **adapter, not a parallel implementation** —
  every ingest still goes through the canonical REST surface, so
  tenant scoping, profile resolution, idempotency, and audit all
  apply identically.
- Auditability is not weakened — every per-file result still
  references a real `IngestionJob`.

---

## 3. Proposed solution

A new tool, **`textral.ingest_local_paths`**, that takes filesystem
references instead of inline bytes, plus a small set of conventions.
The `_local_` infix is load-bearing: it tells both the agent and the
human operator that this tool only makes sense when the MCP server
shares a filesystem with the caller. In remote/HTTP MCP mode the tool
is either disabled or returns a clear capability error.

### 3.1 Architecture: MCP reads bytes, REST owns documents

Path semantics live in the MCP layer only:

```
MCP server (stdio, on the agent's host)
  ├── resolve realpath
  ├── allowlist + size + extension checks
  ├── read bytes from disk
  └── call canonical REST endpoints:
        POST /v1/namespaces/{ns}/documents       (register)
        POST /v1/documents/{id}/uploads          (presign — proxied)
        PUT   <upload-url>                        (bytes)
        POST /v1/documents/{id}/uploads/{u}/finalize
        POST /v1/documents/{id}/ingest
```

The Textral REST API never learns about local paths. Document, version,
job, idempotency, and audit semantics stay where they already live;
the MCP layer is purely a path-aware adapter on top.

### 3.2 Schema — discriminated union, no overlap

The request shape is a tagged union by `mode`. This eliminates
ambiguity ("what wins if `paths`, `glob`, and `entries` disagree?") and
makes per-tool autocomplete clean.

```ts
type IngestLocalPathsRequest =
  | {
      mode: "files";
      namespace: string;
      files: LocalFileEntry[];          // absolute paths, optional per-entry overrides
      defaults?: IngestDefaults;
      wait?: boolean;
      concurrency?: number;
      dry_run?: boolean;
      response_detail?: "summary" | "errors" | "full";
    }
  | {
      mode: "glob";
      namespace: string;
      root: string;                     // absolute, must be under allowlist
      patterns: string[];               // micromatch globs
      exclude?: string[];
      defaults?: IngestDefaults;
      wait?: boolean;
      concurrency?: number;
      dry_run?: boolean;
      response_detail?: "summary" | "errors" | "full";
    };

interface LocalFileEntry {
  path: string;                         // absolute
  title?: string;                       // overrides title_from
  doc_type?: string;
  metadata?: Record<string, unknown>;
}

interface IngestDefaults {
  doc_type?: string;                    // default: "markdown" (see §3.3)
  embedding: EmbeddingConfig;           // mirrors REST contract
  chunking?: ChunkingConfig;
  title_from?: "filename" | "relative_path" | "frontmatter";
  on_existing?: "skip_if_unchanged" | "new_version" | "replace_current";
}
```

### 3.3 Default `doc_type` is `"markdown"`, not `"passage"`

`passage` sounds like an artifact/chunk type, not a document type.
For repository docs the right defaults are:

```
doc_type:           "markdown"          // or "technical_documentation"
chunking.profile:   "technical"
artifact_types:     ["passage"]         // chunking handles passage-level semantics
```

Consumers can still override per-entry.

### 3.4 Idempotency: `on_existing` is explicit

Repeated agent attempts must be cheap and safe. The default mirrors
what the REST `/ingest` path already does on `(document_id, content_hash)`:

| value                | behaviour                                                           |
|----------------------|---------------------------------------------------------------------|
| `skip_if_unchanged`  | (default) hash matches an existing version → return that version, no new job |
| `new_version`        | always create a new version, even if content is unchanged           |
| `replace_current`    | new version + retire the previous one's vectors                     |

This makes "re-run the ingest after editing a few docs" the right
shape: only the changed files do work.

### 3.5 Concurrency is an explicit parameter, not implicit

The schema includes `concurrency` (default `4`, configured max
e.g. `16`). Without this, agents will try to parallelize at the
MCP-call level — defeating the entire reason the bulk tool exists.

### 3.6 Dry-run mode

`dry_run: true` returns what *would* be ingested without touching the
API or writing anything:

```jsonc
{
  "matched_count":     66,
  "total_size_bytes":  718336,
  "skipped": [
    { "path": "/abs/.../bin.jpg", "reason": "EXTENSION_NOT_ALLOWED" }
  ],
  "files": [
    { "path": "/abs/.../1-DESIGN.md", "size_bytes": 55220, "would_use": "skip_if_unchanged" }
  ]
}
```

Useful for debugging glob behaviour, agent self-checks ("matched 66
files under ./docs, proceeding"), and human confirmation flows.

### 3.7 Response shape — compact by default

For 66 files, full per-file detail is noisy. `response_detail`:

- `"summary"` (default): counts + a few per-status totals.
- `"errors"`: summary + only the failed entries.
- `"full"`: every per-file result with `document_id` / `version_id` /
  `job_id` / status.

Successful summary:

```jsonc
{
  "namespace":   "textral-docs",
  "matched":     66,
  "ingested":    63,
  "skipped":     2,
  "failed":      1,
  "duration_ms": 41203
}
```

`response_detail: "errors"` adds a `failures: [...]` array. `"full"`
adds a `results: [...]` array.

### 3.8 Path validation — resolve first, then check

Order matters. Validating a string prefix before `realpath`-ing the
target lets `..` / symlinks escape the allowlist. The pipeline is:

```
1. require absolute path
2. realpath(path)              # resolve symlinks
3. assert under allowlisted root
4. stat                        # exists, is regular file
5. extension policy (§3.9)
6. size policy (§3.9)
7. read
```

Symlinks pointing outside the allowlist are rejected with
`PATH_NOT_ALLOWED`, not silently followed.

### 3.9 File-type and size policy via config

Server-side config (env or `mcp.config.json`):

```
MCP_FS_INGEST                 = allow | deny | stdio_only   (default: stdio_only)
MCP_FS_INGEST_ROOTS           = /home/user/projects:/var/textral/sources
MCP_FS_INGEST_EXTENSIONS      = .md,.mdx,.txt,.json,.yaml,.yml,.pdf
MCP_FS_INGEST_MAX_FILE_BYTES  = 10485760     # 10 MiB
MCP_FS_INGEST_MAX_BATCH_BYTES = 524288000    # 500 MiB
```

`stdio_only` means the tool is registered when the server runs over
stdio (almost certainly co-located with the agent) and quietly absent
when it runs over HTTP. Per-file caps prevent a single huge document
from blocking a batch; the batch cap prevents `**/*` against a 10 GB
tree.

Beyond extension matching, MIME sniffing (libmagic / file(1)) gates
binary content — `.md` containing actual ELF bytes is rejected.

### 3.10 Streaming progress

For `wait=true` with N files, results stream back as MCP progress
notifications keyed on `job_id`, not as one giant blocking response.
Mirrors what single-file `ingest_file` already does per stage.

### 3.11 Why this is FS-safe

The existing `bytes`-only design exists for a reason — portable
(no FS assumption) and safe (no implicit file access). Both still hold:

- `ingest_local_paths` is **additive**. Inline `ingest_file` stays for
  clients that don't share a filesystem (remote / HTTP-mode MCP).
- Filesystem reads are the agent's intent, not the server's. The
  agent already has Bash/Read on the same FS — this only removes a
  token round-trip with no security upside.
- Defaulting `MCP_FS_INGEST=stdio_only` means HTTP MCP deployments
  *can't* enable this by accident; an operator has to flip it on
  explicitly.

### 3.12 Backward compatibility

`ingest_file` keeps working unchanged. Existing recipes, sandbox
flows, and tests do not migrate. Only agents that want bulk/local
behaviour adopt the new tool.

---

## 4. Out of scope for this proposal

- Web URL ingestion (`url: "https://…"`). Worth it eventually, but a
  separate concern: pulls in HTTP fetch, redirects, content-type
  sniffing, and rate-limiting. Should be its own tool
  (`ingest_url` / `ingest_urls`).
- Re-ingestion / version-bump batch operations against already-known
  `document_id`s. Useful but orthogonal — handled by a future
  `reingest_documents` tool that takes IDs, not paths.
- Chunked uploads of >> 100 MB files. The current pipeline doesn't
  support this anywhere; not an MCP-layer issue.

---

## 5. Canonical example

The shape an agent should be able to emit for the very prompt that
surfaced this issue:

```json
{
  "mode": "glob",
  "namespace": "textral-docs",
  "root": "/home/leif/textral/TEXTRAL_REFACTOR_WIP/docs",
  "patterns": ["**/*.md"],
  "exclude": ["**/node_modules/**"],
  "defaults": {
    "doc_type": "markdown",
    "chunking": { "profile": "technical" },
    "embedding": {
      "provider": "openai",
      "model": "text-embedding-3-large",
      "dimensions": 1536,
      "provider_key_ref": "default"
    },
    "title_from": "relative_path",
    "on_existing": "skip_if_unchanged"
  },
  "wait": true,
  "concurrency": 4,
  "dry_run": false,
  "response_detail": "errors"
}
```

## 6. Acceptance criteria

A concrete agent prompt that should work end-to-end without ad-hoc
shell glue once this lands:

> "Create a `textral-docs` namespace on Qdrant and ingest every `.md`
> file under `./docs`."

Expected behaviour:

1. One `create_namespace` call.
2. One `ingest_local_paths` call shaped like §5.
3. The agent gets back a compact summary (and any per-file errors).
4. Total agent context cost is dominated by the response, not by the
   request payload.
5. Re-running the same call after editing two files only does work
   for those two files (`skip_if_unchanged`).

If any of those steps still requires base64-shuttling the file
contents through the conversation, the fix isn't done.
