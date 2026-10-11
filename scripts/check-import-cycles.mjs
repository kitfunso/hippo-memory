#!/usr/bin/env node
// Fails when src/ has a runtime import cycle between files or top-level folders: a cycle makes module init order decide
// whether a binding is defined yet, and it hides which module owns a function.
// Type-only imports are skipped because tsc erases them; dynamic import() is lazy.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripComments } from './lib/source-text.mjs';

const QUOTED = `['"]([^'"\\n]+)['"]`;
const IMPORT_CLAUSE = String.raw`(type\s+)?((?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*\s*as\s+[\w$]+)|[\w$]+)`;
const EXPORT_CLAUSE = String.raw`(type\s+)?(\{[^}]*\}|\*(?:\s*as\s+[\w$]+)?)`;
const IMPORT_RE = new RegExp(String.raw`^[ \t]*import\s+${IMPORT_CLAUSE}\s*from\s*${QUOTED}`, 'gm');
const EXPORT_RE = new RegExp(String.raw`^[ \t]*export\s+${EXPORT_CLAUSE}\s*from\s*${QUOTED}`, 'gm');
const SIDE_EFFECT_RE = new RegExp(String.raw`^[ \t]*import\s*${QUOTED}`, 'gm');

/** True when tsc erases the statement: every named specifier is `type X` and nothing else is bound. */
function isTypeOnly(typeKeyword, clause) {
  if (typeKeyword) return true;
  const braces = /^\{([^}]*)\}$/.exec(clause.trim());
  if (!braces) return false;
  const specs = braces[1].split(',').map((s) => s.trim()).filter(Boolean);
  return specs.length > 0 && specs.every((s) => /^type\s/.test(s));
}

/**
 * Returns the relative specifiers a TypeScript source loads at runtime.
 * @param {string} text
 * @returns {string[]}
 */
export function runtimeSpecifiers(text) {
  const code = stripComments(text);
  const out = [];
  for (const re of [IMPORT_RE, EXPORT_RE]) {
    for (const m of code.matchAll(re)) {
      if (!isTypeOnly(m[1], m[2])) out.push(m[3]);
    }
  }
  for (const m of code.matchAll(SIDE_EFFECT_RE)) out.push(m[1]);
  return out.filter((s) => s.startsWith('./') || s.startsWith('../'));
}

function resolveSpecifier(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  const candidates = [base.replace(/\.js$/, '.ts'), `${base}.ts`, join(base, 'index.ts')];
  return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

function listTsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listTsFiles(p));
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Tarjan's algorithm; returns each component of the graph as a list of nodes. */
function stronglyConnected(graph) {
  let next = 0;
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  const visit = (v) => {
    index.set(v, next);
    low.set(v, next);
    next += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)));
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      components.push(comp);
    }
  };
  for (const v of [...graph.keys()].sort()) if (!index.has(v)) visit(v);
  return components;
}

/** Each src module, as a src-relative path, mapped to the sorted src modules it loads at runtime. */
function runtimeGraph(srcDir) {
  const root = resolve(srcDir);
  const rel = (p) => relative(root, p).replace(/\\/g, '/');
  const graph = new Map();
  for (const file of listTsFiles(root)) {
    const deps = new Set();
    for (const spec of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
      const target = resolveSpecifier(file, spec);
      if (target) deps.add(rel(target));
    }
    graph.set(rel(file), [...deps].sort());
  }
  return graph;
}

/**
 * Finds every group of src modules that import each other at runtime.
 * @param {string} srcDir
 * @returns {{ modules: string[], edges: [string, string][] }[]}
 */
export function findImportCycles(srcDir) {
  const graph = runtimeGraph(srcDir);
  return stronglyConnected(graph)
    .filter((comp) => comp.length > 1 || (graph.get(comp[0]) ?? []).includes(comp[0]))
    .map((comp) => {
      const members = new Set(comp);
      const modules = [...comp].sort();
      const edges = modules.flatMap((a) => (graph.get(a) ?? []).filter((b) => members.has(b)).map((b) => [a, b]));
      return { modules, edges };
    })
    .sort((a, b) => a.modules[0].localeCompare(b.modules[0]));
}

