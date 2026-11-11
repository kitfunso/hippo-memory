// One stub, copied under each stubbed CLI name and run by the stub s4-batch.sh and s4-read.sh: it logs its argv, then acts on the next item of $Z0_STUB_KNOBS/cli-<name>.json.
// An item is { exit, stdout, stderr, write: { <file>: <text> }, make: [<folder>], hangMs }; the list is used one item per call and its last item stays.
import * as fs from 'node:fs';
import * as path from 'node:path';

const name = process.env.Z0_STUB_NAME ?? path.basename(process.argv[1], '.mjs');
const dir = process.env.Z0_STUB_KNOBS;
const log = path.join(dir, 'calls.jsonl');
fs.appendFileSync(log, `${JSON.stringify({ cli: name, argv: process.argv.slice(2) })}\n`);
const nth = fs.readFileSync(log, 'utf8').split('\n').filter((l) => l !== '' && JSON.parse(l).cli === name).length;
const file = path.join(dir, `cli-${name}.json`);
const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
const knob = list[Math.min(nth, list.length) - 1] ?? {};
for (const [target, text] of Object.entries(knob.write ?? {})) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
for (const folder of knob.make ?? []) fs.mkdirSync(folder, { recursive: true });
if (knob.stdout) process.stdout.write(`${knob.stdout}\n`);
if (knob.stderr) process.stderr.write(`${knob.stderr}\n`);
if (knob.hangMs) await new Promise((resolve) => setTimeout(resolve, knob.hangMs));
process.exitCode = knob.exit ?? 0;
