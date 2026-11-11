#!/usr/bin/env node
/** Round 4 prereg item 6: G1 reads every request log of every Claude Code attempt and writes an off-pin file naming the attempts off the pinned model or effort,
 * and the records holding an env name outside the allowlist. Exit 0 whatever it finds; --strict (the smoke) exits 3 on any of them. */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { ARM_TABLE, DESIGNS, allowlistOf, envAllowSet } from './arms.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { Stop, linesOf, parseFlags, parseOrNull, readJson, runCommand, runMain } from './free-cli.mjs';
import { sha256 } from './z0-blind.mjs';
import { OFFPIN_SCHEMA, isString, parsePlan } from './z0-records.mjs';

const USAGE = 'usage: g1-pins.mjs --run OUT [--run OUT ...] --pins FILE --plan-of OUT --out FILE [--strict]';
const SPEC = { values: ['--pins', '--plan-of', '--out'], lists: ['--run'], switches: ['--strict'], required: ['--run', '--pins', '--plan-of', '--out'] };
// The two endpoints that may carry a body in a round 3 log; any other body is a request the pins never covered.
const ENDPOINTS = new Set(['/v1/messages', '/v1/messages/count_tokens']);
const LOG_NAME = /^(.+)\.(?:session|resume)\d+\.requests\.jsonl$/;
const pathOf = (url) => String(url ?? '').split('?')[0];
const hasBody = (e) => e !== null && isString(e.body) && e.body !== '';
// A messages POST with no body hides its model and effort, so it reads as a body that does not parse.
const postsMessages = (e) => e !== null && e.method === 'POST' && pathOf(e.url) === '/v1/messages';
const isObject = (v) => v !== null && v.constructor === Object;

/** The reason a request log is off the pins, null when it is on them; the first failing rule over the whole log, in the plan's order.
 * @param {string | null} logText null when the file is missing @param {{model: string, effort: string}} pins */
export function logVerdict(logText, { model, effort }) {
  if (logText === null) return 'no log';
  const entries = linesOf(logText).map(parseOrNull);
  if (!entries.some(postsMessages)) return 'no /v1/messages POST';
  const bodies = entries.filter((e) => e === null || hasBody(e) || postsMessages(e)).map((e) => (hasBody(e) ? { path: pathOf(e.url), json: parseOrNull(e.body) } : null));
  if (bodies.some((b) => b === null || !isObject(b.json))) return 'body does not parse';
  const stray = bodies.find((b) => !ENDPOINTS.has(b.path));
  if (stray !== undefined) return `unknown endpoint ${stray.path}`;
  const offModel = bodies.find((b) => b.json.model !== model);
  if (offModel !== undefined) return `model ${offModel.json.model ?? 'none'}, pinned ${model}`;
  const offEffort = bodies.find((b) => b.path === '/v1/messages' && b.json.output_config?.effort !== effort);
  return offEffort === undefined ? null : `effort ${offEffort.json.output_config?.effort ?? 'none'}, pinned ${effort}`;
}

const dirsOf = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : []);
const byCell = (a, b) => a.sequence.localeCompare(b.sequence) || a.seed - b.seed || a.position - b.position || a.arm.localeCompare(b.arm);
const lineAt = (file, text, i) => {
  const value = parseOrNull(text);
  if (value === null) throw new Error(`${file} line ${i + 1}: not JSON`);
  return value;
};
const jsonLines = (file) => linesOf(fs.readFileSync(file, 'utf8')).map((l, i) => lineAt(file, l, i));

/** The pinned model of an arm from the pins file, by the arm's row. */
function pinsOf(pins, pinsFile, arm) {
  const key = ARM_TABLE[arm].pinKey;
  if (!isString(pins[key]) || pins[key] === '') throw new Error(`${pinsFile}: ${key} is missing, and arm ${arm} is pinned by it\n${USAGE}`);
  return { model: pins[key], effort: pins.effort };
}

const attemptsOf = (dir) => (fs.existsSync(path.join(dir, 'attempts.jsonl')) ? jsonLines(path.join(dir, 'attempts.jsonl')) : []);

/** One seed folder's attempts and unnamed logs, each read against its arm's pin. A log no attempt names is read too, with a null sessionId; an attempt naming no log has none. */
function seedVoids(dir, { sequence, arm, seed }, pins, positionOf) {
  const named = attemptsOf(dir).map((a) => ({ taskId: a.taskId, sessionId: a.sessionId ?? null, name: isString(a.logFile) && a.logFile !== '' ? a.logFile.split(/[\\/]/).pop() : null }));
  const known = new Set(named.map((n) => n.name));
  const stray = fs.readdirSync(dir).filter((f) => LOG_NAME.test(f) && !known.has(f)).sort().map((name) => ({ taskId: LOG_NAME.exec(name)[1], sessionId: null, name }));
  const voids = [];
  for (const { taskId, sessionId, name } of [...named, ...stray]) {
    const file = name === null ? null : path.join(dir, name);
    // A task the plan does not hold stops the read even when its log passes, so a folder and its plan cannot drift apart unseen.
    const position = positionOf.get(`${sequence}#${seed}#${arm}#${taskId}`);
    if (position === undefined) throw new Error(`${file ?? path.join(dir, 'attempts.jsonl')}: task ${taskId} is not in the plan of ${sequence} seed ${seed} arm ${arm}`);
    const reason = logVerdict(file !== null && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null, pins);
    if (reason !== null) voids.push({ sequence, seed, arm, position, sessionId, reason });
  }
  return voids;
}

