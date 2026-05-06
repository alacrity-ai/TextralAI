// ingest_directory — bulk ingest local files into a namespace. The
// MCP server itself never reads the local filesystem; this prompt
// instructs the agent to use its own filesystem tool (Claude Code's
// fs, or a co-mounted filesystem MCP server) and feed bytes into
// `textral.ingest_file`.

import type { PromptDef } from './types.js';

export const ingestDirectoryPrompt: PromptDef = {
  name: 'ingest_directory',
  description: 'Ingest every supported file under a local directory into a Textral namespace.',
  arguments: [
    { name: 'directory', description: 'Absolute path to the directory of files', required: true },
    { name: 'namespace', description: 'Target namespace slug (created if missing)', required: true },
    { name: 'corpus_profile', description: 'Optional corpus profile (default: generic)', required: false },
    {
      name: 'embedding_profile',
      description: 'Optional embedding profile name (default: openai-text-embedding-3-large)',
      required: false,
    },
  ],
  render: (args) => {
    const directory = String(args.directory ?? '<directory>');
    const namespace = String(args.namespace ?? '<namespace>');
    const corpusProfile = args.corpus_profile ? String(args.corpus_profile) : 'generic';
    const embeddingProfile = args.embedding_profile
      ? String(args.embedding_profile)
      : 'openai-text-embedding-3-large';

    const text = `You are ingesting files from ${directory} into the Textral namespace "${namespace}".

Step 1 — Discover files.
Use your local filesystem tool (Claude Code's fs tools or a co-mounted
filesystem MCP server) to list every file under ${directory}. Filter
to supported types: .md, .txt, .pdf, .html, .docx.

Step 2 — Ensure the namespace exists.
Call \`textral.list_namespaces\` and check whether "${namespace}" is
present. If not, call \`textral.create_namespace\` with:
  slug: "${namespace}"
  corpus_profile: "${corpusProfile}"
  default_embedding_profile: "${embeddingProfile}"

Step 3 — Ingest each file.
For each file:
  - Read the bytes via your local filesystem tool.
  - Base64-encode them.
  - Call \`textral.ingest_file\` with:
      namespace: "${namespace}"
      bytes: <base64>
      content_type: <inferred from extension>
      title: <filename>
      embedding: { provider, model, ... }     // matching ${embeddingProfile}
      wait: false
  - Collect the returned job_id.

Step 4 — Confirm completion.
Either call \`textral.ingest_file\` with wait=true on each item (good
for small corpora), or for larger batches poll the job_ids by calling
\`textral.get_document\` and checking the document's current_version_id.
You can inspect any failure via \`textral.list_failing_jobs\`.

Step 5 — Report.
Return a markdown summary: file → chunk count → status. Halt and
report any failures rather than retrying blindly.`;

    return {
      description: `Ingest ${directory} → ${namespace}`,
      messages: [{ role: 'user', content: { type: 'text', text } }],
    };
  },
};
