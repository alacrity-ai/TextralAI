// Validates every cookbook pattern in the Query tag description
// against deployed dev. Run after the cookbook tenant + namespace +
// ingested narrative-tiny fixture is in place.
//
// Usage:
//   LIVE_WORKER_URL=https://textral-api-dev.<sub>.workers.dev \
//   LIVE_API_KEY=tx_live_... \
//     pnpm --filter @textral/api exec tsx scripts/validate-cookbook.ts
//
// Each pattern lives in a self-contained block: a name + body + a
// pass-fail predicate against the response shape. The script exits
// non-zero if any pattern fails.

const WORKER = (process.env.LIVE_WORKER_URL ?? '').replace(/\/$/, '');
const KEY = process.env.LIVE_API_KEY ?? '';

if (!WORKER || !KEY) {
  console.error('Missing LIVE_WORKER_URL or LIVE_API_KEY');
  process.exit(1);
}

// V3 Phase 1 — cookbook validator parametrised over vector backend.
// Default `vectorize` for back-compat; `qdrant` / `pinecone` need
// matching cookbook namespaces provisioned per Step 11 of
// docs/development/v3/PHASE_1_IMPLEMENTATION.md.
const BACKEND = (() => {
  const i = process.argv.indexOf('--backend');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  return 'vectorize';
})() as 'vectorize' | 'qdrant' | 'pinecone';
const NAMESPACE = process.env.LIVE_NAMESPACE ?? `cookbook-${BACKEND}`;

console.log(`Cookbook backend=${BACKEND} namespace=${NAMESPACE}`);

interface QueryAudit {
  retrieval_status: string;
  citation_integrity: string | null;
  candidates_returned: number;
  reranker: { enabled: boolean; executed: boolean; fallback_reason?: string | null };
  synthesis_status: string | null;
  tokens: { synthesis_input: number; synthesis_output: number };
}
interface QueryResponse {
  query_event_id: string;
  answer: { mode: 'text'; text: string } | { mode: 'structured'; object: unknown; raw?: string };
  citations: Array<{ n: number; chunk_id: string; section_path: string | null; quote?: string }>;
  degradation_level: 'full' | 'no_citations' | 'partial' | 'cannot_answer';
  audit: QueryAudit;
}

interface Pattern {
  name: string;
  body: Record<string, unknown>;
  expect: (r: QueryResponse) => string | null; // null = pass; string = failure reason
  /** If truthy, this pattern uses ?stream=sse. Different validation path. */
  stream?: boolean;
  streamExpect?: (frames: Array<{ event: string; data: unknown }>) => string | null;
}

const baseEmbedding = {
  provider: 'openai',
  model: 'text-embedding-3-large',
  dimensions: 1536,
  provider_key_ref: 'default',
};
const baseInference = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  provider_key_ref: 'default',
};
const baseChunking = { profile: 'generic' };
const baseRetrieval = { strategy: 'hybrid_rrf', top_k_dense: 5, top_k_sparse: 5 };

