"""Round-4 finalists: three refined marks, optically centred, plus a check sheet at 16/32/64/200 px."""
import math
import re
from pathlib import Path

from playwright.sync_api import sync_playwright

from concepts import f2, spiral_outline, stroke, svg

HERE = Path(__file__).parent
S = 6  # stroke on the 64 grid: 1.5 px at 16 px, 3 px at 32 px


def centred(body: str) -> str:
    """Translate the body so its geometric bbox sits at (32, 32). Path numbers only; stroke adds evenly."""
    xs, ys = [], []
    for d in re.findall(r'd="([^"]+)"', body):
        nums = [float(n) for n in re.findall(r"-?\d+\.?\d*", d)]
        # Arcs carry 7 numbers, lines 2; only the last two of each command are points, so scan commands.
        for cmd, args in re.findall(r"([MLAVH])([^MLAVHZ]*)", d):
            a = [float(n) for n in re.findall(r"-?\d+\.?\d*", args)]
            if cmd in "ML":
                xs += a[0::2]; ys += a[1::2]
            elif cmd == "A":
                xs.append(a[5]); ys.append(a[6])
            elif cmd == "V":
                ys += a
            elif cmd == "H":
                xs += a
    for cx, cy in re.findall(r'cx="([^"]+)" cy="([^"]+)"', body):
        xs.append(float(cx)); ys.append(float(cy))
    dx, dy = 32 - (min(xs) + max(xs)) / 2, 32 - (min(ys) + max(ys)) / 2
    return f'<g transform="translate({f2(dx)} {f2(dy)})">{body}</g>'


# 1. Echo h. The letter, then the same arch at half size. The half-life as a glyph.
def echo_h() -> str:
    d = "M10 10V54 M10 38A15 15 0 0 1 40 38V54 M40 46.5A7.5 7.5 0 0 1 55 46.5V54"
    return svg(centred(stroke(d, S)))


# 2. Decay h. The arch rises like an h and then falls along the forgetting curve.
def decay_h() -> str:
    pts = "".join(f"L{f2(x)} {f2(52 - 24 / (1 + ((x - 21) / 10) ** 2))}" for x in (21 + 34 * i / 60 for i in range(61)))
    return svg(centred(stroke("M9 12V52 M9 40A12 12 0 0 1 21 28" + pts, S)))


# 3. Curl. The hippocampus as a tapered seahorse tail; the line thins as it winds in and ends at its eye.
def curl() -> str:
    body = spiral_outline(turns=1.55, r0=23, r1=3.4, w0=11, w1=3.4, cx=32, cy=32, phase=math.pi * 0.95)
    m = re.search(r'd="M([^"]+)Z"', body)
    pts = [tuple(map(float, p.split())) for p in m.group(1).split(" L")]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    dx, dy = 32 - (min(xs) + max(xs)) / 2, 32 - (min(ys) + max(ys)) / 2
    return svg(f'<g transform="translate({f2(dx)} {f2(dy)})">{body}</g>')


FINAL = [("echo-h", "Echo h", echo_h), ("decay-h", "Decay h", decay_h), ("curl", "Curl", curl)]

CSS = """
body{margin:0;background:#1a1d1b;font:13px system-ui;color:#ccc}
.row{display:flex;align-items:center;gap:14px;padding:10px 16px;border-bottom:1px solid #333}
.row b{width:90px}
span{display:inline-grid;place-items:center;border-radius:8px}
svg{display:block}
.dark{background:#0b0f0c;color:#7ce38b} .light{background:#fff;color:#0b0f0c} .mono{background:#7ce38b;color:#0b0f0c}
.big{width:200px;height:200px} .big svg{width:176px;height:176px}
.s64{width:84px;height:84px} .s64 svg{width:64px;height:64px}
.s32{width:52px;height:52px} .s32 svg{width:32px;height:32px}
.s16{width:36px;height:36px} .s16 svg{width:16px;height:16px}
"""


def main() -> None:
    rows = ""
    for slug, title, fn in FINAL:
        s = fn()
        (HERE / f"{slug}.svg").write_text(s + "\n", encoding="utf-8")
        rows += (f'<div class="row"><b>{title}</b>'
                 f'<span class="dark big">{s}</span><span class="light big">{s}</span><span class="mono big">{s}</span>'
                 f'<span class="dark s64">{s}</span><span class="dark s32">{s}</span><span class="dark s16">{s}</span>'
                 f'<span class="light s32">{s}</span><span class="light s16">{s}</span></div>')
    html = HERE / "concepts" / "finalists.html"
    html.write_text(f"<!doctype html><meta charset='utf-8'><style>{CSS}</style>{rows}", encoding="utf-8")
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1100, "height": 700}, device_scale_factor=1)
        pg.goto(html.as_uri())
        pg.screenshot(path=str(HERE / "concepts" / "finalists.png"), full_page=True)
        b.close()
    print("wrote", HERE / "concepts" / "finalists.png")


if __name__ == "__main__":
    main()
