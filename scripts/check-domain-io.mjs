#!/usr/bin/env node
// Fails when src/domain or src/api imports fs or child_process, or when domain reaches src/infra, a model or socket
// adapter, or fetch: those layers get ports from their caller. No file is exempt, and none can be.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFacts } from './lib/ts-facts.mjs';

const IO_MODULES = new Set(['fs', 'fs/promises', 'child_process']);
const IO_LAYERS = ['domain', 'api'];
const PORT_LAYER = 'domain';
// Matched by name as well as by folder, so moving an adapter back under base cannot reopen the hole.
const ADAPTER_MODULE =
  /(?:^|\/)(?:http-retry|embedding-provider|embeddings\/provider|local-embedder|transformers)(?:\.[cm]?[jt]s)?$/;
const ADAPTER_NAMES = new Set(['fetchWithRetry', 'resolveEmbeddingProvider', 'importTransformers']);
const FETCH_CALLS = new Set(['fetch', 'globalThis.fetch']);

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

/**
 * Where a domain source reaches past its ports: an import of src/infra or of an adapter module, an adapter function
 * imported by name, or a fetch call. `spec` names what was reached.
 * @param {string} text
 * @param {string} file the source's path, to resolve its relative imports
 * @param {string} srcRoot the src folder whose infra is out of reach
 * @returns {{ line: number, spec: string }[]}
 */
export function adapterReach(text, file, srcRoot) {
  const infra = join(resolve(srcRoot), 'infra') + sep;
  const facts = readFacts(text, 'file.ts', ['imports', 'dynamic', 'calls']);
  const intoInfra = (spec) => spec.startsWith('.') && resolve(dirname(file), spec).startsWith(infra);
  const hits = facts.imports
    .filter((i) => intoInfra(i.spec) || ADAPTER_MODULE.test(i.spec) || i.names.some((n) => ADAPTER_NAMES.has(n)))
    .map((i) => ({ line: i.line, spec: i.spec }));
  for (const c of facts.calls) if (FETCH_CALLS.has(c.callee)) hits.push({ line: c.line, spec: `${c.callee}()` });
  return hits.sort((a, b) => a.line - b.line);
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
 * Every fs or child_process import under srcDir's domain and api folders, and every reach past a port under domain.
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
      const text = readFileSync(p, 'utf8');
      hits.push(...ioImports(text).map((f) => ({ file, ...f })));
      if (layer === PORT_LAYER) hits.push(...adapterReach(text, p, root).map((f) => ({ file, ...f })));
    }
  }
  return hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// Guarded so the test can import the functions without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const srcDir = process.argv[2] ?? 'src';
  const hits = findDomainIo(srcDir);
  for (const h of hits) console.error(`  ${srcDir}/${h.file}:${h.line} reaches ${h.spec}`);
  if (hits.length > 0) {
    console.error(
      '\nFix: move the read, write, process, model or HTTP call to an infra or surface adapter and pass domain a port.',
    );
    process.exit(1);
  }
  console.log(`No fs or child_process in ${srcDir}/domain or ${srcDir}/api, and no infra or HTTP in domain. OK.`);
}
