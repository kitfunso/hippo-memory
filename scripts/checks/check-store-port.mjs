#!/usr/bin/env node
// CI store-port shape gate: the two port rules that follow type aliases and interfaces across files, which no lint rule
// can do. The store's import and name rules live in .dependency-cruiser.cjs and oxlint.config.ts.

import { existsSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { looseTenants } from '../lib/loose-tenants.mjs';
import { portFunctionParams } from '../lib/port-type-facts.mjs';

function tsFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, out);
    else if (/\.[cm]?ts$/.test(e.name) && !/\.d\.[cm]?ts$/.test(e.name)) out.push(p.split(sep).join('/'));
  }
  return out.sort();
}

const files = ['src/store', 'src/base/ports'].flatMap((dir) => (existsSync(dir) ? tsFiles(dir) : []));
const failures = [
  {
    // A function cannot cross to the store worker thread, so a rule reaches the store as data.
    sites: files.flatMap(portFunctionParams),
    what: 'A port method takes a parameter whose type holds a function',
    fix: 'Send the rule as data the store can read; a function cannot cross to the store worker.',
  },
  {
    sites: files.flatMap(looseTenants),
    what: 'A store function or port method can be called without its tenant',
    fix: 'Take `tenantId: string`, or `TenantId` if a real caller sends ALL_TENANTS (src/base/util/tenant.ts).',
  },
].filter((f) => f.sites.length > 0);

for (const { sites, what, fix } of failures) {
  console.error(`${what}:\n  ${sites.join('\n  ')}\n${fix}`);
}
if (failures.length > 0) process.exit(1);
console.log('Store-port shape OK: port methods take data, and every tenant parameter is required.');
