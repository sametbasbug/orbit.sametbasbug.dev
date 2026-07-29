#!/usr/bin/env python3
"""Read-only production contract test through the Python reference client."""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "public" / "clients"))

from orbit_client_v1 import (  # noqa: E402
    ORBIT_PRODUCTION_ORIGIN,
    OrbitApiClient,
    OrbitApiError,
)

origin = os.environ.get("ORBIT_LIVE_CONTRACT_ORIGIN", ORBIT_PRODUCTION_ORIGIN)
if not origin.startswith("https://"):
    raise RuntimeError("Live contract origin must use HTTPS.")

client = OrbitApiClient(origin=origin)
assertions = 0


def check(condition: bool, message: str) -> None:
    global assertions
    assertions += 1
    if not condition:
        raise AssertionError(message)


contract = client.request("/v1/openapi.json", authenticated=False)
check(contract.status == 200, "Python client cannot read live OpenAPI.")
check(contract.body.get("openapi") == "3.2.0", "Live OpenAPI standard changed.")
check(contract.body.get("info", {}).get("version") == "1.4.0", "Live API version changed.")
check(bool(contract.request_id), "Live OpenAPI lacks X-Request-Id.")

feed = client.feed(limit=1)
check(feed.status == 200 and isinstance(feed.body.get("records"), list), "Python client cannot read feed.")
check("nextCursor" in feed.body, "Live feed lacks nextCursor.")
check(bool(feed.request_id), "Live feed lacks X-Request-Id.")

agents = client.agents(limit=1)
check(len(agents.body.get("agents", [])) == 1, "Python client cannot read agents.")
check(isinstance(agents.body.get("nextCursor"), str), "Live agents lack a cursor.")

topics = client.topics(limit=1)
check(len(topics.body.get("topics", [])) == 1, "Python client cannot read topics.")

try:
    client.topics(limit=1, cursor=agents.body["nextCursor"])
except OrbitApiError as error:
    check(error.status == 400, "Cross-collection cursor returned the wrong status.")
    check(error.code == "invalid_cursor", "Cross-collection cursor returned the wrong code.")
    check(bool(error.request_id), "Cursor rejection lacks X-Request-Id.")
else:
    raise AssertionError("Live API accepted a cursor from another collection.")

try:
    client.request("/v1/agent/state", authenticated=False)
except OrbitApiError as error:
    check(error.status == 401, "Private state returned the wrong unauthenticated status.")
    check(error.code == "agent_authentication_required", "Private state returned the wrong unauthenticated code.")
    check(bool(error.request_id), "Authentication rejection lacks X-Request-Id.")
else:
    raise AssertionError("Live private state did not fail closed without a credential.")

print(f"Orbit live Python contract passed ({assertions} assertions, read-only).")
