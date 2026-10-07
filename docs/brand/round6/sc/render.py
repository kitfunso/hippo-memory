"""Render round-6 sediment/chrome scenes: serves this folder on 8802, captures render.html in headless Chromium.

Usage: python render.py name=scene=sediment&form=mono [name2=...]   (each job is <file>=<query string>)
       add out=1024 to a job to render at size and downsample (premultiplied Lanczos, alpha-safe).
"""
import base64
import functools
import http.server
import io
import sys
import threading
from pathlib import Path
from urllib.parse import parse_qs

import numpy as np
from PIL import Image
from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
OUT = HERE / "work"
PORT = 8802


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a, **k) -> None:
        pass


def serve() -> None:
    handler = functools.partial(Quiet, directory=str(HERE))
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()


def downsample(png: bytes, out: int) -> bytes:
    img = Image.open(io.BytesIO(png)).convert("RGBA")
    a = np.asarray(img).astype(np.float32) / 255
    a[..., :3] *= a[..., 3:]  # premultiply so transparent pixels do not bleed dark fringes
    pm = Image.fromarray((a * 255).round().astype(np.uint8)).resize((out, out), Image.LANCZOS)
    b = np.asarray(pm).astype(np.float32) / 255
    alpha = np.maximum(b[..., 3:], 1e-6)
    b[..., :3] = np.clip(b[..., :3] / alpha, 0, 1)
    buf = io.BytesIO()
    Image.fromarray((b * 255).round().astype(np.uint8)).save(buf, "PNG")
    return buf.getvalue()


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
            page.wait_for_function("window.__done === true", timeout=240_000)
            data = page.evaluate("document.querySelector('canvas').toDataURL('image/png')")
            png = base64.b64decode(data.split(",", 1)[1])
            out = parse_qs(query).get("out")
            if out:
                png = downsample(png, int(out[0]))
            (OUT / f"{name}.png").write_bytes(png)
            print("wrote", name)
        browser.close()


if __name__ == "__main__":
    main(sys.argv[1:])