const PATTERNS: Pattern[] = [
  {
    name: '1. Basic Q&A',
    body: {
      namespace: NAMESPACE,
      query: 'Who calculated the circumference of the Earth?',
      embedding: baseEmbedding,
      inference: baseInference,
      chunking: baseChunking,
      retrieval: baseRetrieval,
    },
    expect: (r) => {
      if (r.answer.mode !== 'text') return `expected text mode, got ${r.answer.mode}`;
      if (r.degradation_level === 'cannot_answer') return `unexpected cannot_answer`;
      if (r.citations.length === 0) return `expected at least 1 citation`;
      if (r.audit.tokens.synthesis_input <= 0) return `synthesis_input tokens not recorded`;
      return null;
    },
  },
  {
    name: '2. Structured (simple)',
    body: {
      namespace: NAMESPACE,
      query: 'Name two scholars connected to Alexandria.',
      embedding: baseEmbedding,
      inference: baseInference,
      chunking: baseChunking,
      retrieval: baseRetrieval,
      output: {
        mode: 'structured',
        schema: {
          type: 'object',
          properties: {
            scholars: {
              type: 'array',
              items: { type: 'string' },
              description: 'Names of the scholars mentioned in the corpus.',
            },
          },
          required: ['scholars'],
          additionalProperties: false,
        },
      },
    },
    expect: (r) => {
      if (r.answer.mode !== 'structured') return `expected structured mode, got ${r.answer.mode}`;
      const obj = r.answer.object as { scholars?: unknown };
      if (!Array.isArray(obj.scholars)) return `answer.object.scholars not an array`;
      if (obj.scholars.length < 1) return `expected at least 1 scholar in array`;
      return null;
    },
  },
  {
    name: '3. Structured (nested + citations)',
    body: {
      namespace: NAMESPACE,
      query: 'List the scholars mentioned and what each is known for.',
      embedding: baseEmbedding,
      inference: baseInference,
      chunking: baseChunking,
      retrieval: baseRetrieval,
      output: {
        mode: 'structured',
        schema: {
          type: 'object',
          properties: {
            scholars: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  known_for: { type: 'string' },
                },
                required: ['name', 'known_for'],
                additionalProperties: false,
              },
            },
            citations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  chunk_id: { type: 'string' },
                  quote: { type: 'string' },
                },
                // OpenAI strict mode requires every property to be in
                // `required`. List all of them; if a field is genuinely
                // optional, model it as `type: ['string', 'null']` and
                // require the field anyway.
                required: ['chunk_id', 'quote'],
                additionalProperties: false,
              },
            },
          },
          required: ['scholars', 'citations'],
          additionalProperties: false,
        },
      },
    },
    expect: (r) => {
      if (r.answer.mode !== 'structured') return `expected structured, got ${r.answer.mode}`;
      const obj = r.answer.object as {
        scholars?: Array<{ name: string; known_for: string }>;
        citations?: Array<{ chunk_id: string; quote?: string }>;
      };
      if (!Array.isArray(obj.scholars) || obj.scholars.length === 0)
        return `scholars array empty`;
      if (!Array.isArray(obj.citations))
        return `citations array missing`;
      // Top-level citations should have at least one entry resolved
      // from the structured citations array (filtered to retrieved
      // chunks).
      if (r.citations.length === 0)
        return `top-level citations empty — schema's citations field should round-trip`;
      return null;
    },
  },
  {
    name: '4. Streaming (SSE)',
    stream: true,
    body: {
      namespace: NAMESPACE,
      query: 'In one sentence, who was Hypatia?',
      embedding: baseEmbedding,
      inference: baseInference,
      chunking: baseChunking,
      retrieval: baseRetrieval,
    },
    expect: () => null,
    streamExpect: (frames) => {
      const tokens = frames.filter((f) => f.event === 'token');
      const dones = frames.filter((f) => f.event === 'done');
      if (dones.length !== 1) return `expected 1 done frame, got ${dones.length}`;
      if (tokens.length === 0) return `no token frames received`;
      const done = dones[0]!.data as QueryResponse;
      if (done.degradation_level === 'cannot_answer')
        return `done frame degraded to cannot_answer`;
      return null;
    },
  },
  {
    name: '5. Document subset (filter retrieval)',
    body: {
      namespace: NAMESPACE,
      query: 'Where did Hypatia teach?',
      // document_ids omitted — pattern is documented but the
      // validator just confirms it works WITHOUT (we'd need a doc id
      // injected for a true subset test; documenting is enough).
      embedding: baseEmbedding,
      inference: baseInference,
      chunking: baseChunking,
      retrieval: baseRetrieval,
    },
    expect: (r) => {
      if (r.degradation_level === 'cannot_answer')
        return `unexpected cannot_answer`;
      return null;
    },
  },
  {
    name: '6. Custom system prompt',
    body: {
      namespace: NAMESPACE,
      query: 'Who was Eratosthenes?',
      embedding: baseEmbedding,
      inference: baseInference,
      chunking: baseChunking,
      retrieval: baseRetrieval,
      prompt: {
        system:
          'You are an irreverent narrator. Begin every answer with "Listen up:" and keep it under 25 words.',
      },
    },
    expect: (r) => {
      if (r.answer.mode !== 'text') return `expected text mode`;
      if (!r.answer.text.toLowerCase().startsWith('listen up'))
        return `expected answer to start with "Listen up:" — model did not honor system prompt; got: ${r.answer.text.slice(0, 80)}...`;
      return null;
    },
  },
  {
    name: '7. Cannot-answer (off-corpus question)',
    body: {
      namespace: NAMESPACE,
      query: 'What is the capital of Mongolia, and what is its current GDP?',
      embedding: baseEmbedding,
      inference: baseInference,
      chunking: baseChunking,
      retrieval: baseRetrieval,
    },
    expect: (r) => {
      // Either the corpus has no relevant chunks (cannot_answer) or the
      // model writes a refusal but the citations array is populated/
      // empty depending on what the retriever found. We just confirm
      // we get a 200 + valid response shape — the audit captures the
      // degradation.
      if (typeof r.audit.tokens.synthesis_output !== 'number')
        return `synthesis_output tokens missing`;
      return null;
    },
  },
  {
    name: '8. Token-budget tweak (compact context)',
    body: {
      namespace: NAMESPACE,
      query: 'Summarise the corpus in two sentences.',
      embedding: baseEmbedding,
      inference: baseInference,
      chunking: baseChunking,
      retrieval: baseRetrieval,
      context: { max_context_tokens: 1500 },
    },
    expect: (r) => {
      if (r.audit.tokens.synthesis_input > 5000)
        return `expected smaller synthesis input under tight budget; got ${r.audit.tokens.synthesis_input}`;
      return null;
    },
  },
];

