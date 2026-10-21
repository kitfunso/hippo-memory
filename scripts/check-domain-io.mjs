#!/usr/bin/env node
// Fails when a src/domain or src/api file imports fs or child_process: those layers get a reader or runner port from
// their caller, so only base, infra and surface touch the disk or start a process. No file is exempt, and none can be.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFacts } from './lib/ts-facts.mjs';

const IO_MODULES = new Set(['fs', 'fs/promises', 'child_process']);
const IO_LAYERS = ['domain', 'api'];

/**
 * The 1-based lines and specifiers of every fs or child_process import in a source text, `node:` prefix or not.
 * @param {string} text
 * @returns {{ line: number, spec: string }[]}
 */
export function ioImports(text) {
  if (!text.includes('fs') && !text.includes('child_process')) return [];
  return readFacts(text, 'file.ts', ['imports', 'dynamic'])
    .imports.filter((i) => IO_MODULES.has(i.spec.replace(/^node:/, '')))
    .map((i) => ({ line: i.line, spec: i.spec }));
}

function listSourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listSourceFiles(p));
    else if (/\.(?:ts|mts|cts)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * Every fs or child_process import under srcDir's domain and api folders.
 * @param {string} srcDir
 * @returns {{ file: string, line: number, spec: string }[]}
 */
export function findDomainIo(srcDir) {
  const root = resolve(srcDir);
  const hits = [];
  for (const layer of IO_LAYERS) {
    const dir = join(root, layer);
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const p of listSourceFiles(dir)) {
      const file = relative(root, p).replace(/\\/g, '/');
      hits.push(...ioImports(readFileSync(p, 'utf8')).map((f) => ({ file, ...f })));
    }
  }
  return hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// Guarded so the test can import the functions without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const srcDir = process.argv[2] ?? 'src';
  const hits = findDomainIo(srcDir);
  for (const h of hits) console.error(`  ${srcDir}/${h.file}:${h.line} imports ${h.spec}`);
  if (hits.length > 0) {
    console.error('\nFix: move the read, write or process call to an infra or surface adapter and pass domain a port.');
    process.exit(1);
  }
  console.log(`No fs or child_process import in ${srcDir}/domain or ${srcDir}/api. OK.`);
}
