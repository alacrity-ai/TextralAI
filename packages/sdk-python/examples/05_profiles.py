"""05_profiles.py — `~/.textral/profiles.toml` resolution.

Demonstrates: explicit `profile=` argument, the default precedence
chain, listing available profiles. Same precedence as the Node
SDK and the MCP server — one config file feeds all three.

Run:
    python 05_profiles.py

See also:
    docs/development/sdks/SDK_COOKBOOK_OUTLINE.md §6
"""

from __future__ import annotations

import sys

from textral import (
    Client,
    Profile,
    TextralProfileNotFound,
    config_path,
    load_profile_file,
    resolve_profile,
)


def main() -> None:
    print(f"profiles file: {config_path()}")
    file = load_profile_file()
    if file is None:
        print("(no profiles.toml — falling back to env vars)")
    else:
        names = sorted(file.get("profiles", {}).keys())
        default = file.get("default")
        print(f"available: {', '.join(names) or '(none)'}")
        if default:
            print(f"default:   {default}")

    # Default precedence chain. Picks `default`, lex-first, or env
    # var synth depending on what's available.
    try:
        active: Profile = resolve_profile()
        print(f"active:    {active.name} → {active.base_url}")
    except TextralProfileNotFound as e:
        print(f"no active profile: {e}", file=sys.stderr)
        sys.exit(1)

    # Explicit profile lookup (commented out — uncomment after
    # adding a "staging" profile to your file):
    #
    #     with Client(profile="staging") as c:
    #         print(c.me())

    # Default falls through the precedence chain.
    with Client() as c:
        me = c.me()
        print(f"workspace: {me.get('workspace_id', '(unknown)')}")


if __name__ == "__main__":
    main()