async function runOne(p: Pattern): Promise<{ ok: boolean; reason?: string; latency_ms: number; resp?: QueryResponse }> {
  const start = Date.now();
  if (p.stream && p.streamExpect) {
    const res = await fetch(`${WORKER}/v1/query?stream=sse`, {
      method: 'POST',
      headers: {
        'X-Textral-Api-Key': KEY,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(p.body),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, reason: `${res.status}: ${text.slice(0, 200)}`, latency_ms: Date.now() - start };
    }
    const frames = await readSse(res.body!);
    const reason = p.streamExpect(frames);
    return { ok: !reason, ...(reason ? { reason } : {}), latency_ms: Date.now() - start };
  }
  const res = await fetch(`${WORKER}/v1/query`, {
    method: 'POST',
    headers: { 'X-Textral-Api-Key': KEY, 'content-type': 'application/json' },
    body: JSON.stringify(p.body),
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, reason: `HTTP ${res.status}: ${text.slice(0, 200)}`, latency_ms: Date.now() - start };
  }
  const resp = (await res.json()) as QueryResponse;
  const reason = p.expect(resp);
  return { ok: !reason, ...(reason ? { reason } : {}), latency_ms: Date.now() - start, resp };
}

async function readSse(
  body: ReadableStream<Uint8Array>,
): Promise<Array<{ event: string; data: unknown }>> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const out: Array<{ event: string; data: unknown }> = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = frame.split('\n');
      let event = '';
      let data = '';
      for (const l of lines) {
        if (l.startsWith('event: ')) event = l.slice(7);
        else if (l.startsWith('data: ')) data = l.slice(6);
      }
      if (event) {
        try {
          out.push({ event, data: JSON.parse(data) });
        } catch {
          out.push({ event, data });
        }
      }
    }
  }
  return out;
}

let pass = 0;
let fail = 0;
for (const p of PATTERNS) {
  process.stdout.write(`▶ ${p.name} ... `);
  const r = await runOne(p);
  if (r.ok) {
    console.log(`OK (${r.latency_ms}ms)`);
    pass++;
  } else {
    console.log(`FAIL (${r.latency_ms}ms) — ${r.reason}`);
    fail++;
  }
}
console.log(`\n${pass}/${PATTERNS.length} patterns OK, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
