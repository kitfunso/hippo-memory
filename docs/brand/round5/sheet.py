"""Build the round-5 sheet from renders/final-*.png: one self-contained HTML file, then phone and desktop screenshots.

Run `python render.py finals` first. Usage: python sheet.py
"""
import base64
import io
from pathlib import Path
from string import Template

from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
R = HERE / "renders"
OUT = HERE / "2026-09-25-logo-round5.html"
INK, PAPER = (11, 15, 12), (227, 233, 228)


def load(name: str) -> Image.Image:
    return Image.open(R / f"{name}.png").convert("RGB")


def b64(im: Image.Image, fmt: str = "JPEG", q: int = 88) -> str:
    buf = io.BytesIO()
    im.save(buf, fmt, quality=q, optimize=True)
    return f"data:image/{fmt.lower()};base64," + base64.b64encode(buf.getvalue()).decode()


def hero(name: str, width: int = 1100, crop: float = 0.06) -> str:
    im = load(name)
    w, h = im.size
    box = (int(w * crop), int(h * crop), int(w * (1 - crop)), int(h * (1 - crop)))
    return b64(im.crop(box).resize((width, width), Image.LANCZOS))


# The slab fills 65% of the frame at dist 11.5; the crop keeps its shadow and a little flat surround.
def tile(name: str, px: int, frac: tuple[float, float, float, float] = (0.12, 0.10, 0.88, 0.86)) -> str:
    im = load(name)
    w, h = im.size
    box = (int(w * frac[0]), int(h * frac[1]), int(w * frac[2]), int(h * frac[3]))
    return b64(im.crop(box).resize((px * 2, px * 2), Image.LANCZOS), "PNG")


# Row takes the render's own backdrop colour so the tile crop has no visible square edge.
def corner(name: str) -> str:
    im = load(name)
    w, h = im.size
    x0, y0 = int(w * 0.13), int(h * 0.11)
    return "#%02x%02x%02x" % im.getpixel((x0, y0))


def mark(name: str, bg: tuple[int, int, int], height: int = 160) -> str:
    im = load(name)
    diff = ImageChops.difference(im, Image.new("RGB", im.size, bg)).convert("L").point(lambda v: 255 if v > 10 else 0)
    x0, y0, x1, y1 = diff.getbbox()
    pad = int((y1 - y0) * 0.06)
    cut = im.crop((x0 - pad, y0 - pad, x1 + pad, y1 + pad))
    return b64(cut.resize((round(cut.width * height / cut.height), height), Image.LANCZOS), "PNG")


