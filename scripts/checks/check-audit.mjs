#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const LEVELS = ['info', 'low', 'moderate', 'high', 'critical'];
const FLOOR = LEVELS.indexOf('moderate');
const ALLOW = JSON.parse(readFileSync(new URL('./audit-allowlist.json', import.meta.url), 'utf8'));
const today = new Date().toISOString().slice(0, 10);

function advisories(prefix, omitDev) {
  const args = ['audit', '--json', ...(prefix ? ['--prefix', prefix] : []), ...(omitDev ? ['--omit=dev'] : [])];
  let out;
  try {
    // One string, because Windows runs npm through a shell; every argument is a constant from this file.
    out = execSync(`npm ${args.join(' ')}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (err) {
    // npm audit exits 1 whenever it finds an advisory; its JSON report is still on stdout.
    out = err.stdout;
    if (!out) throw new Error(`npm ${args.join(' ')} printed no report (${err.message}); run it by hand to see why`);
  }
  const found = new Map();
  for (const vuln of Object.values(JSON.parse(out).vulnerabilities ?? {})) {
    for (const via of vuln.via) {
      if (!via.url || LEVELS.indexOf(via.severity) < FLOOR) continue;
      const id = via.url.split('/').pop();
      found.set(id, `${id} ${via.severity} in ${via.name}: ${via.title}`);
    }
  }
  return found;
}

const failures = [];
const allowed = new Set();
for (const [id, entry] of Object.entries(ALLOW)) {
  if (entry.expires < today) {
    failures.push(
      `${id}: its allowlist entry expired on ${entry.expires}; read the advisory again, then upgrade or move the date`,
    );
  }
}
for (const prefix of ['', 'ui']) {
  const where = prefix || 'root';
  const prod = advisories(prefix, true);
  for (const line of prod.values()) failures.push(`${where} production: ${line}`);
  for (const [id, line] of advisories(prefix, false)) {
    if (prod.has(id)) continue;
    if (ALLOW[id]) {
      allowed.add(`${id} until ${ALLOW[id].expires}`);
    } else {
      failures.push(`${where} dev: ${line}`);
    }
  }
}

if (failures.length) {
  console.error('[audit] FAIL:');
  for (const f of failures) console.error('  - ' + f);
  console.error(
    'Fix: upgrade the package. A dev-only advisory with no patched release may go in scripts/checks/audit-allowlist.json with a reason and an expiry date.',
  );
  process.exit(1);
}
const note = allowed.size ? `; allowed dev advisories: ${[...allowed].join(', ')}` : '';
console.log(`[audit] OK: nothing at moderate or worse in root or ui${note}.`);
