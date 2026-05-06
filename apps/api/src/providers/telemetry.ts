// Provider telemetry — single emission point.
//
// Every provider call (success, degraded, retryable, fatal) emits exactly
// one event, AFTER the result is finalized. `ProviderHttpClient.finalize`
// is the only call site in Phase 2.
//
// `console.info` is intercepted by the Phase 1.6 redaction middleware,
// so any leaked upstream string here is sanitized before the runtime
// drains the log line. Cloudflare's Workers logs platform makes the
// emitted lines searchable for the configured retention window — the
// primary "provider_calls" surface for MVP.
//
// The Phase 6.3 AE datasets (`query_executions`, `ingestion_stage_outcomes`)
// are written from route handlers where `env.AE_METRICS` is in scope.
// We deliberately don't thread env through the HTTP client just to fan
// out a third metric here; that's invasive for marginal value.

import type { ProviderTelemetryEvent } from './types.js';

export function emitProviderTelemetry(ev: ProviderTelemetryEvent): void {
  console.info('provider_call', ev);
}
