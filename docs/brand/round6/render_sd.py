"""Render round-6 logo scenes: serves this folder over http, captures a page in headless Chromium.

Usage: python render.py surfacing/renders/h01=surfacing.html?yaw=20&size=2048 [more jobs]
       a `down=1024` query key downsamples the saved PNG with Lanczos after capture.
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
PORT = 8801


def serve() -> None:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(HERE))
    handler.log_message = lambda *a, **k: None
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()


def luminance_key(out: Path) -> None:
    """Additive glow rendered on black is already premultiplied: alpha = max channel, colour un-premultiplied."""
    im = Image.open(out).convert("RGB")
    r, g, b = (ch.load() for ch in im.split())
    w, h = im.size
    keyed = Image.new("RGBA", im.size)
    px = keyed.load()
    for y in range(h):
        for x in range(w):
            a = max(r[x, y], g[x, y], b[x, y])
            px[x, y] = (min(255, r[x, y] * 255 // a), min(255, g[x, y] * 255 // a), min(255, b[x, y] * 255 // a), a) if a else (0, 0, 0, 0)
    keyed.save(out)


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
            page.wait_for_function("window.__done === true", timeout=300_000)
            data = page.evaluate("document.querySelector('canvas').toDataURL('image/png')")
            out.write_bytes(base64.b64decode(data.split(",", 1)[1]))
            q = parse_qs(target.split("?", 1)[1] if "?" in target else "")
            if q.get("down"):
                n = int(q["down"][0])
                Image.open(out).resize((n, n), Image.LANCZOS).save(out)
            if q.get("key"):
                luminance_key(out)
            print("wrote", out.relative_to(HERE))
        browser.close()


if __name__ == "__main__":
    main(sys.argv[1:])
