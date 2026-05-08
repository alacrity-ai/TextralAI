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
  PROVIDER_KEY_NOT_FOUND: {
    http: 404,
    when: '`provider_key_ref` (label) or `provider_key_id` does not match a registered key.',
    recovery: 'Register the key via `POST /v1/provider-keys`, or list with `GET /v1/provider-keys`.',
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
