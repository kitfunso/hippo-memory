// Renders the hero loop with three.js into public/hero-cabinet.webp (its first frame) and public/hero-cabinet.mp4.
// Run from website/: PW=<path to a playwright package> node scripts/hero/render-hero.mjs (ffmpeg with libx264 and libwebp on PATH).
import { createServer } from 'node:http';
import { readFile, mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CYCLE, STILL_T } from '../../src/scripts/hero-timeline.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const W = 1072, H = 804, FPS = 30;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2' };

const server = createServer(async (req, res) => {
  const file = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://local').pathname));
  if (!file.startsWith(root + sep)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));

const { chromium } = createRequire(import.meta.url)(process.env.PW ?? 'playwright');
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
const frames = await mkdtemp(join(tmpdir(), 'hero-frames-'));
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/scripts/hero/render.html?w=${W}&h=${H}`);
  await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
  const count = CYCLE * FPS;
  for (let i = 0; i < count; i++) {
    const url = await page.evaluate((t) => window.frameAt(t), STILL_T + i / FPS);
    await writeFile(join(frames, `f${String(i).padStart(5, '0')}.png`), Buffer.from(url.split(',')[1], 'base64'));
  }
  if (errors.length) throw new Error(`render page errors: ${errors.join('; ')}`);

  // The frames have a transparent background; both outputs put them on white, which the page multiplies onto the paper colour.
  const onWhite = ['-f', 'lavfi', '-i', `color=white:s=${W}x${H}:r=${FPS}`, '-filter_complex', '[1][0]overlay=shortest=1,format=yuv420p'];
  const mp4 = join(root, 'public', 'hero-cabinet.mp4');
  const webp = join(root, 'public', 'hero-cabinet.webp');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(frames, 'f%05d.png'), ...onWhite,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-profile:v', 'high', '-movflags', '+faststart', '-an', mp4]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(frames, 'f00000.png'), ...onWhite, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '82', webp]);
  console.log(JSON.stringify({ frames: count, size: `${W}x${H}`, mp4Bytes: (await stat(mp4)).size, webpBytes: (await stat(webp)).size }));
} finally {
  await browser.close();
  server.close();
  await rm(frames, { recursive: true, force: true });
}
