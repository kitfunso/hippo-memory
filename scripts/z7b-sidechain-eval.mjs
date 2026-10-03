#!/usr/bin/env node
// Z7b strict sub-agent lesson eval, prereg docs/evals/2026-10-03-z7b-sidechain-strict-prereg.md. Stdout carries counts only, never transcript, lesson or label text.
import { runSelftests } from './z7-sidechain-eval.mjs';
import { z7bSelftests } from './z7b-sidechain-selftest.mjs';

async function selftest() {
  let n = 0;
  const failed = [];
  const t = (name, ok) => { n++; if (!ok) failed.push(name); };
  await runSelftests(t);
  for (const group of z7bSelftests) group(t);
  console.log(`selftest: ${n} cases, ${failed.length} failed`);
  for (const name of failed) console.log(`FAIL: ${name}`);
  process.exit(failed.length ? 1 : 0);
}

async function main() {
  const cmd = process.argv[2];
  if (cmd === 'selftest') return await selftest();
  throw new Error(`unknown command ${cmd}`);
}

main().catch((e) => { console.error(`z7b: ${e.message}`); process.exit(1); });
