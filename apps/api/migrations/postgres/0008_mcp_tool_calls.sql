-- 0008 — mcp_tool_calls audit table.
--
-- Every MCP tool invocation lands a row here. Sister to query_events:
-- same redaction policy (tenants.audit_mode), same write-on-finally
-- discipline so failures land too. The Sandbox MCP tab and any
-- per-tenant operator review tooling read from this table.
--
-- args_redacted is JSONB so the sandbox tab can filter/inspect rows
-- without parsing the column. created_at is BIGINT epoch-millis to
-- match the rest of the schema.

CREATE TABLE mcp_tool_calls (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL REFERENCES tenants(id),
    api_key_id      TEXT,
    tool_name       TEXT NOT NULL,
    transport       TEXT NOT NULL,
    args_redacted   JSONB NOT NULL,
    rest_call_count INTEGER NOT NULL,
    latency_ms      INTEGER NOT NULL,
    outcome         TEXT NOT NULL,
    error_code      TEXT,
    error_message   TEXT,
    created_at      BIGINT NOT NULL
);

CREATE INDEX idx_mcp_calls_tenant_created
    ON mcp_tool_calls(tenant_id, created_at DESC);

CREATE INDEX idx_mcp_calls_tool
    ON mcp_tool_calls(tenant_id, tool_name, created_at DESC);
