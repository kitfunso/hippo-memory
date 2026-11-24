import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
BENCH_ENV = "DOLPHIN_BENCH_HOME"
BENCH = Path(os.environ.get(BENCH_ENV) or HERE.parents[3] / "hippo-bench")
ROOT = BENCH / "dolphinbench"
CODEX_DIR = BENCH.parent / "AppData/Roaming/npm/node_modules/@openai/codex"
