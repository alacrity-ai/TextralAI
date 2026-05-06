// Runtime-agnostic per-message body. The CF queue-consumer wrapper
// (runtime/cf/queue-consumer.ts) loops `batch.messages` and translates
// the result into ack/retry; the Node BRPOP wrapper
// (runtime/node/workers/ingest-consumer.ts) re-LPUSHes on retry or
// moves to a dead list when attempts are exceeded.
//
// The body itself just dispatches to the Container via
// `bindings.containerInvoker.invoke(...)` — no Workers or Node specifics.

import type { Bindings, ContainerInvokeResult } from '../runtime/shared/interfaces.js';

export interface IngestQueueMessage {
  job_id: string;
  tenant_id: string;
  attempt: number;
}

export interface IngestMessageResult {
  ack: boolean;
  /** Optional reason for telemetry / dead-lettering decisions. */
  reason?: string;
  /** Container outcome when present. */
  outcome?: ContainerInvokeResult['outcome'];
}

export async function runIngestMessage(
  msg: IngestQueueMessage,
  bindings: Bindings,
): Promise<IngestMessageResult> {
  try {
    const r = await bindings.containerInvoker.invoke({
      job_id: msg.job_id,
      attempt: msg.attempt,
    });
    if (r.status >= 200 && r.status < 300) {
      // Ack on terminal outcomes (full_success | partial_ingestion |
      // fatal_failure). The Container has already updated D1.
      if (r.outcome === 'fatal_failure') {
        console.warn('ingest_job_fatal', { job_id: msg.job_id });
      }
      return { ack: true, ...(r.outcome ? { outcome: r.outcome } : {}) };
    }
    if (r.status === 409 || r.status === 423) {
      // Lease taken / job already terminal. Ack to avoid spinning.
      return { ack: true, reason: 'lease-or-terminal' };
    }
    console.error('ingest_container_5xx', {
      job_id: msg.job_id,
      status: r.status,
      ...(r.error ? { error: r.error } : {}),
    });
    return { ack: false, reason: 'container-5xx' };
  } catch (e) {
    console.error('ingest_dispatch_failed', {
      job_id: msg.job_id,
      message: String((e as Error)?.message ?? e),
    });
    return { ack: false, reason: 'dispatch-error' };
  }
}
