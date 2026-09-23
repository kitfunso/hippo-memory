#!/usr/bin/env node
// Undeclared diagnostic from the independent critique: final-epoch currentR5 split by how many
// same-template lookalikes of a fact are dated after its current version, and by that version's session.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { generateProtocol } from './generate.mjs';

const dir = process.argv[2];
if (!dir) throw new Error('usage: strata.mjs <campaign dir holding hl7/ and hl365/>');
const ARMS = [['hl7', 'all-off'], ['hl7', 'bm25-static'], ['hl365', 'full'], ['hl7', 'full']];
const TIGHT = /^(.+) (is now|has been set to|was confirmed as|stands at|moved to) (\S+)\.$/;

const acc = {};
const add = (key, arm, hit) => {
  acc[key] ??= {};
  acc[key][arm] ??= [0, 0];
  acc[key][arm][0] += hit ? 1 : 0;
  acc[key][arm][1] += 1;
};

let hashOk = 0;
for (let seed = 21; seed <= 40; seed++) {
  const p = generateProtocol({ seed });
  const hash = createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 16);
  const rows = {};
  for (const [hl, arm] of ARMS) {
    const run = JSON.parse(readFileSync(join(dir, hl, `${arm}-seed${seed}.json`), 'utf8'));
    if (run.meta.protocolHash !== hash) throw new Error(`protocol hash mismatch: ${hl}/${arm} seed ${seed}`);
    hashOk++;
    rows[`${hl}/${arm}`] = new Map(run.epochs.at(-1).probes.map((r) => [r.factId, r]));
  }
  for (const probe of p.probes) {
    const cur = probe.versionTimeline.at(-1);
    const curTok = probe.tokens[cur.version];
    let newer = 0;
    for (const m of p.memories) {
      if (m.content.includes(curTok)) continue;
      const mt = TIGHT.exec(m.content);
      if (mt && mt[1] === probe.query && m.session > cur.session) newer++;
    }
    const kind = cur.version >= 2 ? 'upd' : 'non';
    const from = Math.floor(cur.session / 4) * 4;
    for (const [hl, arm] of ARMS) {
      const hit = rows[`${hl}/${arm}`].get(probe.factId).hit;
      add(`${kind} newerTight=${newer >= 5 ? '5+' : newer}`, `${hl}/${arm}`, hit);
      add(`${kind} ALL`, `${hl}/${arm}`, hit);
      add(`${kind} curSession=${String(from).padStart(2, '0')}-${from + 3}`, `${hl}/${arm}`, hit);
    }
  }
}
console.log(`protocolHash match ${hashOk}, mismatch 0`);
const armKeys = ARMS.map(([h, a]) => `${h}/${a}`);
console.log(['stratum'.padEnd(26), 'n'.padStart(5), ...armKeys.map((k) => k.padStart(16))].join(' '));
for (const key of Object.keys(acc).sort()) {
  const n = acc[key][armKeys[0]][1];
  console.log([key.padEnd(26), String(n).padStart(5), ...armKeys.map((k) => (acc[key][k][0] / acc[key][k][1]).toFixed(3).padStart(16))].join(' '));
}
