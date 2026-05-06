// Stdout-JSON → MetricsSink adapter. Self-host operators forward
// stdout to whatever backend they prefer (Loki, Datadog, ELK,
// ClickHouse, etc.). The output is one JSON object per line —
// the standard structured-logging shape.

import type { MetricsSink } from '../shared/interfaces.js';

export class StdoutMetricsSink implements MetricsSink {
  write(point: {
    indexes: string[];
    doubles: number[];
    blobs: string[];
  }): void {
    console.log(JSON.stringify({ kind: 'metric', ...point }));
  }
}
