#!/usr/bin/env node
/**
 * The hippo mark, flat: the "Spiral" logo study (a hippocampus curl drawn with
 * memories) reduced to dots that survive 16 px. Bright mint dots are recalled
 * memories, dim ones are fading, the amber dot is a memory marked wrong.
 * Writes public/favicon.svg only; the site itself uses the ~/hippo wordmark.
 * Deterministic: re-running produces the same file.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MINT = '#7ce38b', AMBER = '#f2b84b', BONE = '#e6ede7', INK = '#0b0f0c';

const N = 17;
const dots = [];
for (let i = 0; i < N; i++) {
  const t = i / (N - 1);
  const ang = 0.55 + t * Math.PI * 3.05;
  const r = 24 * (1 - t * 0.8);
  const x = 32 + Math.cos(ang) * r;
  const y = 32 + Math.sin(ang) * r * 1.06;
  const strong = [0, 2, 5, 8, 11, 14, 16].includes(i);
  const wrong = i === 4;
  dots.push({
    x: +x.toFixed(2), y: +y.toFixed(2),
    r: wrong ? 3.4 : strong ? 3.6 - t * 0.9 : 2.1 - t * 0.5,
    fill: wrong ? AMBER : strong ? MINT : BONE,
    opacity: wrong || strong ? 1 : 0.38,
  });
}
dots.forEach((d) => { d.r = +d.r.toFixed(2); });

const circles = dots.map((d) => `<circle cx="${d.x}" cy="${d.y}" r="${d.r}" fill="${d.fill}"${d.opacity < 1 ? ` fill-opacity="${d.opacity}"` : ''}/>`).join('');
writeFileSync(join(root, 'public', 'favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${INK}"/>${circles}</svg>\n`);
console.log(`wrote favicon.svg (${dots.length} dots)`);
