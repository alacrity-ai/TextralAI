// Analytics Engine → MetricsSink adapter. Two implementations: one
// for deploys with the AE binding, a no-op for deploys without (the
// existing observability/metrics.ts already gates on
// `env.AE_METRICS` presence; this preserves that behavior at the
// Bindings layer).

import type { MetricsSink } from '../shared/interfaces.js';

export class AeMetricsSink implements MetricsSink {
  constructor(private readonly ae: AnalyticsEngineDataset) {}
  write(point: {
    indexes: string[];
    doubles: number[];
    blobs: string[];
  }): void {
    this.ae.writeDataPoint({
      indexes: point.indexes,
      doubles: point.doubles,
      blobs: point.blobs,
    });
  }
}

export class NoopMetricsSink implements MetricsSink {
  write(): void {}
}
