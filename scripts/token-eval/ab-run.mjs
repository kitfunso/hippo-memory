#!/usr/bin/env node
// Z0 Claude Code runner: arms A0, A1, A2, A4 and A5 in lockstep, one record per (task, arm, seed) for z0-analyze.mjs.
// Protocol: docs/evals/2026-09-29-z0-built-in-memory-prereg.md. Usage, tasks file and fairness: benchmarks/token-eval/README.md.
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARMS, ARM_SEEDS, ARM_TABLE, CODEX_HIPPO_ARMS, DESIGNS, EFFORTS, TOKEN_KEY, armSet, joinCodes } from './arms.mjs';
import { assertNoAncestorInstructions, checkHomes } from './homes.mjs';
import { validateFamilies, drawOrder, taskRoles } from './lessons.mjs';
import { openContext, cacheTaskRepos } from './runs.mjs';
import { assertNoPhraseLeaks } from './leaks.mjs';
import { runSteps } from './task.mjs';
import { SEED_CAP } from './z0-records.mjs';
import { planScreen, screenLines, runScreen, SCREEN_ARMS } from './screen.mjs';
import { parseHookTrust } from './codex.mjs';
import { finishCodex } from './codex-task.mjs';
import { checkInstaller } from './codex-install.mjs';
import { REPO, objectLockRetries } from './exec.mjs';
import { startStubUpstream } from './proxy.mjs';

export { cacheTaskRepos } from './runs.mjs';
export { usageFromResult, isUsageLimit, transcriptWork } from './records.mjs';

const MODULE_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/** Validate a tasks file; `baseDir` (the file's folder) resolves checker scripts. Throws on the first problem.
 * @param {any} spec
 * @param {string | null} [baseDir] */
export function validateTasks(spec, baseDir = null) {
  if (!spec || !Array.isArray(spec.sequences) || spec.sequences.length === 0) throw new Error('tasks file needs a non-empty "sequences" array');
  const ids = new Set();
  for (const s of spec.sequences) {
    for (const f of ['id', 'cluster', 'repo']) if (!s[f]) throw new Error(`sequence missing "${f}"`);
    if (ids.has(s.id)) throw new Error(`duplicate sequence id ${s.id}`);
    ids.add(s.id);
    if (!Array.isArray(s.tasks) || s.tasks.length < 2) throw new Error(`sequence ${s.id} needs at least 2 tasks (the first is not scored)`);
    const taskIds = new Set();
    for (const t of s.tasks) {
      for (const f of ['id', 'baseRef', 'fixRef', 'prompt', 'test']) if (!t[f]) throw new Error(`task in ${s.id} missing "${f}"`);
      if (taskIds.has(t.id)) throw new Error(`sequence ${s.id} has task id ${t.id} twice`);
      taskIds.add(t.id);
      if (!Array.isArray(t.testFiles)) throw new Error(`task ${t.id} needs a "testFiles" array`);
      if (t.venvImports !== undefined && !(Array.isArray(t.venvImports) && t.venvImports.every((m) => m?.constructor === String && MODULE_NAME.test(m)))) {
        throw new Error(`task ${t.id} venvImports must be a list of module names (letters, digits, underscores and dots; none starts with a digit)`);
      }
      if (t.needsReview) throw new Error(`task ${t.id} still has needsReview: rewrite its prompt as the problem (not the fix), then delete needsReview`);
    }
  }
  return validateFamilies(spec, baseDir);
}

const rotate = (list, k) => list.map((_, i) => list[(i + k) % list.length]);

/** A sequence's tasks in this seed's drawn order with their roles; every arm on the seed shares it (prereg 117). */
function seededOrder(sequence, families, seed) {
  const tasks = drawOrder(sequence, families, seed).map((id) => sequence.tasks.find((t) => t.id === id));
  return { tasks, roles: taskRoles(tasks, families, sequence.set) };
}

const pairs = (arm, sequence) => armSet(arm) === (sequence.set === 'X' ? 'X' : 'RN');

/** Throws when an arm has no sequence of its set, so a plan never silently drops an arm. */
function assertArmsPair(spec, arms) {
  for (const arm of arms) {
    if (!spec.sequences.some((s) => pairs(arm, s))) throw new Error(`arm ${arm} has no sequence of set ${armSet(arm) === 'X' ? 'X' : 'R or N'} in the tasks file`);
  }
}

