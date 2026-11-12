"""Fetch the runner's datasets where its code expects them (prereg Amendment 6, group A).

BEAM goes through the runner's own `download_dataset`, so the cache is the one it writes itself.
Usage: python -I download_data.py --runner DIR [--beam 100K,500K,1M,10M] [--lme-m]
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--runner", type=Path, required=True, help="memory-benchmarks clone")
    ap.add_argument("--beam", default="", help="comma-separated BEAM sizes")
    ap.add_argument("--lme-m", action="store_true", help="longmemeval_m_cleaned.json (2.74 GB)")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO)
    log = logging.getLogger("download")
    sys.path.insert(0, str(a.runner))
    os.chdir(a.runner)
    if a.beam:
        from benchmarks.beam.run import DEFAULT_DATASET_DIR, download_dataset
        got = download_dataset(a.beam.split(","), DEFAULT_DATASET_DIR, log)
        for size, convs in got.items():
            print(f"BEAM {size}: {len(convs)} conversations")
    if a.lme_m:
        from huggingface_hub import hf_hub_download
        p = hf_hub_download("xiaowu0162/longmemeval-cleaned", "longmemeval_m_cleaned.json", repo_type="dataset",
                            local_dir=str(a.runner / "datasets" / "longmemeval"))
        print(f"LongMemEval-M: {p} {Path(p).stat().st_size} bytes")


if __name__ == "__main__":
    main()
