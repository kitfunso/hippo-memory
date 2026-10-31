#!/usr/bin/env node
// CI store-port shape gate: the rules that follow types across files, which no lint rule can do, read from the core
// port's and the local tier's interfaces. The store's import and name rules live in .dependency-cruiser.cjs and
// oxlint.config.ts.

import { existsSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { looseTenants } from '../lib/loose-tenants.mjs';
import { portFunctionParams, unreadRoots } from '../lib/port-type-facts.mjs';

function tsFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, out);
    else if (/\.[cm]?ts$/.test(e.name) && !/\.d\.[cm]?ts$/.test(e.name)) out.push(p.split(sep).join('/'));
  }
  return out.sort();
}

// A function cannot cross to the store worker thread, so a rule reaches the store as data.
const AS_DATA = 'Send the rule as data the store can read; a function cannot cross to the store worker.';
const inDirs = (dirs) => dirs.flatMap((dir) => (existsSync(dir) ? tsFiles(dir) : []));
const files = inDirs(['src/store', 'src/base/ports']);
const unread = unreadRoots();
const failures = [
  {
    sites: unread,
    what: "The scan could not read a root of the store's types, so the types it reaches went unchecked",
    fix: 'Point STORE_ROOT or TIER_ROOT in scripts/lib/port-type-facts.mjs at the interface, and type each repository by a declared interface.',
  },
  {
    sites: unread.length > 0 ? [] : inDirs(['src/base/ports', 'src/base/records']).flatMap(portFunctionParams),
    what: 'A port or local-tier method takes a parameter whose type holds a function',
    fix: AS_DATA,
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
console.log('Store-port shape OK: port and local-tier methods take data, and every tenant parameter is required.');
