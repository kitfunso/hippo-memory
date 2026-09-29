"""Mockup sheet: every style direction placed into real contexts, one self-contained HTML file.

Usage: python mockups.py [round_dir]  (defaults to round6; any other dir takes every subfolder with a hero.png)
"""
import base64
import io
import re
import sys
from pathlib import Path

from PIL import Image, ImageFilter

HERE = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).parent
ROUND = HERE.name.replace("round", "round ")
OUT = HERE / f"2026-09-26-logo-{HERE.name}-mockups.html" if len(sys.argv) > 1 else HERE / "2026-09-25-logo-round6-mockups.html"
ORDER = ["dust", "sediment", "chrome", "tinyworld", "mascot", "typo", "holo"] if len(sys.argv) == 1 else sorted(p.name for p in HERE.iterdir() if p.is_dir())


# WebP for everything: the phone viewer choked on a 3.9 MB page of PNG and JPEG.
def b64(im: Image.Image, fmt: str = "WEBP", q: int = 78) -> str:
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=q, method=6)
    return "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode()


def load(d: Path, name: str, px: int, mode: str = "RGB") -> Image.Image | None:
    p = d / f"{name}.png"
    if not p.exists():
        return None
    im = Image.open(p).convert(mode)
    return im.resize((px, round(im.height * px / im.width)), Image.LANCZOS)


def trimmed(im: Image.Image, pad: float = 0.06) -> Image.Image:
    box = im.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    if not box:
        return im
    im = im.crop(box)
    p = int(max(im.size) * pad)
    out = Image.new("RGBA", (im.width + 2 * p, im.height + 2 * p), (0, 0, 0, 0))
    out.paste(im, (p, p))
    return out


# Die-cut sticker: dilate the alpha into a white border behind the mark.
def sticker(mark: Image.Image) -> Image.Image:
    m = trimmed(mark, 0.12)
    m = m.resize((340, round(m.height * 340 / m.width)), Image.LANCZOS)
    a = m.getchannel("A").point(lambda v: 255 if v > 20 else 0).filter(ImageFilter.MaxFilter(19)).filter(ImageFilter.GaussianBlur(8)).point(lambda v: 255 if v > 110 else 0).filter(ImageFilter.GaussianBlur(1.2))
    base = Image.new("RGBA", m.size, (250, 250, 247, 0))
    base.putalpha(a)
    base.alpha_composite(m)
    return base


TITLES = {"surfacing": "Surfacing", "dust": "Memory dust", "sediment": "Sediment", "chrome": "Liquid chrome",
          "tinyworld": "Tiny world", "mascot": "Mascot", "typo": "Half-life type", "holo": "Holo card"}
READ = {"surfacing": "Moody art piece; as a logo the bumps read as eggs, not a face.",
        "dust": "Top pick. Reads instantly as a seahorse, and the logo itself fades like a memory.",
        "sediment": "Second pick. The decay law as an object; strongest concept, top needs work.",
        "chrome": "Album cover, not a logo. Turns into a lump at icon size.",
        "tinyworld": "The friendliest. Charm comes from the cube trail, the hippo is plain.",
        "mascot": "Real character, Docker-whale energy. Needs a sculpted mouth and more hippo muzzle.",
        "typo": "Best wordmark idea: read left to right and you have read the product.",
        "holo": "Best launch/merch visual; the emblem alone is a generic seahorse.",
        "flow": "Strongest art piece: the variant is a poster. The centred mark drifts toward tree rings.",
        "bauhaus": "Cleanest logo: an h you can draw by hand, with the recall and forget story in two objects.",
        "turing": "Best concept of the round: dense memory breaking into dots as it forgets, a few lit ones kept."}


