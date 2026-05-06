// Provider request / response schemas.
//
// Public-API shapes that the Worker accepts and emits for chat,
// embedding, and rerank operations. The internal `apps/api/src/providers`
// types mirror these (TypeScript interfaces); these Zod schemas are the
// validation layer the Worker applies at the route boundary.

import { z } from 'zod';

// ── Inputs ──────────────────────────────────────────────────────────────

export const ChatMessage = z.union([
  z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string(),
  }),
  z.object({
    role: z.literal('developer'),
    content: z.string(),
  }),
]);
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ResponseFormat = z.union([
  z.object({ type: z.literal('text') }),
  z.object({ type: z.literal('json_object') }),
  z.object({
    type: z.literal('json_schema'),
    schema: z.record(z.string(), z.unknown()),
    name: z.string().optional(),
    strict: z.boolean().optional(),
  }),
]);
export type ResponseFormat = z.infer<typeof ResponseFormat>;

export const ChatRequest = z.object({
  model: z.string().min(1),
  messages: z.array(ChatMessage).min(1),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  response_format: ResponseFormat.optional(),
  stop: z.array(z.string()).optional(),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

export const EmbeddingRequest = z.object({
  model: z.string().min(1),
  input: z.array(z.string()).min(1),
});
export type EmbeddingRequest = z.infer<typeof EmbeddingRequest>;

export const RerankRequest = z.object({
  model: z.string().min(1),
  query: z.string().min(1),
  documents: z.array(z.string()).min(1),
  top_n: z.number().int().positive().optional(),
});
export type RerankRequest = z.infer<typeof RerankRequest>;

// ── Outputs ─────────────────────────────────────────────────────────────

export const ChatResponse = z.object({
  content: z.string(),
  parsed: z.unknown().optional(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
  model: z.string(),
  finish_reason: z.enum(['stop', 'length', 'tool_use', 'content_filter', 'other']),
});
export type ChatResponse = z.infer<typeof ChatResponse>;

export const EmbeddingResponse = z.object({
  vectors: z.array(z.array(z.number())),
  model: z.string(),
  usage: z.object({ input_tokens: z.number().int().nonnegative() }),
});
export type EmbeddingResponse = z.infer<typeof EmbeddingResponse>;

export const RerankResponse = z.object({
  results: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      score: z.number(),
    }),
  ),
  model: z.string(),
});
export type RerankResponse = z.infer<typeof RerankResponse>;
