// evaluate_namespace — Phase 1 placeholder. The underlying
// `run_eval_set` tool ships in Phase 2 alongside sandbox eval
// support. This prompt declares the surface so agent clients know
// it's coming.

import type { PromptDef } from './types.js';

export const evaluateNamespacePrompt: PromptDef = {
  name: 'evaluate_namespace',
  description: 'Run a Textral eval set against a namespace and synthesize a quality report. (Phase 2 — placeholder in Phase 1.)',
  arguments: [
    { name: 'namespace', description: 'Target namespace slug', required: true },
    { name: 'eval_set', description: 'Eval set slug or id', required: true },
  ],
  render: (args) => {
    const namespace = String(args.namespace ?? '<namespace>');
    const evalSet = String(args.eval_set ?? '<eval_set>');
    const text = `Run the Textral eval set "${evalSet}" against namespace "${namespace}".

This prompt is a Phase 1 placeholder. The underlying \`textral.run_eval_set\`
tool is not yet exposed; it ships in Phase 2 alongside sandbox eval
support. For now, an operator can run the eval contract via the
\`textral eval\` CLI in packages/eval-cli — see the README in that
package.

When the tool ships, this prompt will instruct you to:
  1. Call textral.run_eval_set(namespace="${namespace}", eval_set="${evalSet}", wait=true).
  2. Tabulate per-question pass/fail + judge scores.
  3. Produce a markdown quality report with a one-sentence verdict.`;
    return {
      description: `Evaluate ${namespace} against ${evalSet} (placeholder)`,
      messages: [{ role: 'user', content: { type: 'text', text } }],
    };
  },
};
