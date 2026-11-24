import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = 'usage: flagged-follows.mjs --analyzer DIR --runs FILE [--runs FILE ...] --plan FILE [--plan FILE ...] --tasks FILE [--tasks FILE ...] --transcripts DIR [--transcripts DIR ...] [--grading FILE] [--labels FILE] [--out FILE]';
const argv = process.argv.slice(2);
const all = (name) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
const one = (name) => all(name)[0];
const need = (name) => {
  const v = all(name);
  if (v.length === 0) throw new Error(`missing ${name}; ${USAGE}`);
  return v;
};

const analyzer = need('--analyzer')[0];
const mod = (f) => import(pathToFileURL(path.join(analyzer, 'scripts', 'token-eval', f)).href);
const { parseZ0Records, parsePlan } = await mod('z0-records.mjs');
const { filterRecords } = await mod('z0-filters.mjs');
const { holds } = await mod('leaks.mjs');

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const labels = readJson(one('--labels') ?? new URL('./flagged-follows-labels.json', import.meta.url));
const variants = new Set(labels.variant);
const grading = one('--grading') ? readJson(one('--grading')) : null;

const records = need('--runs').flatMap((f) => parseZ0Records(fs.readFileSync(f, 'utf8'), f).records);
const planCells = need('--plan').flatMap((f) => parsePlan(fs.readFileSync(f, 'utf8'), f));
const scored = filterRecords(records, planCells, { grading, dropList: null }).scored;

const keyPhrase = new Map();
for (const f of need('--tasks')) for (const fam of readJson(f).families ?? []) for (const l of fam.lessons ?? []) keyPhrase.set(l.id, l.keyPhrase);

const ls = (d) => (fs.existsSync(d) && fs.statSync(d).isDirectory() ? fs.readdirSync(d) : []);
const transcript = new Map();
for (const root of need('--transcripts')) for (const unit of ls(root)) {
  const runs = path.join(root, unit, 'run', 'runs');
  for (const seq of ls(runs)) for (const arm of ls(path.join(runs, seq))) for (const seed of ls(path.join(runs, seq, arm))) {
    const projects = path.join(runs, seq, arm, seed, 'claude-config', 'projects');
    for (const p of ls(projects)) for (const f of ls(path.join(projects, p))) if (f.endsWith('.jsonl')) transcript.set(f.slice(0, -6), path.join(projects, p, f));
  }
}

const typedUser = (o) => o.type === 'user' && !o.isMeta && (typeof o.message?.content === 'string'
  || (Array.isArray(o.message?.content) && o.message.content.some((b) => b.type === 'text')));
const toolInput = (b) => [b.input?.command, b.input?.new_string, b.input?.content].filter(Boolean).map(String).join('\n');

function ranRequiredFormBeforeCorrection(file, phrase) {
  let typed = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    const o = JSON.parse(line);
    if (typedUser(o) && ++typed === 2) return false;
    for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
      if (b.type === 'tool_use' && holds(toolInput(b), phrase)) return true;
    }
  }
  return false;
}

const byArm = {};
const missing = [];
for (const r of scored.filter((x) => x.set === 'R' && x.kind === 'apply' && x.applyIndex === 1)) {
  const a = (byArm[r.arm] ??= { firstApplySlots: 0, fails: 0, variantFails: 0, flaggedFollows: 0, cells: [] });
  for (const l of r.lessons) {
    a.firstApplySlots++;
    if (l.first === 'pass') continue;
    a.fails++;
    if (!variants.has(r.familyId)) continue;
    a.variantFails++;
    if (l.final !== 'fail') continue;
    const file = transcript.get(r.sessionId);
    if (!file) { missing.push(`${r.arm} ${r.sequence} seed ${r.seed} position ${r.position}`); continue; }
    if (ranRequiredFormBeforeCorrection(file, keyPhrase.get(l.lessonId))) {
      a.flaggedFollows++;
      a.cells.push(`${r.familyId} seed ${r.seed} position ${r.position}`);
    }
  }
}
const out = { rule: 'a first-apply lesson on a command-variant family whose first and final checks fail although the agent ran the required form before the correction turn', arms: byArm, missingTranscripts: missing };
if (one('--out')) fs.writeFileSync(one('--out'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
if (missing.length) process.exitCode = 1;