TEMPLATE = Template("""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>hippo logo, round 5</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@400;600&family=Onest:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{--ink:#0b0f0c;--surface:#121815;--line:#1f2a22;--bone:#e9efe9;--muted:#8a978d;--mint:#7ce38b;--paper:#e3e9e4}
*{box-sizing:border-box}
body{margin:0;background:var(--ink);color:var(--bone);font:16px/1.5 Onest,system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:28px 18px 60px}
h1{font:600 22px/1.2 "Martian Mono",monospace;margin:0 0 6px}
h2{font:600 13px/1.2 "Martian Mono",monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--mint);margin:40px 0 14px}
p{margin:0 0 12px}
.sub{color:var(--muted);font-size:14px}
.hero{width:100%;border-radius:16px;display:block;margin:18px 0 12px}
.cap{font-size:15px}
.cap b{font-family:"Martian Mono",monospace;font-weight:600;color:var(--bone)}
.fin{display:grid;gap:16px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.card img{width:100%;display:block}
.card div{padding:12px 14px 14px;font-size:14px}
.card b{font-family:"Martian Mono",monospace;font-weight:600;display:block;margin-bottom:4px}
.tag{display:inline-block;font:600 10px/1 "Martian Mono",monospace;letter-spacing:.08em;color:var(--ink);background:var(--mint);padding:5px 8px;border-radius:999px;vertical-align:2px;margin-left:6px}
.row{display:flex;flex-wrap:wrap;align-items:flex-end;gap:18px;padding:22px 18px;border-radius:14px}
.row.dark{background:var(--ink);border:1px solid var(--line)}
.row.light{background:var(--paper)}
.row img{display:block;flex:none}
.row span{font:11px "Martian Mono",monospace;color:var(--muted);display:block;text-align:center;margin-top:8px}
.lock{display:flex;align-items:center;gap:14px;padding:22px 20px;border-radius:14px}
.lock.dark{background:var(--ink);border:1px solid var(--line)}
.lock.light{background:var(--paper);color:var(--ink);margin-top:12px}
.lock img{height:52px;display:block}
.lock .wm{font:600 34px/1 "Martian Mono",monospace;letter-spacing:-.03em}
.mono{font:13px "Martian Mono",monospace;color:var(--muted);word-break:break-all}
a{color:var(--mint)}
@media (min-width:640px){.fin{grid-template-columns:repeat(3,1fr)}}
</style></head><body><main>
<h1>hippo logo, round 5</h1>
<p class="sub">Every mark on this sheet is a three.js 0.180 render: the round-4 outlines extruded with real bevels, MeshPhysicalMaterial ceramic, frosted glass and brushed metal, a PMREM studio light with a key and a mint rim, GTAO and MSAA. Nothing here is a flat drawing.</p>

<img class="hero" src="$hero" alt="Echo h, the pick: a bone ceramic h with a frosted glass echo lit from inside">
<p class="cap"><b>Echo h</b><span class="tag">PICK</span><br>A bone ceramic h, its own arch repeated at half size in frosted glass with a mint light inside. The letter is the memory; the small lit arch is the part that came back.</p>

<h2>Finalists</h2>
<div class="fin">
<div class="card"><img src="$f1" alt="Echo h on light"><div><b>Echo h</b>On light the h goes ink ceramic and the echo stays lit: two materials, one silhouette, and it still reads as an h at 29 px.</div></div>
<div class="card"><img src="$f2" alt="Curl"><div><b>Curl</b>The seahorse curl as a matte shell with a lit mint eye. The hippocampus by shape, softer and less literal than the letter.</div></div>
<div class="card"><img src="$f3" alt="Coil"><div><b>Coil</b>A log spiral in brushed mint metal whose band halves every turn: the half-life drawn as one solid. Striking large, thin when small.</div></div>
</div>

<h2>App icon</h2>
<p class="sub">The pick set proud of an ink ceramic slab, rendered in 3D at each size, on dark and on light.</p>
<div class="row dark" style="background:$dbg">
<div><img src="$d180" width="180" height="180" alt=""><span>180</span></div>
<div><img src="$d60" width="60" height="60" alt=""><span>60</span></div>
<div><img src="$d48" width="48" height="48" alt=""><span>48</span></div>
<div><img src="$d29" width="29" height="29" alt=""><span>29</span></div>
</div>
<div class="row light" style="margin-top:12px;background:$lbg">
<div><img src="$l180" width="180" height="180" alt=""><span>180</span></div>
<div><img src="$l60" width="60" height="60" alt=""><span>60</span></div>
<div><img src="$l48" width="48" height="48" alt=""><span>48</span></div>
<div><img src="$l29" width="29" height="29" alt=""><span>29</span></div>
</div>

<h2>Lockup</h2>
<div class="lock dark" style="background:$mdbg"><img src="$mdark" alt=""><span class="wm">hippo</span></div>
<div class="lock light" style="background:$mlbg"><img src="$mlight" alt=""><span class="wm">hippo</span></div>

<h2>Live</h2>
<p class="sub">Open <a href="live.html">round5/live.html</a> over http (any static server in this folder) to orbit the pick in real time. Same scene file, same materials.</p>

<h2>Regenerate</h2>
<p class="mono">cd docs/brand/round5 &amp;&amp; python render.py finals &amp;&amp; python sheet.py</p>
<p class="sub">Scene: <span class="mono">scene.js</span>. Any variant: <span class="mono">python render.py name=form=echo&amp;mat=boneglow&amp;env=b</span> (forms echo, curl, coil, decay, core; recipes in RECIPES).</p>
</main></body></html>
""")


def build() -> None:
    html = TEMPLATE.substitute(
        hero=hero("final-hero"),
        f1=hero("final-hero-light", 700, 0.1), f2=hero("final-curl", 700, 0.1), f3=hero("final-coil", 700, 0.1),
        **{f"d{n}": tile("final-tile-dark", n) for n in (180, 60, 48, 29)},
        **{f"l{n}": tile("final-tile-light", n, (0.1, 0.08, 0.94, 0.92)) for n in (180, 60, 48, 29)},
        dbg=corner("final-tile-dark"), lbg=corner("final-tile-light"),
        mdbg=corner("final-mark-dark"), mlbg=corner("final-mark-light"),
        mdark=mark("final-mark-dark", INK), mlight=mark("final-mark-light", PAPER),
    )
    OUT.write_text(html, encoding="utf-8")
    print("wrote", OUT, f"{OUT.stat().st_size / 1e6:.2f} MB")


def shoot() -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for width, dpr in ((420, 2), (1000, 1)):
            page = browser.new_page(viewport={"width": width, "height": 900}, device_scale_factor=dpr)
            page.goto(OUT.as_uri())
            page.wait_for_timeout(1500)
            page.screenshot(path=str(R / f"sheet-{width}.png"), full_page=True)
            print("shot", width)
        browser.close()


if __name__ == "__main__":
    build()
    shoot()
