"""Mem0's own OSS server from the runner (docker/mem0/main.py at 4b61c5d), fixed for the Mem0 it pins (mem0ai 5e941e2).

POST /memories keeps each turn's session date (metadata.created_at, the prompt's Observation Date); POST /search sends the
user id in `filters` and the count as `top_k`; startup builds the entity store and BM25 encoders, and fails without BM25.
Losses Mem0 logs below WARNING are logged again at WARNING, so the gate sees them; what Mem0 does is unchanged.
"""
import os

os.environ.setdefault("MEM0_TELEMETRY", "False")  # read when mem0 is imported

import argparse
import contextlib
import functools
import importlib.util
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import mem0.llms.openai as mem0_openai
import mem0.memory.main as mem0_main
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# A usage-limit wait behind the proxy can last hours; the proxy does all retrying, so the SDK must not.
mem0_openai.OpenAI = functools.partial(mem0_openai.OpenAI, timeout=12 * 3600.0, max_retries=0)

_obs = threading.local()
_prompt = mem0_main.generate_additive_extraction_prompt


def _prompt_with_date(*args: Any, **kwargs: Any) -> str:
    if getattr(_obs, "date", None) and kwargs.get("timestamp") is None:
        kwargs["timestamp"] = _obs.date
    return _prompt(*args, **kwargs)


mem0_main.generate_additive_extraction_prompt = _prompt_with_date


_in_batch = threading.local()


def _surface_quiet_losses(mem: Any, log: Any) -> None:
    """Mem0 drops a failed entity embedding (main.py:739-749), a failed entity link (782-783) and a failed keyword
    search (qdrant.py:424-426) with no log above DEBUG. Each is logged at WARNING here, then Mem0 carries on as it would."""
    emb, store, ents = mem.embedding_model, mem.vector_store, mem.entity_store
    embed, embed_batch, keyword_search, link = emb.embed, emb.embed_batch, store.keyword_search, ents.update

    def watched_embed(*args: Any, **kwargs: Any) -> Any:
        try:
            return embed(*args, **kwargs)
        except Exception as e:
            if getattr(_in_batch, "on", False):  # Mem0 embeds each text of a failed batch again, one at a time
                log.info("an embedding inside a batch failed; Mem0 retries the batch's texts one at a time")
            else:
                log.warning(f"embedding failed, so Mem0 drops this text: {e!r}")
            raise

    def watched_embed_batch(*args: Any, **kwargs: Any) -> Any:
        _in_batch.on = True
        try:
            return embed_batch(*args, **kwargs)
        finally:
            _in_batch.on = False

    def watched_link(*args: Any, **kwargs: Any) -> Any:
        try:
            return link(*args, **kwargs)
        except Exception as e:
            log.warning(f"entity link update failed, so Mem0 drops the link: {e!r}")
            raise

    def watched_keyword_search(*args: Any, **kwargs: Any) -> Any:
        hits = keyword_search(*args, **kwargs)
        query = kwargs.get("query", args[0] if args else "")
        if hits is None and str(query).strip():
            log.warning(f"keyword search failed, so Mem0 ranks without BM25: {query!r}")
        return hits

    emb.embed, emb.embed_batch, store.keyword_search, ents.update = (
        watched_embed, watched_embed_batch, watched_keyword_search, watched_link)


class DatedAdd(BaseModel):
    messages: list[dict[str, Any]]
    user_id: str | None = None
    agent_id: str | None = None
    run_id: str | None = None
    metadata: dict[str, Any] | None = None
    custom_instructions: str | None = None
    timestamp: int | None = None


def build_app(runner: Path) -> FastAPI:
    here = runner / "docker" / "mem0"
    sys.path.insert(0, str(here))
    spec = importlib.util.spec_from_file_location("runner_mem0_main", here / "main.py")
    server = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(server)
    app: FastAPI = server.app
    app.router.routes = [r for r in app.router.routes
                         if not (getattr(r, "path", "") in ("/memories", "/search") and "POST" in getattr(r, "methods", ()))]

    @app.post("/memories")
    def add_memories(req: DatedAdd) -> Any:
        mem = server._get_memory()
        params: dict[str, Any] = {k: v for k, v in
                                  (("user_id", req.user_id), ("agent_id", req.agent_id), ("run_id", req.run_id)) if v}
        meta = dict(req.metadata or {})
        if req.timestamp is not None:
            when = datetime.fromtimestamp(req.timestamp, tz=timezone.utc)
            meta["created_at"] = when.isoformat(timespec="milliseconds").replace("+00:00", "Z")  # as hippo's server
            _obs.date = when.date().isoformat()
        if meta:
            params["metadata"] = meta
        if req.custom_instructions:
            params["prompt"] = req.custom_instructions
        try:
            return mem.add(req.messages, **params)
        except Exception as e:
            server.logger.exception("add() failed")
            raise HTTPException(500, str(e)) from e
        finally:
            _obs.date = None

    # The original passes user_id and limit as keywords: this Mem0 rejects the first and silently drops the second.
    @app.post("/search")
    def search_memories(req: server.SearchRequest) -> Any:
        ids = {k: v for k, v in (("user_id", req.user_id), ("agent_id", req.agent_id), ("run_id", req.run_id)) if v}
        try:
            return server._get_memory().search(req.query, top_k=req.limit, filters={**(req.filters or {}), **ids},
                                               rerank=req.rerank)
        except Exception as e:
            server.logger.exception("search() failed")
            raise HTTPException(500, str(e)) from e

    base = app.router.lifespan_context

    @contextlib.asynccontextmanager
    async def lifespan(a: FastAPI) -> Any:
        async with base(a):
            mem = server._get_memory()
            # Mem0 builds both lazily, so the first ten adds at once raced to create the entity collection (one got 409).
            for store in (mem.vector_store, mem.entity_store):
                if store._get_bm25_encoder() is None:
                    raise SystemExit("no BM25 encoder: Mem0 would silently drop keyword search (pip install fastembed)")
            _surface_quiet_losses(mem, server.logger)
            yield

    app.router.lifespan_context = lifespan
    return app


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--runner", type=Path, required=True, help="memory-benchmarks checkout at 4b61c5d")
    ap.add_argument("--config", type=Path, required=True, help="Mem0 config YAML (config.yaml here)")
    ap.add_argument("--port", type=int, default=8888)
    a = ap.parse_args()
    os.environ["MEM0_CONFIG_PATH"] = str(a.config)
    uvicorn.run(build_app(a.runner), host="127.0.0.1", port=a.port, workers=1)


if __name__ == "__main__":
    main()
