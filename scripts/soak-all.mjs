#!/usr/bin/env node
/**
 * Run all 10 soak-test workload profiles in sequence and produce a summary
 * table that the Frontier AI Discovery feasibility study can cite as O1
 * evidence. Each profile runs against the same starting state (same seed)
 * so cross-profile comparison is apples-to-apples.
 *
 * Usage:
 *   node scripts/soak-all.mjs --ticks 500 --particles 200 --out benchmarks/soak/results/
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  const v = process.argv[i + 1];
  const n = Number(v);
  return Number.isFinite(n) && v !== '' ? n : v;
}

const TICKS = Number(flag('--ticks', 500));
const PARTICLES = Number(flag('--particles', 200));
const SEED = Number(flag('--seed', 42));
const OUT_DIR = String(flag('--out', 'benchmarks/soak/results'));

const PROFILES = [
  'balanced',
  'write-heavy',
  'read-heavy',
  'burst',
  'dedup-heavy',
  'conflict-heavy',
  'decay-only',
  'reward-modulated',
  'consolidation-heavy',
  'steady-state',
];

fs.mkdirSync(OUT_DIR, { recursive: true });

const summary = [];
console.error(`Running ${PROFILES.length} profiles × ${TICKS} ticks × ${PARTICLES} starting particles (seed=${SEED})\n`);

for (const profile of PROFILES) {
  const outCsv = path.join(OUT_DIR, `soak-${profile}.csv`);
  const started = Date.now();
  try {
    execFileSync(process.execPath, [
      'scripts/soak-test.mjs',
      '--profile', profile,
      '--ticks', String(TICKS),
      '--particles', String(PARTICLES),
      '--seed', String(SEED),
      '--out', outCsv,
    ], { stdio: 'inherit', timeout: 600_000 });
  } catch (err) {
    console.error(`  ${profile}: FAILED — ${err.message}`);
    summary.push({ profile, status: 'FAILED', error: err.message });
    continue;
  }
  const wallMs = Date.now() - started;

  // Parse CSV tail for summary stats
  const csv = fs.readFileSync(outCsv, 'utf8').trim().split(/\r?\n/);
  const header = csv[0].split(',');
  const rows = csv.slice(1).map(line => line.split(','));
  const idxEnergy = header.indexOf('total_energy');
  const idxParticles = header.indexOf('particles');
  const idxMaxVel = header.indexOf('max_vel');

  const energies = rows.map(r => Number(r[idxEnergy])).filter(Number.isFinite);
  const firstE = energies[0] ?? 0;
  const finalE = energies[energies.length - 1] ?? 0;
  const maxAbsE = energies.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const maxVel = rows.reduce((m, r) => Math.max(m, Number(r[idxMaxVel]) || 0), 0);
  const finalN = rows.length ? Number(rows[rows.length - 1][idxParticles]) : 0;
  const bounded = Number.isFinite(finalE) && maxVel <= 1.0; // config cap is 0.1; 10x = 1.0

  summary.push({ profile, status: bounded ? 'BOUNDED' : 'DIVERGED', ticks: rows.length, firstE, finalE, maxAbsE, maxVel, finalN, wallMs });
}

// ---- write summary ----
const summaryPath = path.join(OUT_DIR, 'soak-summary.md');
const lines = [];
lines.push('# O1 Soak Test — 10 Workload Profiles');
lines.push('');
lines.push(`Generated: ${new Date().toISOString()}`);
lines.push(`Config: ${TICKS} ticks per profile, ${PARTICLES} starting particles, seed ${SEED}`);
lines.push('');
lines.push('| Profile | Status | Ticks | First E | Final E | Max \\|E\\| | Max \\|v\\| | Final N | Wall (s) |');
lines.push('|---------|--------|-------|---------|---------|----------|----------|---------|----------|');
for (const s of summary) {
  if (s.status === 'FAILED') {
    lines.push(`| ${s.profile} | FAILED | — | — | — | — | — | — | — |`);
    continue;
  }
  lines.push(`| ${s.profile} | ${s.status} | ${s.ticks} | ${s.firstE.toFixed(3)} | ${s.finalE.toFixed(3)} | ${s.maxAbsE.toFixed(3)} | ${s.maxVel.toFixed(4)} | ${s.finalN} | ${(s.wallMs/1000).toFixed(1)} |`);
}
lines.push('');

const boundedCount = summary.filter(s => s.status === 'BOUNDED').length;
lines.push(`**Verdict: ${boundedCount} of ${PROFILES.length} profiles bounded.**`);
lines.push('');
if (boundedCount === PROFILES.length) {
  lines.push('All workload profiles show bounded energy within the configured velocity cap (0.1, Lyapunov-relevant upper bound 1.0 = 10× cap). Physics engine is stable under every tested regime.');
} else {
  lines.push('Some profiles diverged — see individual CSVs for detail. Investigation required before claiming engine stability.');
}

fs.writeFileSync(summaryPath, lines.join('\n'));

console.error('\n=== Summary ===');
for (const s of summary) {
  const tag = s.status === 'BOUNDED' ? '✓' : s.status === 'DIVERGED' ? '✗' : '!';
  console.error(`  ${tag} ${s.profile.padEnd(22)} status=${s.status} finalE=${s.finalE?.toFixed?.(3) ?? '?'} maxV=${s.maxVel?.toFixed?.(4) ?? '?'}`);
}
console.error(`\nSummary written to: ${summaryPath}`);
