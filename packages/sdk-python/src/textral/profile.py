"""`~/.textral/profiles.toml` resolver — the Python parallel of
@textral/profiles. Same file format, same precedence chain. A single
profiles.toml file works for both Node and Python SDKs and the MCP
server simultaneously.

Precedence chain (top → bottom; first match wins):

    1. Constructor `{ baseUrl/api_key, base_url, api_key }`
    2. `name` argument → file lookup
    3. `TEXTRAL_PROFILE` env var → file lookup
    4. File's `default = "..."` field
    5. Lex-first profile in the file
    6. Synth `_env` profile from `TEXTRAL_BASE_URL` + `TEXTRAL_API_KEY`
    7. Raise `TextralProfileNotFound`

The profile file lives at `~/.textral/profiles.toml` by default;
overridable via `TEXTRAL_CONFIG_DIR`.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

if sys.version_info >= (3, 11):
    import tomllib
else:  # pragma: no cover — exercised only on Python 3.10
    import tomli as tomllib  # type: ignore[import-not-found]

from .errors import TextralProfileNotFound

FILE_NAME = "profiles.toml"


@dataclass(frozen=True)
class Profile:
    """A resolved (name, base_url, api_key) tuple. The `name` is
    `_explicit` when the caller passed `base_url`/`api_key`
    directly, `_env` when synthesized from env vars, or the
    user-defined name from the file."""

    name: str
    base_url: str
    api_key: str


def config_dir() -> Path:
    """Resolve the Textral config dir.

    `TEXTRAL_CONFIG_DIR` env var wins (CI / sandboxed test envs use
    this); otherwise `${HOME}/.textral`."""
    override = os.environ.get("TEXTRAL_CONFIG_DIR")
    if override:
        return Path(override).expanduser()
    return Path.home() / ".textral"


def config_path() -> Path:
    return config_dir() / FILE_NAME


def load_profile_file() -> dict[str, Any] | None:
    """Read the profiles.toml file. Returns the raw dict (with
    `default: str` and `profiles: dict[str, dict]` keys), or None
    when the file doesn't exist. Raises ValueError on malformed
    TOML or missing required fields."""
    path = config_path()
    if not path.exists():
        return None

    # Permissions check — non-fatal warning. Skipped on Windows
    # where mode bits don't work this way.
    if hasattr(path, "stat") and os.name != "nt":
        try:
            mode = path.stat().st_mode & 0o777
            if mode & 0o077:
                sys.stderr.write(
                    f"[textral] warning: {path} is mode 0{oct(mode)[2:]}; "
                    "recommend `chmod 600` (it contains bearer credentials)\n"
                )
        except OSError:
            pass

    try:
        data: dict[str, Any] = tomllib.loads(path.read_text())
    except tomllib.TOMLDecodeError as e:
        raise ValueError(f"{path}: failed to parse TOML — {e}") from e

    if "profiles" not in data or not isinstance(data["profiles"], dict):
        raise ValueError(
            f"{path}: missing [profiles.*] table. "
            'See docs/mcp/QUICKSTART.md §"Profiles" for the expected shape.'
        )

    for name, body in data["profiles"].items():
        if not isinstance(body, dict):
            raise ValueError(f"{path}: profile {name!r} is not a table")
        if not isinstance(body.get("base_url"), str) or not body["base_url"]:
            raise ValueError(f"{path}: profile {name!r} missing required `base_url`")
        if not isinstance(body.get("api_key"), str) or not body["api_key"]:
            raise ValueError(f"{path}: profile {name!r} missing required `api_key`")

    if "default" in data and not isinstance(data["default"], str):
        raise ValueError(f"{path}: `default` must be a string if set")

    return data


def resolve_profile(
    *,
    name: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
) -> Profile:
    """SDK-friendly resolver. See module docstring for precedence."""
    # 1. Explicit constructor args win.
    if base_url and api_key:
        return Profile(name="_explicit", base_url=base_url, api_key=api_key)

    # 2. Named profile from the file.
    if name:
        file = load_profile_file()
        if file is None:
            # `_env` is a magic name that maps to the env-var synth
            # path even when no file exists. Other names hard-fail.
            if name == "_env":
                env_url = os.environ.get("TEXTRAL_BASE_URL")
                env_key = os.environ.get("TEXTRAL_API_KEY")
                if env_url and env_key:
                    return Profile(name="_env", base_url=env_url, api_key=env_key)
            raise TextralProfileNotFound(
                name,
                f"Profile {name!r} requested but {config_path()} doesn't exist. "
                "Create it (see docs/mcp/QUICKSTART.md), or pass {base_url, api_key} explicitly.",
            )
        profiles = file.get("profiles", {})
        if name not in profiles:
            available = sorted(profiles.keys())
            raise TextralProfileNotFound(
                name,
                f"Profile {name!r} not in {config_path()}. "
                f"Available: {', '.join(available) or '(none)'}",
            )
        p = profiles[name]
        return Profile(name=name, base_url=p["base_url"], api_key=p["api_key"])

    # 3-6. Fall through to the precedence chain on TEXTRAL_PROFILE
    # env / file.default / lex-first / env-vars synth.
    return _resolve_active_profile()


def _resolve_active_profile() -> Profile:
    """Internal: implements rungs 3–6 of the precedence chain."""
    file = load_profile_file()
    env_profile = os.environ.get("TEXTRAL_PROFILE")

    if file is not None:
        profiles = file.get("profiles", {})
        available = sorted(profiles.keys())

        # 3. TEXTRAL_PROFILE env var → file lookup.
        if env_profile:
            if env_profile not in profiles:
                raise TextralProfileNotFound(
                    env_profile,
                    f"TEXTRAL_PROFILE={env_profile!r} not in {config_path()}. "
                    f"Available: {', '.join(available) or '(none)'}",
                )
            p = profiles[env_profile]
            return Profile(name=env_profile, base_url=p["base_url"], api_key=p["api_key"])

        # 4. File's `default = "..."`.
        default = file.get("default")
        if isinstance(default, str):
            if default not in profiles:
                raise TextralProfileNotFound(
                    default,
                    f"{config_path()}: default = {default!r} but no [profiles.{default}] table. "
                    f"Available: {', '.join(available) or '(none)'}",
                )
            p = profiles[default]
            return Profile(name=default, base_url=p["base_url"], api_key=p["api_key"])

        # 5. Lex-first profile.
        if not available:
            raise TextralProfileNotFound("<unspecified>", f"{config_path()}: no profiles defined")
        first = available[0]
        p = profiles[first]
        return Profile(name=first, base_url=p["base_url"], api_key=p["api_key"])

    # 6. Synth `_env` from TEXTRAL_BASE_URL + TEXTRAL_API_KEY.
    env_url = os.environ.get("TEXTRAL_BASE_URL")
    env_key = os.environ.get("TEXTRAL_API_KEY")
    if env_url and env_key:
        return Profile(name="_env", base_url=env_url, api_key=env_key)

    # 7. Hard fail.
    raise TextralProfileNotFound(
        env_profile or "<unspecified>",
        "No Textral profile configured. Either:\n"
        f"  1. Create {config_path()} with [profiles.*] tables, or\n"
        "  2. Set TEXTRAL_BASE_URL + TEXTRAL_API_KEY env vars on the launch command.",
    )
