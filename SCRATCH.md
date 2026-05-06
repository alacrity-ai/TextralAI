# We ran out of tokens

# This is the last claude output that we had:

● Plan written: docs/bugs/resolutions/5-6-2026-SOLUTION-PLAN.md.

  TL;DR for each bug:

  Bug 1 — GPT-5 inference fails. Root cause confirmed: apps/api/src/providers/openai-compat.ts:187-200 sends temperature and max_tokens to every OpenAI model. The reasoning-model family (gpt-5*, o1*, o3*, o4*) rejects both — temperature must
  be 1 (or omitted), and max_tokens must be max_completion_tokens. Fix: an isReasoningModel() predicate + branch in buildChatBody + the streaming-chat body builder. Secondary: bad_request is currently classified non-fatal at
  error-classification.ts:48, which is why your logs showed retry_count: 3 — should flip to fatal.

  Bug 2 — Free-text model field. No registry exists today; model strings are scattered as hard-coded constants in code samples. Plan: add packages/contracts/src/models.ts with a curated KNOWN_MODELS list, expose GET /v1/models?provider&kind,
  add an mcp__textral__list_models tool, and replace the QueryForm <Input> with provider+kind-filtered <SelectField> dropdowns. Keeps a free-text escape hatch for registry staleness.

  Bug 3 — Opaque dimension mismatch. Two stacked problems: the form blindly defaults to 1536, and the namespace's default_embedding_profile field is a soft-default that doesn't reliably encode dimensions (lighthouse-tales is
  openai-text-embedding-3-large but indexed at 1024 dims). The error already carries a dimension discriminator and available[] array — the message just doesn't surface them. Combined fix: (A) rewrite the error message in profile-gate.ts:32 to
  name the available profiles, (B) expose indexed_profiles[] on the Namespace API response (computed from version_indexes) and have the form's useEffect autopopulate from it.

  Sequencing: Bug 1 first (smallest, fastest, unblocks users immediately), then Bug 3 (small surface, big UX win, also lays groundwork for Bug 2's autopopulate), then Bug 2 (biggest scope: new registry, route, MCP tool, sandbox context).

  Want me to start executing? If so, just Bug 1, or all three?

✻ Cooked for 4m 38s

❯ Execute and resolve all 3 bugs, I will verify when you are done.

● Bug 1: openai-compat reasoning-model branch

  Read 1 file (ctrl+o to expand)

● Both sync and streaming paths share buildChatBody. One update fixes both.

● Update(apps/api/src/providers/openai-compat.ts)
  ⎿  Added 10 lines, removed 2 lines
      185    // ── Body building ─────────────────────────────────────────────────────
      186
      187    private buildChatBody(req: ChatRequest): Record<string, unknown> {
      188 +    const reasoning = isReasoningModel(req.model);
      189      const body: Record<string, unknown> = {
      190        model: req.model,
      191        messages: req.messages,
      191 -      temperature: req.temperature ?? 0,
      192      };                                                                                                                                                                                                                                        193 -    if (req.max_tokens != null) body.max_tokens = req.max_tokens;
      193 +    // Reasoning models (gpt-5*, o1*, o3*, o4*) reject `temperature !== 1`                                                                                                                                                                    194 +    // and require `max_completion_tokens` instead of `max_tokens`. See
      195 +    // OpenAI docs "Reasoning models — API differences."
      196 +    if (!reasoning) {
      197 +      body.temperature = req.temperature ?? 0;
      198 +      if (req.max_tokens != null) body.max_tokens = req.max_tokens;
      199 +    } else if (req.max_tokens != null) {
      200 +      body.max_completion_tokens = req.max_tokens;
      201 +    }
      202      if (req.stop) body.stop = req.stop;
      203      if (req.response_format) {
      204        const encoded = this.encodeResponseFormat(req.response_format);

● Now add the isReasoningModel helper. Place it at the bottom of the file as a module-private export.

  Read 1 file (ctrl+o to expand)

● Update(apps/api/src/providers/openai-compat.ts)
  ⎿  Added 9 lines
  ⎿  Added 9 lines
      408    }
      409  }
      410
      411 +/** OpenAI's reasoning-model family (gpt-5*, o1*, o3*, o4*) does not
      412 + *  accept `temperature` (other than the default 1) and requires
      413 + *  `max_completion_tokens` in place of the deprecated `max_tokens`.
      414 + *  See: https://platform.openai.com/docs/guides/reasoning */
      415 +export function isReasoningModel(model: string): boolean {
      416 +  const m = model.toLowerCase();
      417 +  return /^gpt-5/.test(m) || /^o[134](?:-|$)/.test(m);
      418 +}
      419 +
      420  /** Convenience instance for OpenAI-direct. */
      421  export const openaiDirect = new OpenAICompatProvider({
      422    name: 'openai',

● Bug 1.2: bad_request → fatal

● Update(apps/api/src/providers/error-classification.ts)
  ⎿  Added 9 lines, removed 2 lines
      36    return 'unknown';
      37  }
      38
      39 -/** Whether the error type should short-circuit the retry loop. */
      39 +/** Whether the error type should short-circuit the retry loop.
      40 + *
      41 + *  `bad_request` is fatal: HTTP 400 from OpenAI/Anthropic indicates a
      42 + *  malformed request (unsupported parameter, missing required field,
      43 + *  schema violation), and retrying will deterministically hit the same
      44 + *  400. The only exception class would be transient validation
      45 + *  (none currently observed); if one arises, route it to a more
      46 + *  specific type via the OpenAI/Anthropic classifiers. */
      47  export function isFatal(t: ProviderErrorType): boolean {
      48    switch (t) {
      49      case 'invalid_api_key':
     ...
      51      case 'unsupported_model':
      52      case 'context_length_exceeded':
      53      case 'refusal':
      47 -      return true;
      54      case 'bad_request':
      55 +      return true;
      56      case 'malformed_response':
      57      case 'schema_violation':
      58      case 'partial_batch':
  ⎿  You're out of extra usage · resets May 8, 4am (America/New_York)

✻ Crunched for 1m 5s

  9 tasks (2 done, 1 in progress, 6 open)
  ◼ Bug 3A: Better EMBEDDING_PROFILE_MISMATCH message                                                                                                                                                                                            ─
  ◻ Bug 3B: Expose indexed_profiles on Namespace
  ◻ Bug 3B: Sandbox autopopulates from indexed_profiles
  ◻ Bug 2: Build KNOWN_MODELS registry in contracts
  ◻ Bug 2: GET /v1/models route + MCP tool
   … +2 pending, 2 completed