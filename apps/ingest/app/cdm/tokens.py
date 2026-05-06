"""tiktoken wrapper. The chunker honors the *embed model's* tokenizer so
budgets are honest with the provider, not with a generic estimate."""

from __future__ import annotations

import tiktoken

# cl100k_base covers the OpenAI text-embedding-3-* family and gpt-4*.
_ENC = tiktoken.get_encoding("cl100k_base")


def count_tokens(text: str) -> int:
    return len(_ENC.encode(text))


def encode(text: str) -> list[int]:
    return _ENC.encode(text)


def decode(ids: list[int]) -> str:
    return _ENC.decode(ids)
