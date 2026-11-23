#!/usr/bin/env node
// Anthropic's plugin directory downloads the whole repo for each plugin version and refuses one over 256 MiB.
import { execFileSync } from 'node:child_process';

const LIMIT_MIB = 200;
const MIB = 1024 * 1024;

const listing = execFileSync('git', ['ls-tree', '-r', '-l', 'HEAD'], { encoding: 'utf8', maxBuffer: 64 * MIB });
const byFolder = new Map();
let total = 0;
for (const line of listing.split('\n')) {
  const match = line.match(/^\d+ blob \w+\s+(\d+)\t(.+)$/);
  if (!match) continue;
  const size = Number(match[1]);
  total += size;
  const folder = match[2].split('/').slice(0, 2).join('/');
  byFolder.set(folder, (byFolder.get(folder) ?? 0) + size);
}

const mib = (bytes) => (bytes / MIB).toFixed(1);
if (total <= LIMIT_MIB * MIB) {
  console.log(`repo size ok: ${mib(total)} MiB of tracked files, limit ${LIMIT_MIB} MiB`);
  process.exit(0);
}
const largest = [...byFolder].sort((a, b) => b[1] - a[1]).slice(0, 5);
console.error(`repo size ${mib(total)} MiB is over the ${LIMIT_MIB} MiB limit.`);
console.error('Largest folders:');
for (const [folder, size] of largest) console.error(`  ${mib(size)} MiB  ${folder}`);
console.error('Move large design or data files to another repo before merging.');
process.exit(1);
