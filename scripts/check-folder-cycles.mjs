#!/usr/bin/env node
// Fails when src/ features import each other at runtime, even when no single file is on a cycle (a/1 -> b/1, b/2 -> a/2).
// File cycles are oxlint's import/no-cycle (.oxlintrc.json), which cannot see folder cycles.
// Type-only imports are skipped because tsc erases them; dynamic import() is lazy.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runtimeSpecifiers } from './lib/ts-facts.mjs';

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

// base, domain and surface hold one folder per feature, so a cycle between two of their features must count.
const FEATURE_LAYERS = new Set(['base', 'domain', 'surface']);

/** The feature a module sits in: src/<layer>/<feature> under those layers, else its top folder or root file. */
const folderOf = (module) => {
  const [head, feature, ...rest] = module.split('/');
  return FEATURE_LAYERS.has(head) && rest.length > 0 ? `${head}/${feature}` : head;
};

/**
 * Finds every group of src features that import each other at runtime, even when no single file is on a cycle.
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

// Guarded so the test can import the functions without running the check.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const srcDir = process.argv[2] ?? 'src';
  const cycles = findFolderCycles(srcDir);
  if (cycles.length > 0) {
    console.error(`\n${cycles.length} folder-level import cycle(s) in ${srcDir}/:`);
    for (const c of cycles) {
      console.error(`\n  ${c.folders.join(', ')}`);
      for (const [a, b] of c.edges) console.error(`    ${a} -> ${b}`);
    }
    console.error(
      '\nFix: move what one folder takes from the other into the folder both already import, or a lower layer.\n',
    );
    process.exit(1);
  }
  console.log(`No runtime import cycles between the features of ${srcDir}/. OK.`);
}
