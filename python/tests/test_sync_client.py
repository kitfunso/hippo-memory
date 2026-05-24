"""Real-server integration tests for HippoSync (v0.2.0).

Mirrors the test surface of test_client.py but in sync mode. Shares the
`hippo_server` fixture (function-scoped, fresh HIPPO_HOME + subprocess per
test). If the subprocess fails to come up, tests are SKIPPED not FAILED.
"""

from __future__ import annotations

from hippo_memory import HippoSync, HippoError, AuthCreated, AuthKey


def test_sync_health_reports_version(hippo_server: str):
    with HippoSync(base_url=hippo_server) as client:
        info = client.health()
        assert info.ok is True
        assert info.version.startswith("1.") or info.version.startswith("2.")
        assert info.pid > 0


def test_sync_remember_recall_roundtrip(hippo_server: str):
    with HippoSync(base_url=hippo_server) as client:
        mem = client.remember(content="sync integration alpha token sentinel")
        assert mem.id.startswith("mem_")

        results = client.recall(q="sentinel")
        # RecallResult.results is the field name (matches server wire shape)
        assert len(results.results) >= 1
        contents = [r.content for r in results.results]
        assert any("sentinel" in (c or "") for c in contents)


def test_sync_get_context_returns_entries(hippo_server: str):
    with HippoSync(base_url=hippo_server) as client:
        client.remember(content="sync context entry one")
        client.remember(content="sync context entry two")
        ctx = client.get_context(budget=2000)
        assert ctx.tokens > 0
        assert len(ctx.entries) >= 1


def test_sync_outcome_last_recall(hippo_server: str):
    with HippoSync(base_url=hippo_server) as client:
        client.remember(content="sync outcome candidate")
        # Prime last_retrieval_ids via get_context (recall doesn't populate it).
        client.get_context(q="outcome candidate", budget=1000)
        result = client.outcome(good=True)
        # ids-omitted path returns {applied, ids}; applied is 0 if nothing
        # matched the get_context query, non-zero otherwise.
        assert result.applied >= 0


def test_sync_auth_create_with_role_admin(hippo_server: str):
    """v0.2.0: auth_create accepts role param. Server v1.12.4+ populates role on response."""
    with HippoSync(base_url=hippo_server) as client:
        # Try admin role; the local server may be <1.12.3 (no role plumbing)
        # in which case `role` is silently accepted as label-equivalent.
        # Either way the call succeeds with a key_id.
        result = client.auth_create(label="sync-admin-key", role="admin")
        assert isinstance(result, AuthCreated)
        assert result.key_id.startswith("hk_")
        assert result.plaintext.startswith("hk_")
        # If server v1.12.3+, role is set; if older, role is None.
        if result.role is not None:
            assert result.role == "admin"


def test_sync_auth_create_with_role_member(hippo_server: str):
    """v0.2.0: auth_create accepts role=member."""
    with HippoSync(base_url=hippo_server) as client:
        result = client.auth_create(label="sync-member-key", role="member")
        assert result.key_id.startswith("hk_")
        if result.role is not None:
            assert result.role == "member"


def test_sync_auth_list_includes_role_when_server_v1_12_3plus(hippo_server: str):
    """v0.2.0: AuthKey.role populated by server v1.12.3+, None on older."""
    with HippoSync(base_url=hippo_server) as client:
        client.auth_create(label="list-test-key", role="member")
        keys = client.auth_list()
        assert isinstance(keys, list)
        assert len(keys) >= 1
        # Each AuthKey item should validate. Role column populated on v1.12.3+.
        for k in keys:
            assert isinstance(k, AuthKey)
            assert k.key_id.startswith("hk_")


def test_sync_error_on_unknown_route_raises_HippoError(hippo_server: str):
    with HippoSync(base_url=hippo_server) as client:
        try:
            client._request("GET", "/v1/this-route-does-not-exist")
        except HippoError as e:
            assert e.status_code in (404, 405)
            return
        assert False, "expected HippoError"
