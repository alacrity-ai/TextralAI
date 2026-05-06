// Container Durable Object glue. Cloudflare-runtime only.
//
// `IngestContainer` is the class wrangler instantiates per-instance —
// Cloudflare Containers run as Durable Objects under the hood. The
// `Container` base class handles port forwarding + lifecycle; we only
// need to declare which port the container listens on and how long it
// can sit idle before being put to sleep.
//
// Sleep-after-idle is intentional: ingestion is queue-driven and bursty,
// so paying for an always-on container is wasteful. Cold start is on the
// order of seconds — invisible amortized over a multi-second ingestion
// job. The query path never touches the Container (see docs/1-DESIGN.md
// §3.2), so user latency is not affected.
//
// Lives under `runtime/cf/` because `@cloudflare/containers` is the
// only Cloudflare-runtime-specific import in the entire api source
// tree. The Node runtime invokes the same Container via plain HTTP
// (see `runtime/node/http-container-invoker.ts`).

import { Container } from '@cloudflare/containers';
import type { Env } from '../../types.js';

export class IngestContainer extends Container<Env> {
  override defaultPort = 8000;
  override sleepAfter = '10m';

  // The Container needs to call back into the Worker for every D1 / R2 /
  // Vectorize / embed operation. WORKER_INTERNAL_URL is the back-channel
  // base; INTERNAL_HMAC_SECRET signs every request. Both are mirrored in
  // from the Worker's environment so they never live in the image.
  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);
    this.envVars = {
      WORKER_INTERNAL_URL: env.WORKER_INTERNAL_URL ?? '',
      INTERNAL_HMAC_SECRET: env.INTERNAL_HMAC_SECRET ?? '',
    };
  }
}
