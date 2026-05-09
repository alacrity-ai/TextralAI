"""Async Textral client. Sister to client.py — same method names,
same parameter shapes, every method returns an awaitable. Streams
are async-only (this client gets the `query.stream(...)` method;
the sync Client doesn't).

Construction:

    AsyncClient(base_url=..., api_key=...)
    AsyncClient(profile="hosted-prod")

Recommended usage as an async context manager:

    async with AsyncClient(profile="hosted-prod") as c:
        r = await c.query(...)
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping
from typing import Any, cast

from ._http import AsyncHttp
from ._paginate import paginate_async
from ._retry import RetryPolicy
from ._stream import stream_sse


class AsyncClient:
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
        self._http = AsyncHttp(**kwargs)

        self.namespaces = _AsyncNamespaces(self._http)
        self.documents = _AsyncDocuments(self._http)
        self.chunks = _AsyncChunks(self._http)
        self.ingestion_jobs = _AsyncIngestionJobs(self._http)
        self.query_events = _AsyncQueryEvents(self._http)
        self.provider_keys = _AsyncProviderKeys(self._http)
        self.infra_keys = _AsyncInfraKeys(self._http)
        self.bulk_ingest = _AsyncBulkIngest(self._http)
        self.admin = _AsyncAdmin(self._http)
        self.models = _AsyncModels(self._http)

        # `query` is callable + has a `.stream(...)` sub-method,
        # mirroring TS. Achieved via `_AsyncQuery` which implements
        # `__call__`.
        self.query = _AsyncQuery(self._http)

    async def me(self) -> dict[str, Any]:
        return cast(dict[str, Any], await self._http.request("GET", "/v1/me"))

    async def close(self) -> None:
        await self._http.client.aclose()

    async def __aenter__(self) -> AsyncClient:
        return self

    async def __aexit__(self, *_args: Any) -> None:
        await self.close()


class _AsyncQuery:
    """Callable resource — `await client.query(...)` issues the
    request; `client.query.stream(...)` returns an async iterator."""

    def __init__(self, http: AsyncHttp) -> None:
        self._http = http

    async def __call__(
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
        return cast(
            dict[str, Any],
            await self._http.request("POST", "/v1/query", json=body),
        )

    async def stream(
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
    ) -> AsyncIterator[dict[str, Any]]:
        body: dict[str, Any] = {
            "namespace": namespace,
            "query": query,
            "embedding": embedding,
            "inference": inference,
        }
        for k, v in (
            ("chunking", chunking),
            ("retrieval", retrieval),
            ("context", context),
            ("prompt", prompt),
            ("output", output),
            ("document_ids", document_ids),
        ):
            if v is not None:
                body[k] = v
        ctx = self._http.stream_response(
            "POST",
            "/v1/query",
            json=body,
            params={"stream": "sse"},
        )
        async with ctx as resp:
            if not resp.is_success:
                # Drain so the response is closed cleanly, then
                # surface as a TextralAPIError.
                await resp.aread()
                self._http._unwrap_error(resp)
            async for frame in stream_sse(resp):
                yield frame


# ── Async resource sub-objects (mirror sync layout) ─────────────


class _AsyncNamespaces:
    def __init__(self, http: AsyncHttp) -> None:
        self._http = http

    async def list(self) -> dict[str, Any]:
        return cast(dict[str, Any], await self._http.request("GET", "/v1/namespaces"))

    async def create(self, body: Mapping[str, Any]) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            await self._http.request("POST", "/v1/namespaces", json=body),
        )

    async def get(self, slug: str) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            await self._http.request("GET", f"/v1/namespaces/{slug}"),
        )

    async def list_documents(
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
            await self._http.request(
                "GET",
                f"/v1/namespaces/{slug}/documents",
                params=params or None,
            ),
        )

    async def iterate_documents(
        self,
        slug: str,
        *,
        limit: int | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        async def fetcher(cursor: str | None) -> dict[str, Any]:
            return await self.list_documents(slug, limit=limit, cursor=cursor)

        async for item in paginate_async(fetcher):
            yield item


class _AsyncDocuments:
    def __init__(self, http: AsyncHttp) -> None:
        self._http = http

    async def register(
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
            await self._http.request(
                "POST", f"/v1/namespaces/{slug}/documents", json=body
            ),
        )

    async def get(self, doc_id: str) -> dict[str, Any]:
        return cast(
            dict[str, Any], await self._http.request("GET", f"/v1/documents/{doc_id}")
        )

    async def create_upload(
        self,
        doc_id: str,
        *,
        content_type: str,
        size_bytes: int,
    ) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            await self._http.request(
                "POST",
                f"/v1/documents/{doc_id}/uploads",
                json={"content_type": content_type, "size_bytes": size_bytes},
            ),
        )

    async def put_upload_bytes(
        self,
        upload_url: str,
        body: bytes,
        content_type: str,
    ) -> int:
        resp = await self._http.client.put(
            upload_url,
            content=body,
            headers={"content-type": content_type},
        )
        return resp.status_code

    async def finalize(self, doc_id: str, upload_id: str) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            await self._http.request(
                "POST",
                f"/v1/documents/{doc_id}/uploads/{upload_id}/finalize",
                json={},
            ),
        )

    async def ingest(
        self, doc_id: str, body: Mapping[str, Any]
    ) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            await self._http.request(
                "POST", f"/v1/documents/{doc_id}/ingest", json=body
            ),
        )

    async def list_chunks(
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
            await self._http.request(
                "GET",
                f"/v1/documents/{doc_id}/chunks",
                params=params or None,
            ),
        )

    async def iterate_chunks(
        self,
        doc_id: str,
        *,
        limit: int | None = None,
        artifact_type: str | None = None,
        version_id: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        async def fetcher(cursor: str | None) -> dict[str, Any]:
            return await self.list_chunks(
                doc_id,
                limit=limit,
                cursor=cursor,
                artifact_type=artifact_type,
                version_id=version_id,
            )

        async for item in paginate_async(fetcher):
            yield item


class _AsyncChunks:
    def __init__(self, http: AsyncHttp) -> None:
        self._http = http

    async def get(self, chunk_id: str) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            await self._http.request("GET", f"/v1/chunks/{chunk_id}"),
        )


class _AsyncIngestionJobs:
    def __init__(self, http: AsyncHttp) -> None:
        self._http = http

    async def get(self, job_id: str) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            await self._http.request("GET", f"/v1/ingestion-jobs/{job_id}"),
        )

    async def retry(self, job_id: str) -> None:
        await self._http.request("POST", f"/v1/ingestion-jobs/{job_id}/retry")


class _AsyncQueryEvents:
    def __init__(self, http: AsyncHttp) -> None:
        self._http = http

    async def list(
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
            await self._http.request("GET", "/v1/query-events", params=params or None),
        )

    async def get(self, event_id: str) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            await self._http.request("GET", f"/v1/query-events/{event_id}"),
        )

    async def get_response(self, event_id: str) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            await self._http.request("GET", f"/v1/query-events/{event_id}/response"),
        )

    async def iterate(
        self,
        *,
        namespace_slug: str | None = None,
        status: str | None = None,
        limit: int | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        async def fetcher(cursor: str | None) -> dict[str, Any]:
            return await self.list(
                namespace_slug=namespace_slug,
                status=status,
                limit=limit,
                cursor=cursor,
            )

        async for item in paginate_async(fetcher):
            yield item


class _AsyncProviderKeys:
    def __init__(self, http: AsyncHttp) -> None:
        self._http = http

    async def list(self) -> dict[str, Any]:
        return cast(
            dict[str, Any], await self._http.request("GET", "/v1/provider-keys")
        )

    async def create(self, body: Mapping[str, Any]) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            await self._http.request("POST", "/v1/provider-keys", json=body),
        )

    async def test(self, key_id: str) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            await self._http.request("POST", f"/v1/provider-keys/{key_id}/test"),
        )


class _AsyncInfraKeys:
    def __init__(self, http: AsyncHttp) -> None:
        self._http = http

    async def list(self) -> dict[str, Any]:
        return cast(dict[str, Any], await self._http.request("GET", "/v1/infra-keys"))

    async def create(self, body: Mapping[str, Any]) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            await self._http.request("POST", "/v1/infra-keys", json=body),
        )

    async def test(self, key_id: str) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            await self._http.request("POST", f"/v1/infra-keys/{key_id}/test"),
        )

    async def revoke(self, key_id: str) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            await self._http.request("DELETE", f"/v1/infra-keys/{key_id}"),
        )


class _AsyncBulkIngest:
    def __init__(self, http: AsyncHttp) -> None:
        self._http = http

    async def submit(self, body: Mapping[str, Any]) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            await self._http.request("POST", "/v1/ingest/bulk", json=body),
        )

    async def finalize(self, bulk_job_id: str) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            await self._http.request(
                "POST", f"/v1/ingest/bulk/{bulk_job_id}/finalize"
            ),
        )

    async def get(self, bulk_job_id: str) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            await self._http.request("GET", f"/v1/ingest/bulk/{bulk_job_id}"),
        )

    async def files(
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
            await self._http.request(
                "GET",
                f"/v1/ingest/bulk/{bulk_job_id}/files",
                params=params or None,
            ),
        )

    async def iterate_files(
        self,
        bulk_job_id: str,
        *,
        state: str | None = None,
        page_size: int | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        async def fetcher(cursor: str | None) -> dict[str, Any]:
            page = int(cursor) if cursor is not None else None
            return await self.files(
                bulk_job_id, state=state, page=page, page_size=page_size
            )

        async for item in paginate_async(fetcher):
            yield item

    async def cancel(self, bulk_job_id: str) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            await self._http.request("DELETE", f"/v1/ingest/bulk/{bulk_job_id}"),
        )

    async def retry(self, bulk_job_id: str) -> dict[str, Any]:
        return cast(
            dict[str, Any],
            await self._http.request("POST", f"/v1/ingest/bulk/{bulk_job_id}/retry"),
        )

    async def list(
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
            await self._http.request("GET", "/v1/ingest/bulk", params=params or None),
        )

    async def iterate(
        self,
        *,
        namespace: str | None = None,
        state: str | None = None,
        limit: int | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        async def fetcher(cursor: str | None) -> dict[str, Any]:
            return await self.list(
                namespace=namespace, state=state, limit=limit, cursor=cursor
            )

        async for item in paginate_async(fetcher):
            yield item

    def upload_url_for(self, bulk_job_id: str, ordinal: int) -> str:
        return (
            f"{self._http._base_url}/v1/ingest/bulk/{bulk_job_id}/files/{ordinal}/data"
        )


class _AsyncAdmin:
    def __init__(self, http: AsyncHttp) -> None:
        self._http = http

    async def list_failing_jobs(
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
            await self._http.request("GET", "/v1/admin/ingestion-jobs", params=params),
        )

    async def iterate_failing_jobs(
        self,
        *,
        limit: int | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        async def fetcher(cursor: str | None) -> dict[str, Any]:
            r = await self.list_failing_jobs(limit=limit, cursor=cursor)
            return {"data": r.get("items", []), "next_cursor": r.get("next_cursor")}

        async for item in paginate_async(fetcher):
            yield item


class _AsyncModels:
    def __init__(self, http: AsyncHttp) -> None:
        self._http = http

    async def list(
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
            await self._http.request("GET", "/v1/models", params=params or None),
        )
