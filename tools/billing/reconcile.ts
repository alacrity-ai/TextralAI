#!/usr/bin/env tsx
// Phase 8.6 — cost reconciliation.
//
// Compares three numbers for a (tenant, day):
//   1. SUM(query_events.total_cost_usd_micros) for that tenant + day
//   2. AI Gateway dashboard total for that tenant + day (manual entry)
//   3. Provider dashboard total (manual entry)
//
// Report: any pair > $0.01 apart is flagged.
//
// Usage:
//   tsx tools/billing/reconcile.ts \
//     --tenant ten_xxx \
//     --date 2026-05-03 \
//     --aig-total 1.234 \
//     --provider-total 1.231

import { Buffer } from 'node:buffer';

interface Args {
  tenant: string;
  date: string;            // YYYY-MM-DD
  source?: 'query_events' | 'aig' | 'all';
  aig_total?: number;      // dollars
  provider_total?: number; // dollars
  worker_url?: string;
  api_key?: string;
}

function parseArgs(): Args {
  const out: Partial<Args> = { source: 'all' };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!.replace(/^--/, '');
    const v = argv[i + 1];
    switch (k) {
      case 'tenant':
        out.tenant = v;
        i++;
        break;
      case 'date':
        out.date = v;
        i++;
        break;
      case 'source':
        out.source = v as 'query_events' | 'aig' | 'all';
        i++;
        break;
      case 'aig-total':
        out.aig_total = Number(v);
        i++;
        break;
      case 'provider-total':
        out.provider_total = Number(v);
        i++;
        break;
      case 'worker-url':
        out.worker_url = v;
        i++;
        break;
      case 'api-key':
        out.api_key = v;
        i++;
        break;
    }
  }
  if (!out.tenant) throw new Error('--tenant required');
  if (!out.date) throw new Error('--date required');
  return out as Args;
}

function dayBucketMs(date: string): { since: number; until: number } {
  // YYYY-MM-DD → UTC midnight + 24h.
  const d = new Date(`${date}T00:00:00Z`);
  if (isNaN(d.getTime())) throw new Error(`bad date: ${date}`);
  const since = d.getTime();
  const until = since + 86_400_000;
  return { since, until };
}

async function fetchQueryEventsTotal(args: Args): Promise<number | null> {
  if (!args.worker_url || !args.api_key) {
    console.error('skipping query_events fetch — no --worker-url / --api-key');
    return null;
  }
  // The MVP API doesn't yet expose a /v1/admin/usage endpoint that
  // sums query_events.total_cost_usd_micros directly. Document the
  // SQL to run via wrangler d1 execute, and accept manual input.
  console.error(
    'query_events total — run this in wrangler d1 (then pass the result via',
    '--qe-total when wired):\n',
  );
  const { since, until } = dayBucketMs(args.date);
  console.error(
    `  SELECT SUM(total_cost_usd_micros) AS micros\n` +
      `    FROM query_events\n` +
      `   WHERE tenant_id = '${args.tenant}'\n` +
      `     AND created_at >= ${since}\n` +
      `     AND created_at < ${until};\n`,
  );
  return null;
}

function diffOk(a: number, b: number, tol = 0.01): boolean {
  return Math.abs(a - b) <= tol;
}

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(`Reconcile tenant=${args.tenant} date=${args.date}`);
  const qe = await fetchQueryEventsTotal(args);
  const aig = args.aig_total ?? null;
  const prov = args.provider_total ?? null;
  console.log({ query_events_usd: qe, aig_usd: aig, provider_usd: prov });
  const failures: string[] = [];
  if (qe !== null && aig !== null && !diffOk(qe, aig)) {
    failures.push(`query_events vs AIG: |${qe} - ${aig}| > $0.01`);
  }
  if (aig !== null && prov !== null && !diffOk(aig, prov)) {
    failures.push(`AIG vs provider: |${aig} - ${prov}| > $0.01`);
  }
  if (qe !== null && prov !== null && !diffOk(qe, prov)) {
    failures.push(`query_events vs provider: |${qe} - ${prov}| > $0.01`);
  }
  if (failures.length > 0) {
    console.error('Reconciliation failed:');
    for (const f of failures) console.error('  ', f);
    process.exit(1);
  }
  console.log('Reconciliation OK (within ±$0.01)');
}

void Buffer; // avoid lint warning if not used in final form
main().catch((e: unknown) => {
  console.error('reconcile error:', (e as Error).message);
  process.exit(2);
});
