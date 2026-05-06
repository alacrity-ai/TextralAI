// Prompt construction.
//
// Resolves system + developer prompts with namespace + profile defaults.
// Appends the mandatory platform suffix after the consumer's developer
// prompt — the platform owns citation integrity and this is non-
// negotiable.

import type { ChatMessage } from '@textral/contracts';

const MANDATORY_SUFFIX = `
You must cite the chunks you used by their numeric ID. Format: [N].
Cite only chunks that appear in the provided context.
`.trim();

export interface PromptArgs {
  system: string | null;
  developer: string | null;
  user_query: string;
  context_block: string;
}

export function buildMessages(args: PromptArgs): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (args.system) {
    messages.push({ role: 'system', content: args.system });
  }
  const dev = args.developer ? `${args.developer}\n\n${MANDATORY_SUFFIX}` : MANDATORY_SUFFIX;
  messages.push({ role: 'developer', content: dev });
  const userBlock = `${args.user_query}\n\n--- Retrieved context ---\n${args.context_block}`;
  messages.push({ role: 'user', content: userBlock });
  return messages;
}

export { MANDATORY_SUFFIX };
