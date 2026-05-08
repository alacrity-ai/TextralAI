// Hand-authored explanations for every error code in the catalog.
// Generated into a markdown table for the docs landing page (D5).
//
// When you add a code to packages/contracts/src/error.ts, add an entry
// here too — the docs regression test pins that the two stay in sync.

export interface ErrorMeta {
  /** Default HTTP status the throw site uses. Some codes appear at
   *  multiple statuses; document the typical one. */
  http: number;
  /** When this fires, in one sentence. */
  when: string;
  /** Recovery action, in one sentence (or empty if user-actionable
   *  is not applicable). */
  recovery: string;
}

export const ERROR_CATALOG: Record<string, ErrorMeta> = {
  INTERNAL: {
    http: 500,
    when: 'Unhandled error escaped a route handler.',
    recovery: 'Capture the request_id; report to the operator.',
  },
  NOT_FOUND: {
    http: 404,
    when: 'Generic resource not found (or not visible to your tenant).',
    recovery: 'Verify the id; cross-tenant probes also return 404 by design.',
  },
  BAD_REQUEST: {
    http: 400,
    when: 'Request body or path parameter failed validation.',
    recovery: 'Inspect `details.issues`; fix the malformed field.',
  },
  INVALID_API_KEY: {
    http: 401,
    when: 'Missing `X-Textral-Api-Key` header, or the key is invalid/revoked.',
    recovery: 'Paste your key into the auth field above; rotate via your operator if revoked.',
  },
  TENANT_NOT_FOUND: {
    http: 404,
    when: 'Tenant id does not resolve.',
    recovery: 'Verify the tenant id with your operator.',
  },
  NAMESPACE_NOT_FOUND: {
    http: 404,
    when: 'Namespace slug not found in the calling tenant.',
    recovery: 'Create with `POST /v1/namespaces`, or check spelling.',
  },
  NAMESPACE_ALREADY_EXISTS: {
    http: 409,
    when: 'Slug or eval-set name conflict on insert.',
    recovery: 'Pick a different slug/name, or fetch the existing resource.',
  },
  NAMESPACE_DIMENSION_MISMATCH: {
    http: 400,
    when: "Ingest requested an embedding dim different from the namespace's locked `embedding_dimensions`.",
    recovery: "Embed at the namespace's locked dim, or create a new namespace with the dim you need (locked at create time, immutable).",
  },
  JOB_NOT_RUNNING: {
    http: 409,
    when: 'Cancel was attempted on a job that is already in a terminal state (completed/failed/cancelled).',
    recovery: 'No action needed — the job is no longer running. Inspect via `GET /v1/ingestion-jobs/{id}`.',
  },
  JOB_CANCELLED: {
    http: 409,
    when: 'A stage-attempt write was attempted against a job that the user already cancelled. The runner exits cleanly on the next stage boundary.',
    recovery: 'No action needed — the cancellation is taking effect.',
  },
  PROVIDER_KEY_NOT_FOUND: {
    http: 404,
    when: '`provider_key_ref` (label) or `provider_key_id` does not match a registered key.',
    recovery: 'Register the key via `POST /v1/provider-keys`, or list with `GET /v1/provider-keys`.',
  },
  INFRA_KEY_NOT_FOUND: {
    http: 400,
    when: 'A namespace operation needs the tenant\'s infra key (e.g. Pinecone) but no active key is registered.',
    recovery: 'Register one with `POST /v1/infra-keys` (provider=pinecone, label=default).',
  },
  INFRA_KEY_ALREADY_REGISTERED: {
    http: 409,
    when: 'An active infra key already exists for this (tenant, provider). KISS rule: at most one active per backend.',
    recovery: 'Revoke the existing one first (`DELETE /v1/infra-keys/{id}`), then re-register.',
  },
  PROVIDER_KEY_INVALID: {
    http: 422,
    when: 'Upstream rejected your BYOK key (revoked, malformed, wrong scope).',
    recovery: 'Rotate the key upstream; re-register with `POST /v1/provider-keys`.',
  },
  PROVIDER_KEY_VALIDATION_FAILED: {
    http: 200,
    when: 'The provider-key validation probe (`/test`) returned non-OK.',
    recovery: 'See the validation response; fix the key upstream.',
  },
  PROVIDER_QUOTA_EXHAUSTED: {
    http: 422,
    when: 'Upstream returned a quota/billing-exhausted error (e.g. OpenAI 429 with `insufficient_quota`).',
    recovery: 'Top up the upstream account or rotate to a different BYOK.',
  },
  PROVIDER_RATE_LIMITED: {
    http: 503,
    when: 'Upstream rate-limited the call (transient).',
    recovery: 'Retry with backoff; reduce QPS.',
  },
  PROVIDER_TIMEOUT: {
    http: 503,
    when: 'Upstream call exceeded the timeout budget.',
    recovery: 'Retry; investigate provider status if persistent.',
  },
  PROVIDER_UNAVAILABLE: {
    http: 503,
    when: 'Upstream returned 5xx or a network error.',
    recovery: 'Retry; check the provider status page.',
  },
  PROVIDER_REFUSAL: {
    http: 422,
    when: 'Upstream model refused the request (content policy).',
    recovery: 'Adjust the prompt; check the provider\'s policy.',
  },
  PROVIDER_MALFORMED_RESPONSE: {
    http: 502,
    when: 'Upstream returned a response that violates the provider contract (missing usage, partial batch, etc.).',
    recovery: 'Retry; investigate the provider if persistent.',
  },
  PROVIDER_UNSUPPORTED_MODEL: {
    http: 400,
    when: 'The selected provider has no implementation for the requested capability (e.g. embedding on a chat-only provider).',
    recovery: 'Pick a model the provider supports.',
  },
  CONTEXT_LENGTH_EXCEEDED: {
    http: 400,
    when: 'Synthesis input exceeds the model\'s context window.',
    recovery: 'Reduce `context.max_context_tokens`, or pick a larger-context model.',
  },
  DOCUMENT_NOT_FOUND: {
    http: 404,
    when: 'Document id does not resolve in the calling tenant.',
    recovery: 'Verify the id; check `GET /v1/namespaces/{slug}/documents`.',
  },
  DOCUMENT_VERSION_NOT_FOUND: {
    http: 404,
    when: 'Version id does not resolve.',
    recovery: 'Verify the id; finalize an upload to create one.',
  },
  UPLOAD_VALIDATION_FAILED: {
    http: 400,
    when: 'Finalize-time mismatch: actual size/content-type differs from declared.',
    recovery: 'Re-upload with matching declared metadata.',
  },
  UPLOAD_INTENT_NOT_FOUND: {
    http: 404,
    when: '`upload_id` does not resolve, or the intent has been consumed.',
    recovery: 'Re-presign via `POST /v1/documents/{id}/uploads`.',
  },
  INDEX_ALREADY_BUILT: {
    http: 409,
    when: 'Conflicting concurrent index build for the same `(version_id, profiles)`.',
    recovery: 'Poll the existing job instead of dispatching a new one.',
  },
  INGESTION_IN_PROGRESS: {
    http: 409,
    when: 'A pending/running job already exists for this `version_id`.',
    recovery: 'Wait for completion or call retry on the existing job.',
  },
  INGESTION_FAILED: {
    http: 500,
    when: 'A required ingestion stage failed terminally.',
    recovery: 'Check the job\'s `error_code` + stage attempts; retry after fixing the upstream issue.',
  },
  UNSUPPORTED_CHUNK_JSONL_SCHEMA: {
    http: 400,
    when: 'Container produced a chunks JSONL row whose schema the Worker does not recognize.',
    recovery: 'Operator: check Container ↔ Worker contract drift.',
  },
  EMBEDDING_PROFILE_MISMATCH: {
    http: 400,
    when: 'Query\'s embedding profile (model + dimensions) or chunking profile doesn\'t match what this namespace was ingested with.',
    recovery: 'Inspect `details.available[]` for the indexed (chunking_profile, embedding_profile) pairs; re-query with a matching pair or re-ingest under the requested profile. `details.dimension` indicates which dimension (embedding/chunking/both) failed.',
  },
  RETRIEVAL_FAILED: {
    http: 500,
    when: 'Both retrieval arms (dense + sparse) failed.',
    recovery: 'Check Vectorize + D1 health.',
  },
  SYNTHESIS_FAILED: {
    http: 500,
    when: 'The synthesis call failed terminally; query degraded to `cannot_answer`.',
    recovery: 'Inspect `audit.synthesis_status`; rotate the inference key if applicable.',
  },
  EMPTY_QUERY: {
    http: 400,
    when: 'Query body has an empty `query` string.',
    recovery: 'Provide a non-empty question.',
  },
  QUERY_RESPONSE_UNAVAILABLE: {
    http: 410,
    when: 'The query_event row exists but the mirrored answer is gone (failed query, mirror_error, or reaped blob).',
    recovery: 'Inspect the row\'s `error_code`/`mirror_error`; re-run the query if the data is still relevant.',
  },
  UNKNOWN_CORPUS_PROFILE: {
    http: 400,
    when: '`corpus_profile` is not one of the shipped profiles.',
    recovery: 'Use one of: generic, narrative, legal, support, technical.',
  },
  ENRICHMENT_PASS_FAILED: {
    http: 500,
    when: 'A required enrichment pass failed (optional passes are recorded in `enrichment_status` instead).',
    recovery: 'Inspect the job\'s stage attempts; rotate the inference key if it\'s the cause.',
  },
  INPUT_TOO_LARGE_FOR_PASS: {
    http: 400,
    when: 'A document-scope pass\'s input exceeded `max_input_tokens` and `oversize_strategy=fail` triggered.',
    recovery: 'Switch to `oversize_strategy=truncate` or `map_reduce` in the profile/request.',
  },
  INTERNAL_AUTH_REQUIRED: {
    http: 401,
    when: 'Internal back-channel call missing the HMAC signature/timestamp.',
    recovery: 'Operator: should never appear at consumer level.',
  },
  INTERNAL_TIMESTAMP_OUT_OF_WINDOW: {
    http: 401,
    when: 'HMAC timestamp older than 5 minutes.',
    recovery: 'Operator: clock-sync the Container.',
  },
  INTERNAL_SIGNATURE_INVALID: {
    http: 401,
    when: 'HMAC signature mismatch.',
    recovery: 'Operator: verify `INTERNAL_HMAC_SECRET` is mirrored into the Container.',
  },
  INTERNAL_OWNERSHIP_MISMATCH: {
    http: 403,
    when: 'Internal call body claims a `tenant_id` the loaded job does not own.',
    recovery: 'Operator: should never appear at consumer level.',
  },
  DLQ_NOT_FOUND: {
    http: 404,
    when: 'Retry target job not visible to the calling tenant.',
    recovery: 'Verify the job id; cross-tenant probes return 404 by design.',
  },
  DLQ_NOT_DEAD_LETTERED: {
    http: 400,
    when: 'Retry called on a job that isn\'t in dead-letter state.',
    recovery: 'Only DLQ\'d jobs (`dead_lettered=1`) can be retried.',
  },
  ADMIN_RATE_LIMITED: {
    http: 429,
    when: 'Admin batch endpoint exceeded the per-minute cap (10/min).',
    recovery: 'Wait one minute or split the batch.',
  },
  INSUFFICIENT_SCOPE: {
    http: 403,
    when: 'API key authenticated but lacks the required scope (e.g. `admin`).',
    recovery: 'Rotate to a key with the right scope.',
  },
  STREAM_INTERRUPTED: {
    http: 200,
    when: 'SSE stream surfaced as `done` with `synthesis_status=failed` (mid-stream upstream failure).',
    recovery: 'Re-issue the query; treat as transient.',
  },
  EVAL_SET_NOT_FOUND: {
    http: 404,
    when: 'Eval set id not found in the namespace.',
    recovery: 'Register with `POST /v1/namespaces/{slug}/eval-sets`.',
  },
  EVAL_QUESTION_NOT_FOUND: {
    http: 404,
    when: 'Eval question id not found in the set.',
    recovery: 'List the set to verify question ids.',
  },
  EVAL_RUN_NOT_FOUND: {
    http: 404,
    when: 'Eval run id not found.',
    recovery: 'List runs with `GET .../runs`.',
  },
  EVAL_RUN_FAILED: {
    http: 500,
    when: 'Eval runner crashed before completing all questions.',
    recovery: 'Re-run; check inference-key validity.',
  },
  EVAL_JUDGE_FAILED: {
    http: 500,
    when: 'A judge\'s LLM call returned malformed JSON or out-of-range score.',
    recovery: 'Re-run; check inference-key + model.',
  },
  NOT_IMPLEMENTED: {
    http: 501,
    when: 'Phase-stub endpoint not yet wired.',
    recovery: 'Should not appear in MVP.',
  },
  TOKEN_EXPIRED: {
    http: 410,
    when: '`/v1/auth/redeem` called with a token whose `expires_at` is in the past, or no row matches the supplied token at all (stale-link / typo / supersession).',
    recovery: 'Request a fresh email via `/v1/auth/register` (new tenants) or `/v1/auth/recover` (existing tenants). Tokens live 1 hour.',
  },
  TOKEN_ALREADY_USED: {
    http: 410,
    when: '`/v1/auth/redeem` called twice with the same token. The first call already minted the API key; the second loses the atomic single-use race.',
    recovery: 'The previous call returned the raw API key — that key is the only artifact. If lost, request a recovery email via `/v1/auth/recover`.',
  },
  TENANT_REGISTRATION_DISABLED: {
    http: 503,
    when: '`MAILGUN_API_KEY` / `MAILGUN_DOMAIN` / `TEXTRAL_PUBLIC_BASE` are unset on a `prod` deploy. The route can\'t deliver a usable confirmation email.',
    recovery: 'Operator: set the three Worker secrets/vars (see `docs/runbooks/DEPLOY.md`). For self-host without Mailgun, mint tenants via `/v1/admin/bootstrap` instead.',
  },
  RATE_LIMITED: {
    http: 429,
    when: 'Public auth endpoint (`/v1/auth/register` or `/v1/auth/recover`) exceeded the per-IP per-minute cap.',
    recovery: 'Wait one minute and retry; the limit is intentionally tight (5/min for register, 3/min for recover).',
  },

  // ── Bulk ingest ────────────────────────────────────────────────────
  BULK_TOO_MANY_FILES: {
    http: 413,
    when: 'Bulk manifest exceeded the 1000-files-per-job cap.',
    recovery: 'Submit multiple smaller bulk jobs. >1000-file workflows are on the roadmap (`bulk_job_group_id`).',
  },
  BULK_BYTES_EXCEEDED: {
    http: 413,
    when: 'Bulk manifest aggregate size exceeded the 5 GB-per-job cap.',
    recovery: 'Submit multiple smaller bulk jobs. Per-file cap remains 25 MB.',
  },
  BULK_DUPLICATE_FILENAMES_IN_JOB: {
    http: 400,
    when: 'Two or more files in the same manifest declared the same `filename`.',
    recovery: 'Make filenames unique within a single bulk job. Resubmit.',
  },
  BULK_DIMENSION_LOCK_MISMATCH: {
    http: 409,
    when: 'Manifest embedding dimensions conflict with the namespace dim-lock.',
    recovery: 'Ingest into a namespace whose `embedding_dimensions` matches your config, or create a new namespace at the right dim.',
  },
  BULK_NAMESPACE_NOT_FOUND: {
    http: 404,
    when: 'Manifest references a namespace slug not visible to the caller.',
    recovery: 'Create the namespace via `POST /v1/namespaces` first; verify the slug is correct.',
  },
  BULK_PROVIDER_KEY_NOT_FOUND: {
    http: 400,
    when: 'Manifest references a `provider_key_ref` (or `provider_key_id`) that doesn\'t resolve for this tenant.',
    recovery: 'Register the provider key via `POST /v1/provider-keys`, or pass the existing key\'s id.',
  },
  BULK_QUOTA_EXCEEDED: {
    http: 429,
    when: 'Tenant has 10 active bulk jobs already; the limit blocks new submissions.',
    recovery: 'Cancel a stuck job or wait for an existing one to terminate.',
  },
  BULK_DUPLICATE_REQUEST_ID_DIFFERENT_MANIFEST: {
    http: 409,
    when: '`client_request_id` reused within 24h with a different file set.',
    recovery: 'Use a fresh `client_request_id` for distinct manifests; same id only for retries of the same manifest.',
  },
  BULK_JOB_NOT_FOUND: {
    http: 404,
    when: 'No bulk job exists for the given `bulk_job_id` (or it isn\'t visible to the caller).',
    recovery: 'Verify the `bulk_job_id`. Expired or cancelled jobs are listable via `GET /v1/ingest/bulk?state=expired`.',
  },
  BULK_JOB_TERMINAL: {
    http: 409,
    when: 'Operation requires a non-terminal bulk job; current state is `cancelled` / `expired` / etc.',
    recovery: 'Submit a new bulk job for the same files.',
  },
  BULK_JOB_HAS_SUCCEEDED_FILES: {
    http: 409,
    when: '`DELETE /v1/ingest/bulk/{id}` refuses because at least one file already succeeded.',
    recovery: 'For audit cleanliness, cancellation must be all-or-nothing. Submit a new job for the remaining files; do not cancel.',
  },
  BULK_JOB_CANCELLED: {
    http: 200,
    when: 'Per-file terminal cause when the bulk job was cancelled before this file finished.',
    recovery: 'Resubmit the file in a new bulk job.',
  },
  BULK_FILE_NOT_FOUND: {
    http: 404,
    when: 'Per-file ordinal doesn\'t exist on the bulk job.',
    recovery: 'Verify the `ordinal` from the original submit response.',
  },
  BULK_FILE_HASH_MISMATCH: {
    http: 400,
    when: 'PUT body size differs from the declared `size_bytes` on the manifest entry.',
    recovery: 'Re-PUT with the correct bytes, or submit a new manifest with the correct size.',
  },
  BULK_FILE_UPLOAD_EXPIRED: {
    http: 410,
    when: 'Per-file upload URL expired (7 days from issue) or R2 tmp object disappeared.',
    recovery: 'Submit a new bulk job; the new manifest will issue fresh upload URLs.',
  },
  BULK_FILE_UPLOAD_INVALID_STATE: {
    http: 400,
    when: 'PUT received against a file row not in `pending` state.',
    recovery: 'A successful upload is single-shot. To replace bytes, use `POST /v1/ingest/bulk/{id}/retry` after marking the file failed.',
  },
  BULK_FILE_FORMAT_UNSUPPORTED: {
    http: 415,
    when: 'A file\'s declared (or detected) content-type isn\'t supported by the chunker.',
    recovery: 'Convert to a supported format (Markdown, PDF, plain text). Roadmap: more formats via the connector marketplace.',
  },
  BULK_FILE_PROVIDER_THROTTLED: {
    http: 429,
    when: 'Per-file ingestion failed because the embedding provider rate-limited the queue.',
    recovery: 'Retry the failed files via `POST /v1/ingest/bulk/{id}/retry`. Consider raising your provider\'s rate cap.',
  },
  BULK_FILE_FINALIZE_FAILED: {
    http: 500,
    when: 'Per-file finalize raised an unexpected error (R2 read, hash compute, document insert, or version insert).',
    recovery: 'Check `error_detail` on the file row. Retry via `POST /v1/ingest/bulk/{id}/retry`.',
  },
  BULK_FILE_INGEST_FAILED: {
    http: 500,
    when: 'Per-file ingestion job terminated `failed`; surfaces the underlying ingestion `error_code`.',
    recovery: 'Check `error_detail`. Retry via `POST /v1/ingest/bulk/{id}/retry` once the underlying issue is resolved.',
  },

  // ── Ingestion job auto-recovery ────────────────────────────────────
  INGEST_LEASE_RECOVERY_EXHAUSTED: {
    http: 500,
    when: 'The lease-recovery cron auto-requeued a stuck ingestion job 3 times in a row without it completing — likely a poison message or persistent Container failure. Job has been dead-lettered.',
    recovery: 'Operator: inspect `ingest_stage_attempts` for the last completed stage to localize the failure. Once root-caused, requeue via `POST /v1/admin/ingestion-jobs/{id}/clear-dlq` (resets attempt_count to 0).',
  },
};

