"""Build the self-contained round-4 sheet from the finalist SVGs, then screenshot it at 420 px wide."""
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
OUT = HERE / "2026-09-25-logo-round4.html"

FINALISTS = [
    ("echo-h", "Echo h", "The letter h, then its own arch at half size. One glyph says half-life, and it still reads as h at 16 px.", True),
    ("decay-h", "Decay h", "An h whose arch falls along the forgetting curve. Says decay in one line, but the droop reads tired above 64 px.", False),
    ("curl", "Curl", "The hippocampus as a tapered seahorse tail, kin to the site's spiral. Holds at 16 px, but a stranger reads a 9 before a curl.", False),
]


def load(slug: str) -> str:
    return (HERE / f"{slug}.svg").read_text(encoding="utf-8").strip()


def tile(svg: str, px: int) -> str:
    return f'<div class="tile" style="width:{px}px;height:{px}px;border-radius:{px * 0.2237:.1f}px">{svg}</div>'


def icon_row(svg: str, light: bool) -> str:
    cells = "".join(f'<div class="sz">{tile(svg, s)}<i>{s}</i></div>' for s in (180, 60, 48, 29))
    return f'<div class="row{" light" if light else ""}">{cells}</div>'


def favicon_row(svg: str, light: bool) -> str:
    cells = "".join(f'<div class="sz"><span class="fav" style="width:{s}px;height:{s}px">{svg}</span><i>{s}</i></div>' for s in (32, 16))
    bare = "".join(f'<div class="sz"><span class="bare" style="width:{s}px;height:{s}px">{svg}</span><i>{s} bare</i></div>' for s in (32, 16))
    return f'<div class="row{" light" if light else ""}">{cells}{bare}</div>'


def lockup(svg: str, light: bool) -> str:
    return f'<div class="row lockup{" light" if light else ""}"><span class="lm">{svg}</span><span class="wm">hippo</span></div>'


def card(slug: str, title: str, why: str, pick: bool) -> str:
    s = load(slug)
    return (f'<figure class="card{" pick" if pick else ""}">'
            f'<div class="pair"><span class="dark">{s}</span><span class="white">{s}</span></div>'
            f'<div class="small"><span class="dark s32">{s}</span><span class="dark s16">{s}</span><span class="white s32">{s}</span><span class="white s16">{s}</span><span class="mint s32">{s}</span></div>'
            f'<figcaption><b>{title}</b>{" <em>pick</em>" if pick else ""}<p>{why}</p><code>{slug}.svg</code></figcaption></figure>')


