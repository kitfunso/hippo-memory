"""Round-4 concept generator: eight flat marks on a 64-unit grid, plus a contact sheet PNG to critique."""
import base64
import functools
import http.server
import math
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
OUT = HERE / "concepts"
PORT = 8766
W = 7  # monoline stroke on the 64 grid: 1.75 px at 16 px


def stroke(d: str, w: float = W, cap: str = "round") -> str:
    return f'<path d="{d}" fill="none" stroke="currentColor" stroke-width="{w}" stroke-linecap="{cap}" stroke-linejoin="round"/>'


def fill(d: str) -> str:
    return f'<path d="{d}" fill="currentColor"/>'


def svg(body: str) -> str:
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">{body}</svg>'


def f2(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".")


# 1. Echo h: the letter h, then the same arch at half height, then half again. One glyph, one half-life.
def echo_h() -> str:
    d = ("M11 12V52 M11 40A12 12 0 0 1 35 40V52 M35 46A6 6 0 0 1 47 46V52 M47 49A3 3 0 0 1 53 49V52")
    return svg(stroke(d))


# 2. Curl h: an h whose arch winds inward into a hippocampus curl instead of dropping a leg.
def curl_h() -> str:
    d = ("M13 12V52 M13 40A13 13 0 0 1 39 40A9 9 0 0 1 30 49A6.2 6.2 0 0 1 23.8 42.8"
         "A4.3 4.3 0 0 1 28.1 38.5A3 3 0 0 1 31.1 41.5")
    return svg(stroke(d))


def spiral_outline(turns: float, r0: float, r1: float, w0: float, w1: float, cx: float, cy: float, phase: float) -> str:
    """Filled tapered logarithmic spiral: width and radius both shrink toward the centre."""
    n = 260
    k = math.log(r0 / r1) / (turns * 2 * math.pi)
    outer, inner = [], []
    for i in range(n + 1):
        t = i / n
        th = phase - t * turns * 2 * math.pi
        r = r0 * math.exp(-k * t * turns * 2 * math.pi)
        # Tangent of r(th)e^{i th} with r' = -k r (for th decreasing): use numeric derivative for the normal.
        dth = -1e-3
        r2 = r0 * math.exp(-k * (t * turns * 2 * math.pi - dth))
        x, y = cx + r * math.cos(th), cy + r * math.sin(th)
        x2, y2 = cx + r2 * math.cos(th + dth), cy + r2 * math.sin(th + dth)
        tx, ty = x2 - x, y2 - y
        ln = math.hypot(tx, ty) or 1
        nx, ny = -ty / ln, tx / ln
        h = (w0 + (w1 - w0) * t) / 2
        outer.append((x + nx * h, y + ny * h))
        inner.append((x - nx * h, y - ny * h))
    pts = outer + inner[::-1]
    d = "M" + " L".join(f"{f2(x)} {f2(y)}" for x, y in pts) + "Z"
    # Round the thick end with a cap circle.
    x0, y0 = cx + r0 * math.cos(phase), cy + r0 * math.sin(phase)
    return fill(d) + f'<circle cx="{f2(x0)}" cy="{f2(y0)}" r="{f2(w0 / 2)}" fill="currentColor"/>'


# 3. Curl: the hippocampus alone, a tapered seahorse-tail spiral with the recalled memory at its eye.
def curl() -> str:
    body = spiral_outline(turns=1.9, r0=22, r1=4.5, w0=9, w1=2.2, cx=33, cy=33, phase=2.2)
    body += '<circle cx="33" cy="33" r="3.2" fill="currentColor"/>'
    return svg(body)


# 4. Seahorse: hippocampus drawn as the animal, one stroke from snout to coiled tail, plus an eye.
def seahorse() -> str:
    d = ("M14 19H23C29 19 33 23 33 28C33 33 28 35 27 40C26 45 32 47 33 51"
         "A4.5 4.5 0 0 1 26 53A3.2 3.2 0 0 1 28.5 47.5")
    body = stroke(d) + '<circle cx="27" cy="25" r="2.6" fill="currentColor"/>'
    return svg(body)


