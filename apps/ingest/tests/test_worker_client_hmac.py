"""Worker client HMAC — must produce identical signatures to the Worker's
internal-auth middleware (apps/api/src/middleware/internal-auth.ts) and
the TS test helper (apps/api/test/helpers/internal-sign.ts).

We can't shell into the Worker runtime here, so we replicate the
canonical form in pure Python and assert the client matches it bit-for-bit.

Canonical form: `METHOD\\nPATH\\nSHA256(body)\\nTIMESTAMP_MS`."""

from __future__ import annotations

import hashlib
import hmac
import json

import httpx
import pytest
import respx

from app.clients.worker import WorkerClient, WorkerError


SECRET = "test-internal-hmac-secret-do-not-use-in-prod"
BASE = "http://worker.test"


def _expected_canonical(method: str, path: str, body: bytes, ts: str) -> str:
    return f"{method.upper()}\n{path}\n{hashlib.sha256(body).hexdigest()}\n{ts}"


def _expected_sig(canonical: str) -> str:
    return hmac.new(SECRET.encode(), canonical.encode(), hashlib.sha256).hexdigest()


def test_init_requires_url_and_secret(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("WORKER_INTERNAL_URL", raising=False)
    monkeypatch.delenv("INTERNAL_HMAC_SECRET", raising=False)
    with pytest.raises(RuntimeError, match="WORKER_INTERNAL_URL"):
        WorkerClient()


def test_init_strips_trailing_slash() -> None:
    c = WorkerClient(base_url="http://x/", secret="s")
    assert c.base_url == "http://x"


def test_sign_canonical_matches_worker_middleware() -> None:
    """Most important test in the file: the Worker rejects mismatched
    signatures, and we own both sides of the contract here."""
    client = WorkerClient(base_url=BASE, secret=SECRET)
    body = b'{"hello":"world"}'
    headers = client._sign("POST", "/internal/jobs/job_x/transition", body)

    assert "x-textral-internal-timestamp" in headers
    assert "x-textral-internal-signature" in headers
    ts = headers["x-textral-internal-timestamp"]
    sig = headers["x-textral-internal-signature"]

    canonical = _expected_canonical("POST", "/internal/jobs/job_x/transition", body, ts)
    assert sig == _expected_sig(canonical)
    # Hex format
    assert len(sig) == 64
    int(sig, 16)
    # Timestamp is ms-since-epoch (13 digits as of 2001+)
    assert ts.isdigit()
    assert len(ts) >= 13


def test_sign_method_is_uppercased_in_canonical() -> None:
    client = WorkerClient(base_url=BASE, secret=SECRET)
    headers = client._sign("get", "/internal/jobs/abc", b"")
    ts = headers["x-textral-internal-timestamp"]
    expected = _expected_sig(_expected_canonical("GET", "/internal/jobs/abc", b"", ts))
    assert headers["x-textral-internal-signature"] == expected


def test_sign_includes_empty_body_hash_for_get() -> None:
    """Worker middleware always sha256s the body — even when empty (b"").
    `hashlib.sha256(b"").hexdigest()` is a known constant; verify the
    signer matches that exact path."""
    client = WorkerClient(base_url=BASE, secret=SECRET)
    headers = client._sign("GET", "/internal/jobs/job_x", b"")
    ts = headers["x-textral-internal-timestamp"]
    empty_hash = hashlib.sha256(b"").hexdigest()
    canonical = f"GET\n/internal/jobs/job_x\n{empty_hash}\n{ts}"
    assert headers["x-textral-internal-signature"] == _expected_sig(canonical)


def test_sign_changes_with_body() -> None:
    client = WorkerClient(base_url=BASE, secret=SECRET)
    a = client._sign("POST", "/x", b'{"a":1}')
    b = client._sign("POST", "/x", b'{"a":2}')
    # Even with same timestamp string, the body hash differs → sig differs.
    assert a["x-textral-internal-signature"] != b["x-textral-internal-signature"] or \
        a["x-textral-internal-timestamp"] != b["x-textral-internal-timestamp"]


def test_content_type_header_is_json() -> None:
    client = WorkerClient(base_url=BASE, secret=SECRET)
    headers = client._sign("POST", "/x", b"{}")
    assert headers["content-type"] == "application/json"


@respx.mock
async def test_post_json_signs_actual_request_bytes() -> None:
    client = WorkerClient(base_url=BASE, secret=SECRET)
    captured: dict[str, str] = {}

    def _capture(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = str(request.url)
        captured["body"] = request.content.decode()
        captured["sig"] = request.headers["x-textral-internal-signature"]
        captured["ts"] = request.headers["x-textral-internal-timestamp"]
        return httpx.Response(200, json={"ok": True})

    respx.post(f"{BASE}/internal/jobs/job_42/claim").mock(side_effect=_capture)

    res = await client.post_json("/internal/jobs/job_42/claim", {"container_instance_id": "i_1"})
    assert res == {"ok": True}

    # Verify the signed canonical matches the actual sent body.
    body_bytes = captured["body"].encode()
    expected = _expected_sig(
        _expected_canonical("POST", "/internal/jobs/job_42/claim", body_bytes, captured["ts"])
    )
    assert captured["sig"] == expected
    # And the body really is what we expected (json.dumps default ordering).
    assert json.loads(captured["body"]) == {"container_instance_id": "i_1"}

    await client.aclose()


@respx.mock
async def test_get_json_signs_empty_body() -> None:
    client = WorkerClient(base_url=BASE, secret=SECRET)
    captured: dict[str, str] = {}

    def _capture(request: httpx.Request) -> httpx.Response:
        captured["body"] = request.content.decode()
        captured["sig"] = request.headers["x-textral-internal-signature"]
        captured["ts"] = request.headers["x-textral-internal-timestamp"]
        return httpx.Response(200, json={"job": {"id": "job_x"}})

    respx.get(f"{BASE}/internal/jobs/job_x").mock(side_effect=_capture)
    res = await client.get_json("/internal/jobs/job_x")
    assert res["job"]["id"] == "job_x"
    assert captured["body"] == ""
    expected = _expected_sig(
        _expected_canonical("GET", "/internal/jobs/job_x", b"", captured["ts"])
    )
    assert captured["sig"] == expected

    await client.aclose()


@respx.mock
async def test_post_json_4xx_raises_worker_error_with_body() -> None:
    client = WorkerClient(base_url=BASE, secret=SECRET)
    respx.post(f"{BASE}/internal/jobs/job_x/transition").mock(
        return_value=httpx.Response(
            422,
            json={"error": {"code": "PROVIDER_QUOTA_EXHAUSTED", "message": "billing"}},
        )
    )
    with pytest.raises(WorkerError) as ei:
        await client.post_json("/internal/jobs/job_x/transition", {"status": "completed"})
    assert ei.value.status == 422
    assert ei.value.body["error"]["code"] == "PROVIDER_QUOTA_EXHAUSTED"
    await client.aclose()


@respx.mock
async def test_post_json_5xx_surfaces_raw_text_when_not_json() -> None:
    client = WorkerClient(base_url=BASE, secret=SECRET)
    respx.post(f"{BASE}/internal/jobs/job_x/transition").mock(
        return_value=httpx.Response(503, text="Bad Gateway")
    )
    with pytest.raises(WorkerError) as ei:
        await client.post_json("/internal/jobs/job_x/transition", {"status": "running"})
    assert ei.value.status == 503
    assert ei.value.body == {"raw": "Bad Gateway"}
    await client.aclose()
