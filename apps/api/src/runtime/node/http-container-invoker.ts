// Plain-HTTP → ContainerInvoker adapter. Mirrors the CF
// `DoContainerInvoker` shape but uses `fetch` against a normal
// docker-compose hostname instead of the Workers DO RPC stub.
//
// Auth: the api → Container direction has no HMAC layer (the
// Container's `/jobs/run` endpoint is reachable only on the
// internal docker network). The HMAC scheme in
// `middleware/internal-auth.ts` covers the inverse direction —
// Container → Worker callbacks for D1/R2/embed operations — and
// is unchanged.

import type {
  ContainerInvokeResult,
  ContainerInvoker,
  ContainerOutcome,
} from '../shared/interfaces.js';

interface HttpContainerInvokerCfg {
  host: string;
  port?: number;
}

export class HttpContainerInvoker implements ContainerInvoker {
  private readonly url: string;

  constructor(cfg: HttpContainerInvokerCfg) {
    const port = cfg.port ?? 8000;
    this.url = `http://${cfg.host}:${port}/jobs/run`;
  }

  async invoke(args: {
    job_id: string;
    attempt: number;
  }): Promise<ContainerInvokeResult> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args),
      });
    } catch (e) {
      // Network-level failure (DNS / TCP / TLS). Surface as a 0-status
      // result so the consumer's retry path treats it like a 5xx.
      return {
        status: 0,
        error: String((e as Error)?.message ?? e).slice(0, 200),
      };
    }
    if (res.status >= 200 && res.status < 300) {
      const body = (await res.json()) as { outcome?: ContainerOutcome };
      return {
        status: res.status,
        ...(body.outcome ? { outcome: body.outcome } : {}),
      };
    }
    return {
      status: res.status,
      error: (await res.text()).slice(0, 200),
    };
  }
}
