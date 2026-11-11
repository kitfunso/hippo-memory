#!/usr/bin/env node
/** Round 4 G5 across a batch's run folders (base prereg 166): every folder's latest reader round counted together, with the first-check split reported beside it.
 * The round 3 combine script with this checkout's g5-draw.mjs. Each grading file sits in the out folder that holds its sealed reader rounds. Exit 0 on a file, 1 on bad input. */

import * as path from 'node:path';

import { writeFileAtomic } from './atomic-write.mjs';
import { parseFlags, readJson, runCommand, runMain } from './free-cli.mjs';
import { kappa, wilson } from './g5-draw.mjs';
import { sha256 } from './z0-blind.mjs';

const USAGE = 'usage: z0-grading-combine.mjs --grading FILE [--grading FILE ...] --out FILE';
const SPEC = { values: ['--out'], lists: ['--grading'], required: ['--grading', '--out'] };

/** One folder's latest reader round split by check, recounted from the sealed key and score; the recount must match the grading file's own total. */
function readerSplit(file, grading) {
  const sealed = path.join(path.dirname(file), 'g5', 'sealed');
  const k = grading.g5.readerRound;
  const key = readJson(path.join(sealed, `reader-r${k}.key.json`));
  const score = readJson(path.join(sealed, `reader-r${k}.score.json`));
  const split = { first: { n: 0, disagreements: 0 }, final: { n: 0, disagreements: 0 } };
  for (const p of key.pairs) {
    if (!split[p.which]) throw new Error(`${file}: reader pair ${p.file} has check ${p.which}, not first or final`);
    split[p.which].n++;
    if (score.labels[p.file] !== p.verdict) split[p.which].disagreements++;
  }
  const n = split.first.n + split.final.n;
  const disagreements = split.first.disagreements + split.final.disagreements;
  if (n !== grading.readerSample.n || disagreements !== grading.readerSample.disagreements) {
    throw new Error(`${file}: sealed round ${k} recounts to ${disagreements} of ${n}, the grading file says ${grading.readerSample.disagreements} of ${grading.readerSample.n}`);
  }
  return split;
}

/** The folders' stored samples as one: summed table and exclusions, agreement, Wilson interval and kappa. */
function pooledStored(parts) {
  const scored = parts.filter((p) => p.grading.storedSample !== undefined);
  if (scored.length === 0) return undefined;
  if (scored.length !== parts.length) throw new Error(`stored sample scored in ${scored.length} of ${parts.length} folders; score it in all or none`);
  const table = { yesYes: 0, yesNo: 0, noYes: 0, noNo: 0 };
  const excluded = {};
  for (const { grading: { storedSample: s } } of scored) {
    for (const k of Object.keys(table)) table[k] += s.table[k];
    for (const [k, v] of Object.entries(s.excluded ?? {})) excluded[k] = (excluded[k] ?? 0) + v;
  }
  const n = table.yesYes + table.yesNo + table.noYes + table.noNo;
  const agree = table.yesYes + table.noNo;
  return { n, agree, agreement: n ? agree / n : null, ci95: wilson(agree, n), kappa: kappa(table), table, excluded };
}

function readPart(file, cwd) {
  const grading = readJson(path.resolve(cwd, file));
  if (!Number.isInteger(grading.g5?.readerRound) || grading.g5.readerRound < 1) throw new Error(`${file}: no scored reader round (readerRound ${grading.g5?.readerRound})`);
  return { file, sha256: sha256(path.resolve(cwd, file)), grading, split: readerSplit(path.resolve(cwd, file), grading) };
}

/** The combined grading object of the parts, in the order given. */
export function combine(parts) {
  const sum = (pick) => parts.reduce((a, p) => a + pick(p), 0);
  const first = { disagreements: sum((p) => p.split.first.disagreements), n: sum((p) => p.split.first.n) };
  const combined = {
    acceptanceFlips: sum((p) => p.grading.acceptanceFlips),
    flippedLessons: [...new Set(parts.flatMap((p) => p.grading.flippedLessons))].sort(),
    g5: {
      allPairs: { disagreements: sum((p) => p.grading.readerSample.disagreements), n: sum((p) => p.grading.readerSample.n) },
      rule: 'base prereg 166: readerSample counts every pair of each folder\'s latest scored round; firstPairs is reported with no verdict',
      firstPairs: first,
      finalPairs: { disagreements: sum((p) => p.split.final.disagreements), n: sum((p) => p.split.final.n) },
      folders: parts.map(({ file, sha256: hash, grading, split }) => ({ file, sha256: hash, g5: grading.g5, readerSample: grading.readerSample, split })),
    },
    readerSample: { disagreements: sum((p) => p.grading.readerSample.disagreements), n: sum((p) => p.grading.readerSample.n) },
  };
  const stored = pooledStored(parts);
  if (stored) combined.storedSample = stored;
  return combined;
}

/** @param {string[]} argv @param {string} [cwd] */
export function runCli(argv, cwd = process.cwd()) {
  return runCommand(() => {
    const args = parseFlags(argv, SPEC, USAGE);
    const combined = combine(args.grading.map((file) => readPart(file, cwd)));
    // Written whole each time: the end phase reruns with the same files and gets the same bytes.
    writeFileAtomic(path.resolve(cwd, args.out), `${JSON.stringify(combined, null, 2)}\n`);
    const stored = combined.storedSample ? `, stored sample n ${combined.storedSample.n}` : '';
    return `wrote ${args.out}: G5 reads ${combined.readerSample.n} pairs (${combined.g5.firstPairs.n} first-check), ${combined.flippedLessons.length} flipped lessons, ${combined.acceptanceFlips} acceptance flips${stored}\n`;
  });
}

runMain(import.meta.url, runCli);
