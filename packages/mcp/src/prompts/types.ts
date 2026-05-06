// Workflow prompt definition. Prompts are reusable, parameterized
// agent instructions — they don't *do* anything, they tell the
// agent what tools to call in what order.

import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';

export interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface PromptDef {
  name: string;
  description: string;
  arguments: PromptArgument[];
  render: (args: Record<string, unknown>) => GetPromptResult;
}
