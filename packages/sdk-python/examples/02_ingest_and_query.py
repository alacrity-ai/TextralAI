"""02_ingest_and_query.py — Full single-file ingest pipeline, then
query the freshly-ingested document.

Demonstrates: register → upload → finalize → ingest → poll →
query. Try/finally cleanup so a flaky run doesn't leave the
namespace populated.

Env: same as 01_quick_start.py.

Run:
    python 02_ingest_and_query.py

See also:
    docs/development/sdks/SDK_COOKBOOK_OUTLINE.md §3
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from textral import Client, TextralAPIError

DATA_DIR = Path(__file__).parent / "data"
PROVIDER_KEY_REF = os.environ.get("TEXTRAL_PROVIDER_KEY_REF", "openai")


def main() -> None:
    scratch_slug = f"cookbook-{int(time.time())}"

    with Client() as client:
        ns = client.namespaces.create(
            {
                "slug": scratch_slug,
                "vector_backend": "vectorize",
                "embedding_dimensions": 1536,
            }
        )

        try:
            # 1. Register the document.
            bytes_ = (DATA_DIR / "alexandria.md").read_bytes()
            doc = client.documents.register(
                ns["slug"],
                title="alexandria.md",
                doc_type="narrative",
            )
            print(f"document: {doc['id']}")

            # 2. Reserve the upload slot.
            upload = client.documents.create_upload(
                doc["id"],
                content_type="text/markdown",
                size_bytes=len(bytes_),
            )

            # 3. PUT bytes.
            put_status = client.documents.put_upload_bytes(
                upload["url"], bytes_, "text/markdown"
            )
            if put_status >= 300:
                raise RuntimeError(f"PUT failed: {put_status}")

            # 4. Finalize.
            fin = client.documents.finalize(doc["id"], upload["upload_id"])
            print(f"version:  {fin['version_id']}")

            # 5. Kick off ingestion.
            job = client.documents.ingest(
                doc["id"],
                {
                    "version_id": fin["version_id"],
                    "embedding": {
                        "provider": "openai",
                        "model": "text-embedding-3-large",
                        "dimensions": 1536,
                        "provider_key_ref": PROVIDER_KEY_REF,
                    },
                    "chunking": {
                        "profile": "generic",
                        "target_tokens": 600,
                        "overlap_tokens": 80,
                    },
                    "mode": "full",
                },
            )
            print(f"job:      {job['job_id']}")

            # 6. Poll until terminal.
            start = time.time()
            while True:
                if time.time() - start > 90:
                    raise RuntimeError("ingestion did not terminate within 90s")
                j = client.ingestion_jobs.get(job["job_id"])
                if j["status"] == "completed":
                    break
                if j["status"] == "failed":
                    raise RuntimeError(
                        f"ingest failed: {j.get('error_code')} — {j.get('error_message', '')}"
                    )
                time.sleep(1.5)

            # 7. Query.
            result = client.query(
                namespace=ns["slug"],
                query="What survived the Library of Alexandria?",
                embedding={
                    "provider": "openai",
                    "model": "text-embedding-3-large",
                    "dimensions": 1536,
                    "provider_key_ref": PROVIDER_KEY_REF,
                },
                inference={
                    "provider": "openai",
                    "model": "gpt-4o-mini",
                    "provider_key_ref": PROVIDER_KEY_REF,
                },
            )
            print("---")
            answer = result.get("answer")
            if isinstance(answer, str):
                print(answer)
            else:
                print(json.dumps(answer, indent=2))
        finally:
            # 8. Tear down the scratch namespace (idempotent soft-delete).
            try:
                client._http.request("DELETE", f"/v1/namespaces/{ns['slug']}")
            except TextralAPIError:
                pass


if __name__ == "__main__":
    main()