# Agents wrote notes.md in mixed shapes; strip labels and markdown, keep the first line as the idea and the Weak line.
def note(d: Path) -> tuple[str, str, str]:
    p = d / "notes.md"
    raw = p.read_text(encoding="utf-8").splitlines() if p.exists() else []
    lines = [re.sub(r"^(Name|Idea|Weak):\s*", "", l.replace("**", "").strip("-# ").strip()) for l in raw if l.strip()]
    tagged = [l.replace("**", "").strip("-# ") for l in raw]
    idea = next((lines[i] for i, t in enumerate(t for t in tagged if t.strip()) if t.startswith("Idea")), lines[0] if lines else "")
    weak = next((re.sub(r"^Weak:\s*", "", t.strip()) for t in tagged if t.strip().startswith("Weak")), "")
    named = next((re.sub(r"^Name:\s*", "", t.strip()) for t in tagged if t.strip().startswith("Name")), d.name)
    return TITLES.get(d.name, named), idea, weak


def section(d: Path) -> str:
    hero, icon, alt = load(d, "hero", 860), load(d, "icon", 160), load(d, "alt", 600)
    mark = load(d, "mark", 420, "RGBA")
    if hero is None:
        return ""
    name, idea, weak = note(d)
    icon = icon or hero.resize((160, 160))
    ic = b64(icon)
    t = trimmed(mark) if mark else icon
    mk = b64(t.resize((round(t.width * 96 / t.height), 96), Image.LANCZOS))
    st = b64(sticker(mark), "PNG") if mark else ""
    others = "".join(f'<div class="app"><div class="ai" style="background:{c}"></div><span>{n}</span></div>'
                     for n, c in [("Mail", "linear-gradient(#4fa3ff,#1c6fe8)"), ("Notes", "linear-gradient(#ffe27a,#f5c542)"),
                                  ("Maps", "linear-gradient(#8fe08a,#3fae5a)"), ("Music", "linear-gradient(#ff6b86,#e8304f)"),
                                  ("Photos", "conic-gradient(#ff5f6d,#ffc371,#7ce38b,#4fa3ff,#b57cff,#ff5f6d)"),
                                  ("Camera", "linear-gradient(#d5d8dc,#9aa1a8)"), ("Clock", "#111")])
    return f"""
<section id="{d.name}">
<h2>{name}</h2><p class="read">{READ.get(d.name, "")}</p><p class="idea">{idea}</p>
<img class="hero" src="{b64(hero)}" alt="{name}">
<div class="grid">
 <figure class="phone"><div class="screen"><div class="apps">
  <div class="app"><img class="ai" src="{ic}" alt=""><span>hippo</span></div>{others}
 </div></div><figcaption>Home screen</figcaption></figure>
 <figure class="site"><div class="nav"><img src="{mk}" alt=""><b>hippo</b><i>Docs</i><i>Teams</i><i>GitHub</i></div>
  <div class="pitch"><h3>Memory that forgets<br>like you do.</h3><p>npm i hippo-memory</p></div>
  <figcaption>Website header</figcaption></figure>
 <figure class="gh"><div class="bar"><img src="{ic}" alt=""><span>kitfunso / <b>hippo</b></span><em>Public</em></div>
  <p>Biologically inspired memory for AI agents: decay, recall, consolidation.</p><figcaption>GitHub</figcaption></figure>
 {f'<figure class="stk"><img src="{st}" alt=""><figcaption>Laptop sticker</figcaption></figure>' if st else ''}
 {f'<figure class="alt"><img src="{b64(alt)}" alt=""><figcaption>Variant</figcaption></figure>' if alt else ''}
</div>
<p class="weak">Weak spot: {weak}</p>
</section>"""


def main() -> None:
    dirs = [HERE / n for n in ORDER if (HERE / n / "hero.png").exists()]
    body = "".join(section(d) for d in dirs)
    toc = " · ".join(f'<a href="#{d.name}">{note(d)[0]}</a>' for d in dirs)
    html = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>hippo logo, {ROUND}</title>
