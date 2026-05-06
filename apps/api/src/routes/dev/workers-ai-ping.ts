// /dev/workers-ai-ping — one-shot Workers AI binding probe.
//
// Verifies that `env.ai.run(...)` works against the binding tier, both
// for chat (a known model that always answers) and embed (a known
// embedding model). ENABLE_DEBUG_ROUTES-gated; 404s in prod.
// Also 404s in self-host (no Workers AI binding available).

import { Hono } from 'hono';
import { WorkersAIBindingProvider } from '../../providers/workers-ai-binding.js';
import type { Env, Variables } from '../../types.js';

export const devWorkersAiPing = new Hono<{ Bindings: Env; Variables: Variables }>();

devWorkersAiPing.get('/', async (c) => {
  if (c.env.ENABLE_DEBUG_ROUTES !== 'true') return c.notFound();
  // 404 (not 501) when the binding is absent: this is a diagnostic
  // probe whose entire purpose is to verify the Workers AI binding
  // is wired. In self-host (no binding), the route is meaningless;
  // returning "not found" is the right semantics. Production
  // workers_ai usage 501s through `providers/registry.ts:resolve()`
  // with a remediation message — that's the user-facing path.
  if (!c.env.ai) return c.notFound();
  const provider = new WorkersAIBindingProvider(c.env.ai);
  const chat = await provider.chat(
    {
      model: '@cf/meta/llama-3.1-8b-instruct',
      messages: [{ role: 'user', content: 'reply with exactly the word PING' }],
      max_tokens: 16,
    },
    {},
  );
  const embed = await provider.embed(
    { model: '@cf/baai/bge-large-en-v1.5', input: ['ping', 'pong'] },
    {},
  );
  return c.json({
    chat: {
      outcome: chat.outcome,
      content:
        chat.outcome === 'success' || chat.outcome === 'degraded_success'
          ? chat.value.content
          : null,
      error:
        chat.outcome === 'fatal_error' || chat.outcome === 'retryable_error' ? chat.error : null,
    },
    embed: {
      outcome: embed.outcome,
      vector_count:
        embed.outcome === 'success' || embed.outcome === 'degraded_success'
          ? embed.value.vectors.length
          : 0,
      first_dim:
        embed.outcome === 'success' || embed.outcome === 'degraded_success'
          ? (embed.value.vectors[0]?.length ?? 0)
          : 0,
      error:
        embed.outcome === 'fatal_error' || embed.outcome === 'retryable_error' ? embed.error : null,
    },
  });
});
