"""01_quick_start.py — One query, one cited answer.

The "would I keep reading this README?" example. Three lines of
SDK call between configuration and a real cited answer.

Env:
    TEXTRAL_API_KEY          (required if no profile is configured)
    TEXTRAL_BASE_URL         (optional)
    TEXTRAL_PROFILE          (optional; from ~/.textral/profiles.toml)
    TEXTRAL_NAMESPACE        (optional; defaults to "cookbook")
    TEXTRAL_PROVIDER_KEY_REF (optional; defaults to "openai")

Run:
    python 01_quick_start.py

See also:
    docs/development/sdks/SDK_COOKBOOK_OUTLINE.md §2
"""

from __future__ import annotations

import json
import os
import sys

from textral import Client


def main() -> None:
    namespace = os.environ.get("TEXTRAL_NAMESPACE", "cookbook")
    provider_key_ref = os.environ.get("TEXTRAL_PROVIDER_KEY_REF", "openai")

    with Client() as client:  # falls through profile precedence chain
        result = client.query(
            namespace=namespace,
            query="What survived the Library of Alexandria?",
            embedding={
                "provider": "openai",
                "model": "text-embedding-3-large",
                "dimensions": 1536,
                "provider_key_ref": provider_key_ref,
            },
            inference={
                "provider": "openai",
                "model": "gpt-4o-mini",
                "provider_key_ref": provider_key_ref,
            },
        )

    answer = result.get("answer")
    if isinstance(answer, str):
        print(answer)
    else:
        print(json.dumps(answer, indent=2))
    print(f"citations:        {len(result.get('citations') or [])}")
    print(f"query_event_id:   {result.get('query_event_id')}")
    audit = result.get("audit") or {}
    print(f"retrieval_status: {audit.get('retrieval_status', '(none)')}")

    # CI assertion mirrors the TS cookbook.
    if os.environ.get("CI") and (
        not answer
        or (isinstance(answer, dict) and "text" not in answer)
    ):
        print("quick-start: empty answer", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
