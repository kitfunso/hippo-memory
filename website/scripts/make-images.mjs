#!/usr/bin/env node
// Draws public/favicon.svg, public/apple-touch-icon.png and a 1200x630 Open Graph card per built page, captioned
// with its <title>. Run after `astro build`, then build again so each page links its own card. Needs Chrome (or
// CHROME=<path>); `--social <file.png>` also draws the 1280x640 GitHub social preview.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const pub = join(root, 'public');
const PAPER = '#f7f4ee', PAPER_2 = '#fdfbf7', INK = '#1f1b16', INK_2 = '#5e554a', ACCENT = '#1d5b43';
const CHROME = process.env.CHROME
  || { win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe', darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }[process.platform]
  || 'google-chrome';

// The mark is a paper `h` on the bottle-green accent, drawn as strokes so it needs no font and still reads at 16 px.
const mark = ({ size, rounded = true }) =>
  `<svg xmlns="http://www.w3.org/2000/svg"${size ? ` width="${size}" height="${size}"` : ''} viewBox="0 0 64 64">`
  + `<rect width="64" height="64"${rounded ? ' rx="14"' : ''} fill="${ACCENT}"/>`
  + `<path d="M22 13V51M22 33C24 27 29 25 34 25C39 25 42 28 42 34V51" fill="none" stroke="${PAPER}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const font = (pkg, file) => readFileSync(join(root, 'node_modules', '@fontsource', pkg, 'files', file)).toString('base64');
const faces = [['Newsreader', 'newsreader', 'newsreader-latin-400-normal.woff2', 400], ['Geist Mono', 'geist-mono', 'geist-mono-latin-400-normal.woff2', 400]]
  .map(([family, pkg, file, weight]) => `@font-face{font-family:'${family}';font-weight:${weight};src:url(data:font/woff2;base64,${font(pkg, file)}) format('woff2')}`)
  .join('');

const tmp = mkdtempSync(join(tmpdir(), 'hippo-images-'));
function shoot(html, width, height, out) {
  const page = join(tmp, 'page.html');
  writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><style>${faces}*{margin:0;box-sizing:border-box}html,body{width:${width}px;height:${height}px;overflow:hidden;background:${PAPER}}</style></head><body>${html}</body></html>`);
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--force-device-scale-factor=1',
    `--user-data-dir=${join(tmp, 'profile')}`, '--virtual-time-budget=3000',
    `--window-size=${width},${height}`, `--screenshot=${out}`, pathToFileURL(page).href,
  ], { stdio: 'ignore' });
}

// <title> text arrives HTML-escaped from dist, so it goes back into HTML as is. The hero poster sits on white, so it multiplies onto the paper.
const poster = `data:image/webp;base64,${readFileSync(join(pub, 'hero-cabinet.webp')).toString('base64')}`;
const card = (title, path, width, height) => {
  const text = title.replace(/\s*\|\s*hippo(-memory)?\s*$/, '');
  const size = text.length > 48 ? 54 : 62;
  return `<div style="position:relative;display:flex;flex-direction:column;justify-content:space-between;height:${height}px;padding:64px 72px;color:${INK}">`
    + `<img src="${poster}" style="position:absolute;right:28px;top:50%;transform:translateY(-50%);width:${Math.round(width * 0.44)}px;mix-blend-mode:multiply">`
    + `<div style="display:flex;align-items:center;gap:18px;font:400 40px Newsreader">${mark({ size: 52 })}<span>hippo</span></div>`
    + `<h1 style="position:relative;font:400 ${size}px/1.08 Newsreader;max-width:${Math.round(width * 0.47)}px">${text}</h1>`
    + `<div style="position:relative;display:flex;gap:28px;align-items:center;font:400 24px 'Geist Mono';color:${INK_2}">`
    + `<span style="border:1px solid rgba(31,27,22,.2);border-radius:12px;padding:14px 20px;background:${PAPER_2};color:${INK}"><span style="color:${ACCENT};margin-right:12px">$</span>npm install -g hippo-memory</span>`
    + `<span>hippo-memory.com${path === '/' ? '' : path}</span></div></div>`;
};

function pages(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return pages(full);
    if (e.name !== 'index.html') return [];
    const path = `/${relative(dist, dir).split(/[\\/]/).filter(Boolean).join('/')}/`.replace('//', '/');
    const title = (readFileSync(full, 'utf8').match(/<title>([^<]*)<\/title>/) || [])[1];
    if (!title) throw new Error(`no <title> in ${full}`);
    return [{ path, title }];
  });
}

try {
  const built = pages(dist);
  if (!built.length) throw new Error('no pages in dist/: run astro build first');
  writeFileSync(join(pub, 'favicon.svg'), `${mark({})}\n`);
  shoot(mark({ size: 180, rounded: false }), 180, 180, join(pub, 'apple-touch-icon.png'));
  rmSync(join(pub, 'og'), { recursive: true, force: true });
  mkdirSync(join(pub, 'og'));
  for (const { path, title } of built) {
    const slug = path.replace(/^\/|\/$/g, '').replace(/\//g, '-') || 'home';
    shoot(card(title, path, 1200, 630), 1200, 630, join(pub, 'og', `${slug}.png`));
  }
  const social = process.argv.indexOf('--social');
  if (social > 0) {
    const home = built.find((p) => p.path === '/');
    shoot(card(home.title, '/', 1280, 640), 1280, 640, process.argv[social + 1]);
  }
  console.log(`wrote favicon.svg, apple-touch-icon.png and ${built.length} cards in public/og/`);
} finally {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}
