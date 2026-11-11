// Stub of ab-run.mjs for the s4-batch.sh tests: the listing counts it as a runner by its file name and `--out <folder>/run`.
// It replays `<fixture>/steps.json` into the run folder and reads its knobs from `$Z0_STUB_KNOBS/<folder name>.json` (else default.json).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);

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
  await sleep(knobs.endMs ?? 0);
  if (knobs.abandon) {
    fs.writeFileSync(path.join(out, 'ABANDONED'), '');
    process.exit(1);
  }
  if (knobs.printRecords !== false) process.stdout.write(`\nRecords: ${path.join(out, 'runs.jsonl')}\nAnalyze with the stub\n`);
  if (knobs.hang) setInterval(() => {}, 1000);
  else process.exit(knobs.exit ?? 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
