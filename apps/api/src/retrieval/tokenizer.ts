// js-tiktoken cl100k_base wrapper. Same family as the OpenAI embed
// model so context budgets are honest with what the model sees.

import { Tiktoken } from 'js-tiktoken/lite';
import cl100kBase from 'js-tiktoken/ranks/cl100k_base';

let _enc: Tiktoken | null = null;

function enc(): Tiktoken {
  if (!_enc) _enc = new Tiktoken(cl100kBase);
  return _enc;
}

export function countTokens(text: string): number {
  return enc().encode(text).length;
}
