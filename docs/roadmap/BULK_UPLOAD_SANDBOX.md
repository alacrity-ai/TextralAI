# Bulk Upload

Presently we don't have a way, at least through the sandbox, to bulk upload documents.  We need this capability.

## Bulk Upload

Bulk upload must be possible on:
API
MCP
and through the Sandbox (which hits the API)

We do have a potential MCP bulk local filesystem upload option already proposed:
see: `./docs/roadmap/LARGE_INGEST_ISSUE.md`

This could be contingent or orthogonal work, but I thought I'd point out that mcp document, as it may relate to the larger context behind this ticket.

## Acceptance Criteria

I am able to bulk upload via API, from within the sandbox (e.g. drop in multiple files, of multiple filetypes ideally), and through MCP (local filesystem, and later, likely we'll add S3 variants, or bulk tickets import from Jira, or bulk document import from Confluence.  But those are integration related and will come later, see ./docs/roadmap/INTEGRATIONS.md)

Invariant: Bulk upload should be able to handle multiple filetypes.  Though likely they should all be the same chunking profile (generic). I don't think we can dictate that you need to specify a different chunking profile for each file, that gets a bit extreme.

## Open Questions

Do we want different chunking profiles per file in a bulk upload? It's a worthwhile question.  How could this be achieved ergonomically/intuitively?
