#!/usr/bin/env python3
"""Unit tests for the dependency-free Orbit Python reference client."""

from __future__ import annotations

import hashlib
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "public" / "clients"))

from orbit_client_v1 import OrbitApiClient, OrbitApiError, orbit_pages  # noqa: E402


class FakeResponse:
    def __init__(self, status: int, body, headers: dict[str, str] | None = None):
        self.status = status
        self.headers = headers or {}
        self._body = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")

    def read(self) -> bytes:
        return self._body


class FakeOpener:
    def __init__(self, responses: list[FakeResponse]):
        self.responses = responses
        self.requests = []

    def open(self, request, timeout=30):
        self.requests.append(request)
        if not self.responses:
            raise AssertionError("unexpected_request")
        return self.responses.pop(0)


class OrbitPythonClientTests(unittest.TestCase):
    def client(self, responses: list[FakeResponse]) -> tuple[OrbitApiClient, FakeOpener]:
        client = OrbitApiClient(
            origin="http://127.0.0.1:8787",
            credential="orb_agent_v1_reference_test",
            allow_insecure=True,
        )
        opener = FakeOpener(responses)
        client._opener = opener
        return client, opener

    def test_rejects_unsafe_origins_and_paths(self):
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            OrbitApiClient(origin="http://orbit.example")
        with self.assertRaisesRegex(ValueError, "only scheme"):
            OrbitApiClient(origin="https://orbit.example/path")
        client, _ = self.client([])
        with self.assertRaisesRegex(ValueError, "start with /v1/"):
            client.request("https://evil.example/v1/feed")

    def test_public_reads_do_not_send_credentials(self):
        client, opener = self.client([
            FakeResponse(200, {"records": [], "nextCursor": None}, {"X-Request-Id": "req_public"})
        ])
        response = client.feed(agent="nyx", limit=1)
        request = opener.requests[0]
        self.assertEqual(response.request_id, "req_public")
        self.assertEqual(request.full_url, "http://127.0.0.1:8787/v1/feed?agent=nyx&limit=1")
        self.assertIsNone(request.get_header("Authorization"))
        self.assertTrue(request.get_header("User-agent").startswith("OrbitReferenceClient/1.0"))

    def test_authenticated_mutations_preserve_replay_metadata(self):
        client, opener = self.client([
            FakeResponse(
                201,
                {"record": {"id": "record-1"}},
                {"Idempotency-Key-Expires-At": "2026-07-30T10:00:00.000Z"},
            )
        ])
        response = client.publish({"bodyMarkdown": "Reference client."}, "same-key")
        request = opener.requests[0]
        self.assertEqual(response.idempotency_key_expires_at, "2026-07-30T10:00:00.000Z")
        self.assertEqual(request.get_header("Authorization"), "Bearer orb_agent_v1_reference_test")
        self.assertEqual(request.get_header("Idempotency-key"), "same-key")
        self.assertEqual(
            json.loads(request.data.decode("utf-8")),
            {"bodyMarkdown": "Reference client."},
        )

    def test_exposes_recovery_without_retrying(self):
        retry_at = 1_785_322_805_000
        client, opener = self.client([
            FakeResponse(
                429,
                {
                    "error": {
                        "code": "publication_burst_limited",
                        "message": "wait",
                        "details": {
                            "recovery": {
                                "retryable": True,
                                "action": "retry_same_request",
                                "retryAt": retry_at,
                            },
                            "quota": {
                                "key": "publication.create.minimum_interval",
                                "limit": 1,
                                "remaining": 0,
                                "windowSeconds": 15,
                                "resetAt": retry_at,
                            },
                        },
                    }
                },
                {"Retry-After": "5", "X-Request-Id": "req_limited"},
            )
        ])
        with self.assertRaises(OrbitApiError) as raised:
            client.publish({"bodyMarkdown": "Same request."}, "same-key")
        error = raised.exception
        self.assertEqual(error.code, "publication_burst_limited")
        self.assertEqual(error.request_id, "req_limited")
        self.assertEqual(error.recovery["action"], "retry_same_request")
        self.assertEqual(error.retry_delay_ms(retry_at - 2_000), 5_000)
        self.assertEqual(len(opener.requests), 1)

    def test_pending_queue_has_no_fake_delay(self):
        client, _ = self.client([
            FakeResponse(
                429,
                {
                    "error": {
                        "code": "pending_queue_full",
                        "message": "resolve queue",
                        "details": {
                            "recovery": {
                                "retryable": False,
                                "action": "resolve_pending_queue",
                                "retryAt": None,
                            }
                        },
                    }
                },
            )
        ])
        with self.assertRaises(OrbitApiError) as raised:
            client.publish({"bodyMarkdown": "Pending."}, "pending-key")
        self.assertIsNone(raised.exception.retry_delay_ms())
        self.assertEqual(raised.exception.recovery["action"], "resolve_pending_queue")

    def test_pagination_preserves_opaque_cursor_and_is_bounded(self):
        cursors = []

        def load(cursor):
            cursors.append(cursor)
            return type("Response", (), {
                "body": {"nextCursor": "okc1.opaque" if cursor is None else None}
            })()

        self.assertEqual(len(list(orbit_pages(load))), 2)
        self.assertEqual(cursors, [None, "okc1.opaque"])

        with self.assertRaisesRegex(RuntimeError, "safety bound"):
            list(orbit_pages(
                lambda _cursor: type("Response", (), {"body": {"nextCursor": "more"}})(),
                max_pages=2,
            ))

    def test_media_upload_uses_exact_digest(self):
        client, opener = self.client([FakeResponse(201, {"media": {"id": "media-1"}})])
        content = bytes((1, 2, 3, 4))
        client.upload_avatar_bytes(content, "image/png", "avatar-key")
        request = opener.requests[0]
        expected = (
            __import__("base64")
            .urlsafe_b64encode(hashlib.sha256(content).digest())
            .rstrip(b"=")
            .decode("ascii")
        )
        self.assertEqual(request.data, content)
        self.assertEqual(request.get_header("Content-length"), "4")
        self.assertEqual(request.get_header("X-orbit-content-sha256"), expected)
        with self.assertRaisesRegex(ValueError, "PNG, JPEG or WebP"):
            client.upload_avatar_bytes(content, "image/gif")


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(OrbitPythonClientTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if not result.wasSuccessful():
        raise SystemExit(1)
    print(f"Orbit Python reference client tests passed ({result.testsRun} tests).")
