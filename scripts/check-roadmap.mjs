#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const filename = process.argv[2] ?? fileURLToPath(new URL('../ROADMAP.md', import.meta.url));
const markdown = await readFile(filename, 'utf8');
const lines = markdown.split(/\r?\n/);
const issues = [];
const initiatives = new Map();
const anchors = new Set();
const slugCounts = new Map();
const content = [];
const headings = [];
let fence;

for (const [index, line] of lines.entries()) {
  const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
  if (marker && !fence) { fence = marker[1]; continue; }
  if (fence) {
    if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined;
    continue;
  }
  content.push([index + 1, line]);
  for (const alias of line.matchAll(/<a\s+id=["']([^"']+)["']/g)) {
    if (anchors.has(alias[1])) issues.push(`line ${index + 1}: duplicate anchor ${alias[1]}`);
    anchors.add(alias[1]);
  }
  const heading = line.match(/^#{1,6}\s+(.+?)(?:\s+#+)?\s*$/);
  if (!heading) continue;
  const title = heading[1];
  const slug = title.toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
  const count = slugCounts.get(slug) ?? 0;
  slugCounts.set(slug, count + 1);
  const anchor = count ? `${slug}-${count}` : slug;
  if (anchors.has(anchor)) issues.push(`line ${index + 1}: heading collides with anchor ${anchor}`);
  anchors.add(anchor);
  headings.push([index + 1, title]);
  const item = title.match(/^([A-Z][A-Z0-9]*\d[a-z]?(?:\.\d+)*)\.\s/);
  if (item) {
    if (initiatives.has(item[1])) issues.push(`line ${index + 1}: duplicate initiative ${item[1]} (first at line ${initiatives.get(item[1])})`);
    else initiatives.set(item[1], index + 1);
  }
}

if (!initiatives.size) issues.push('no numbered initiative headings found');
let references = 0;
let executionIndex = false;
for (const [line, text] of content) {
  if (/^## Current execution index\s*$/.test(text)) executionIndex = true;
  else if (/^#{1,3} /.test(text)) executionIndex = false;
  if (!executionIndex || !text.startsWith('|')) continue;
  const items = text.split('|')[2] ?? '';
  for (const ref of items.matchAll(/\b([A-Z][A-Z0-9]*\d[a-z]?(?:\.\d+)*)\b/g)) {
    references++;
    if (!initiatives.has(ref[1])) issues.push(`line ${line}: unknown execution-index initiative ${ref[1]}`);
  }
}
for (const [line, title] of headings) {
  for (const clause of title.matchAll(/(?:hard|conditional(?: adapters)?|optional producer|baselines?|rollout gates?|release gates?|gates?|completion):\s*([^;\]]+)/g)) {
    for (const ref of clause[1].matchAll(/\b([A-Z][A-Z0-9]*\d[a-z]?(?:\.\d+)*)\b/g)) {
      references++;
      if (!initiatives.has(ref[1])) issues.push(`line ${line}: unknown typed dependency ${ref[1]}`);
    }
  }
}
for (const [line, text] of content) {
  for (const link of text.matchAll(/\[([^\]]+)\]\(#([^\s)]+)\)/g)) {
    references++;
    let fragment;
    try { fragment = decodeURIComponent(link[2]); }
    catch { issues.push(`line ${line}: invalid anchor encoding ${link[2]}`); continue; }
    if (!anchors.has(fragment)) issues.push(`line ${line}: unknown local anchor #${fragment}`);
    if (/^[A-Z][A-Z0-9]*\d[a-z]?(?:\.\d+)*$/.test(link[1]) && !initiatives.has(link[1])) {
      issues.push(`line ${line}: unknown linked initiative ${link[1]}`);
    }
  }
}

if (issues.length) {
  console.error('[roadmap] Invalid initiative IDs or explicit references:');
  for (const issue of issues) console.error(`  - ${issue}`);
  process.exit(1);
}
console.log(`[roadmap] OK: ${initiatives.size} unique initiatives; ${references} explicit references checked.`);
