"""Smoke test for live.html: serve the folder, load it headless with GPU, fail on console errors, save a frame."""
import functools
import http.server
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
PORT = 8770

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(HERE))
handler.log_message = lambda *a, **k: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()

errors: list[str] = []
with sync_playwright() as p:
    browser = p.chromium.launch(args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"])
    page = browser.new_page(viewport={"width": 420, "height": 700})
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(f"http://127.0.0.1:{PORT}/live.html")
    page.wait_for_timeout(6000)
    page.screenshot(path=str(HERE / "renders" / "live-420.png"))
    browser.close()
print("errors:", errors or "none")