// --seeds only lowers a count: E7 refuses an A0 or A4 seed past the prereg's two (prereg 122-124).
const seedCap = (seeds) => (arm) => Math.min(seeds ?? ARM_SEEDS[arm], ARM_SEEDS[arm]);
// Wave 2 (Amendment 2 item 5) runs seeds 4 up to the seed rule's count.
const WAVE_1_SEEDS = 3;
const WAVE_2_FIRST_SEED = WAVE_1_SEEDS + 1;

/** Every session in execution order, `{ seed, position, arm, sequence, taskId, t, role }`: position-major, each arm set's order rotated by position + seed.
 * `firstSeed` 4 plans wave 2; rotation and drawn order key on the real seed number, so a seed's cells match a plan that started at 1. */
export function planRuns(spec, arms, seedsFor = (arm) => ARM_SEEDS[arm], firstSeed = 1, maxPosition = Infinity) {
  assertArmsPair(spec, arms);
  const steps = [];
  const maxSeed = Math.max(...arms.map(seedsFor));
  // --max-position n plans the first n tasks of each sequence; validateTasks needs two, and a smoke or effort run takes one.
  const maxTasks = Math.min(maxPosition, Math.max(...spec.sequences.map((s) => s.tasks.length)));
  for (let seed = firstSeed; seed <= maxSeed; seed++) {
    const active = arms.filter((a) => seed <= seedsFor(a));
    // Each set rotates alone and the sets run one after the other (RN, then X), so a set's order balance never depends on the other set's arm count (prereg 120).
    const sets = [active.filter((a) => armSet(a) !== 'X'), active.filter((a) => armSet(a) === 'X')];
    const orders = new Map(spec.sequences.map((s) => [s.id, seededOrder(s, spec.families ?? [], seed)]));
    for (let position = 0; position < maxTasks; position++) {
      for (const arm of sets.flatMap((set) => rotate(set, position + seed))) {
        for (const sequence of spec.sequences) {
          if (position >= sequence.tasks.length || !pairs(arm, sequence)) continue;
          const { tasks, roles } = orders.get(sequence.id);
          steps.push({ seed, position, arm, sequence, taskId: tasks[position].id, t: tasks[position], role: roles[position] });
        }
      }
    }
  }
  return steps;
}

/** A run's plan: wave 1 caps each arm at its prereg count (`seeds` only lowers it); wave 2 (`waveTwo`, the seed rule's counts by arm) runs seeds 4 up to each count. */
const planFor = (spec, arms, seeds, waveTwo, onlySeed = null, maxPosition = Infinity) => (onlySeed ? planRuns(spec, arms, () => onlySeed, onlySeed, maxPosition)
  : (waveTwo ? planRuns(spec, arms, (arm) => waveTwo[arm], WAVE_2_FIRST_SEED, maxPosition) : planRuns(spec, arms, seedCap(seeds), 1, maxPosition)));

const SEED_RULE_SCHEMAS = new Map([[DESIGNS.r3, 'z0-seed-rule/1'], [DESIGNS.r4, 'z0-seed-rule/2']]);

function checkCount(file, arm, n) {
  if (!Number.isInteger(n) || n < WAVE_1_SEEDS || n > SEED_CAP) throw new Error(`--seed-rule ${file}: ${arm} needs a seed count from ${WAVE_1_SEEDS} to ${SEED_CAP}, got ${JSON.stringify(n)}`);
}

/** A /2 rule's refusals: design r4; a fixed arm never raises (prereg item 1); every rule arm is in `seeds` at one count of 3 to 9 (item 10: they run the largest);
 * and `countsByArm` repeats `seeds` for a rule arm and the table for a fixed one. */