<link href="https://fonts.googleapis.com/css2?family=Martian+Mono:wght@400;700&family=Onest:wght@400;600&display=swap" rel="stylesheet">
<style>
:root{{--ink:#0b0f0c;--surface:#121815;--line:#1f2a22;--bone:#e9efe9;--muted:#8a978d;--mint:#7ce38b}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--ink);color:var(--bone);font:15px/1.5 Onest,system-ui,sans-serif}}
main{{max-width:980px;margin:auto;padding:26px 16px 80px}}h1{{font:700 22px "Martian Mono",monospace;margin:0 0 6px}}
.toc{{color:var(--muted);font-size:13px}}.toc a{{color:var(--mint);text-decoration:none}}
section{{margin-top:56px;padding-top:18px;border-top:1px solid var(--line)}}
h2{{font:700 18px "Martian Mono",monospace;margin:0;color:var(--mint)}}.read{{font-weight:600;margin:6px 0 0}}.idea{{color:var(--muted);font-size:14px;margin:4px 0 14px}}
.weak{{color:var(--muted);font-size:13px}}.hero{{width:100%;border-radius:16px;display:block}}
.grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-top:14px}}
figure{{margin:0;border-radius:16px;overflow:hidden;background:var(--surface);border:1px solid var(--line);position:relative}}
figcaption{{position:absolute;left:10px;bottom:8px;font:11px "Martian Mono",monospace;color:var(--muted)}}
.phone{{padding:18px 18px 34px;background:linear-gradient(160deg,#20352a,#0d1510 60%,#1a1230)}}
.screen{{border-radius:26px;padding:22px 14px;background:rgba(255,255,255,.03)}}
.apps{{display:grid;grid-template-columns:repeat(4,1fr);gap:16px 10px}}.app{{text-align:center;font-size:10.5px;color:#eee}}
.ai{{width:56px;height:56px;border-radius:13px;display:block;margin:0 auto 4px;object-fit:cover;box-shadow:0 2px 6px rgba(0,0,0,.4)}}
.site{{background:#0b0f0c;padding:14px 16px 40px}}.nav{{display:flex;align-items:center;gap:10px;font-size:13px}}
.nav img{{height:30px;width:auto}}.nav b{{font:700 15px "Martian Mono",monospace;margin-right:auto}}.nav i{{font-style:normal;color:var(--muted)}}
.pitch h3{{font:700 22px/1.2 "Martian Mono",monospace;margin:26px 0 8px}}.pitch p{{display:inline-block;margin:0;padding:6px 10px;border:1px solid var(--line);border-radius:8px;font:12px "Martian Mono",monospace;color:var(--mint)}}
.gh{{background:#0d1117;padding:16px 16px 40px}}.bar{{display:flex;align-items:center;gap:10px;font-size:15px;color:#c9d1d9}}
.bar img{{width:40px;height:40px;border-radius:50%;object-fit:cover}}.bar b{{color:#58a6ff}}.bar em{{font-style:normal;font-size:11px;border:1px solid #30363d;border-radius:10px;padding:1px 7px;color:#8b949e}}
.gh p{{color:#8b949e;font-size:13.5px;margin:14px 0 0}}
.stk{{background:#9aa3a8 linear-gradient(135deg,#b7bec2,#7d868b);display:grid;place-items:center;padding:24px 0 34px}}
.stk figcaption{{color:#2a3230}}.stk img{{width:62%;filter:drop-shadow(0 6px 10px rgba(0,0,0,.35));transform:rotate(-6deg)}}
.alt img{{width:100%;display:block}}
</style></head><body><main>
<h1>hippo logo, {ROUND}</h1>
<p class="toc">{len(dirs)} styles, every one rendered in three.js, each placed on a home screen, a site header, GitHub and a sticker. {toc}</p>
{body}
</main></body></html>"""
    OUT.write_text(html, encoding="utf-8")
    print(OUT, f"{OUT.stat().st_size / 1e6:.2f} MB", [d.name for d in dirs])


if __name__ == "__main__":
    main()
