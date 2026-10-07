"""Render round-6 variants: serves this folder on 127.0.0.1:8803, captures render.html in headless Chromium.

Usage: python render.py name=view=hero&size=2048&out=1024 [name2=...]   (each job is <file>=<query string>)
       `out` downsamples the capture; a name with a path writes relative to renders/ (../hero for the deliverable).
"""
import base64
import functools
import http.server
import io
import sys
import threading
from pathlib import Path
from urllib.parse import parse_qs

from PIL import Image
from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
OUT = HERE / "renders"
PORT = 8803


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
            page.wait_for_function("window.__done === true", timeout=300_000)
            data = page.evaluate("document.querySelector('canvas').toDataURL('image/png')")
            img = Image.open(io.BytesIO(base64.b64decode(data.split(",", 1)[1])))
            out = int(parse_qs(query).get("out", [img.width])[0])
            if out != img.width:
                img = img.resize((out, out), Image.LANCZOS)
            img.save(OUT / f"{name}.png")
            print("wrote", name, img.size)
        browser.close()


if __name__ == "__main__":
    main(sys.argv[1:])
