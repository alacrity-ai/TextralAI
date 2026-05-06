// Metric writes — runtime-agnostic via the `MetricsSink` adapter.
//
// Three datasets, each a different grain:
//   - query_executions          one point per /v1/query response
//   - ingestion_stage_outcomes  one point per stage attempt commit
//   - provider_calls            one point per upstream provider call
//
// AE convention: `indexes[0]` is the high-cardinality dimension (we put
// `tenant_id` here so dashboards can sample-then-group by tenant).
//
// `bindings.metrics` is built per-runtime by the runtime adapter:
//   - CF runtime → AeMetricsSink (Workers Analytics Engine) when the
//     AE binding is bound, NoopMetricsSink otherwise.
//   - Node runtime → StdoutMetricsSink (structured JSON to stdout).
// The `dataset` name is encoded into `blob[0]` so a single sink backs
// all three logical datasets.

import type { Bindings } from '../runtime/shared/interfaces.js';

export type MetricDataset =
  | 'query_executions'
  | 'ingestion_stage_outcomes'
  | 'provider_calls';

export interface MetricPoint {
  /** Free-form string columns. AE accepts up to 20. */
  blobs: string[];
  /** Numeric columns. AE accepts up to 20. */
  doubles: number[];
  /** Indexed columns — first one drives sampling. Convention: tenant_id first. */
  indexes: string[];
}

export function writeMetric(env: Bindings, dataset: MetricDataset, point: MetricPoint): void {
  env.metrics.write({
    blobs: [dataset, ...point.blobs],
    doubles: point.doubles,
    indexes: point.indexes,
  });
}
