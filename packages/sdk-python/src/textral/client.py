"""Sync Textral client.

Method names + parameter shapes mirror @textral/sdk's
TextralClient — a Python user who knows the TS API knows the
Python API. The async sister lives in async_client.py.

Construction:

    Client(base_url=..., api_key=...)        # explicit
    Client(profile="hosted-prod")            # ~/.textral/profiles.toml
    Client()                                  # default precedence chain

Both API responses and request bodies are typed via the generated
Pydantic models in textral.models. Where the wire shape has
optional fields with server-side defaults, request params accept
plain dicts as well as model instances — see each method.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from typing import Any, cast

from ._http import SyncHttp
from ._paginate import paginate
from ._retry import RetryPolicy

# We import models lazily inside methods rather than at module top
# so that `import textral` is fast and cheap. Pydantic class
# construction is non-trivial.


class Client:
    """Sync client. Wraps an httpx.Client; close it when you're done.

    Recommended usage as a context manager:

        with Client(profile="hosted-prod") as c:
            r = c.query(namespace="docs", query="...")
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
        profile: str | None = None,
        retry: RetryPolicy | None = None,
        timeout: float = 30.0,
    ) -> None:
        kwargs: dict[str, Any] = {"timeout": timeout}
        if base_url is not None:
            kwargs["base_url"] = base_url
        if api_key is not None:
            kwargs["api_key"] = api_key
        if profile is not None:
            kwargs["profile"] = profile
        if retry is not None:
            kwargs["retry"] = retry
        self._http = SyncHttp(**kwargs)

        # Resource sub-objects — one block per REST surface, mirroring
        # the TS SDK's grouping. Each holds a reference to `_http`
        # so methods are short.
        self.namespaces = _Namespaces(self._http)
        self.documents = _Documents(self._http)
        self.chunks = _Chunks(self._http)
        self.ingestion_jobs = _IngestionJobs(self._http)
        self.query_events = _QueryEvents(self._http)
        self.provider_keys = _ProviderKeys(self._http)
        self.infra_keys = _InfraKeys(self._http)
        self.bulk_ingest = _BulkIngest(self._http)
        self.admin = _Admin(self._http)
        self.models = _Models(self._http)

    # ── tenancy ────────────────────────────────────────────────
    def me(self) -> dict[str, Any]:
        return cast(dict[str, Any], self._http.request("GET", "/v1/me"))

    # ── query ──────────────────────────────────────────────────
    def query(
        self,
        *,
        namespace: str,
        query: str,
        embedding: dict[str, Any],
        inference: dict[str, Any],
        chunking: dict[str, Any] | None = None,
        retrieval: dict[str, Any] | None = None,
        context: dict[str, Any] | None = None,
        prompt: dict[str, Any] | None = None,
        output: dict[str, Any] | None = None,
        document_ids: list[str] | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "namespace": namespace,
            "query": query,
            "embedding": embedding,
            "inference": inference,
        }
        if chunking is not None:
            body["chunking"] = chunking
        if retrieval is not None:
            body["retrieval"] = retrieval
        if context is not None:
            body["context"] = context
        if prompt is not None:
            body["prompt"] = prompt
        if output is not None:
            body["output"] = output
        if document_ids is not None:
            body["document_ids"] = document_ids
        return cast(dict[str, Any], self._http.request("POST", "/v1/query", json=body))

    # ── lifecycle ──────────────────────────────────────────────
    def close(self) -> None:
        self._http.client.close()

    def __enter__(self) -> Client:
        return self

    def __exit__(self, *_args: Any) -> None:
        self.close()


# ── Resource sub-objects ───────────────────────────────────────
#
# Each one is a tiny class taking the SyncHttp instance. Method
# bodies are intentionally one-liners where possible — anything
# more complex belongs in _http.py or a helper.


