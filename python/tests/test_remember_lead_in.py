"""The body `remember` posts for `lead_in`, with no server: a stub transport records the request."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from hippo_memory import Hippo, HippoSync

LEAD_IN = "user: How often do you and Mel run?"


def _recorder(sent: list[dict[str, Any]]) -> httpx.MockTransport:
    def handle(request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={"id": "mem_x", "kind": "distilled", "tenantId": "default"})

    return httpx.MockTransport(handle)


@pytest.mark.parametrize(
    ("kwargs", "expected"),
    [
        ({"lead_in": LEAD_IN}, {"content": "Three times a week", "leadIn": LEAD_IN}),
        ({}, {"content": "Three times a week"}),
        ({"lead_in": None}, {"content": "Three times a week"}),
    ],
)
async def test_async_remember_sends_lead_in_only_when_set(kwargs: dict[str, Any], expected: dict[str, Any]) -> None:
    sent: list[dict[str, Any]] = []
    async with Hippo(base_url="http://hippo.test") as client:
        client._client = httpx.AsyncClient(base_url="http://hippo.test", transport=_recorder(sent))
        await client.remember(content="Three times a week", **kwargs)
    assert sent == [expected]


@pytest.mark.parametrize(
    ("kwargs", "expected"),
    [
        ({"lead_in": LEAD_IN}, {"content": "Three times a week", "leadIn": LEAD_IN}),
        ({}, {"content": "Three times a week"}),
        ({"lead_in": None}, {"content": "Three times a week"}),
    ],
)
def test_sync_remember_sends_lead_in_only_when_set(kwargs: dict[str, Any], expected: dict[str, Any]) -> None:
    sent: list[dict[str, Any]] = []
    with HippoSync(base_url="http://hippo.test") as client:
        client._client = httpx.Client(base_url="http://hippo.test", transport=_recorder(sent))
        client.remember(content="Three times a week", **kwargs)
    assert sent == [expected]
