"""Render hippo round-3 logo concepts to PNG with headless Chromium (three.js needs http, not file://)."""
import base64
import functools
import http.server
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
OUT = HERE / "renders"
PORT = 8765


def serve() -> None:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(HERE))
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()


def main(jobs: list[str]) -> None:
    OUT.mkdir(exist_ok=True)
    serve()
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"])
        page = browser.new_page(viewport={"width": 1024, "height": 1024})
        page.on("console", lambda m: print("console:", m.text) if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: print("pageerror:", e))
        for job in jobs:
            name, query = job.split("=", 1)
            page.goto(f"http://127.0.0.1:{PORT}/render.html?{query}")
            page.wait_for_function("window.__done === true", timeout=120_000)
            data = page.evaluate("document.querySelector('canvas').toDataURL('image/png')")
            (OUT / f"{name}.png").write_bytes(base64.b64decode(data.split(",", 1)[1]))
            print("wrote", name)
        browser.close()


if __name__ == "__main__":
    main(sys.argv[1:])
