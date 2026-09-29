"""Build the self-contained round-3 sheet: renders cropped to content, embedded as base64."""
import base64
import io
from pathlib import Path

from PIL import Image

HERE = Path(__file__).parent
R = HERE / "renders"


def cropped(name: str, pad: float = 0.12, size: int = 0) -> str:
    im = Image.open(R / f"{name}.png").convert("RGBA")
    box = im.getchannel("A").getbbox()
    im = im.crop(box)
    side = int(max(im.size) * (1 + 2 * pad))
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
    if size:
        sq = sq.resize((size, size), Image.LANCZOS)
    buf = io.BytesIO()
    sq.save(buf, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def hero(name: str) -> str:
    im = Image.open(R / f"{name}.png").convert("RGB").crop((112, 112, 912, 912)).resize((640, 640), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=90)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


CARDS = [
    ("A", "Recall spiral", "A seahorse-tail curl, which is what hippocampus means. Bright where a memory was just recalled, cooling to dark stone as it winds in. The amber eye is the one memory marked wrong.", True),
    ("B", "Memory string", "The site's spiral, built from pearls. Each one is a memory; they dim as they age. Friendly, but busier at small sizes.", False),
    ("D", "Half-life rings", "Three generations of memory as rings, dimmer inward, with an amber rider. Reads as science, less as hippo.", False),
    ("C", "The h", "A lowercase h lit from the top and fading to its feet. Simplest, but says the least.", False),
]


def icon_tile(src: str, px: int, light: bool) -> str:
    ink = "radial-gradient(120% 120% at 30% 20%, #1a241d 0%, #0b0f0c 60%)"
    return (f'<div class="tile" style="width:{px}px;height:{px}px;border-radius:{px * 0.225:.1f}px;background:{ink};'
            f'box-shadow:0 0 0 {1 if light else 0}px rgba(0,0,0,.08)"><img src="{src}" alt=""></div>')


def main() -> None:
    a_icon = cropped("A-icon", pad=0.1, size=512)
    b_icon = cropped("B-icon", pad=0.1, size=512)
    cards = "".join(
        f'<figure class="card{" pick" if pick else ""}"><img src="{hero(k)}" alt="{t}">'
        f'<figcaption><b>{t}</b>{" <span>my pick</span>" if pick else ""}<p>{d}</p></figcaption></figure>'
        for k, t, d, pick in CARDS)
    sizes = [180, 60, 48, 29]

    def row(src: str, light: bool) -> str:
        return (f'<div class="row {"light" if light else ""}">'
                + "".join(f'<div class="sz">{icon_tile(src, s, light)}<i>{s}px</i></div>' for s in sizes)
                + f'<div class="sz"><img class="bare" src="{src}" style="width:48px"><i>no tile</i></div></div>')

    html = f"""<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>hippo logo, round 3</title>
<style>
:root{{--ink:#0b0f0c;--surface:#111713;--line:#1f2a22;--bone:#e6ede7;--muted:#9aa79e;--mint:#7ce38b;--amber:#f2b84b}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--ink);color:var(--bone);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}}
main{{max-width:1100px;margin:auto;padding:28px 18px 60px}}h1{{font-size:22px;margin:0 0 4px}}h2{{font-size:16px;margin:40px 0 12px;color:var(--mint)}}
.lede{{color:var(--muted);margin:0 0 20px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}}
.card{{margin:0;background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden}}
.card.pick{{border-color:var(--mint)}}.card img{{width:100%;display:block}}
figcaption{{padding:12px 14px 14px}}figcaption span{{color:var(--ink);background:var(--mint);font-size:11px;padding:2px 7px;border-radius:9px;margin-left:6px}}
figcaption p{{margin:6px 0 0;color:var(--muted);font-size:13.5px}}
.row{{display:flex;flex-wrap:wrap;align-items:flex-end;gap:22px;padding:22px;border-radius:14px;background:var(--surface);border:1px solid var(--line);margin-bottom:12px}}
.row.light{{background:#eef3ee;border-color:#dfe6df}}.row.light i{{color:#5b675f}}
.sz{{display:flex;flex-direction:column;align-items:center;gap:6px}}.sz i{{font-size:11px;color:var(--muted);font-style:normal}}
.tile{{display:grid;place-items:center;overflow:hidden}}.tile img{{width:84%;height:84%}}
.bare{{display:block}}
</style>
<main>
<h1>hippo logo, round 3</h1>
<p class="lede">Real three.js renders: polished dark bodies lit from inside. Mint means recalled, dark means faded, amber means marked wrong.</p>
<div class="grid">{cards}</div>
<h2>Recall spiral as the app icon, real sizes</h2>
{row(a_icon, False)}{row(a_icon, True)}
<h2>Memory string as the app icon, for comparison</h2>
{row(b_icon, False)}{row(b_icon, True)}
</main></html>"""
    out = HERE / "2026-09-25-logo-round3.html"
    out.write_text(html, encoding="utf-8")
    print(out, len(html) // 1024, "KB")


if __name__ == "__main__":
    main()
