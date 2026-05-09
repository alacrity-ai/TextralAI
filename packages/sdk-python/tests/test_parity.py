"""Cross-language parity tests. The same fixture file lives in
`packages/profiles/tests/fixtures/profiles.toml` (Node side) and
`packages/sdk-python/tests/fixtures/profiles.toml` (Python side);
both sides MUST resolve it the same way.

If you change `tests/fixtures/profiles.toml`, update its twin in
@textral/profiles AND update the assertions in BOTH files.

The Python side is the only side this test file checks. The Node
parity test mirrors these exact same assertions over there."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from textral.profile import resolve_profile

FIXTURE = Path(__file__).parent / "fixtures" / "profiles.toml"


@pytest.fixture(autouse=True)
def install_fixture(isolated_config: Path) -> None:
    """Copy the parity fixture into the test's isolated config dir."""
    shutil.copy(FIXTURE, isolated_config / "profiles.toml")


def test_parity_default_resolves_to_prod() -> None:
    """File specifies `default = "prod"`. With no other inputs, that
    wins."""
    p = resolve_profile()
    assert p.name == "prod"
    assert p.base_url == "https://api.example.com"
    assert p.api_key == "prod-fixture-key"


def test_parity_named_dev() -> None:
    p = resolve_profile(name="dev")
    assert p.name == "dev"
    assert p.base_url == "https://dev.example/api"
    assert p.api_key == "dev-fixture-key"


def test_parity_env_var_overrides_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TEXTRAL_PROFILE", "staging")
    p = resolve_profile()
    assert p.name == "staging"
    assert p.base_url == "https://staging.example/api"


def test_parity_explicit_args_override_everything(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TEXTRAL_PROFILE", "staging")
    p = resolve_profile(base_url="https://override.example", api_key="override-key")
    assert p.name == "_explicit"
    assert p.base_url == "https://override.example"
    assert p.api_key == "override-key"
