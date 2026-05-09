/**
 * 01-quick-start.ts — One query, one cited answer.
 *
 * The "would I keep reading this README?" example. Three lines of
 * SDK call between configuration and a real cited answer.
 *
 * Env:
 *     TEXTRAL_API_KEY     (required if no profile is configured)
 *     TEXTRAL_BASE_URL    (optional)
 *     TEXTRAL_PROFILE     (optional; from ~/.textral/profiles.toml)
 *     TEXTRAL_NAMESPACE   (optional; defaults to "cookbook")
 *     TEXTRAL_PROVIDER_KEY_REF (optional; defaults to "openai")
 *
 * Run:
 *     npx tsx 01-quick-start.ts
 *
 * See also:
 *     SDK_COOKBOOK_OUTLINE.md §2
 */

import { TextralClient } from '@textral/sdk';

const profileName = process.env.TEXTRAL_PROFILE;
const namespace = process.env.TEXTRAL_NAMESPACE ?? 'cookbook';
const providerKeyRef = process.env.TEXTRAL_PROVIDER_KEY_REF ?? 'openai';

const client = profileName
  ? new TextralClient({ profile: profileName })
  : new TextralClient({
      baseUrl: process.env.TEXTRAL_BASE_URL ?? 'https://api.textral.alacrity.ai',
      apiKey: process.env.TEXTRAL_API_KEY ?? '',
    });

const result = await client.query({
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
});

console.log(typeof result.answer === 'string' ? result.answer : JSON.stringify(result.answer, null, 2));
console.log(`citations:        ${result.citations?.length ?? 0}`);
console.log(`query_event_id:   ${result.query_event_id}`);
console.log(`retrieval_status: ${result.audit?.retrieval_status ?? '(none)'}`);

// CI assertion — runs only when CI is set + we got an API key.
if (process.env.CI && (!result.answer || (typeof result.answer === 'object' && !('text' in (result.answer as object))))) {
  console.error('quick-start: empty answer');
  process.exit(1);
}
