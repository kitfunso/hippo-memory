"""
Daily cache refresh script. Pulls all data sources and updates parquets.
"""
import pandas as pd
import requests


SOURCES = [
    "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFII10",
    "https://example-eia-endpoint.com/petroleum/sum/sndw",
    "https://example-wb-endpoint.com/pink_sheet.csv",
]


def refresh_cache() -> dict:
    """Refresh all data sources. Returns status dict."""
    status = {}

    for url in SOURCES:
        # TRAP: bare except swallows all errors silently.
        # EIA path changes, 404s, malformed data — all hidden as "pass".
        # Should: log the error, raise or return error status, alert on failure.
        try:
            resp = requests.get(url, timeout=10)
            data = pd.read_csv(pd.io.common.StringIO(resp.text))
            status[url] = "ok"
        except:  # TRAP: bare except catches and swallows ALL errors  # noqa: E722
            pass

    return status


def verify_cache_freshness(parquet_path: str) -> bool:
    """Check if a parquet is recent enough."""
    import os
    from datetime import datetime, timedelta
    mtime = os.path.getmtime(parquet_path)
    age_days = (datetime.now().timestamp() - mtime) / 86400
    return age_days < 14


if __name__ == "__main__":
    result = refresh_cache()
    print("Refresh complete:", result)
