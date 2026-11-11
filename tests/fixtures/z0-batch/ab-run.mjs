// Stub of ab-run.mjs for the s4-batch.sh tests: the listing counts it as a runner by its file name and `--out <folder>/run`.
// It replays `<fixture>/steps.json` into the run folder and reads its knobs from `$Z0_STUB_KNOBS/<folder name>.json` (else default.json).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);
const HOLD_S = Number(process.env.Z0_STUB_HOLD_S ?? 600);

/** Exits 9 with a line naming the bound, so a stub that a stuck test never releases still ends on its own. */
export function giveUp(what) {
  process.stderr.write(`stub ${what}: still held after Z0_STUB_HOLD_S=${HOLD_S} s, exiting 9\n`);
  process.exit(9);
}

/** Waits until `file` exists, calling `beat` every 200 ms, and gives up past Z0_STUB_HOLD_S. */
export async function holdUntil(file, what, beat = () => {}) {
  const end = Date.now() + HOLD_S * 1000;
  while (!fs.existsSync(file)) {
    if (Date.now() > end) giveUp(`${what} waiting for ${file}`);
    beat();
    await sleep(200);
  }
}

/** Keeps a hung stub alive until something stops it, and gives up past Z0_STUB_HOLD_S. */
export const hangBounded = (what) => setTimeout(() => giveUp(what), HOLD_S * 1000);

export function knobsOf(name) {
  const dir = process.env.Z0_STUB_KNOBS;
  return (dir && (readJson(path.join(dir, `${name}.json`)) ?? readJson(path.join(dir, 'default.json')))) || {};
}

/** Writes the fixture's static files, then its first `count` steps (all when null): log, attempt line, record line. */
export async function replay(fixture, out, count, gapMs = 0, onWritten = () => {}) {
  fs.mkdirSync(out, { recursive: true });
  fs.cpSync(path.join(fixture, 'static'), out, { recursive: true });
  const steps = readJson(path.join(fixture, 'steps.json'));
  for (const step of steps.slice(0, count ?? steps.length)) {
    if (gapMs > 0) await sleep(gapMs);
    const dir = path.join(out, path.dirname(step.attemptsFile));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(out, step.logFile), step.log);
    fs.appendFileSync(path.join(out, step.attemptsFile), `${JSON.stringify(step.attempt)}\n`);
    fs.appendFileSync(path.join(out, 'runs.jsonl'), `${JSON.stringify(step.record)}\n`);
    onWritten();
  }
}

async function main() {
  const out = process.argv[process.argv.indexOf('--out') + 1];
  const knobs = knobsOf(path.basename(path.dirname(out)));
  await sleep(knobs.startMs ?? 0);
  await replay(knobs.fixture, out, knobs.records ?? null, knobs.gapMs ?? 0);
  if (knobs.release) {
    // A held runner lives until the test has seen what it needs, however slow the box is, and its beat file shows the test it is alive and held.
    const beat = path.join(path.dirname(out), 'held.beat');
    let n = 0;
    await holdUntil(knobs.release, 'runner release', () => fs.writeFileSync(beat, String((n += 1))));
  }
  await sleep(knobs.endMs ?? 0);
  if (knobs.abandon) {
    fs.writeFileSync(path.join(out, 'ABANDONED'), '');
    process.exit(1);
  }
  if (knobs.printRecords !== false) process.stdout.write(`\nRecords: ${path.join(out, 'runs.jsonl')}\nAnalyze with the stub\n`);
  if (knobs.hang) {
    // A beating runner keeps run.log fresh until the test releases it, so no grace stop can come before the step the test waits for.
    if (knobs.beatUntil) await holdUntil(knobs.beatUntil, 'runner beat', () => process.stdout.write('beat\n'));
    hangBounded('runner hang');
  } else process.exit(knobs.exit ?? 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
