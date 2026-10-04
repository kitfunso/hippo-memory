// Z0 prereg 179: the hand-labelled stored sample that checks the key-phrase judgement of `chain.stored`, with agreement and kappa.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { holds } from './leaks.mjs';
import { cellKey, isBool, isInvalid, isLeak, parseZ0Records } from './z0-records.mjs';
import { listGrades } from './regrade.mjs';
import { FORBIDDEN, blindLeaks, fenced, fillStrata, kappa, labelsTemplate, parseLabels, seededOrder, wilson } from './g5-draw.mjs';
import { fileIds, forbiddenFor, outRedactor, taskText } from './reader-sample.mjs';

const CUT = /\[cut at \d+ chars\]\n?$/;
// Config parts would name the tool or its settings outright, so they never reach the reader.
const DROPPED_PART = /(?:config|settings)\.json$|(?:^|[\\/])\.hippo[\\/]config/i;
const YES_NO = ['yes', 'no'];
const keyFile = (out) => path.join(out, 'g5', 'sealed', 'stored.key.json');
const scoreFile = (out) => path.join(out, 'g5', 'sealed', 'stored.score.json');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

/** Best-effort blinding: headers become `=== part N`, config parts go, `hippo` becomes `[tool]`, run paths become `<run>`. */
export function blindSurfaces(text, redact) {
  const parts = text.split(/^(?==== )/m).filter((p) => p.startsWith('=== '));
  const kept = parts.map((p) => {
    const nl = p.indexOf('\n');
    return { where: p.slice(4, nl < 0 ? p.length : nl).replace(/#[^#\\/]*$/, ''), body: nl < 0 ? '' : p.slice(nl + 1) };
  }).filter((p) => !DROPPED_PART.test(p.where));
  return kept.map((p, i) => `=== part ${i + 1}\n${redact(p.body).replace(/hippo/gi, '[tool]')}`).join('');
}

/** Valid applies with a stored judgement and a surfaces.txt; cut, empty and hidden-hit texts are left out and counted (179, R15). */
export function storedUnits(out, records, text, redact) {
  const units = [];
  const excluded = { cut: 0, empty: 0, hiddenHit: 0 };
  for (const r of records) {
    if (r.kind !== 'apply' || isInvalid(r) || isLeak(r) || !isBool(r.chain?.stored)) continue;
    const file = path.join(out, 'grading', r.sequence, r.arm, `seed${r.seed}`, `${r.taskId}.surfaces.txt`);
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf8');
    const lesson = text.lesson(r.lessons[0].lessonId);
    const blind = blindSurfaces(raw, redact);
    if (CUT.test(raw)) excluded.cut++;
    else if (raw.trim() === '') excluded.empty++;
    else if (r.chain.stored && !holds(blind, lesson.keyPhrase)) excluded.hiddenHit++;
    else units.push({ key: cellKey(r), arm: r.arm, lessonId: lesson.id, judged: r.chain.stored ? 'yes' : 'no', rule: lesson.rule, blind });
  }
  return { units, excluded };
}

const unitText = (u) => [
  '## Rule', u.rule, '', '## Question', 'Does this text hold this rule? Write yes or no in labels.tsv.', '', '## Text', fenced(u.blind, 'text'),
].join('\n');

/** Draw the stored sample: n/2 judged yes and n/2 judged no, a shortfall moved to the other, each in seeded order. */
export function drawStored(out, { tasksFile, runsFile, seed, n = 30, aliases = [] }) {
  if (fs.existsSync(keyFile(out))) {
    const key = readJson(keyFile(out));
    if (key.seed !== seed || key.n !== n) throw new Error(`the stored sample was drawn with --seed ${key.seed} --n ${key.n}; it is drawn once`);
    return `stored sample: already drawn, ${key.units.length} units in ${path.join(out, 'g5', 'stored')}\n`;
  }
  const { records } = parseZ0Records(fs.readFileSync(runsFile, 'utf8'), runsFile);
  // Every record's run root too, since a unit's text can name a run with no saved grade.json.
  const cells = [...listGrades(out).map((e) => e.grade), ...records.map((r) => ({ runName: r.sequence, arm: r.arm, seed: r.seed }))];
  const { units, excluded } = storedUnits(out, records, taskText(tasksFile), outRedactor([out, ...aliases], cells));
  // `[tool]` is this sample's own stand-in for the tool name, so only the reader sample scans for it.
  const forbidden = forbiddenFor(cells, FORBIDDEN.filter((f) => f !== '[tool]'));
  const accept = (u) => blindLeaks(unitText(u), forbidden).length === 0;
  const stratum = (j) => ({ quota: j === 'yes' ? Math.ceil(n / 2) : Math.floor(n / 2), items: seededOrder(seed, units.filter((u) => u.judged === j), (u) => u.key) });
  const { taken, rejected } = fillStrata([{ share: n, strata: YES_NO.map(stratum) }], n, accept);
  const ordered = seededOrder(seed, taken, (u) => u.key, 'order:');
  const ids = fileIds('s', ordered.length);
  const dir = path.join(out, 'g5', 'stored');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  ordered.forEach((u, i) => fs.writeFileSync(path.join(dir, `${ids[i]}.md`), `# Unit ${ids[i]}\n\n${unitText(u)}`));
  fs.writeFileSync(path.join(dir, 'labels.tsv'), labelsTemplate(ids, YES_NO));
  writeJson(keyFile(out), {
    seed, n, eligible: units.length, excluded, unblindable: rejected.length,
    units: ordered.map((u, i) => ({ file: ids[i], key: u.key, lessonId: u.lessonId, arm: u.arm, judged: u.judged })),
  });
  return `stored sample: drew ${ordered.length} of ${units.length} units (${rejected.length} unblindable; excluded ${excluded.cut} cut, ${excluded.empty} empty, ${excluded.hiddenHit} hidden-hit) into ${dir}\n`;
}

/** Score the labels: agreement with its Wilson interval, kappa and the 2x2 table; per-stratum agreement stays under sealed/. */
export function scoreStored(out, labelsFile) {
  if (!fs.existsSync(keyFile(out))) throw new Error('the stored sample is not drawn');
  const key = readJson(keyFile(out));
  const labels = parseLabels(fs.readFileSync(labelsFile, 'utf8'), key.units.map((u) => u.file), YES_NO);
  const table = { yesYes: 0, yesNo: 0, noYes: 0, noNo: 0 };
  const perStratum = { yes: { n: 0, agree: 0 }, no: { n: 0, agree: 0 } };
  for (const u of key.units) {
    const label = labels.get(u.file);
    table[`${u.judged}${label === 'yes' ? 'Yes' : 'No'}`]++;
    perStratum[u.judged].n++;
    if (label === u.judged) perStratum[u.judged].agree++;
  }
  const n = key.units.length;
  const agree = table.yesYes + table.noNo;
  const summary = { n, agree, agreement: n ? agree / n : null, ci95: wilson(agree, n), kappa: kappa(table), table, excluded: key.excluded };
  writeJson(scoreFile(out), { ...summary, perStratum, labels: Object.fromEntries(labels) });
  return `stored sample: ${agree} of ${n} labels agree with the key-phrase judgement\n`;
}

/** grading.json's storedSample, present only once the sample is scored. */
export function storedSummary(out) {
  if (!fs.existsSync(scoreFile(out))) return undefined;
  const { n, agree, agreement, ci95, kappa: k, table, excluded } = readJson(scoreFile(out));
  return { n, agree, agreement, ci95, kappa: k, table, excluded };
}
