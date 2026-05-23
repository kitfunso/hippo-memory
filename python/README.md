# hippo-memory (Python SDK)

Async Python SDK for [hippo-memory](https://github.com/kitfunso/hippo-memory), a biologically-inspired memory system for AI agents. Decay by default, strength through use, sleep consolidation.

This package is a thin async HTTP wrapper. Run `hippo serve` from the npm package alongside, then use this SDK to talk to it from Python.

## Install

```bash
pip install hippo-memory
```

Requires Python 3.10+. Runtime deps: `httpx>=0.27`, `pydantic>=2.0`.

## Server setup

You also need the `hippo-memory` npm package running locally:

```bash
npm install -g hippo-memory
hippo init       # creates a .hippo directory
hippo serve      # binds 127.0.0.1:3737 by default
```

The Python SDK talks to this loopback server. Requires `hippo-memory@>=1.11.4` server (the `/v1/outcome`, `/v1/context`, `/v1/sleep` routes land in v1.11.4).

## Quickstart

```python
import asyncio
from hippo_memory import Hippo

async def main():
    async with Hippo(base_url="http://127.0.0.1:3737") as client:
        # Persist a memory
        mem = await client.remember(content="bug fix lesson", tags=["error"])
        print(mem.id)

        # Search the store
        results = await client.recall(q="bug fix", limit=5)
        for r in results.results:
            print(r.id, r.score, r.content)

        # Assemble a context bundle (for prompt injection)
        ctx = await client.get_context(budget=1500)
        for item in ctx.entries:
            print(item.entry.content)

        # After your agent uses recalled memories, mark them good/bad
        await client.outcome(good=True)  # uses last-recall path

asyncio.run(main())
```

See `examples/` for 3 runnable scripts: basic remember+recall, context injection, outcome feedback.

## Authentication

Default is unauthenticated localhost (tenant `default`). For multi-tenant deployments, mint an API key via the CLI:

```bash
hippo auth create-key --label my-key
# Outputs a plaintext sk_... key (saved ONCE — store it)
```

Then pass it to the client:

```python
async with Hippo(api_key="sk_...") as client:
    # All operations now scoped to the key's tenant
    ...
```

## API surface

| Method | HTTP | Notes |
|---|---|---|
| `health()` | `GET /health` | server version + pid |
| `remember(content, ...)` | `POST /v1/memories` | returns slim envelope (id + kind + tenant_id) |
| `recall(q, ...)` | `GET /v1/memories` | search; scored results + token usage |
| `drill(id, ...)` | `GET /v1/recall/drill/:id` | drill into a memory's children (DAG) |
| `forget(id)` | `DELETE /v1/memories/:id` | hard-delete |
| `archive(id, reason?)` | `POST /v1/memories/:id/archive` | soft-archive (append-only raw memories) |
| `supersede(id, by)` | `POST /v1/memories/:id/supersede` | mark superseded |
| `promote(id)` | `POST /v1/memories/:id/promote` | local -> global |
| `outcome(good, ids?)` | `POST /v1/outcome` | apply outcome; last-recall path if no ids |
| `get_context(...)` | `GET /v1/context` | assemble context bundle for prompt injection |
| `sleep(dry_run?, no_share?)` | `POST /v1/sleep` | consolidation (loopback-only) |
| `assemble(session_id)` | `GET /v1/sessions/:id/assemble` | Phase 2 context-engine assembly |
| `auth_create(label?)` | `POST /v1/auth/keys` | mint a key (plaintext returned ONCE) |
| `auth_list(active?)` | `GET /v1/auth/keys` | list keys for caller's tenant |
| `auth_revoke(key_id)` | `DELETE /v1/auth/keys/:keyId` | revoke a key |
| `audit(op?, since?, limit?)` | `GET /v1/audit` | read audit events |

Every method returns a Pydantic v2 model. Failed HTTP responses raise `HippoError` with `status_code` and parsed `body`.

## Limitations (v0.1)

- **Async-only.** Sync wrappers (`HippoSync`) are a v0.2 candidate.
- **`/v1/sleep` is loopback-only on the server side.** The route refuses non-loopback connections; this SDK is intended for use against a co-located `hippo serve`.
- **`/v1/sleep` operates host-wide (cross-tenant).** Matches the CLI's `hippo sleep` semantic. Per-tenant scoping is tracked for a future hippo-memory minor release.
- **`get_context` `last_retrieval_ids` parity gap.** HTTP `GET /v1/memories` (recall) does NOT populate `last_retrieval_ids` — only `GET /v1/context` (get_context) does. CLI `hippo recall` populates it; the SDK's `recall` does not. To prime the last-recall outcome path, call `get_context` first. Tracked in TODOS.md.
- **`ContextResult.entries` exposes the full `MemoryEntry` surface** (richer than `hippo context --format json` which projects to a subset). A `.projected()` helper is a v0.2 candidate.
- **Server connector webhook routes (`/v1/connectors/{slack,github}/events`)** are not wrapped in the SDK — they are server-side facing, not client-shaped.

## Versioning

PyPI: `hippo-memory v0.1.0`. npm: `hippo-memory@1.11.4` (the server). The two version lines move independently; the SDK reads the server's `/health` version to confirm compatibility.

## Source

Lives in `python/` of the [kitfunso/hippo-memory](https://github.com/kitfunso/hippo-memory) monorepo. CHANGELOG entry: `Python SDK v0.1.0 (2026-05-23)` at the top of the root [CHANGELOG.md](https://github.com/kitfunso/hippo-memory/blob/master/CHANGELOG.md).

## License

MIT.
