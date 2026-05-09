"""03_bulk_ingest.py — Bulk-ingest the cookbook corpus.

Demonstrates: bulk_ingest_orchestrate(), progress callback,
on_existing policy. Re-runs are cheap because of
skip_if_unchanged.

Env: same as 01_quick_start.py.

Run:
    python 03_bulk_ingest.py

See also:
    docs/development/sdks/SDK_COOKBOOK_OUTLINE.md §4
"""

from __future__ import annotations

import os
from pathlib import Path

from textral import (
    BulkOrchestrateFile,
    Client,
    bulk_ingest_orchestrate,
)

DATA_DIR = Path(__file__).parent / "data"
PROVIDER_KEY_REF = os.environ.get("TEXTRAL_PROVIDER_KEY_REF", "openai")
NAMESPACE = os.environ.get("TEXTRAL_NAMESPACE", "cookbook")


def main() -> None:
    filenames = ["alexandria.md", "lighthouse.md", "scholars.md", "decline.md"]
    files = [
        BulkOrchestrateFile(
            filename=name,
            bytes_=(DATA_DIR / name).read_bytes(),
            size_bytes=(DATA_DIR / name).stat().st_size,
            content_type="text/markdown",
        )
        for name in filenames
    ]

    def on_progress(snap: dict) -> None:
        state = str(snap.get("state", "?")).ljust(12)
        counts = snap.get("counts", {})
        total = snap.get("total_files", 0)
        succeeded = counts.get("succeeded", 0)
        pct = snap.get("progress_pct", 0)
        print(f"{state} {succeeded}/{total} ({pct}%)")

    with Client() as client:
        result = bulk_ingest_orchestrate(
            client,
            namespace=NAMESPACE,
            config={
                "embedding": {
                    "provider": "openai",
                    "model": "text-embedding-3-large",
                    "dimensions": 1536,
                    "provider_key_ref": PROVIDER_KEY_REF,
                },
                "chunking": {"profile": "generic", "target_tokens": 600, "overlap_tokens": 80},
                "mode": "full",
            },
            files=files,
            on_existing="skip_if_unchanged",
            auto_finalize=True,
            concurrency=4,
            on_progress=on_progress,
        )

    counts = result.final_status.get("counts", {})
    print("---")
    print(f"bulk_job_id: {result.bulk_job_id}")
    print(f"final state: {result.final_status.get('state')}")
    print(
        f"succeeded: {counts.get('succeeded', 0)}, "
        f"skipped: {counts.get('skipped', 0)}, "
        f"failed: {counts.get('failed', 0)}"
    )


if __name__ == "__main__":
    main()
