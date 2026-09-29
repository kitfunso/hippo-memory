"""Render round-5 logo variants to PNG: serves this folder over http, captures render.html in headless Chromium.

Usage: python render.py name=form=echo&mat=ghost [name2=...]   (each job is <file>=<query string>)
       python render.py finals                                 (the renders sheet.py consumes)
"""
import base64
import functools
import http.server
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
OUT = HERE / "renders"
PORT = 8769
PICK = "form=echo&mat=boneglow&zoff=3&glow=2&key=0.6&bev=1.2"
TILE = f"{PICK}&tile=raised&dist=11.5&yaw=-6&pitch=6&flat=1"
FINALS = [
    f"final-hero={PICK}&yaw=-18&pitch=11&size=2048",
    f"final-hero-light={PICK}&mat=inkglow&key=1&bg=light&yaw=-18&pitch=11&size=2048",
    "final-curl=form=curl&mat=boneglow&glow=2.5&key=0.7&yaw=-16&pitch=10&size=2048",
    "final-coil=form=coil&mat=mintmetal&key=1.7&exposure=1.1&size=2048",
    f"final-tile-dark={TILE}&size=2048",
    f"final-tile-light={TILE}&bg=light&size=2048",
    f"final-mark-dark={PICK}&flat=1&size=1024",
    f"final-mark-light={PICK}&mat=inkglow&key=1&flat=1&bg=light&size=1024",
]


def serve() -> None:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(HERE))
    handler.log_message = lambda *a, **k: None
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()


def main(jobs: list[str]) -> None:
    OUT.mkdir(exist_ok=True)
    serve()
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"])
        page = browser.new_page(viewport={"width": 1024, "height": 1024})
        page.on("console", lambda m: print(f"console[{m.type}]:", m.text))
        page.on("pageerror", lambda e: print("pageerror:", e))
        for job in jobs:
            name, query = job.split("=", 1)
            page.goto(f"http://127.0.0.1:{PORT}/render.html?{query}")
            page.wait_for_function("window.__done === true", timeout=180_000)
            data = page.evaluate("document.querySelector('canvas').toDataURL('image/png')")
            (OUT / f"{name}.png").write_bytes(base64.b64decode(data.split(",", 1)[1]))
            print("wrote", name)
        browser.close()


if __name__ == "__main__":
    main(FINALS if sys.argv[1:] == ["finals"] else sys.argv[1:])