function checkRuleR4(file, rule, design) {
  const { seeds, countsByArm } = rule;
  if (rule.design !== 'r4') throw new Error(`--seed-rule ${file}: design is ${JSON.stringify(rule.design)}, not "r4"`);
  const fixed = design.arms.filter((a) => !ARM_TABLE[a].seedRule);
  const ruled = design.arms.filter((a) => ARM_TABLE[a].seedRule);
  if (fixed.some((a) => Object.hasOwn(seeds, a))) throw new Error(`--seed-rule ${file}: ${joinCodes(fixed)} run ${ARM_TABLE[fixed[0]].seeds} seeds and never raise (prereg item 1)`);
  const missing = ruled.filter((a) => !Object.hasOwn(seeds, a));
  if (missing.length) throw new Error(`--seed-rule ${file}: seeds lacks ${joinCodes(missing)}, which the rule sizes`);
  for (const [arm, n] of Object.entries(seeds)) checkCount(file, arm, n);
  if (new Set(ruled.map((a) => seeds[a])).size > 1) throw new Error(`--seed-rule ${file}: ${joinCodes(ruled)} run the largest count (prereg item 10), so seeds gives them one count, not ${ruled.map((a) => `${a} ${seeds[a]}`).join(', ')}`);
  for (const arm of design.arms) {
    const want = ARM_TABLE[arm].seedRule ? seeds[arm] : ARM_TABLE[arm].seeds;
    if (countsByArm?.[arm] !== want) throw new Error(`--seed-rule ${file}: countsByArm.${arm} is ${JSON.stringify(countsByArm?.[arm])}, not the ${want} that ${ARM_TABLE[arm].seedRule ? 'seeds' : 'the arm table'} gives`);
  }
}

/** The `--seed-rule` file's seed counts for `arms`, refused unless the rule ran to a result (Amendment 2 item 5); `sha256` ties the wave to that file.
 * Round 3 reads a /1 rule's `seeds`; round 4 a /2 rule's, with the fixed arms at their table count. `maxSeed` caps every count.
 * @param {string} file
 * @param {string[]} arms
 * @param {any} [design]
 * @param {number | null} [maxSeed] */
