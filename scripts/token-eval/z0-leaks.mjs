#!/usr/bin/env node
/** Round 4 prereg item 9: lists the (sequence, seed)s a first run leaked, so z0-merge can drop them. It reads through the analyzer's one filter path
 * with no price file, and stops when its list and G3's count differ. Exit 0 on a list, 1 on bad input, 3 on that stop. */

import * as path from 'node:path';

import { writeFileAtomic } from './atomic-write.mjs';
import { Stop, parseFlags, runCommand, runMain } from './free-cli.mjs';
import { loadInputs } from './z0-analyze.mjs';
import { sha256 } from './z0-blind.mjs';
import { filteredInput } from './z0-filters.mjs';
import { LEAKS_SCHEMA, isLeak, runKey } from './z0-records.mjs';

const USAGE = 'usage: z0-leaks.mjs --runs FILE --plan FILE --out FILE [--design NAME]';
const SPEC = { values: ['--runs', '--plan', '--out', '--design'], required: ['--runs', '--plan', '--out'] };

/** Stops unless the list holds as many (sequence, seed)s as G3 counts as leaked. */
export function assertSameCount(listed, counted) {
  if (listed !== counted) throw new Stop(`STOP: ${listed} leaks listed, G3 counts ${counted}`);
}

/** @param {string[]} argv @param {string} [cwd] */
export function runCli(argv, cwd = process.cwd()) {
  return runCommand(() => {
    const args = parseFlags(argv, SPEC, USAGE);
    const inputs = loadInputs({ runs: [args.runs], plan: [args.plan], prices: null, grading: null, dropList: null, offPin: [], out: null, design: args.design }, cwd);
    const { filtered, records } = filteredInput(inputs.records, inputs.planCells, { design: inputs.design }, { dropAbandoned: false });
    const hits = new Map(records.filter(isLeak).map((r) => [runKey(r.sequence, r.seed), { sequence: r.sequence, seed: r.seed }]));
    const leaks = [...hits.values()].sort((a, b) => a.sequence.localeCompare(b.sequence) || a.seed - b.seed);
    assertSameCount(leaks.length, filtered.leaked.length);
    const runsFile = path.resolve(cwd, args.runs);
    writeFileAtomic(path.resolve(cwd, args.out), `${JSON.stringify({ schema: LEAKS_SCHEMA, runs: { file: runsFile, sha256: sha256(runsFile) }, leaks }, null, 2)}\n`);
    return leaks.map((l) => `${l.sequence} ${l.seed}\n`).join('');
  });
}

runMain(import.meta.url, runCli);
