/**
 * 07-paginate-events.ts — Pagination iterators in action.
 *
 * Demonstrates: client.queryEvents.iterate(...), early termination
 * via `break`, useful aggregation patterns.
 *
 * Env: same as 01-quick-start.ts.
 *
 * Run:
 *     npx tsx 07-paginate-events.ts
 *
 * See also:
 *     SDK_COOKBOOK_OUTLINE.md §8
 */

import { TextralClient } from '@textral/sdk';

const profileName = process.env.TEXTRAL_PROFILE;
const namespace = process.env.TEXTRAL_NAMESPACE ?? 'cookbook';

const client = profileName
  ? new TextralClient({ profile: profileName })
  : new TextralClient({
      baseUrl: process.env.TEXTRAL_BASE_URL ?? 'https://api.textral.alacrity.ai',
      apiKey: process.env.TEXTRAL_API_KEY ?? '',
    });

let total = 0;
let withCitations = 0;
let withDropped = 0;
let totalLatency = 0;

for await (const ev of client.queryEvents.iterate({ namespace_slug: namespace })) {
  total++;
  if ((ev.citations_returned ?? 0) > 0) withCitations++;
  if ((ev.dropped_citations?.length ?? 0) > 0) withDropped++;
  if (ev.latency_ms !== null) totalLatency += ev.latency_ms;
  if (total >= 1000) break; // example caps to 1000
}

console.log(`scanned ${total} events`);
console.log(`  with citations:        ${withCitations}`);
console.log(`  with dropped citation: ${withDropped}`);
console.log(`  avg latency:           ${total > 0 ? Math.round(totalLatency / total) : 0}ms`);
