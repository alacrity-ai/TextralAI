"""Test config. Forces TEXTRAL_CONFIG_DIR + clears env vars per
test so profile resolution is deterministic across runs."""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest

_PROFILE_ENV_VARS = ("TEXTRAL_PROFILE", "TEXTRAL_BASE_URL", "TEXTRAL_API_KEY")


@pytest.fixture(autouse=True)
def isolated_config(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """Each test gets its own empty config dir. Profile env vars
    are cleared so prior shell state can't leak in."""
    config = tmp_path / ".textral"
    config.mkdir()
    monkeypatch.setenv("TEXTRAL_CONFIG_DIR", str(config))
    for var in _PROFILE_ENV_VARS:
        monkeypatch.delenv(var, raising=False)
    yield config


@pytest.fixture
def asyncio_default_fixture_loop_scope() -> str:
    """Pin pytest-asyncio's default loop scope to silence its
    'unset / will change' deprecation warning."""
    return "function"


def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line(
        "filterwarnings",
        "ignore::DeprecationWarning:pytest_asyncio",
    )


# Suppress unused-import flagging.
_ = os
