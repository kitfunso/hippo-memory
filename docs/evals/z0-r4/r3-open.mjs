// Shared start of every round 3 re-read script, so none prints before the report's hashes and 04835462b's blobs match.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { openFrozenRead, DEFAULT_REPORT, DEFAULT_GRADING, DEFAULT_DROP_LIST } from '../../../scripts/token-eval/z0-cost-by-kind.mjs';

const REF = '04835462b';
const FIX = `check out ${REF} at --analyzer`;
const API_MODULES = ['scripts/token-eval/z0-analyze.mjs', 'scripts/token-eval/z0-filters.mjs', 'scripts/token-eval/z0-hypotheses.mjs'];
const IMPORT = /\bfrom\s*['"](\.[^'"]+)['"]|\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)|\bimport\s*['"](\.[^'"]+)['"]/g;

export const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};

// Walks imports too: a module the report hashes can pull in one it does not (z0-gates.mjs imports arms.mjs).
function reach(root, entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    if (!fs.existsSync(path.join(root, file))) {
      throw new Error(`${file} is missing under --analyzer ${root}; ${FIX}`);
    }
    for (const m of fs.readFileSync(path.join(root, file), 'utf8').matchAll(IMPORT)) {
      const next = path.posix.join(path.posix.dirname(file), m[1] ?? m[2] ?? m[3]);
      if (fs.existsSync(path.join(root, next))) {
        queue.push(next);
      }
    }
  }
  return seen;
}

function checkBlobs(root, files) {
  const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  for (const file of files) {
    let got;
    let want;
    try {
      got = git(['hash-object', path.join(root, file)]);
      want = git(['rev-parse', `${REF}:${file}`]);
    } catch (e) {
      throw new Error(`cannot compare ${file} under --analyzer ${root} with ${REF} (${String(e.stderr ?? e.message).trim().split('\n')[0]}); ${FIX}`);
    }
    if (got !== want) {
      throw new Error(`${file} under --analyzer ${root} has blob ${got}, ${REF} holds ${want}; ${FIX}`);
    }
  }
}

// loads lists every extra analyzer module the script will load(), so each one is gated before any figure prints.
export async function openRound3(loads = []) {
  const analyzer = arg('--analyzer', null);
  if (analyzer === null) throw new Error('--analyzer <checkout of 04835462b> is required');
  const frozen = await openFrozenRead({
    analyzer,
    report: arg('--report', DEFAULT_REPORT),
    grading: arg('--grading', DEFAULT_GRADING),
    dropList: arg('--drop-list', DEFAULT_DROP_LIST),
  });
  const hashed = new Set(frozen.report.hashes.filter((h) => h.role === 'source').map((h) => h.file));
  const gated = reach(frozen.analyzer, [...API_MODULES, ...loads]);
  const unhashed = [...gated].filter((file) => !hashed.has(file)).sort();
  checkBlobs(frozen.analyzer, unhashed);
  console.log(`frozen read: ${frozen.sources} sources and ${frozen.analyzerArgs.runs.length} runs files match the report, and ${unhashed.length} unhashed modules match ${REF}; H3 and H4 self-check exact`);
  const { api, inputs } = frozen;
  return {
    ...frozen,
    load: (file) => {
      if (!gated.has(file)) {
        throw new Error(`${file} was not passed to openRound3, so nothing gated it`);
      }
      return import(pathToFileURL(path.join(frozen.analyzer, file)).href);
    },
    // The round 3 sizing scripts read every scored record with the drop list off; the gate above ran with it on.
    scoredNoDrop: () => api.filterRecords(inputs.records, inputs.planCells, { grading: inputs.grading, dropList: null }).scored,
  };
}
