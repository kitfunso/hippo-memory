#!/usr/bin/env node
// Fails when src/base, src/domain or src/api imports fs, os or child_process, when domain or api imports src/host at run
// time, or when domain reaches src/infra, a model or socket adapter, or fetch. No file is exempt, and none can be.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFacts } from './lib/ts-facts.mjs';

const IO_MODULES = new Set(['fs', 'fs/promises', 'os', 'child_process']);
const IO_LAYERS = ['base', 'domain', 'api'];
// src/host holds the disk and process reads; these layers get its answers from their caller, and may name its types.
const HOST_BANNED_LAYERS = new Set(['domain', 'api']);
const PORT_LAYER = 'domain';
// Matched by name as well as by folder, so moving an adapter back under base cannot reopen the hole.
const ADAPTER_MODULE =
  /(?:^|\/)(?:http-retry|embedding-provider|embeddings\/provider|local-embedder|transformers)(?:\.[cm]?[jt]s)?$/;
const ADAPTER_NAMES = new Set(['fetchWithRetry', 'resolveEmbeddingProvider', 'importTransformers']);
const FETCH_CALLS = new Set(['fetch', 'globalThis.fetch']);

/**
 * The 1-based lines and specifiers of every fs, os or child_process import in a source text, `node:` prefix or not.
 * @param {string} text
 * @returns {{ line: number, spec: string }[]}
 */
export function ioImports(text) {
  if (!/['"](?:node:)?(?:fs|os|child_process)\b/.test(text)) return [];
  return readFacts(text, 'file.ts', ['imports', 'dynamic'])
    .imports.filter((i) => IO_MODULES.has(i.spec.replace(/^node:/, '')))
    .map((i) => ({ line: i.line, spec: i.spec }));
}

/**
 * Every import of src/host in a source text that is not type-only: static, re-exported or dynamic.
 * @param {string} text
 * @param {string} file the source's path, to resolve its relative imports
 * @param {string} srcRoot the src folder whose host is out of reach
 * @returns {{ line: number, spec: string }[]}
 */
export function hostReach(text, file, srcRoot) {
  if (!text.includes('host/')) return [];
  const host = join(resolve(srcRoot), 'host') + sep;
  return readFacts(text, 'file.ts', ['imports', 'dynamic'])
    .imports.filter((i) => !i.typeOnly && i.spec.startsWith('.') && resolve(dirname(file), i.spec).startsWith(host))
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
 * Every fs, os or child_process import under srcDir's base, domain and api folders, every run-time src/host import
 * under domain and api, and every reach past a port under domain.
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
      if (HOST_BANNED_LAYERS.has(layer)) hits.push(...hostReach(text, p, root).map((f) => ({ file, ...f })));
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
      '\nFix: move the disk, process, model or HTTP call to src/host or an adapter and pass the answer or a port down.',
    );
    process.exit(1);
  }
  console.log(`No fs, os or child_process in ${srcDir}/base, domain or api; no run-time host in domain or api. OK.`);
}
