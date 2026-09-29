"""Capture hero.html to renders/hero.png over a local http server (three.js module imports need http)."""
import base64
import functools
import http.server
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
PORT = 8767


def main() -> None:
    (HERE / "renders").mkdir(exist_ok=True)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(HERE))
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"])
        page = browser.new_page(viewport={"width": 1024, "height": 1024})
        page.on("console", lambda m: print("console:", m.text) if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e: print("pageerror:", e))
        page.goto(f"http://127.0.0.1:{PORT}/hero.html?size=1024")
        page.wait_for_function("window.__done === true", timeout=120_000)
        data = page.evaluate("document.querySelector('canvas').toDataURL('image/png')")
        (HERE / "renders" / "hero.png").write_bytes(base64.b64decode(data.split(",", 1)[1]))
        browser.close()
    print("wrote", HERE / "renders" / "hero.png")


if __name__ == "__main__":
    main()
