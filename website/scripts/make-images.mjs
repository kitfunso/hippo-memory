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
const INK = '#0b0f0c', PANEL = '#0f1411', MINT = '#7ce38b', BONE = '#e6ede7', MUTED = '#9aa59d';
const CHROME = process.env.CHROME
  || { win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe', darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }[process.platform]
  || 'google-chrome';

// The mark is a mint `~/` on ink, drawn as strokes so it needs no font and still reads at 16 px.
const mark = ({ size, rounded = true }) =>
  `<svg xmlns="http://www.w3.org/2000/svg"${size ? ` width="${size}" height="${size}"` : ''} viewBox="0 0 64 64">`
  + `<rect width="64" height="64"${rounded ? ' rx="14"' : ''} fill="${INK}"/>`
  + `<g fill="none" stroke="${MINT}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round">`
  + '<path d="M10 36C13 27 19 26 22 32C25 38 31 37 34 28"/><path d="M39 46L53 18"/></g></svg>';

const font = (pkg, file) => readFileSync(join(root, 'node_modules', '@fontsource', pkg, 'files', file)).toString('base64');
const faces = [['Geist', 'geist', 'geist-latin-500-normal.woff2', 500], ['Geist Mono', 'geist-mono', 'geist-mono-latin-400-normal.woff2', 400]]
  .map(([family, pkg, file, weight]) => `@font-face{font-family:'${family}';font-weight:${weight};src:url(data:font/woff2;base64,${font(pkg, file)}) format('woff2')}`)
  .join('');

const tmp = mkdtempSync(join(tmpdir(), 'hippo-images-'));
function shoot(html, width, height, out) {
  const page = join(tmp, 'page.html');
  writeFileSync(page, `<!doctype html><html><head><meta charset="utf-8"><style>${faces}*{margin:0;box-sizing:border-box}html,body{width:${width}px;height:${height}px;overflow:hidden;background:${INK}}</style></head><body>${html}</body></html>`);
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--force-device-scale-factor=1',
    `--user-data-dir=${join(tmp, 'profile')}`, '--virtual-time-budget=3000',
    `--window-size=${width},${height}`, `--screenshot=${out}`, pathToFileURL(page).href,
  ], { stdio: 'ignore' });
}

// <title> text arrives HTML-escaped from dist, so it goes back into HTML as is.
const card = (title, path, width, height) => {
  const text = title.replace(/\s*\|\s*hippo(-memory)?\s*$/, '');
  const size = text.length > 48 ? 60 : 72;
  return `<div style="display:flex;flex-direction:column;justify-content:space-between;height:${height}px;padding:72px 80px;font-family:Geist;color:${BONE};background-image:radial-gradient(rgba(124,227,139,.08) 1px,transparent 1px);background-size:28px 28px">`
    + `<div style="display:flex;align-items:center;gap:20px;font:400 30px 'Geist Mono'">${mark({ size: 64 })}<span>hippo-memory</span></div>`
    + `<h1 style="font-weight:500;font-size:${size}px;line-height:1.1;letter-spacing:-.02em;max-width:${width - 200}px">${text}</h1>`
    + `<div style="display:flex;justify-content:space-between;align-items:center;font:400 26px 'Geist Mono';color:${MUTED}">`
    + `<span style="border:1px solid rgba(230,237,231,.14);border-radius:14px;padding:14px 22px;background:${PANEL};color:${BONE}"><span style="color:${MINT};margin-right:14px">$</span>npm install -g hippo-memory</span>`
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
