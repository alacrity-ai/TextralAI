# Embeddable Widget (`@textral/widget`)

The sandbox UI is for tenant admins. There's no surface today that an end user can interact with. "Chat with your docs" is the most viral RAG demo there is, and we don't have it.

A 3-line script tag that drops a Textral chat widget on any site is table-stakes for the easy on-ramp pitch.

## Why

- **Viral demo surface.** Customers can show their stakeholders a working chat-with-docs in 60 seconds.
- **Pinecone Assistant has it.** They show this prominently; it's a closing wedge against us.
- **Low-effort end-user RAG.** Customers without engineering bandwidth can still ship something useful.
- **Marketing surface.** Our own marketing site can embed Textral over our docs, dogfood-style.

## Scope

In:
- New package `@textral/widget` (publishable to npm, also distributed via CDN).
- Iframe-isolated chat UI; configurable per-namespace; theme-able via CSS variables.
- Public read-only API token type scoped to a single namespace + retrieval-only mode + rate limit.
- Server-side render or client-side render — both supported.
- A 3-line install:
  ```html
  <script src="https://cdn.textral.com/widget.js"
          data-public-token="ptk_..." 
          data-namespace="docs"></script>
  ```
- Sandbox UI to provision public tokens and configure widget appearance.

Out:
- Customer fully replacing the chat UI with their own. They can iframe in any case.
- Voice / multimodal input. Text-only v1.
- Rich citation tooltips with PDF previews. v2; v1 just deeplinks the section_path.

## Sketch

- New `apps/widget/` with Vite + React (or Preact for size); compiled to a single ESM file ~30-50kb gzipped.
- New auth mode: `public_token` (`ptk_*` prefix). Stored hashed in D1; scoped to one namespace, rate-limited per token, force-binds `synthesis: true` and `mode: "fast"`.
- Token rotation + per-domain origin allowlist (`Origin` header check) to prevent token theft from third-party embeds.
- CDN: Cloudflare Workers serves `widget.js` from R2 or KV.
- Sandbox: "Embed widget" tab on each namespace; provisions public token, shows the script tag, lets admin pick theme + initial prompts.
- Default styling has clear "Powered by Textral" link (removable on paid tiers — light branding lock-in).

## Acceptance Criteria

- Pasting the 3-line script tag into a vanilla HTML page renders a working chat widget.
- Widget hits `/query` with the public token; namespace is enforced server-side.
- Origin allowlist works: token used from a non-allowlisted domain returns 403.
- Rate limit per token (e.g. 60 req/min default) is enforced.
- Theme variables (`--textral-primary`, `--textral-radius`, etc.) work and are documented.
- Citations render with section_path; clicking a citation deeplinks (optional) to a configurable doc URL.

## Open Questions

- **iframe vs. shadow DOM?** iframe is bulletproof CSS isolation; shadow DOM is lighter-weight. Recommend iframe for v1.
- **Public token scope.** Read-only retrieval over a single namespace is the safe default. Should we let it span multiple namespaces? Probably not for v1.
- **Conversational memory.** v1 is stateless; "follow-up question" needs session memory. Could be client-side localStorage initially.
- **PII safety.** A widget on a public site means anyone can ask anything. Worth a content-safety pre-filter? Maybe a v2.
- **Free-tier branding lock.** "Powered by Textral" link removable on paid tiers — yes/no? Pricing decision.

## Related

- [`COST_ATTRIBUTION.md`](./COST_ATTRIBUTION.md) — public-token traffic must roll up to tenant cost reporting.
- [`METADATA_FILTERS.md`](./METADATA_FILTERS.md) — widget can expose facet filters once metadata is available.
- [`RETRIEVAL_ONLY_MODE.md`](./RETRIEVAL_ONLY_MODE.md) — public tokens may default to retrieval-only on the free tier for cost control.