def main() -> None:
    pick = load("echo-h")
    cards = "".join(card(*f) for f in FINALISTS)
    html = f"""<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>hippo logo, round 4</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@400;500;600&family=Onest:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{{--ink:#0b0f0c;--surface:#111713;--line:#1f2a22;--bone:#e6ede7;--muted:#9aa79e;--mint:#7ce38b}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--ink);color:var(--bone);font:15px/1.5 Onest,system-ui,sans-serif}}
main{{max-width:1040px;margin:auto;padding:24px 16px 64px}}
h1{{font:500 20px/1.2 "Martian Mono",monospace;margin:0 0 6px}}
h2{{font:500 13px/1.2 "Martian Mono",monospace;color:var(--mint);margin:40px 0 12px;letter-spacing:.04em;text-transform:uppercase}}
p{{margin:0}} .lede{{color:var(--muted);max-width:60ch}}
svg{{display:block;width:100%;height:100%}}
.hero{{display:grid;place-items:center;background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:32px 16px 28px;margin-top:18px}}
.hero .mark{{width:min(56vw,260px);height:min(56vw,260px);color:var(--mint)}}
.hero .cap{{margin-top:18px;color:var(--muted);font-size:13px;text-align:center}}
.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}}
.card{{margin:0;background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden}}
.card.pick{{border-color:var(--mint)}}
.pair{{display:grid;grid-template-columns:1fr 1fr}} .pair span{{display:grid;place-items:center;aspect-ratio:1}}
.pair svg{{width:78%;height:78%}}
.dark{{background:var(--ink);color:var(--mint)}} .white{{background:#fff;color:var(--ink)}} .mint{{background:var(--mint);color:var(--ink)}}
.small{{display:flex;gap:8px;padding:10px 12px;background:#161c18;align-items:center}}
.small span{{display:grid;place-items:center;border-radius:6px}}
.s32{{width:44px;height:44px}} .s32 svg{{width:32px;height:32px}}
.s16{{width:28px;height:28px}} .s16 svg{{width:16px;height:16px}}
figcaption{{padding:12px 14px 14px}} figcaption b{{font:500 14px "Martian Mono",monospace}}
figcaption em{{font-style:normal;color:var(--ink);background:var(--mint);font-size:11px;padding:2px 7px;border-radius:9px;margin-left:8px;vertical-align:1px}}
figcaption p{{margin:6px 0 8px;color:var(--muted);font-size:13.5px}} figcaption code{{font:12px "Martian Mono",monospace;color:#6e7a71}}
.row{{display:flex;flex-wrap:wrap;align-items:flex-end;gap:18px;padding:20px;border-radius:14px;background:var(--surface);border:1px solid var(--line);margin-bottom:12px}}
.row.light{{background:#f1f4f1;border-color:#dfe6df;color:var(--ink)}} .row.light i{{color:#5b675f}}
.sz{{display:flex;flex-direction:column;align-items:center;gap:6px}} .sz i{{font:11px "Martian Mono",monospace;color:var(--muted);font-style:normal}}
.tile{{display:grid;place-items:center;background:var(--ink);color:var(--mint);box-shadow:0 0 0 1px rgba(255,255,255,.06)}}
.row.light .tile{{box-shadow:0 1px 3px rgba(0,0,0,.18)}} .tile svg{{width:76%;height:76%}}
.fav{{display:grid;place-items:center;background:var(--ink);color:var(--mint);border-radius:22%;box-shadow:0 0 0 1px rgba(255,255,255,.06)}} .fav svg{{width:82%;height:82%}}
.bare{{display:block;color:var(--mint)}} .row.light .bare{{color:var(--ink)}}
.lockup{{align-items:center;gap:14px;padding:26px 24px}}
.lm{{width:44px;height:44px;color:var(--mint)}} .row.light .lm{{color:var(--ink)}}
.wm{{font:500 34px/1 "Martian Mono",monospace;letter-spacing:-.02em;color:var(--bone)}} .row.light .wm{{color:var(--ink)}}
.notes{{color:var(--muted);font-size:13.5px;max-width:64ch}} .notes li{{margin-bottom:6px}}
</style>
<main>
<h1>hippo logo, round 4</h1>
<p class="lede">Flat first this time. Every mark is one colour on a 64 unit grid with a 6 unit stroke, and had to read at 16 px before anything else. 11 concepts drawn, 3 kept, 1 picked.</p>

<div class="hero"><div class="mark">{pick}</div><p class="cap">Echo h. The letter, then its own arch at half size: the half-life as a glyph.</p></div>

<h2>The three finalists</h2>
<div class="grid">{cards}</div>

<h2>Echo h as the app icon, 180, 60, 48 and 29 px</h2>
{icon_row(pick, False)}{icon_row(pick, True)}

<h2>Favicon, 32 and 16 px</h2>
{favicon_row(pick, False)}{favicon_row(pick, True)}

<h2>Wordmark</h2>
{lockup(pick, False)}{lockup(pick, True)}

<h2>Notes</h2>
<ul class="notes">
<li>Cut in round 4: seahorse (read as a question mark), hippo at the waterline (read as a bathtub), rings (a target), bars (an equaliser), recall curve (a scribbled W), tail h (read as b), self-similar echo (thin strokes vanish at 16 px), arc spiral (read as an at sign).</li>
<li>A matte clay render of Echo h was made with three.js and dropped: it went pale and toothpaste-like and did not beat the flat mark, so the flat mark ships alone.</li>
<li>Weak points to know about: some eyes will read Echo h as "hn" before "h"; the 1.5 px stroke at 16 px is fine on screen but print below 12 mm wants a heavier cut.</li>
<li>Sources: <code>echo-h.svg</code>, <code>decay-h.svg</code>, <code>curl.svg</code>, <code>favicon.svg</code> next to this file. Every SVG uses currentColor, so CSS recolours it inline.</li>
</ul>
</main></html>"""
    OUT.write_text(html, encoding="utf-8")
    fav = pick.replace('viewBox="0 0 64 64">', 'viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0b0f0c"/><g transform="translate(6 6) scale(0.8125)" fill="#7ce38b" color="#7ce38b">', 1).replace("</svg>", "</g></svg>")
    (HERE / "favicon.svg").write_text(fav + "\n", encoding="utf-8")
    with sync_playwright() as p:
        b = p.chromium.launch()
        for w in (420, 1000):
            pg = b.new_page(viewport={"width": w, "height": 900}, device_scale_factor=2 if w == 420 else 1)
            pg.goto(OUT.as_uri())
            pg.wait_for_timeout(1500)
            pg.screenshot(path=str(HERE / "concepts" / f"sheet-{w}.png"), full_page=True)
        b.close()
    print(OUT, len(html) // 1024, "KB")


if __name__ == "__main__":
    main()
