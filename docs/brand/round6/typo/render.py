"""Round-6 renders for the typo and holo directions: serves round6/ on 8804, captures <dir>/render.html in headless Chromium.

Usage: python render.py typo hero=cam=low&field=ink [name2=...]   (each job is <file>=<query>, rendered at 2048 then resized to out=)
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

ROOT = Path(__file__).parent.parent
PORT = 8804


def serve() -> None:
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    handler.log_message = lambda *a, **k: None
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()


def main(sub: str, jobs: list[str]) -> None:
    out_dir = ROOT / sub / "renders"
    out_dir.mkdir(parents=True, exist_ok=True)
    serve()
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"])
        page = browser.new_page(viewport={"width": 1024, "height": 1024})
        page.on("console", lambda m: print(f"console[{m.type}]:", m.text))
        page.on("pageerror", lambda e: print("pageerror:", e))
        for job in jobs:
            name, query = job.split("=", 1)
            out = int(parse_qs(query).get("out", ["1024"])[0])
            page.goto(f"http://127.0.0.1:{PORT}/{sub}/render.html?size=2048&{query}")
            page.wait_for_function("window.__done === true", timeout=240_000)
            data = page.evaluate("document.querySelector('canvas').toDataURL('image/png')")
            img = Image.open(io.BytesIO(base64.b64decode(data.split(",", 1)[1])))
            if out != img.width:
                img = img.resize((out, out), Image.LANCZOS)
            img.save(out_dir / f"{name}.png")
            print("wrote", name, img.size, img.mode)
        browser.close()


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