/** Every Claude Code attempt's void under `<out>/raw/<sequence>/<arm>/seed<n>/`; a run folder with no raw folder read nothing, so it stops. */
function runVoids(out, pins, pinsFile, positionOf) {
  if (!fs.existsSync(path.join(out, 'raw'))) throw new Error(`${path.join(out, 'raw')}: the run folder has no raw folder, so no request log was read\n${USAGE}`);
  const voids = [];
  for (const sequence of dirsOf(path.join(out, 'raw'))) {
    for (const arm of dirsOf(path.join(out, 'raw', sequence))) {
      if (!Object.hasOwn(ARM_TABLE, arm)) throw new Error(`${path.join(out, 'raw', sequence, arm)}: unknown arm ${arm}`);
      if (ARM_TABLE[arm].tool !== 'claude-code') continue;
      const armPins = pinsOf(pins, pinsFile, arm);
      for (const folder of dirsOf(path.join(out, 'raw', sequence, arm)).filter((d) => /^seed\d+$/.test(d))) {
        voids.push(...seedVoids(path.join(out, 'raw', sequence, arm, folder), { sequence, arm, seed: Number(folder.slice(4)) }, armPins, positionOf));
      }
    }
  }
  return voids;
}

/** A void for each Claude Code record that ran a session (it has a `sessionId`) and whose seed folder names no session attempt for its task: no request log to read.
 * A record with no session and an `invalid` reason (setup, leak, ancestor-instructions) is skipped, since its own `invalid` removes it; with neither, the runner did not write it. */
function unloggedVoids(out, records, runsFile) {
  const attempts = new Map();
  const voids = [];
  records.forEach((r, i) => {
    if (!Object.hasOwn(ARM_TABLE, r.arm)) throw new Error(`${runsFile} line ${i + 1}: unknown arm ${r.arm}`);
    if (ARM_TABLE[r.arm].tool !== 'claude-code') return;
    if ((r.sessionId ?? null) === null) {
      if ((r.invalid ?? null) === null) throw new Error(`${runsFile} line ${i + 1}: a ${r.arm} record has no sessionId and no invalid reason`);
      return;
    }
    const dir = path.join(out, 'raw', r.sequence, r.arm, `seed${r.seed}`);
    if (!attempts.has(dir)) attempts.set(dir, attemptsOf(dir));
    if (!attempts.get(dir).some((a) => a.taskId === r.taskId && a.kind === 'session')) voids.push({ sequence: r.sequence, seed: r.seed, arm: r.arm, position: r.position, sessionId: r.sessionId, reason: 'no log' });
  });
  return voids;
}

/** Records whose `envKeys` hold a name outside the round 4 allowlist, with the uppercase sorted names. */
function envOutside(records, allowed) {
  const hits = [];
  for (const r of records) {
    const names = [...new Set((Array.isArray(r.envKeys) ? r.envKeys : []).map((k) => String(k).toUpperCase()))].filter((n) => !allowed.has(n)).sort();
    if (names.length > 0) hits.push({ sequence: r.sequence, seed: r.seed, arm: r.arm, position: r.position, names });
  }
  return hits;
}

/** @param {string[]} argv @param {string} [cwd] */
export function runCli(argv, cwd = process.cwd()) {
  return runCommand(() => {
    const args = parseFlags(argv, SPEC, USAGE);
    const pinsFile = path.resolve(cwd, args.pins);
    const pins = readJson(pinsFile);
    if (!isString(pins.effort) || pins.effort === '') throw new Error(`${pinsFile}: effort is missing\n${USAGE}`);
    const planFile = path.join(path.resolve(cwd, args.planOf), 'plan.json');
    const hashed = (file) => ({ file, sha256: sha256(file) });
    const positionOf = new Map(parsePlan(fs.readFileSync(planFile, 'utf8'), planFile).filter((c) => c.taskId !== undefined).map((c) => [`${c.sequence}#${c.seed}#${c.arm}#${c.taskId}`, c.position]));
    const allowed = envAllowSet(allowlistOf(DESIGNS.r4));
    const runs = [];
    const voids = [];
    const outside = [];
    for (const run of args.run) {
      const out = path.resolve(cwd, run);
      const runsFile = path.join(out, 'runs.jsonl');
      runs.push({ dir: out, file: 'runs.jsonl', sha256: sha256(runsFile) });
      const records = jsonLines(runsFile);
      voids.push(...runVoids(out, pins, pinsFile, positionOf), ...unloggedVoids(out, records, runsFile));
      outside.push(...envOutside(records, allowed));
    }
    voids.sort(byCell);
    outside.sort(byCell);
    writeFileAtomic(path.resolve(cwd, args.out), `${JSON.stringify({ schema: OFFPIN_SCHEMA, runs, pins: hashed(pinsFile), planOf: hashed(planFile), voids, envOutside: outside }, null, 2)}\n`);
    const text = `off-pin ${voids.length}\nenv-outside ${outside.length}\n`;
    if (args.strict && (voids.length > 0 || outside.length > 0)) throw new Stop(`SMOKE FAIL: ${voids.length} off-pin, ${outside.length} env-outside`, text);
    return text;
  });
}

runMain(import.meta.url, runCli);
