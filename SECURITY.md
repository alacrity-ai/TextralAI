# Security Policy

Thanks for taking the time to report a security issue. Coordinated
disclosure makes Textral safer for everyone running it.

## Reporting a vulnerability

**Email: [security@alacrity.ai]**

Use the email above — please **do not open a public GitHub issue or
pull request** for any vulnerability report. Public reports give bad
actors a window between disclosure and patch.

If you'd prefer encrypted email, request our PGP key in your initial
message and we'll respond with the public key fingerprint.

GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
is also enabled on this repository — submit via **Security → Report a
vulnerability** if you prefer a structured form over email.

## What to include

A useful report has:

- A clear description of the issue and the affected component
  (e.g., "tenant-isolation bypass on `/v1/query`," "credential leak
  via `query_events.request_config`," "RCE in the ingest container's
  PDF parser").
- Reproduction steps — minimal, deterministic if possible.
- The version / commit hash you observed it on.
- Your assessment of severity and impact (CVSS optional but
  appreciated).
- Whether you've already reported this to anyone else (Cloudflare,
  upstream provider, etc.).

If you have a proof-of-concept, include it. If exploitation requires
a custom corpus or non-default configuration, tell us.

## What we promise

| Stage | SLA |
|---|---|
| Acknowledgement of your report | 2 business days |
| Initial triage + severity assessment | 7 days |
| Status update if the fix takes longer than the embargo window | every 14 days until resolved |
| Coordinated disclosure (you + us publish together) | up to 90 days from your report |

If we determine the report is out of scope or not a vulnerability,
we'll tell you why. We do not attempt to "manage" reporters who
disagree with our triage — escalate to a third party (e.g., the CVE
program) if you believe we got it wrong.

## Scope

In scope for this policy:

- The Textral codebase in this repository (api, ingest, sandbox,
  packages, tools, docs).
- Default configurations as documented in `docs/SELF_HOSTING.md` and
  `docs/CLOUDFLARE_QUICKSTART.md`.
- The MCP surface (`@textral/mcp`) and the embedded `/v1/mcp` route.
- Audit-trail integrity — issues that cause `query_events`,
  `mcp_tool_calls`, or `usage_records` to drop, mis-attribute, or
  fail to redact per the configured `tenants.audit_mode`.
- Tenant isolation at every storage boundary (Postgres / D1 row-level,
  vector metadata, R2 / MinIO prefix, Redis / Queue partitioning,
  Pinecone native namespace).
- Credential storage paths (provider keys, integration tokens).

Out of scope:

- Third-party services we depend on (OpenAI, Anthropic, Pinecone,
  Cloudflare, AWS) — please report those upstream.
- Self-host stacks running with operator-modified configuration that
  weakens defaults (e.g., disabled redaction, shared API key
  pepper).
- Best-practice deviations that aren't exploitable (e.g., "you should
  use stricter CORS"). These belong in regular issues / PRs.
- Vulnerabilities in dependencies we haven't yet bumped — open a PR
  bumping the dep instead, or report to the upstream first.

## Safe-harbor

We treat security research conducted in good faith as authorized
under this policy. Specifically:

- We will not pursue legal action against researchers who report
  issues through the channels above and who do not exfiltrate or
  destroy data, do not access data beyond what's necessary to
  demonstrate the issue, and do not impact other users.
- This safe-harbor extends to the act of *reporting* — we'll engage
  with reports in good faith regardless of whether you accept any
  bounty or recognition we might offer.

We do not currently run a paid bug-bounty program. If we add one
later we'll publish details here.

## Disclosure

After a fix is shipped:

1. We publish a GitHub Security Advisory, request a CVE, and
   credit you (unless you've asked to remain anonymous).
2. We update affected versions' release notes with the advisory ID.
3. If the issue affects upstream dependencies, we coordinate with
   their security teams before disclosure.

We default to **90-day** coordinated disclosure from the date you
report. We can shorten this for trivial fixes or extend it for
deeply-rooted issues with your agreement; we won't extend
unilaterally.

## Hardening guidance for operators

The `docs/security/THREAT_MODEL.md` document tracks the per-component
threat model and the mitigations we ship. Operators running self-host
deployments should review:

- `docs/SELF_HOSTING.md §3` — secret rotation, env-var hygiene
- `docs/runbooks/INCIDENTS.md` — incident response patterns
- `docs/security/THREAT_MODEL.md` — the asset-by-asset threat
  inventory and mitigation status

If your deploy diverges from the documented baseline (e.g., custom
auth in front of the API, a non-default Postgres setup), the threats
you face will diverge too — the threat model is your starting point,
not your finish line.
