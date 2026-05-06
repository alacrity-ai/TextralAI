"""Tokenizer wrapper — sanity for the cl100k_base encoding the chunker
budgets against."""

from __future__ import annotations

from app.cdm.tokens import count_tokens, decode, encode


def test_count_tokens_matches_round_trip() -> None:
    text = "The quick brown fox jumps over the lazy dog."
    ids = encode(text)
    assert count_tokens(text) == len(ids)
    assert decode(ids) == text


def test_count_tokens_handles_unicode() -> None:
    text = "naïve résumé — Москва"
    assert count_tokens(text) > 0
    assert decode(encode(text)) == text


def test_count_tokens_is_zero_for_empty_string() -> None:
    assert count_tokens("") == 0
