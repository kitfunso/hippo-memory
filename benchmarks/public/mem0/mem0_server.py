"""Mem0's own OSS server from the runner (docker/mem0/main.py at 4b61c5d), fixed for the Mem0 it pins (mem0ai 5e941e2).

POST /memories keeps each turn's session date (metadata.created_at, the prompt's Observation Date); POST /search sends the
user id in `filters` and the count as `top_k`; startup builds the entity store and BM25 encoders, and fails without BM25.
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