/** Render the catalog as an HTML table for embedding in
 *  `info.description` (Phase D5 docs polish). Sorted by code.
 *
 *  We emit raw HTML rather than a markdown pipe-table so we can pin
 *  explicit column widths via `<colgroup>` — without that, Scalar's
 *  default table CSS character-breaks short cells like the HTTP
 *  status codes ("429" → "4\n29"). Markdown pipe-tables don't expose
 *  width hints. The function name keeps "Markdown" for back-compat
 *  with the call site + tests. */
export function renderErrorCatalogMarkdown(): string {
  const rows = Object.entries(ERROR_CATALOG)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(
      ([code, m]) =>
        `<tr><td><code>${code}</code></td>` +
        `<td><code>${m.http}</code></td>` +
        `<td>${escapeHtml(m.when)}</td>` +
        `<td>${escapeHtml(m.recovery)}</td></tr>`,
    )
    .join('\n');
  return [
    '<table>',
    '<colgroup>',
    '  <col style="width: 22ch">',
    '  <col style="width: 6ch">',
    '  <col style="width: 40%">',
    '  <col>',
    '</colgroup>',
    '<thead>',
    '  <tr><th>Code</th><th>HTTP</th><th>When</th><th>Recovery</th></tr>',
    '</thead>',
    '<tbody>',
    rows,
    '</tbody>',
    '</table>',
  ].join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
