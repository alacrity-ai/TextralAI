// Runtime-agnostic OpenAPIHono construction. Both the CF default-
// export entrypoint (apps/api/src/index.ts) and the future Node
// entrypoint (apps/api/src/runtime/node/index.ts) import the
// configured `app` from here.
//
// Middleware order is intentional and locked:
//   1. redaction         — installs console interceptors before any
//                          logger or error reporter touches the request
//   2. request-id        — every request gets a stable id
//   3. (Phase-aware)     — auth on /v1/* via requireApiKey

import { OpenAPIHono } from '@hono/zod-openapi';
import type { Env, Variables } from './types.js';
import { redactionMiddleware } from './middleware/redaction.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { handleError } from './middleware/error-envelope.js';
import { requireApiKey } from './auth/middleware.js';
import { healthRoute } from './routes/health.js';
import { devIngestPing } from './routes/dev/ingest-ping.js';
import { devWorkersAiPing } from './routes/dev/workers-ai-ping.js';
import { meRoute } from './routes/me.js';
import { namespacesRoute } from './routes/namespaces.js';
import { apiKeysRoute } from './routes/api-keys.js';
import { providerKeysRoute } from './routes/provider-keys.js';
import { documentsRoute, documentRegisterRoute } from './routes/documents.js';
import { ingestionJobsRoute } from './routes/ingestion-jobs.js';
import { queryRoute } from './routes/query.js';
import { queryEventsRoute } from './routes/query-events.js';
import { chunksRoute } from './routes/chunks.js';
import { bootstrapRoute } from './routes/admin/bootstrap.js';
import { adminIngestionJobsRoute } from './routes/admin/ingestion-jobs.js';
import { adminEnrichmentRunsRoute } from './routes/admin/enrichment-runs.js';
import { adminMcpToolCallsRoute } from './routes/admin/mcp-tool-calls.js';
import { evalRoute } from './routes/eval.js';
import { internalRoute } from './routes/internal/ingest-write.js';
import { internalProvidersRoute } from './routes/internal/providers.js';
import { internalMcpToolCallsRoute } from './routes/internal/mcp-tool-calls.js';
import { mcpRoute } from './routes/mcp.js';
import { redactionCheckRoute } from './routes/__redaction_check.js';
import { profilesRoute } from './routes/profiles.js';
import { modelsRoute } from './routes/models.js';
import { errorCatalogRoute } from './routes/error-catalog.js';
import { mountDocs } from './routes/docs.js';

const app = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>({
  // Adapt the framework's Zod-validation 400 to our standard envelope.
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: {
            code: 'BAD_REQUEST' as const,
            message: 'Request validation failed',
            details: { issues: result.error.issues },
            ...(c.get('request_id') ? { request_id: c.get('request_id') } : {}),
          },
        },
        400,
      );
    }
    return undefined;
  },
});

// MUST come first — installs the console interceptor.
app.use('*', redactionMiddleware);
app.use('*', requestIdMiddleware);

// Public — no auth required.
mountDocs(app); // /openapi.json + /docs
app.route('/healthz', healthRoute);
app.route('/dev/ingest-ping', devIngestPing);
app.route('/dev/workers-ai-ping', devWorkersAiPing);
app.route('/__redaction_check', redactionCheckRoute);

// /internal/* — Container ↔ Worker back-channel. HMAC-authenticated
// (see middleware/internal-auth.ts). Routes 404 in any environment
// where INTERNAL_HMAC_SECRET is unset.
app.route('/internal', internalRoute);
app.route('/internal/providers', internalProvidersRoute);

// /v1/admin/* — gated by ADMIN_BOOTSTRAP_TOKEN, NOT by X-Textral-Api-Key.
// Mounted before the requireApiKey middleware so it bypasses it.
app.route('/v1/admin/bootstrap', bootstrapRoute);

// Authenticated — every /v1/* path requires an API key.
const v1 = new OpenAPIHono<{ Bindings: Env; Variables: Variables }>();
v1.use('*', requireApiKey);
v1.route('/me', meRoute);
v1.route('/namespaces', namespacesRoute);
v1.route('/api-keys', apiKeysRoute);
v1.route('/provider-keys', providerKeysRoute);
// Documents: register lives under the namespace tree
// (`/v1/namespaces/{slug}/documents`); every `/{id}/...` op (get,
// uploads, finalize, ingest) lives at `/v1/documents/{id}/...`. Two
// distinct OpenAPIHono apps so the spec emits each operation under
// exactly one path — sharing one app across two mounts duplicated
// every op in the spec sidebar.
v1.route('/namespaces', documentRegisterRoute);
v1.route('/documents', documentsRoute);
v1.route('/ingestion-jobs', ingestionJobsRoute);
v1.route('/admin/ingestion-jobs', adminIngestionJobsRoute);
v1.route('/admin/namespaces', adminEnrichmentRunsRoute);
v1.route('/admin/mcp_tool_calls', adminMcpToolCallsRoute);
v1.route('/namespaces', evalRoute);
v1.route('/query', queryRoute);
v1.route('/query-events', queryEventsRoute);
v1.route('/chunks', chunksRoute);
v1.route('/profiles', profilesRoute);
v1.route('/models', modelsRoute);
v1.route('/error-catalog', errorCatalogRoute);
v1.route('/_internal/mcp_tool_calls', internalMcpToolCallsRoute);
v1.route('/mcp', mcpRoute);
app.route('/v1', v1);

app.notFound((c) =>
  c.json(
    {
      error: {
        code: 'NOT_FOUND',
        message: `Route not found: ${c.req.method} ${c.req.path}`,
        ...(c.get('request_id') ? { request_id: c.get('request_id') } : {}),
      },
    },
    404,
  ),
);

app.onError(handleError);

export default app;
