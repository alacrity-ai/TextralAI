import type { PromptDef } from './types.js';
import { ingestDirectoryPrompt } from './ingest-directory.js';
import { compareRetrievalConfigsPrompt } from './compare-retrieval-configs.js';
import { evaluateNamespacePrompt } from './evaluate-namespace.js';

export const allPrompts: PromptDef[] = [
  ingestDirectoryPrompt,
  compareRetrievalConfigsPrompt,
  evaluateNamespacePrompt,
];
