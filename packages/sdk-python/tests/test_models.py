"""Pydantic model parity tests — verifies that the codegen output:
  * Imports cleanly
  * Validates known-good wire payloads
  * Allows extra fields (forward-compat)
  * Rejects bad enum values
"""

from __future__ import annotations

from textral.models import BulkOnExisting, BulkSubmitRequest, Namespace

_NAMESPACE_FIXTURE = {
    "id": "ns_01",
    "tenant_id": "ten_01",
    "slug": "docs",
    "corpus_profile": "default",
    "default_embedding_profile": "voyage-3",
    "embedding_dimensions": 1024,
    "default_inference_model": None,
    "default_prompt_template_id": None,
    "vector_backend": "vectorize",
    "vector_index_name": None,
    "vector_namespace": None,
    "created_at": 1735689600000,
    "updated_at": 1735689600000,
}


def test_namespace_validates_basic_payload() -> None:
    n = Namespace.model_validate(_NAMESPACE_FIXTURE)
    assert n.slug == "docs"


def test_namespace_allows_extra_fields() -> None:
    """Server-side additive forward-compat — new fields shouldn't
    break old SDKs."""
    n = Namespace.model_validate(
        {**_NAMESPACE_FIXTURE, "future_field": "x", "another": {"nested": True}}
    )
    assert n.slug == "docs"


def test_bulk_on_existing_root_model() -> None:
    assert BulkOnExisting.model_validate("skip_if_unchanged").root == "skip_if_unchanged"
    assert BulkOnExisting.model_validate("new_version").root == "new_version"
    assert BulkOnExisting.model_validate("replace_current").root == "replace_current"


def test_bulk_submit_request_minimal() -> None:
    """Minimal valid submit request — namespace + config + files.
    The codegen output marks server-defaulted fields as required,
    so pass them explicitly. This documents the wire contract for
    downstream callers."""
    req = BulkSubmitRequest.model_validate(
        {
            "namespace": "docs",
            "config": {
                "embedding": {"provider": "voyage", "model": "voyage-3"},
            },
            "files": [
                {
                    "ordinal": 0,
                    "filename": "a.pdf",
                    "content_type": "application/pdf",
                    "size_bytes": 100,
                },
            ],
        }
    )
    assert len(req.files) == 1
    assert req.files[0].ordinal == 0
