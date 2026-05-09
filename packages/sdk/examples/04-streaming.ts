/**
 * 04-streaming.ts — SSE streaming query.
 *
 * Demonstrates: client.query.stream(...), AbortSignal cancellation,
 * TextralStreamInterrupted handling.
 *
 * Env: same as 01-quick-start.ts.
 *
 * Run:
 *     npx tsx 04-streaming.ts
 *
 * See also:
 *     SDK_COOKBOOK_OUTLINE.md §5
 */

import { TextralClient, TextralStreamInterrupted } from '@textral/sdk';

const profileName = process.env.TEXTRAL_PROFILE;
const namespace = process.env.TEXTRAL_NAMESPACE ?? 'cookbook';
const providerKeyRef = process.env.TEXTRAL_PROVIDER_KEY_REF ?? 'openai';

const client = profileName
  ? new TextralClient({ profile: profileName })
  : new TextralClient({
      baseUrl: process.env.TEXTRAL_BASE_URL ?? 'https://api.textral.alacrity.ai',
      apiKey: process.env.TEXTRAL_API_KEY ?? '',
    });

const ac = new AbortController();
// Safety timeout — cancel after 30s no matter what.
setTimeout(() => ac.abort(), 30_000).unref();

try {
  for await (const frame of client.query.stream(
    {
      namespace,
      query: 'What survived the Library of Alexandria?',
      embedding: {
        provider: 'openai',
        model: 'text-embedding-3-large',
        dimensions: 1536,
        provider_key_ref: providerKeyRef,
      },
      inference: {
        provider: 'openai',
        model: 'gpt-4o-mini',
        provider_key_ref: providerKeyRef,
      },
    },
    { signal: ac.signal },
  )) {
    switch (frame.type) {
      case 'token':
        process.stdout.write(frame.value);
        break;
      case 'citation':
        console.error(`\n  [${frame.ordinal}] ${frame.section_path}`);
        break;
      case 'audit':
        console.error(`\n  audit: ${frame.query_event_id}`);
        break;
      case 'done':
        // streamSse returns on [DONE]; this is mostly informational.
        break;
    }
  }
  console.log();
} catch (e) {
  if (e instanceof TextralStreamInterrupted) {
    console.error('stream interrupted:', e.message);
    process.exit(2);
  }
  throw e;
}