class _Namespaces:
    def __init__(self, http: SyncHttp) -> None:
        self._http = http

    def list(self) -> dict[str, Any]:
        return cast(dict[str, Any], self._http.request("GET", "/v1/namespaces"))

    def create(self, body: Mapping[str, Any]) -> dict[str, Any]:
        return cast(dict[str, Any], self._http.request("POST", "/v1/namespaces", json=body))

    def get(self, slug: str) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            self._http.request("GET", f"/v1/namespaces/{slug}"),
        )

    def list_documents(
        self,
        slug: str,
        *,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if cursor is not None:
            params["cursor"] = cursor
        return cast(
            dict[str, Any],
            self._http.request(
                "GET",
                f"/v1/namespaces/{slug}/documents",
                params=params or None,
            ),
        )

    def iterate_documents(
        self,
        slug: str,
        *,
        limit: int | None = None,
    ) -> Iterator[dict[str, Any]]:
        def fetcher(cursor: str | None) -> dict[str, Any]:
            return self.list_documents(slug, limit=limit, cursor=cursor)

        return paginate(fetcher)


class _Documents:
    def __init__(self, http: SyncHttp) -> None:
        self._http = http

    def register(
        self,
        slug: str,
        *,
        title: str | None = None,
        doc_type: str | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if title is not None:
            body["title"] = title
        if doc_type is not None:
            body["doc_type"] = doc_type
        if metadata is not None:
            body["metadata"] = metadata
        return cast(
            dict[str, Any],
            self._http.request("POST", f"/v1/namespaces/{slug}/documents", json=body),
        )

    def get(self, doc_id: str) -> dict[str, Any]:
        return cast(dict[str, Any], self._http.request("GET", f"/v1/documents/{doc_id}"))

    def create_upload(
        self,
        doc_id: str,
        *,
        content_type: str,
        size_bytes: int,
    ) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            self._http.request(
                "POST",
                f"/v1/documents/{doc_id}/uploads",
                json={"content_type": content_type, "size_bytes": size_bytes},
            ),
        )

    def put_upload_bytes(
        self,
        upload_url: str,
        body: bytes,
        content_type: str,
    ) -> int:
        """PUT bytes to a presigned upload URL. Returns the HTTP
        status (caller asserts is_success). Bypasses the retry +
        envelope-unwrap layer because the URL is server-minted and
        may live on a different origin than the API."""
        resp = self._http.client.put(
            upload_url,
            content=body,
            headers={"content-type": content_type},
        )
        return resp.status_code

    def finalize(self, doc_id: str, upload_id: str) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            self._http.request(
                "POST",
                f"/v1/documents/{doc_id}/uploads/{upload_id}/finalize",
                json={},
            ),
        )

    def ingest(self, doc_id: str, body: Mapping[str, Any]) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            self._http.request("POST", f"/v1/documents/{doc_id}/ingest", json=body),
        )

    def list_chunks(
        self,
        doc_id: str,
        *,
        limit: int | None = None,
        cursor: str | None = None,
        artifact_type: str | None = None,
        version_id: str | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {}
        if limit is not None:
            params["limit"] = limit
        if cursor is not None:
            params["cursor"] = cursor
        if artifact_type is not None:
            params["artifact_type"] = artifact_type
        if version_id is not None:
            params["version_id"] = version_id
        return cast(
            dict[str, Any],
            self._http.request(
                "GET",
                f"/v1/documents/{doc_id}/chunks",
                params=params or None,
            ),
        )

    def iterate_chunks(
        self,
        doc_id: str,
        *,
        limit: int | None = None,
        artifact_type: str | None = None,
        version_id: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        def fetcher(cursor: str | None) -> dict[str, Any]:
            return self.list_chunks(
                doc_id,
                limit=limit,
                cursor=cursor,
                artifact_type=artifact_type,
                version_id=version_id,
            )

        return paginate(fetcher)


class _Chunks:
    def __init__(self, http: SyncHttp) -> None:
        self._http = http

    def get(self, chunk_id: str) -> dict[str, Any]:
        return cast(dict[str, Any], self._http.request("GET", f"/v1/chunks/{chunk_id}"))


class _IngestionJobs:
    def __init__(self, http: SyncHttp) -> None:
        self._http = http

    def get(self, job_id: str) -> dict[str, Any]:
        return cast(
            dict[str, Any], self._http.request("GET", f"/v1/ingestion-jobs/{job_id}")
        )

    def retry(self, job_id: str) -> None:
        self._http.request("POST", f"/v1/ingestion-jobs/{job_id}/retry")


class _QueryEvents:
    def __init__(self, http: SyncHttp) -> None:
        self._http = http

    def list(
        self,
        *,
        namespace_slug: str | None = None,
        status: str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {}
        if namespace_slug is not None:
            params["namespace_slug"] = namespace_slug
        if status is not None:
            params["status"] = status
        if limit is not None:
            params["limit"] = limit
        if cursor is not None:
            params["cursor"] = cursor
        return cast(
            dict[str, Any],
            self._http.request("GET", "/v1/query-events", params=params or None),
        )

    def get(self, event_id: str) -> dict[str, Any]:
        return cast(
            dict[str, Any], self._http.request("GET", f"/v1/query-events/{event_id}")
        )

    def get_response(self, event_id: str) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            self._http.request("GET", f"/v1/query-events/{event_id}/response"),
        )

    def iterate(
        self,
        *,
        namespace_slug: str | None = None,
        status: str | None = None,
        limit: int | None = None,
    ) -> Iterator[dict[str, Any]]:
        def fetcher(cursor: str | None) -> dict[str, Any]:
            return self.list(
                namespace_slug=namespace_slug,
                status=status,
                limit=limit,
                cursor=cursor,
            )

        return paginate(fetcher)


class _ProviderKeys:
    def __init__(self, http: SyncHttp) -> None:
        self._http = http

    def list(self) -> dict[str, Any]:
        return cast(dict[str, Any], self._http.request("GET", "/v1/provider-keys"))

    def create(self, body: Mapping[str, Any]) -> dict[str, Any]:
        return cast(
            dict[str, Any], self._http.request("POST", "/v1/provider-keys", json=body)
        )

    def test(self, key_id: str) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            self._http.request("POST", f"/v1/provider-keys/{key_id}/test"),
        )


class _InfraKeys:
    def __init__(self, http: SyncHttp) -> None:
        self._http = http

    def list(self) -> dict[str, Any]:
        return cast(dict[str, Any], self._http.request("GET", "/v1/infra-keys"))

    def create(self, body: Mapping[str, Any]) -> dict[str, Any]:
        return cast(
            dict[str, Any], self._http.request("POST", "/v1/infra-keys", json=body)
        )

    def test(self, key_id: str) -> dict[str, Any]:
        return cast(
            dict[str, Any], self._http.request("POST", f"/v1/infra-keys/{key_id}/test")
        )

    def revoke(self, key_id: str) -> dict[str, Any]:
        return cast(
            dict[str, Any], self._http.request("DELETE", f"/v1/infra-keys/{key_id}")
        )


class _BulkIngest:
    def __init__(self, http: SyncHttp) -> None:
        self._http = http

    def submit(self, body: Mapping[str, Any]) -> dict[str, Any]:
        return cast(
            dict[str, Any], self._http.request("POST", "/v1/ingest/bulk", json=body)
        )

    def finalize(self, bulk_job_id: str) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            self._http.request("POST", f"/v1/ingest/bulk/{bulk_job_id}/finalize"),
        )

    def get(self, bulk_job_id: str) -> dict[str, Any]:
        return cast(
            dict[str, Any], self._http.request("GET", f"/v1/ingest/bulk/{bulk_job_id}")
        )

    def files(
        self,
        bulk_job_id: str,
        *,
        state: str | None = None,
        page: int | None = None,
        page_size: int | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {}
        if state is not None:
            params["state"] = state
        if page is not None:
            params["page"] = page
        if page_size is not None:
            params["page_size"] = page_size
        return cast(
            dict[str, Any],
            self._http.request(
                "GET",
                f"/v1/ingest/bulk/{bulk_job_id}/files",
                params=params or None,
            ),
        )

    def iterate_files(
        self,
        bulk_job_id: str,
        *,
        state: str | None = None,
        page_size: int | None = None,
    ) -> Iterator[dict[str, Any]]:
        def fetcher(cursor: str | None) -> dict[str, Any]:
            # `next_cursor` here is actually a page number string;
            # paginate() doesn't care.
            page = int(cursor) if cursor is not None else None
            return self.files(
                bulk_job_id,
                state=state,
                page=page,
                page_size=page_size,
            )

        return paginate(fetcher)

    def cancel(self, bulk_job_id: str) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            self._http.request("DELETE", f"/v1/ingest/bulk/{bulk_job_id}"),
        )

    def retry(self, bulk_job_id: str) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            self._http.request("POST", f"/v1/ingest/bulk/{bulk_job_id}/retry"),
        )

    def list(
        self,
        *,
        namespace: str | None = None,
        state: str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {}
        if namespace is not None:
            params["namespace"] = namespace
        if state is not None:
            params["state"] = state
        if limit is not None:
            params["limit"] = limit
        if cursor is not None:
            params["cursor"] = cursor
        return cast(
            dict[str, Any],
            self._http.request("GET", "/v1/ingest/bulk", params=params or None),
        )

    def iterate(
        self,
        *,
        namespace: str | None = None,
        state: str | None = None,
        limit: int | None = None,
    ) -> Iterator[dict[str, Any]]:
        def fetcher(cursor: str | None) -> dict[str, Any]:
            return self.list(
                namespace=namespace,
                state=state,
                limit=limit,
                cursor=cursor,
            )

        return paginate(fetcher)

    def upload_url_for(self, bulk_job_id: str, ordinal: int) -> str:
        # base_url is private to _http; reach in for this helper.
        return (
            f"{self._http._base_url}/v1/ingest/bulk/{bulk_job_id}/files/{ordinal}/data"
        )


class _Admin:
    def __init__(self, http: SyncHttp) -> None:
        self._http = http

    def list_failing_jobs(
        self,
        *,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"dead_lettered": "1"}
        if limit is not None:
            params["limit"] = limit
        if cursor is not None:
            params["cursor"] = cursor
        return cast(
            dict[str, Any],
            self._http.request("GET", "/v1/admin/ingestion-jobs", params=params),
        )

    def iterate_failing_jobs(
        self,
        *,
        limit: int | None = None,
    ) -> Iterator[dict[str, Any]]:
        def fetcher(cursor: str | None) -> dict[str, Any]:
            r = self.list_failing_jobs(limit=limit, cursor=cursor)
            # The route returns `items`, not `data`. Adapt.
            return {"data": r.get("items", []), "next_cursor": r.get("next_cursor")}

        return paginate(fetcher)


class _Models:
    def __init__(self, http: SyncHttp) -> None:
        self._http = http

    def list(
        self,
        *,
        provider: str | None = None,
        kind: str | None = None,
        include_deprecated: bool = False,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {}
        if provider is not None:
            params["provider"] = provider
        if kind is not None:
            params["kind"] = kind
        if include_deprecated:
            params["include_deprecated"] = "true"
        return cast(
            dict[str, Any],
            self._http.request("GET", "/v1/models", params=params or None),
        )
