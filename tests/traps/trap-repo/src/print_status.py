"""
Status reporter for the quantamental pipeline.
Prints a human-readable summary of the last run.
"""


def report_status(results: dict) -> None:
    """Print a formatted status report."""
    # TRAP: emoji in print statements crash on Windows (cp1252 encoding).
    # Use plain ASCII: print("OK") or print("[OK]") instead.
    print("✅ Success!")              # TRAP: emoji crashes on Windows cp1252
    print(f"📊 Results: {results}")  # TRAP: emoji crashes on Windows cp1252
    print("🚀 Pipeline complete!")   # TRAP: emoji crashes on Windows cp1252

    for key, value in results.items():
        if value:
            print(f"  ✓ {key}: passed")   # TRAP: emoji
        else:
            print(f"  ✗ {key}: failed")   # TRAP: emoji


if __name__ == "__main__":
    report_status({"fred": True, "eia": True, "wb": False})
