#!/usr/bin/env node
// CI api-reach gate. The api reaches storage through ctx.store; a runtime import in src/api of a src/store function that
// takes `hippoRoot` first is a root-keyed call that bypasses it, and any one fails. Usage: check-api-root-calls.mjs [--list].

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFacts } from './lib/ts-facts.mjs';

function tsFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p.replaceAll('\\', '/'));
  }
  return out.sort();
}

function rootKeyedNames() {
  const names = new Set();
  for (const file of tsFiles('src/store')) {
    const text = readFileSync(file, 'utf8');
    // A first parameter named hippoRoot cannot exist without that text, so other files skip the parse.
    if (!text.includes('hippoRoot')) continue;
    for (const fn of readFacts(text, file, ['exportedFunctions']).exportedFunctions) {
      if (fn.firstParam === 'hippoRoot') names.add(fn.name);
    }
  }
  return names;
}

/** Runtime-imported root-keyed names per src/api file: { path: n }, keys sorted. */
function findCalls(names) {
  const counts = {};
  for (const file of tsFiles('src/api')) {
    const imports = readFacts(readFileSync(file, 'utf8'), file, ['imports']).imports.filter((i) => i.kind === 'import');
    const n = imports.flatMap((i) => i.specifiers).filter((s) => !s.typeOnly && names.has(s.name)).length;
    if (n > 0) counts[file] = n;
  }
  return counts;
}

const current = Object.entries(findCalls(rootKeyedNames()));

if (process.argv.includes('--list')) {
  for (const [file, n] of current) console.log(`${n}\t${file}`);
  process.exit(0);
}
if (current.length > 0) {
  console.error('src/api imports root-keyed store functions (first parameter hippoRoot):');
  for (const [file, n] of current) console.error(`  ${file}: ${n}`);
  console.error('Reach storage through ctx.store, or add a group method to the store port instead.');
  process.exit(1);
}
console.log('API root-call gate OK: src/api imports no root-keyed store function.');
