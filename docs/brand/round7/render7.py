"""Render round-7 scenes (turing, interference): serves round7 over http on 8805, captures the canvas in headless Chromium.

Usage: python render7.py turing/hero=turing/scene.html?size=2048 [more jobs]; `down=N` Lanczos-downsamples after capture.
"""
import base64
import functools
import http.server
import sys
import threading
from pathlib import Path
from urllib.parse import parse_qs

from PIL import Image
from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
PORT = 8805


def serve() -> None:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(HERE))
    handler.log_message = lambda *a, **k: None
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()


def main(jobs: list[str]) -> None:
    serve()
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"])
        page = browser.new_page(viewport={"width": 1024, "height": 1024})
        page.on("console", lambda m: print(f"console[{m.type}]:", m.text))
        page.on("pageerror", lambda e: print("pageerror:", e))
        for job in jobs:
            name, target = job.split("=", 1)
            out = HERE / f"{name}.png"
            out.parent.mkdir(parents=True, exist_ok=True)
            page.goto(f"http://127.0.0.1:{PORT}/{target}")
            page.wait_for_function("window.__done === true", timeout=500_000, polling=500)
            data = page.evaluate("document.querySelector('canvas').toDataURL('image/png')")
            out.write_bytes(base64.b64decode(data.split(",", 1)[1]))
            q = parse_qs(target.split("?", 1)[1] if "?" in target else "")
            if q.get("down"):
                n = int(q["down"][0])
                Image.open(out).resize((n, n), Image.LANCZOS).save(out)
            print("wrote", out.relative_to(HERE))
        browser.close()


if __name__ == "__main__":
    main(sys.argv[1:])
