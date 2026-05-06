// compare_retrieval_configs — sandbox's Compare page exposed as a
// prompt. The agent runs the same query under two retrieval configs
// and reports a markdown diff (citation overlap, ordering shifts,
// degradation differences).

import type { PromptDef } from './types.js';

export const compareRetrievalConfigsPrompt: PromptDef = {
  name: 'compare_retrieval_configs',
  description: 'Run the same query under two retrieval configs and report a markdown diff.',
  arguments: [
    { name: 'namespace', description: 'Target namespace slug', required: true },
    { name: 'query', description: 'The natural-language question to ask', required: true },
    {
      name: 'config_a',
      description: 'JSON of the first retrieval config (RetrievalConfig contract shape)',
      required: true,
    },
    {
      name: 'config_b',
      description: 'JSON of the second retrieval config',
      required: true,
    },
  ],
  render: (args) => {
    const namespace = String(args.namespace ?? '<namespace>');
    const query = String(args.query ?? '<query>');
    const configA = String(args.config_a ?? '{}');
    const configB = String(args.config_b ?? '{}');

    const text = `Compare two retrieval configurations on namespace "${namespace}".

Question: ${query}

Config A: ${configA}
Config B: ${configB}

Procedure:
1. Call \`textral.query\` twice — once with retrieval=Config A, once
   with retrieval=Config B. Use identical embedding/inference/prompt
   settings; only \`retrieval\` differs.
2. Capture each response's:
   - answer.mode + answer.text/object
   - degradation_level
   - citations[] (n, chunk_id, section_path)
   - audit.retrieval_status, audit.candidate_count
   - audit.tokens (so you can compare cost)
3. Produce a markdown report:
   ## Question
   ## Config A
     - Answer (truncated to ~500 chars)
     - Degradation level
     - Citations table
   ## Config B
     - same
   ## Diff
     - Citation overlap (set intersection on chunk_id)
     - Citations only in A / only in B
     - Did the answer text change materially? (yes/no + brief
       characterization)
     - Cost delta (tokens)
4. End with a one-sentence recommendation. Halt — do not implement
   the change yourself.`;

    return {
      description: `Compare retrieval configs on ${namespace}`,
      messages: [{ role: 'user', content: { type: 'text', text } }],
    };
  },
};
