#!/usr/bin/env node
// The npm registry keeps only the first 64 KB of a README, and npmjs.com shows that copy.
import { readFileSync } from 'node:fs';

const LIMIT = 65536;
const SECTIONS = ['## Comparison', '## Benchmarks'];

const text = readFileSync('README.md', 'utf8');
const bytesTo = (index) => Buffer.byteLength(text.slice(0, index), 'utf8');
let failed = false;
for (const heading of SECTIONS) {
  const start = text.search(new RegExp(`^${heading}$`, 'm'));
  if (start < 0) {
    console.error(`README.md has no "${heading}" heading. Fix: restore it, or update SECTIONS in this check.`);
    failed = true;
    continue;
  }
  const next = text.slice(start + heading.length).search(/^## /m);
  const end = bytesTo(next < 0 ? text.length : start + heading.length + next);
  if (end > LIMIT) {
    console.error(
      `README.md "${heading}" ends at byte ${end}, past the ${LIMIT} bytes npm keeps, so npmjs.com cuts it.`,
    );
    failed = true;
  } else {
    console.log(`readme npm window ok: "${heading}" ends at byte ${end} of ${LIMIT}`);
  }
}
if (failed) {
  console.error(
    'Fix: move the section higher in README.md, or move long notes out of it, so it ends inside the first 64 KB.',
  );
  process.exit(1);
}