/** The top-level src folder a module sits in; a file at the src root is a unit of its own. */
const folderOf = (module) => module.split('/')[0];

/**
 * Finds every group of top-level src folders that import each other at runtime, even when no single file is on a cycle.
 * @param {string} srcDir
 * @returns {{ folders: string[], edges: [string, string][] }[]}
 */
export function findFolderCycles(srcDir) {
  const files = runtimeGraph(srcDir);
  const graph = new Map();
  for (const [file, deps] of files) {
    const from = folderOf(file);
    const to = new Set(graph.get(from) ?? []);
    for (const dep of deps) if (folderOf(dep) !== from) to.add(folderOf(dep));
    graph.set(from, [...to].sort());
  }
  return stronglyConnected(graph)
    .filter((comp) => comp.length > 1)
    .map((comp) => {
      const members = new Set(comp);
      const crosses = (a, b) => folderOf(a) !== folderOf(b) && members.has(folderOf(a)) && members.has(folderOf(b));
      const edges = [...files].flatMap(([a, deps]) => deps.filter((b) => crosses(a, b)).map((b) => [a, b]));
      return { folders: [...comp].sort(), edges: edges.sort((x, y) => x.join(' ').localeCompare(y.join(' '))) };
    })
    .sort((a, b) => a.folders[0].localeCompare(b.folders[0]));
}

// Folder cycles not broken yet, each with why. An entry that matches no cycle fails the check too, so the list only shrinks.
export const FOLDER_CYCLE_ALLOWLIST = [];

/**
 * Splits folder cycles into the ones the allowlist does not cover and the allowlist entries that match no cycle.
 * @param {{ folders: string[] }[]} cycles
 * @param {{ folders: string[], why: string }[]} allowlist
 */
export function judgeFolderCycles(cycles, allowlist) {
  const key = (folders) => [...folders].sort().join(',');
  const allowed = new Set(allowlist.map((a) => key(a.folders)));
  const found = new Set(cycles.map((c) => key(c.folders)));
  return {
    unlisted: cycles.filter((c) => !allowed.has(key(c.folders))),
    stale: allowlist.filter((a) => !found.has(key(a.folders))),
  };
}

// Guarded so the test can import the functions without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const srcDir = process.argv[2] ?? 'src';
  const cycles = findImportCycles(srcDir);
  if (cycles.length > 0) {
    console.error(`\n${cycles.length} import cycle(s) in ${srcDir}/:`);
    for (const c of cycles) {
      console.error(`\n  ${c.modules.join(', ')}`);
      for (const [a, b] of c.edges) console.error(`    ${a} -> ${b}`);
    }
    console.error('\nFix: move the shared function or constant into the lower module or a new leaf module.\n');
    process.exit(1);
  }
  const { unlisted, stale } = judgeFolderCycles(findFolderCycles(srcDir), FOLDER_CYCLE_ALLOWLIST);
  if (unlisted.length > 0 || stale.length > 0) {
    if (unlisted.length > 0) console.error(`\n${unlisted.length} folder-level import cycle(s) in ${srcDir}/:`);
    for (const c of unlisted) {
      console.error(`\n  ${c.folders.join(', ')}`);
      for (const [a, b] of c.edges) console.error(`    ${a} -> ${b}`);
    }
    if (unlisted.length > 0) console.error('\nFix: move what one folder takes from the other into the folder both already import, or a lower layer.\n');
    for (const s of stale) console.error(`Allowlisted folder cycle ${s.folders.join(', ')} is gone; delete its FOLDER_CYCLE_ALLOWLIST entry.`);
    process.exit(1);
  }
  console.log(`No runtime import cycles in ${srcDir}/, between files or between folders. OK.`);
}
