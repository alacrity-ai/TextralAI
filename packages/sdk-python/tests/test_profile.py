"""Profile resolver tests. Each rung of the precedence chain is
exercised individually + a few interaction cases.

Cross-language parity: a fixture profiles.toml file used here is
also used by @textral/profiles' tests. If you change the file,
update both sides — the whole point of profiles.toml is that the
two SDKs agree on its meaning."""

from __future__ import annotations

from pathlib import Path

import pytest

from textral.errors import TextralProfileNotFound
from textral.profile import Profile, load_profile_file, resolve_profile


def _write(p: Path, contents: str) -> None:
    p.write_text(contents)


def test_explicit_args_win(isolated_config: Path) -> None:
    """Constructor args trump every other rung."""
    _write(
        isolated_config / "profiles.toml",
        'default = "ignored"\n[profiles.ignored]\nbase_url = "x"\napi_key = "y"\n',
    )
    p = resolve_profile(base_url="https://api.test", api_key="key-1")
    assert p == Profile(name="_explicit", base_url="https://api.test", api_key="key-1")


def test_named_profile_lookup(isolated_config: Path) -> None:
    _write(
        isolated_config / "profiles.toml",
        '[profiles.staging]\nbase_url = "https://staging.example"\napi_key = "stg-key"\n',
    )
    p = resolve_profile(name="staging")
    assert p == Profile(
        name="staging", base_url="https://staging.example", api_key="stg-key"
    )


def test_named_profile_missing(isolated_config: Path) -> None:
    _write(
        isolated_config / "profiles.toml",
        '[profiles.prod]\nbase_url = "x"\napi_key = "y"\n',
    )
    with pytest.raises(TextralProfileNotFound) as exc:
        resolve_profile(name="staging")
    assert exc.value.profile_name == "staging"
    assert "Available: prod" in str(exc.value)


def test_named_profile_no_file_falls_back_to_env(
    isolated_config: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Asking for `_env` by name bypasses the file requirement and
    pulls from env vars — matches the TS behavior."""
    monkeypatch.setenv("TEXTRAL_BASE_URL", "https://e.example")
    monkeypatch.setenv("TEXTRAL_API_KEY", "env-key")
    p = resolve_profile(name="_env")
    assert p.name == "_env"
    assert p.base_url == "https://e.example"
    assert p.api_key == "env-key"


def test_env_profile_var(isolated_config: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write(
        isolated_config / "profiles.toml",
        '[profiles.dev]\nbase_url = "https://d.example"\napi_key = "dev-key"\n'
        '[profiles.prod]\nbase_url = "https://p.example"\napi_key = "prod-key"\n',
    )
    monkeypatch.setenv("TEXTRAL_PROFILE", "prod")
    p = resolve_profile()
    assert p.name == "prod"
    assert p.base_url == "https://p.example"


def test_env_profile_var_unknown(isolated_config: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write(
        isolated_config / "profiles.toml",
        '[profiles.dev]\nbase_url = "x"\napi_key = "y"\n',
    )
    monkeypatch.setenv("TEXTRAL_PROFILE", "doesnotexist")
    with pytest.raises(TextralProfileNotFound):
        resolve_profile()


def test_default_field(isolated_config: Path) -> None:
    _write(
        isolated_config / "profiles.toml",
        'default = "prod"\n'
        '[profiles.dev]\nbase_url = "x"\napi_key = "y"\n'
        '[profiles.prod]\nbase_url = "https://p.example"\napi_key = "prod-key"\n',
    )
    p = resolve_profile()
    assert p.name == "prod"


def test_lex_first_when_no_default(isolated_config: Path) -> None:
    _write(
        isolated_config / "profiles.toml",
        '[profiles.zzz]\nbase_url = "https://z.example"\napi_key = "z-key"\n'
        '[profiles.aaa]\nbase_url = "https://a.example"\napi_key = "a-key"\n',
    )
    p = resolve_profile()
    assert p.name == "aaa"


def test_synth_env_profile_when_no_file(
    isolated_config: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TEXTRAL_BASE_URL", "https://e.example")
    monkeypatch.setenv("TEXTRAL_API_KEY", "env-key")
    p = resolve_profile()
    assert p.name == "_env"
    assert p.base_url == "https://e.example"


def test_no_credentials_raises(isolated_config: Path) -> None:
    with pytest.raises(TextralProfileNotFound) as exc:
        resolve_profile()
    msg = str(exc.value)
    assert "TEXTRAL_BASE_URL" in msg
    assert "profiles.toml" in msg


def test_malformed_toml_raises(isolated_config: Path) -> None:
    _write(isolated_config / "profiles.toml", "this is not [valid toml")
    with pytest.raises(ValueError, match="failed to parse TOML"):
        load_profile_file()


def test_missing_required_field_raises(isolated_config: Path) -> None:
    _write(
        isolated_config / "profiles.toml",
        '[profiles.broken]\nbase_url = "x"\n',  # no api_key
    )
    with pytest.raises(ValueError, match="missing required"):
        load_profile_file()


def test_default_pointing_to_missing_profile(isolated_config: Path) -> None:
    _write(
        isolated_config / "profiles.toml",
        'default = "ghost"\n[profiles.real]\nbase_url = "x"\napi_key = "y"\n',
    )
    with pytest.raises(TextralProfileNotFound):
        resolve_profile()
