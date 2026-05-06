// Container DO → ContainerInvoker adapter. Wraps the existing
// `idFromName / get / fetch` pattern (was inline in the original
// `processIngestQueue` before Phase 2 Step 11) so the runtime-
// agnostic `runIngestMessage(msg, bindings)` body can dispatch
// without knowing about Cloudflare's DO RPC shape.

import type {
  ContainerInvokeResult,
  ContainerInvoker,
  ContainerOutcome,
} from '../shared/interfaces.js';

export class DoContainerInvoker implements ContainerInvoker {
  constructor(private readonly ns: DurableObjectNamespace) {}

  async invoke(args: {
    job_id: string;
    attempt: number;
  }): Promise<ContainerInvokeResult> {
    const id = this.ns.idFromName(`job:${args.job_id}`);
    const stub = this.ns.get(id);
    const res = await stub.fetch('http://container/jobs/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args),
    });
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
