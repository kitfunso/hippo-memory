# hippo-memory-sdk (Python SDK)

Async Python SDK for [hippo-memory](https://github.com/kitfunso/hippo-memory), a biologically-inspired memory system for AI agents. Decay by default, strength through use, sleep consolidation.

This package is a thin async HTTP wrapper. Run `hippo serve` from the npm package alongside, then use this SDK to talk to it from Python.

## Install

```bash
pip install hippo-memory-sdk
```

The Python import name is `hippo_memory` (the distribution name `hippo-memory-sdk` only matters at install time; `pip install hippo-memory-sdk` was chosen because PyPI's similarity check blocked the bare `hippo-memory` name due to an existing `hippomem` project).

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

## What's new in v0.2.0

- **Sync client (`HippoSync`).** A line-for-line mirror of `Hippo` using `httpx.Client`. Use when your code already runs synchronously (CLI scripts, notebooks, `threading.Thread` callbacks) and you don't want to manage an event loop. Wire-compatible: same routes, same models, same errors.
- **`ContextEntry.projected()` helper.** Projects the full `MemoryEntry` surface to the CLI's narrower json shape (`id`, `score`, `strength`, `tags`, `confidence`, `content`, `global`). Use when piping SDK results into LLM context or CLI-shaped downstream consumers.
- **`auth_create(role=)` parameter.** Matches hippo-memory v1.12.3 server: pass `role="admin"` or `role="member"`. Member keys are 403-blocked from admin-gated routes (e.g. `/v1/sleep`). Both `AuthCreated.role` and `AuthKey.role` populated by v1.12.3+ servers.

## Limitations (v0.2)

- **`/v1/sleep` is loopback-only + admin-gated on the server side.** The route refuses non-loopback connections (v1.11.4) and member-role Bearer tokens (v1.12.0 sub-1). This SDK is intended for use against a co-located `hippo serve` with an admin key.
- **`/v1/sleep` operates host-wide (cross-tenant).** Matches the CLI's `hippo sleep` semantic. Per-tenant scoping deferred until non-loopback serving lands.
- **`recall` does NOT populate `last_retrieval_ids` — by design** (locked in hippo-memory v1.11.5). To prime the last-recall outcome path, call `get_context` first. The CLI's `hippo recall` populates it because the CLI is interactive (user is about to run `hippo outcome --good`); the SDK is programmatic and SDK callers batch recall calls, where overwriting `last_retrieval_ids` each call would break the outcome workflow. Source: `api.ts:412-421` JSDoc + `tests/api-recall-no-side-effects.test.ts`.
- **Server connector webhook routes (`/v1/connectors/{slack,github}/events`)** are not wrapped in the SDK — they are server-side facing, not client-shaped.

## Versioning

PyPI: `hippo-memory-sdk v0.2.0`. npm: `hippo-memory@>=1.12.4` (the server). The two version lines move independently; the SDK reads the server's `/health` version to confirm compatibility.

## Source

Lives in `python/` of the [kitfunso/hippo-memory](https://github.com/kitfunso/hippo-memory) monorepo. CHANGELOG entry: `Python SDK v0.1.0 (2026-05-23)` at the top of the root [CHANGELOG.md](https://github.com/kitfunso/hippo-memory/blob/master/CHANGELOG.md).

## License

MIT.