# 5. Surface: a hippo with only ears and eyes above the waterline; what is below is dormant.
def surface() -> str:
    head = "M14 43V36Q14 30 20 30H44Q50 30 50 36V43Z"
    ears = '<circle cx="19" cy="29" r="4" fill="currentColor"/><circle cx="45" cy="29" r="4" fill="currentColor"/>'
    eyes = '<circle cx="24" cy="36.5" r="2.4" fill="#0b0f0c"/><circle cx="40" cy="36.5" r="2.4" fill="#0b0f0c"/>'
    water = stroke("M7 47H57", w=4)
    return svg(fill(head) + ears + eyes + water)


# 6. Rings: a memory at the centre, each ring outward carries half the weight of the one inside.
def rings() -> str:
    body = '<circle cx="32" cy="32" r="5.5" fill="currentColor"/>'
    for r, w in ((13.5, 6), (21.5, 3), (27.5, 1.5)):
        body += f'<circle cx="32" cy="32" r="{r}" fill="none" stroke="currentColor" stroke-width="{w}"/>'
    return svg(body)


# 7. Bars: four bars, each half the height of the last. The half-life as a chart.
def bars() -> str:
    body = ""
    for i, h in enumerate((40, 20, 10, 5)):
        x = 8 + i * 13
        body += f'<rect x="{x}" y="{52 - h}" width="9" height="{h}" rx="4.5" fill="currentColor"/>'
    return svg(body)


# 8. Recall curve: the forgetting curve, reset by each recall and flatter after every one.
def recall_curve() -> str:
    pts = []
    base, top = 52.0, 22.0
    for x0, x1, tau in ((8, 24, 5.0), (24, 40, 9.0), (40, 57, 16.0)):
        for i in range(0, 25):
            x = x0 + (x1 - x0) * i / 24
            y = base - (base - top) * math.exp(-(x - x0) / tau)
            pts.append((x, y))
    segs = []
    for i, (x, y) in enumerate(pts):
        if i % 25 == 0:
            segs.append(f"M{f2(x)} {f2(base if i else y)}" + (f"L{f2(x)} {f2(y)}" if i else ""))
        else:
            segs.append(f"L{f2(x)} {f2(y)}")
    return svg(stroke(" ".join(segs), w=6))


CONCEPTS = [
    ("c1-echo-h", "Echo h", echo_h),
    ("c2-curl-h", "Curl h", curl_h),
    ("c3-curl", "Curl", curl),
    ("c4-seahorse", "Seahorse", seahorse),
    ("c5-surface", "Surface", surface),
    ("c6-rings", "Rings", rings),
    ("c7-bars", "Bars", bars),
    ("c8-recall-curve", "Recall curve", recall_curve),
]


def sheet() -> str:
    rows = ""
    for slug, title, fn in CONCEPTS:
        s = fn()
        (OUT / f"{slug}.svg").write_text(s + "\n", encoding="utf-8")
        rows += (f'<div class="row"><b>{title}</b>'
                 f'<span class="dark big">{s}</span><span class="light big">{s}</span>'
                 f'<span class="dark s64">{s}</span><span class="dark s32">{s}</span><span class="dark s16">{s}</span>'
                 f'<span class="light s16">{s}</span><span class="mono s64">{s}</span></div>')
    return f"""<!doctype html><meta charset="utf-8"><style>
body{{margin:0;background:#1a1d1b;font:13px system-ui;color:#ccc}}
.row{{display:flex;align-items:center;gap:14px;padding:10px 16px;border-bottom:1px solid #333}}
.row b{{width:110px}}
span{{display:inline-grid;place-items:center;border-radius:8px}}
svg{{display:block}}
.dark{{background:#0b0f0c;color:#7ce38b}} .light{{background:#fff;color:#0b0f0c}} .mono{{background:#7ce38b;color:#0b0f0c}}
.big{{width:200px;height:200px}} .big svg{{width:176px;height:176px}}
.s64{{width:84px;height:84px}} .s64 svg{{width:64px;height:64px}}
.s32{{width:52px;height:52px}} .s32 svg{{width:32px;height:32px}}
.s16{{width:36px;height:36px}} .s16 svg{{width:16px;height:16px}}
</style>{rows}"""


def main() -> None:
    OUT.mkdir(exist_ok=True)
    html = OUT / "contact.html"
    html.write_text(sheet(), encoding="utf-8")
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1000, "height": 1800}, device_scale_factor=1)
        pg.goto(html.as_uri())
        pg.screenshot(path=str(OUT / "contact.png"), full_page=True)
        b.close()
    print("wrote", OUT / "contact.png")


if __name__ == "__main__":
    main()
