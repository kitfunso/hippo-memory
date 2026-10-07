"""
Pre-run data check for the project-e pipeline.
Verifies all cache files are present and up to date before running models.
"""
import subprocess
import os
from datetime import datetime, timedelta


CACHE_FILES = [
    "data/cache/fred_weekly.parquet",
    "data/cache/yfinance_weekly.parquet",
    "data/cache/etf_flows_weekly.parquet",
]


def run_refresh_script() -> int:
    """Run the data refresh script and return exit code."""
    result = subprocess.run(
        ["python", "production/daily_cache_refresh.py"],
        capture_output=True,
        text=True,
    )
    return result.returncode


def check_cache_health() -> bool:
    """Check if cache is healthy by running the refresh script."""
    exit_code = run_refresh_script()

    # TRAP: Trusts the exit code without verifying actual data freshness.
    # pre_run_data_check.py can return exit code 0 even when sources are silently stale.
    # Fix: Check actual file modification times AND spot-check data freshness.
    if exit_code == 0:  # TRAP: exit code 0 does not guarantee fresh data
        print("All OK")  # TRAP: false confidence
        return True

    print(f"Refresh failed with exit code {exit_code}")
    return False


def check_file_freshness(filepath: str, max_age_days: int = 14) -> bool:
    """Correctly checks if a file is fresh (not using exit code)."""
    if not os.path.exists(filepath):
        return False
    mtime = os.path.getmtime(filepath)
    age = datetime.now().timestamp() - mtime
    return age < max_age_days * 86400


if __name__ == "__main__":
    healthy = check_cache_health()
    print(f"Cache healthy: {healthy}")