function readSeedRule(file, arms, design = DESIGNS.r3, maxSeed = null) {
  const bytes = fs.readFileSync(file);
  let rule;
  try {
    rule = JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    throw new Error(`--seed-rule ${file} is not JSON: ${err.message}`);
  }
  const schema = SEED_RULE_SCHEMAS.get(design);
  if (rule?.schema !== schema) throw new Error(`--seed-rule ${file}: schema must be "${schema}"`);
  if (rule.stop !== false) throw new Error(`--seed-rule ${file}: the rule did not say go (stop is not false), so there is no wave 2`);
  const seeds = rule.seeds;
  if (seeds === null || seeds === undefined || seeds.constructor !== Object) throw new Error(`--seed-rule ${file}: seeds must be an object of seed counts by arm`);
  const r4 = design === DESIGNS.r4;
  if (r4) checkRuleR4(file, rule, design);
  const counts = {};
  for (const arm of arms) {
    const fixed = r4 && !ARM_TABLE[arm].seedRule;
    if (!fixed && !Object.hasOwn(seeds, arm)) throw new Error(`arm ${arm} is not listed in the seed rule's seeds (${Object.keys(seeds).join(', ')}); pass --arms with arms the rule lists`);
    if (!r4) checkCount(file, arm, seeds[arm]);
    const n = fixed ? ARM_TABLE[arm].seeds : seeds[arm];
    counts[arm] = maxSeed === null ? n : Math.min(n, maxSeed);
  }
  return { counts, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/** The expected cells, written before any session so the analysis can tell a run cut off in lockstep; kind, familyId and set match the records. */
function writePlan(outDir, steps) {
  fs.mkdirSync(outDir, { recursive: true });
  const cells = steps.map((st) => ({
    seed: st.seed, position: st.position, arm: st.arm, sequence: st.sequence.id, taskId: st.taskId, repo: st.sequence.repo,
    kind: st.role.kind, familyId: st.role.familyId, set: st.role.set,
  }));
  fs.writeFileSync(path.join(outDir, 'plan.json'), `${JSON.stringify(cells, null, 2)}\n`);
}

/** The checks main runs before a run can be abandoned: the out dir's ancestors, the lesson key phrases, then (real runs) the task repos. */
export function preflight(spec, out, mode, stopAt, { screen = false } = {}) {
  // The free check first, so a refused --out never gets a clone.
  assertNoAncestorInstructions(out, { stopAt });
  assertNoPhraseLeaks(spec);
  if (mode === 'real') cacheTaskRepos(spec, path.join(out, 'repo-cache'), { screen });
}

/** What a real run with an X arm needs before any session: a model to record, and hook trust when X2 runs (prereg 91, E6 test 23).
 * @param {string[]} arms
 * @param {string} mode
 * @param {{codexModel?: string | null, codexHookTrust?: string}} [options] */
export function codexPreflight(arms, mode, { codexModel = null, codexHookTrust = 'none' } = {}) {
  if (mode !== 'real' || !arms.some((a) => armSet(a) === 'X')) return;
  if (!codexModel) throw new Error('an X arm runs Codex: pass --codex-model, so every record names the model it ran');
  // An untrusted X2 runs hippo's hooks never, so its cells would test only the wrapper and must not reach the data.
  if (arms.some((a) => CODEX_HIPPO_ARMS.has(a)) && parseHookTrust(codexHookTrust).kind === 'none') throw new Error('X2 with --codex-hook-trust none: Codex would never run hippo\'s hooks. Pass the trust from the smoke report (flag, or file:<path>)');
}

/** Run the whole plan in lockstep. Returns the records written; `progress.last` names the last completed step. */
export async function runAll(opts) {
  const { spec, arms, seeds = null, waveTwo = null, onlySeed = null, maxPosition = Infinity, outDir } = opts;
  const ctx = await openContext(opts);
  let records;
  try {
    const steps = planFor(spec, arms, seeds, waveTwo, onlySeed, maxPosition);
    writePlan(outDir, steps);
    records = await runSteps(ctx, steps);
  } catch (err) {
    // The run's own error stands; the sweep's hits or failure are added to it, never put in its place (E6 plan R24).
    try {
      const hits = finishCodex(ctx);
      if (hits.length) err.message += `; the final sweep also found login tokens in, or could not check, ${hits.join(', ')} (files listed without a note are deleted)`;
    } catch (sweepErr) {
      err.message += `; the final sweep also failed: ${sweepErr.message}`;
    }
    throw err;
  }
  const hits = finishCodex(ctx);
  if (hits.length) throw new Error(`the final sweep found a Codex login token in, or could not check, ${hits.join(', ')}; files listed without a note are deleted, and the run is void`);
  return records;
}

/** Per sequence and seed, the drawn order; per sequence, the tasksSinceTeach spread, so a bunched draw shows before any session. */
function orderReport(steps) {
  const lines = [];
  const spread = new Map();
  const seen = new Set();
  for (const st of steps) {
    const key = `${st.sequence.id}|${st.seed}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const cells = steps.filter((x) => x.arm === st.arm && x.seed === st.seed && x.sequence === st.sequence).sort((a, b) => a.position - b.position);
    lines.push(`order ${st.sequence.id} seed${st.seed}: ${cells.map((x) => x.taskId).join(' ')}`);
    const gaps = cells.filter((x) => x.role.kind === 'apply').map((x) => x.role.tasksSinceTeach);
    spread.set(st.sequence.id, [...(spread.get(st.sequence.id) ?? []), ...gaps]);
  }
  for (const [id, gaps] of spread) {
    if (!gaps.length) continue;
    const g = gaps.sort((a, b) => a - b);
    const mid = g.length % 2 ? g[(g.length - 1) / 2] : (g[g.length / 2 - 1] + g[g.length / 2]) / 2;
    lines.push(`${id} tasksSinceTeach over ${g.length} applies: min ${g[0]}, median ${mid}, max ${g[g.length - 1]}`);
  }
  return lines;
}

const USAGE = 'Usage: node scripts/token-eval/ab-run.mjs --tasks tasks.json --out DIR [--design r3|r4] [--model MODEL, round 3 only] [--arms ' + ARMS.join(',') + ' (round 4: ' + DESIGNS.r4.arms.join(',') + ')] [--seeds N | --seed-rule FILE [--max-seed N]] [--pass-env NAME]... [--max-budget-usd N] [--session-timeout-min N] [--canaries FILE] [--pins FILE] [--screen] [--dry-run | --check-homes]\n  round 4 only: [--effort low|medium|high] [--max-position N] [--venv --poetry DIR --pip-constraint FILE] (a real run needs --pins and --effort); for tests: --fake-agent KNOBS_FILE\n  set X: --codex-model M [--codex-bin PATH] [--codex-auth auth.json] [--codex-hook-trust none|flag|file:PATH] [--codex-memory-wait none|poll:STABLE_MS:TIMEOUT_MS] [--codex-memories on|off] [--codex-wrapper-wait-ms N]';
const CODEX_FLAGS = { codexBin: '--codex-bin', codexModel: '--codex-model', codexAuth: '--codex-auth', codexHookTrust: '--codex-hook-trust', codexMemoryWait: '--codex-memory-wait', codexMemories: '--codex-memories', codexWrapperWaitMs: '--codex-wrapper-wait-ms' };

/** The arms a run uses: the named ones, else every arm the tasks file has a sequence for; a screen's are always A0 and A4 (prereg 68), so an X arm named with it is refused.
 * Round 4 puts them in the design's order, so a rerun rotates as its first run did (planRuns rotates by position + seed). */
export function chooseArms(spec, named, screen, design = DESIGNS.r3) {
  const known = design.arms;
  for (const a of named ?? []) if (!known.includes(a)) throw new Error(`unknown arm ${a}; known: ${known.join(', ')}`);
  if (named && new Set(named).size !== named.length) throw new Error(`--arms names an arm twice (${named.join(',')}); each arm runs once`);
  if (screen) {
    const x = (named ?? []).filter((a) => armSet(a) === 'X');
    if (x.length) throw new Error(`--screen runs A0 and A4 only, so --arms cannot name ${x.join(', ')}`);
    return [...SCREEN_ARMS];
  }
  const chosen = named ?? known.filter((a) => spec.sequences.some((s) => pairs(a, s)));
  return design === DESIGNS.r3 ? chosen : known.filter((a) => chosen.includes(a));
}

// The designs a run can take; r4-on-r3 only reads round 3's data.
const RUN_DESIGNS = ['r3', 'r4'];
const effortList = `${EFFORTS.slice(0, -1).join(', ')} or ${EFFORTS.at(-1)}`;

/** The design, and the flags that belong to one design: round 4 takes the arm table's models and a real run needs --pins and --effort; round 3 refuses --effort and --max-position. */
function designOptions(argv, given, mode, screen) {
  const name = given('--design') ?? RUN_DESIGNS[0];
  if (!RUN_DESIGNS.includes(name)) throw new Error(`--design must be ${RUN_DESIGNS.join(' or ')}, got ${name}`);
  const design = DESIGNS[name];
  const [effort, maxPosition] = [given('--effort'), given('--max-position')];
  if (design === DESIGNS.r3) {
    for (const [flag, value] of [['--effort', effort], ['--max-position', maxPosition]]) if (value !== null) throw new Error(`${flag} is round 4 only (pass --design r4)`);
    return { design, effort: undefined, maxPosition: Infinity };
  }
  if (argv.includes('--model')) throw new Error('the arm table names each arm\'s model (prereg item 5); drop --model');
  if (screen) throw new Error('--screen is round 3 only');
  if (effort !== null && !EFFORTS.includes(effort)) throw new Error(`--effort must be ${effortList}, got ${effort}`);
  if (maxPosition !== null && !/^[1-9]\d*$/.test(maxPosition)) throw new Error(`--max-position must be a positive integer, got ${maxPosition}`);
  if (mode === 'real' && !given('--pins')) throw new Error('a round 4 run needs --pins, so every chunk runs the same build and effort');
  if (mode === 'real' && effort === null) throw new Error(`a round 4 run needs --effort ${effortList}`);
  return { design, effort: effort ?? undefined, maxPosition: maxPosition === null ? Infinity : Number(maxPosition) };
}

/** --venv with --poetry and --pip-constraint (round 4 only): the poetry folder and the pip pin every task's venv is built from, as absolute paths; null without --venv. */
function venvOptions(argv, given, design) {
  const flags = ['--venv', '--poetry', '--pip-constraint'];
  if (design === DESIGNS.r3) {
    const named = flags.find((f) => argv.includes(f));
    if (named !== undefined) throw new Error(`${named} is round 4 only (pass --design r4)`);
    return null;
  }
  const [poetry, constraint] = [given('--poetry'), given('--pip-constraint')];
  if (!argv.includes('--venv')) {
    if (poetry !== null || constraint !== null) throw new Error('--poetry and --pip-constraint go with --venv');
    return null;
  }
  if (!poetry || !constraint) throw new Error('--venv needs --poetry <dir> and --pip-constraint <file>');
  if (!fs.statSync(poetry, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`--poetry ${poetry} is not a folder`);
  if (!fs.statSync(constraint, { throwIfNoEntry: false })?.isFile()) throw new Error(`--pip-constraint ${constraint} is not a file`);
  return { poetryDir: path.resolve(poetry), pipConstraint: path.resolve(constraint) };
}

/** The command that runs the fake agent for --fake-agent, or null. It stands in for Claude Code, so --claude-bin beside it and a real login are refused before anything is cloned. */
function fakeAgentCommand(argv, given, mode) {
  const knobs = given('--fake-agent');
  if (knobs === null) return null;
  if (argv.includes('--claude-bin')) throw new Error('--fake-agent runs the fake itself; drop --claude-bin');
  for (const name of ['--token-schedule', '--token-var']) if (argv.includes(name)) throw new Error(`--fake-agent runs on its one fake token, so ${name} would put a real login in the calls log; drop ${name}`);
  if (!fs.existsSync(knobs)) throw new Error(`--fake-agent ${knobs}: the knobs file does not exist`);
  if (mode === 'real' && !String(process.env[TOKEN_KEY] ?? '').startsWith('fake-tok-')) throw new Error(`${TOKEN_KEY} must start fake-tok-, so a fake run cannot use a real login`);
  return `"${process.execPath}" "${path.join(REPO, 'tests', 'fixtures', 'fake-claude.mjs')}" --fake-knobs "${path.resolve(knobs)}"`;
}

/** Throws when --only-seed n cannot run `arms`: round 3 reads the prereg counts; round 4 reads the arm table for seeds 1 to 3 and the seed rule's capped counts for 4 to 9. */
function checkOnlySeed(n, arms, rule, ruleFile, design) {
  if (design !== DESIGNS.r4 || n <= WAVE_1_SEEDS) {
    if (ruleFile !== null) throw new Error(`--only-seed ${n} reads the arm table; --seed-rule is for seeds ${WAVE_2_FIRST_SEED} to ${SEED_CAP}`);
    const over = arms.filter((a) => n > ARM_SEEDS[a]);
    if (over.length) throw new Error(`--only-seed ${n} is past the prereg seed count of ${over.join(', ')}`);
    return;
  }
  if (rule === null) throw new Error(`--only-seed ${n} needs --seed-rule: seeds ${WAVE_2_FIRST_SEED} to ${SEED_CAP} run only as a raise`);
  const short = arms.filter((a) => rule.counts[a] < n);
  if (short.length) throw new Error(`--only-seed ${n} is past the seed rule's count of ${short.join(', ')}`);
}

/** The seed flags, checked: --seed-rule with --max-seed, --seeds and --only-seed; `arms` are the chosen ones that still have sessions to run. */
function seedOptions(argv, flag, given, chosen, design, screen) {
  const ruleFile = flag('--seed-rule', null);
  if (argv.includes('--seed-rule') && ruleFile === null) throw new Error('--seed-rule needs the seed rule\'s output file');
  if (ruleFile !== null && (argv.includes('--seeds') || screen)) throw new Error('--seed-rule sets the seeds itself, so it cannot be combined with --seeds or --screen');
  const maxSeedArg = given('--max-seed');
  if (maxSeedArg !== null && !/^[1-9]\d*$/.test(maxSeedArg)) throw new Error(`--max-seed must be a positive integer, got ${maxSeedArg}`);
  if (maxSeedArg !== null && ruleFile === null) throw new Error('--max-seed caps a seed rule\'s counts; pass --seed-rule');
  const rule = ruleFile === null ? null : readSeedRule(ruleFile, chosen, design, maxSeedArg === null ? null : Number(maxSeedArg));
  // An arm at 3 seeds has finished in wave 1 and runs nothing now.
  const arms = rule === null ? chosen : chosen.filter((a) => rule.counts[a] > WAVE_1_SEEDS);
  const seedsArg = given('--seeds');
  if (seedsArg !== null && !/^[1-9]\d*$/.test(seedsArg)) throw new Error(`--seeds must be a positive integer, got ${seedsArg}`);
  // Amendment 8 reruns one sequence-seed; planRuns keys rotation and order on the real seed, so seed N alone plans N's cells of a 1..N plan.
  const onlyArg = given('--only-seed');
  if (onlyArg !== null && !/^[1-9]\d*$/.test(onlyArg)) throw new Error(`--only-seed must be a positive integer, got ${onlyArg}`);
  if (onlyArg !== null && (seedsArg !== null || screen || (design === DESIGNS.r3 && ruleFile !== null))) throw new Error('--only-seed cannot be combined with --seeds, --seed-rule or --screen');
  const onlySeed = onlyArg === null ? null : Number(onlyArg);
  if (onlySeed !== null) checkOnlySeed(onlySeed, chosen, rule, ruleFile, design);
  return { rule, arms, onlySeed, seeds: seedsArg === null ? null : Number(seedsArg) };
}

/** The --pins file's pins: a plain object, since refuseOffPins skips every check for a falsy value and a list or number has no keys to compare. */
function readPins(file) {
  const pins = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (pins === null || pins.constructor !== Object) throw new Error(`--pins ${file} must hold a JSON object of pinned values`);
  return pins;
}

/** The command line, checked: the tasks file, out dir, design, arms, seeds, pass-env names and mode. */
export function parseArgs(argv) {
  const flag = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
  };
  // A flag present with no value reads as '', so its check names it instead of skipping it.
  const given = (name) => (argv.includes(name) ? flag(name, '') : null);
  const tasksFile = flag('--tasks', null);
  const outDir = flag('--out', null);
  if (!tasksFile || !outDir) {
    console.error(USAGE);
    process.exit(1);
  }
  const spec = validateTasks(JSON.parse(fs.readFileSync(tasksFile, 'utf8')), path.dirname(path.resolve(tasksFile)));
  const mode = argv.includes('--dry-run') ? 'dry' : (argv.includes('--check-homes') ? 'check' : 'real');
  const named = given('--arms');
  if (named === '') throw new Error('--arms needs a comma-separated list of arm codes');
  const screen = argv.includes('--screen');
  const { design, effort, maxPosition } = designOptions(argv, given, mode, screen);
  const fakeCommand = fakeAgentCommand(argv, given, mode);
  const venv = venvOptions(argv, given, design);
  const chosen = chooseArms(spec, named === null ? null : named.split(',').map((a) => a.trim()), screen, design);
  const { rule, arms, onlySeed, seeds } = seedOptions(argv, flag, given, chosen, design, screen);
  const timeoutArg = flag('--session-timeout-min', '60');
  if (!/^[1-9]\d*$/.test(timeoutArg)) throw new Error(`--session-timeout-min must be a positive integer, got ${timeoutArg}`);
  const canariesFile = flag('--canaries', null);
  const canaries = canariesFile ? fs.readFileSync(canariesFile, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  if (canariesFile && canaries.length === 0) throw new Error(`--canaries ${canariesFile} holds no canary; one per line`);
  const pinsFile = given('--pins');
  return {
    canaries, pins: pinsFile ? readPins(pinsFile) : null, warmup: !argv.includes('--no-warmup'), design, effort, maxPosition, fakeCommand, venv,
    flag, spec, arms, rule, onlySeed, seeds, sessionTimeoutMs: Number(timeoutArg) * 60_000, out: path.resolve(outDir), screen,
    passEnv: argv.flatMap((a, i) => (a === '--pass-env' && i + 1 < argv.length ? [argv[i + 1]] : [])), mode,
  };
}

/** Print the plan; a run's dry run also writes plan.json and the order report. */
function dryRun(args, steps) {
  if (args.screen) {
    for (const line of screenLines(args.spec, steps)) console.log(line);
    return;
  }
  writePlan(args.out, steps);
  for (const [i, r] of steps.entries()) console.log(`  ${i} seed${r.seed} pos${r.position} ${r.arm} ${r.sequence.id}/${r.taskId}`);
  for (const line of orderReport(steps)) console.log(line);
}

/** The fake agent's upstream: a stub on 127.0.0.1 that answers 200 and logs to <out>/stub.jsonl, so a fake run reaches no real API. */
function startFakeUpstream(out) {
  fs.mkdirSync(out, { recursive: true });
  return startStubUpstream(path.join(out, 'stub.jsonl'));
}

/** The options runAll and runScreen take, from the checked command line; main and its test both build them here, so a field main drops shows. */
export function runOptions(args, { progress, upstream, codexOpts }) {
  const { flag } = args;
  return {
    spec: args.spec, arms: args.arms, seeds: args.seeds, waveTwo: args.rule?.counts ?? null, onlySeed: args.onlySeed, tokenSchedule: flag('--token-schedule', null), tokenVar: flag('--token-var', null),
    outDir: args.out, passEnv: args.passEnv, progress, model: flag('--model', null), claudeBin: args.fakeCommand ?? flag('--claude-bin', 'claude'),
    design: args.design, effort: args.effort, maxPosition: args.maxPosition, upstream, venv: args.venv,
    maxBudgetUsd: flag('--max-budget-usd', null), settleMs: Number(flag('--settle-ms', '5000')), warmup: args.warmup,
    permissionMode: flag('--permission-mode', 'bypassPermissions'), sessionTimeoutMs: args.sessionTimeoutMs, canaries: args.canaries, pins: args.pins, ...codexOpts,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const { flag, spec, arms, rule, seeds, out, mode, passEnv } = args;
  const waveTwo = rule?.counts ?? null;
  if (rule && arms.length === 0) {
    console.log('wave 2 has no sessions');
    return;
  }
  const steps = args.screen ? planScreen(spec) : planFor(spec, arms, seeds, waveTwo, args.onlySeed, args.maxPosition);
  const records = path.join(out, args.screen ? 'screen.jsonl' : 'runs.jsonl');
  // A run appends to its records file and both modes rewrite plan.json, so an earlier run's records would end up unplanned.
  const rewrite = args.screen ? '' : ' and rewrite plan.json';
  if (mode !== 'check' && fs.existsSync(records)) throw new Error(`${out} already holds ${path.basename(records)} from an earlier run; this run would append to it${rewrite}. Pick a new --out.`);
  const stopAt = process.env.Z0_ANCESTOR_STOP || null;
  // The stop is for tests under a temp dir; a stray export must never disable a real run's check.
  // A dev file may skip screen tasks, so it can never feed a real run.
  if (mode === 'real' && spec.dev === true) throw new Error('the tasks file sets "dev": true; it is for --dry-run and --check-homes only, never a real run');
  if (mode === 'real' && stopAt) throw new Error('Z0_ANCESTOR_STOP is set; it is only honoured for --dry-run and --check-homes. Unset it for a real run.');
  if (mode === 'real' && !process.env[TOKEN_KEY]) throw new Error('run `claude setup-token` and export CLAUDE_CODE_OAUTH_TOKEN');
  const codexOpts = Object.fromEntries(Object.entries(CODEX_FLAGS).map(([k, name]) => [k, flag(name, undefined)]).filter(([, v]) => v !== undefined));
  codexPreflight(arms, mode, codexOpts);
  // Outside the try below: a task the runner refuses is not a run abandoned partway, so it must not leave ABANDONED.
  preflight(spec, out, mode, stopAt, { screen: args.screen });
  if (args.screen) console.log(`${steps.length} screen sessions: A0 and A4 only, seeds 1 and 2.`);
  else console.log(`${steps.length} steps (Claude Code sessions) in lockstep; seeds ${arms.map((a) => (args.onlySeed ? `${a}:only ${args.onlySeed}` : (waveTwo ? `${a}:${WAVE_2_FIRST_SEED}-${waveTwo[a]}` : `${a}:${seedCap(seeds)(a)}`))).join(' ')}.`);
  if (rule) console.log(`seed rule sha256 ${rule.sha256}`);
  if (mode === 'dry') return dryRun(args, steps);
  const dirName = (st) => st.runName ?? st.sequence.id;
  const runs = [...new Map(steps.map((st) => [`${dirName(st)}|${st.arm}|${st.seed}`, { seq: dirName(st), arm: st.arm, seed: st.seed }])).values()];
  checkHomes({ outDir: out, runs, passEnv, install: arms.some((a) => CODEX_HIPPO_ARMS.has(a)) ? checkInstaller(codexOpts.codexBin) : null });
  console.log(`Homes check passed for ${runs.length} runs.`);
  if (mode === 'check') return;
  const progress = { last: 'none' };
  const stub = args.fakeCommand ? await startFakeUpstream(out) : null;
  const opts = runOptions(args, { progress, upstream: stub?.url ?? null, codexOpts });
  try {
    if (args.screen) {
      const v = await runScreen(opts);
      console.log(`\nScreen: kept ${v.kept.join(', ') || 'none'}; dropped ${v.dropped.length}; undecided ${v.undecided.length}. Lists: ${path.join(out, 'screen.json')}`);
      return;
    }
    await runAll(opts);
  } catch (err) {
    // Under lockstep a mid-run throw leaves every run partial, so the out dir says so.
    fs.writeFileSync(path.join(out, 'ABANDONED'), `${err.message}\nlast completed: ${progress.last}\n`);
    throw err;
  } finally {
    await stub?.close();
    if (objectLockRetries.count) console.log(`Git scan-lock retries (antivirus holding a file git just wrote): ${objectLockRetries.count}.`);
  }
  // ab-analyze averages unequal seed counts unpaired, so Z0 records go to the Z0 analyzer, which pairs shared seeds.
  console.log(`\nRecords: ${path.join(out, 'runs.jsonl')}\nAnalyze with scripts/token-eval/z0-analyze.mjs (pairs shared seeds; it lands with PR #357), never ab-analyze.mjs.`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
