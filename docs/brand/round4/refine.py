"""Round-4 iteration 2: variants of the h family and the curl, shot as one contact sheet."""
import math
from pathlib import Path

from playwright.sync_api import sync_playwright

from concepts import f2, fill, spiral_outline, stroke, svg

HERE = Path(__file__).parent
OUT = HERE / "concepts"


def quarter_spiral(x: float, y: float, heading: float, radii: list[float], cw: bool) -> str:
    """Chain of quarter arcs, each of the next radius, turning the same way. heading in degrees, screen coords."""
    d = ""
    h = math.radians(heading)
    for r in radii:
        # Turn by 90 degrees about a centre offset perpendicular to the heading.
        side = 1 if cw else -1
        cx, cy = x + math.cos(h + side * math.pi / 2) * r, y + math.sin(h + side * math.pi / 2) * r
        h2 = h + side * math.pi / 2
        x2, y2 = cx + math.cos(h2 - side * math.pi / 2) * r, cy + math.sin(h2 - side * math.pi / 2) * r
        d += f"A{f2(r)} {f2(r)} 0 0 {1 if cw else 0} {f2(x2)} {f2(y2)}"
        x, y, h = x2, y2, h2
    return d


# Echo h, self-similar: each echo is the previous one at half scale, stroke included.
def echo_h_selfsim(cap: str) -> str:
    parts = stroke("M9 10V54", 6, cap)
    parts += stroke("M9 40A14 14 0 0 1 37 40V54", 6, cap)
    parts += stroke("M37 47A7 7 0 0 1 51 47V54", 3, cap)
    parts += stroke("M51 50.5A3.5 3.5 0 0 1 58 50.5V54", 1.5, cap)
    return svg(parts)


# Echo h, two-step: h plus one half-height echo, constant stroke.
def echo_h_two(cap: str) -> str:
    d = "M10 10V54 M10 38A15 15 0 0 1 40 38V54 M40 46.5A7.5 7.5 0 0 1 55 46.5V54"
    return svg(stroke(d, 6, cap))


# Echo h, three-step with the last echo a dot: h, half, point.
def echo_h_dot(cap: str) -> str:
    d = "M9 10V54 M9 40A14 14 0 0 1 37 40V54 M37 47A7 7 0 0 1 51 47V54"
    return svg(stroke(d, 6, cap) + '<circle cx="57.5" cy="51" r="3" fill="currentColor"/>')


# Tail h: an h whose right leg curls inward at the foot, the seahorse tail.
def tail_h(cap: str) -> str:
    d = "M11 12V52 M11 40A12 12 0 0 1 35 40V45" + quarter_spiral(35, 45, 90, [7, 4.6, 3], True)
    return svg(stroke(d, 6, cap))


# Decay h: the arch rises and then decays like the forgetting curve, never reaching a second leg.
def decay_h(cap: str) -> str:
    pts = []
    for i in range(0, 61):
        x = 23 + 34 * i / 60
        y = 52 - 24 / (1 + ((x - 23) / 10) ** 2)
        pts.append(f"L{f2(x)} {f2(y)}")
    d = "M11 12V52 M11 40A12 12 0 0 1 23 28" + "".join(pts)
    return svg(stroke(d, 6, cap))


# Curl v2: fewer turns, thicker head, tail thins to a point; the eye is the end of the line itself.
def curl_v2() -> str:
    return svg(spiral_outline(turns=1.6, r0=22.5, r1=3.6, w0=11, w1=3.5, cx=33, cy=34, phase=2.5))


# Curl v3: constant-stroke spiral of quarter arcs, a dot at the eye.
def curl_v3(cap: str) -> str:
    d = "M10 40" + quarter_spiral(10, 40, -90, [22, 16, 11.5, 8, 5.5], True)
    return svg(stroke(d, 6, cap) + '<circle cx="34.5" cy="36.5" r="3.4" fill="currentColor"/>')


VARIANTS = [
    ("e1-echo-selfsim-round", "Echo self-similar, round", lambda: echo_h_selfsim("round")),
    ("e1-echo-selfsim-butt", "Echo self-similar, butt", lambda: echo_h_selfsim("butt")),
    ("e2-echo-two-round", "Echo two-step, round", lambda: echo_h_two("round")),
    ("e2-echo-two-butt", "Echo two-step, butt", lambda: echo_h_two("butt")),
    ("e3-echo-dot-round", "Echo h.half.dot", lambda: echo_h_dot("round")),
    ("t1-tail-h-round", "Tail h, round", lambda: tail_h("round")),
    ("t1-tail-h-butt", "Tail h, butt", lambda: tail_h("butt")),
    ("d1-decay-h-round", "Decay h, round", lambda: decay_h("round")),
    ("d1-decay-h-butt", "Decay h, butt", lambda: decay_h("butt")),
    ("c2-curl-tapered", "Curl v2 tapered", curl_v2),
    ("c3-curl-arcs", "Curl v3 arcs", lambda: curl_v3("round")),
]


def main() -> None:
    rows = ""
    for slug, title, fn in VARIANTS:
        s = fn()
        (OUT / f"{slug}.svg").write_text(s + "\n", encoding="utf-8")
        rows += (f'<div class="row"><b>{title}</b>'
                 f'<span class="dark big">{s}</span><span class="light big">{s}</span>'
                 f'<span class="dark s64">{s}</span><span class="dark s32">{s}</span><span class="dark s16">{s}</span>'
                 f'<span class="light s16">{s}</span><span class="mono s64">{s}</span></div>')
    html = OUT / "contact2.html"
    css = (HERE / "concepts.py").read_text(encoding="utf-8").split("<style>")[1].split("</style>")[0].replace("{{", "{").replace("}}", "}")
    html.write_text(f"<!doctype html><meta charset='utf-8'><style>{css}</style>{rows}", encoding="utf-8")
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1000, "height": 2500}, device_scale_factor=1)
        pg.goto(html.as_uri())
        pg.screenshot(path=str(OUT / "contact2.png"), full_page=True)
        b.close()
    print("wrote", OUT / "contact2.png")


if __name__ == "__main__":
    main()
