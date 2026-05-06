// /dev/ingest-ping — round-trips through the IngestContainer to prove
// the CF Durable-Object binding is wired correctly. Diagnostic only.
//
// Gated behind ENABLE_DEBUG_ROUTES so the route 404s in prod even if
// it somehow ships. Also runtime-gated: only meaningful in CF mode
// (the Node runtime reaches the Container via plain HTTP — operators
// curl it directly).
//
// Reaches the legacy `c.env.INGEST_CONTAINER` binding directly (rather
// than `c.env.containerInvoker`) because the abstraction's `invoke()`
// targets `/jobs/run` specifically; this ping hits `/healthz`. Keeping
// the binding access here is intentional — see runtime/cf/
// do-container-invoker.ts for the production path.

import { Hono } from 'hono';
import type { Env, Variables } from '../../types.js';

export const devIngestPing = new Hono<{ Bindings: Env; Variables: Variables }>();

devIngestPing.get('/', async (c) => {
  if (c.env.ENABLE_DEBUG_ROUTES !== 'true') return c.notFound();
  if (c.env.runtime !== 'cf') return c.notFound();
  const id = c.env.INGEST_CONTAINER.idFromName('ping');
  const stub = c.env.INGEST_CONTAINER.get(id);
  const res = await stub.fetch('http://container/healthz');
  const body = (await res.json()) as Record<string, unknown>;
  return c.json({ container: body });
});
