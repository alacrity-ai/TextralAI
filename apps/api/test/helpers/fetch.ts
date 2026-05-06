// Test helper: invokes the Worker handler with a constructed Request,
// casting around the type mismatch between `new Request(...)` (which has
// `cf: CfProperties<unknown>`) and `ExportedHandler.fetch` (which expects
// `cf: IncomingRequestCfProperties<unknown>`). The latter properties
// don't exist client-side; only the runtime synthesizes them.

import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../../src/index.js';
import type { Env } from '../../src/types.js';

export async function callWorker(env: Env, req: Request): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    req as unknown as Parameters<NonNullable<typeof worker.fetch>>[0],
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

export async function callJson(
  env: Env,
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json', ...headers },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return callWorker(env, new Request(url, init));
}
