-- 0008 — mcp_tool_calls audit table.
--
-- Every MCP tool invocation lands a row here. Sister to query_events:
-- same redaction policy (tenants.audit_mode), same write-on-finally
-- discipline so failures land too. The Sandbox MCP tab and any
-- per-tenant operator review tooling read from this table.
--
-- transport: 'stdio' (CLI shim) or 'http' (embedded /mcp route).
-- args_redacted: JSON, redaction-aware. Subject to audit_mode.
-- rest_call_count: how many REST calls the tool fanned out to —
--                  separates "thin pass-through" tools from the
--                  multi-step ones (ingest_file).
-- outcome: 'ok' | 'tool_error' | 'rest_error' | 'cancelled'.

CREATE TABLE mcp_tool_calls (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL REFERENCES tenants(id),
    api_key_id      TEXT,
    tool_name       TEXT NOT NULL,
    transport       TEXT NOT NULL,
    args_redacted   TEXT NOT NULL,
    rest_call_count INTEGER NOT NULL,
    latency_ms      INTEGER NOT NULL,
    outcome         TEXT NOT NULL,
    error_code      TEXT,
    error_message   TEXT,
    created_at      INTEGER NOT NULL
);

CREATE INDEX idx_mcp_calls_tenant_created
    ON mcp_tool_calls(tenant_id, created_at DESC);

CREATE INDEX idx_mcp_calls_tool
    ON mcp_tool_calls(tenant_id, tool_name, created_at DESC);
