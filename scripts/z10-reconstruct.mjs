#!/usr/bin/env node
// Names which delivery class one lesson reached in one session, from the ledger, the host transcript and a label file; read-only, not shipped.
//   node scripts/z10-reconstruct.mjs --store <dir> --session <id> (--memory <id> | --key <text>) [--transcript <file>] [--labels <file>] [--tenant <t>] [--global <dir>|--no-global]
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isText, parseTranscript, pairTurns } from './z10/transcript.mjs';

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
// Windows dynamic import() needs a file:// URL, not a raw drive path.
const { blockHash } = await import(pathToFileURL(path.join(DIST, 'util', 'token-text.js')).href);
const { realpathOrResolve } = await import(pathToFileURL(path.join(DIST, 'util', 'real-path.js')).href);
const { resolveGlobalRootDir } =await import(pathToFileURL(path.join(DIST, 'core', 'project-identity.js')).href);

const RANK = { 'not-written': 0, 'not-retrieved': 1, rejected: 2, 'delivery-unconfirmed': 3, 'application-unknown': 4 };
const ROW_CAP = 16;
const APPLICATIONS = ['observed', 'judged', 'unknown'];
const SIGNALS = ['resolved-check', 'failed-check', 'explicit-correction', 'revert', 'repeated-error', 'unknown'];
const WRONG = ['failed-check', 'explicit-correction', 'revert', 'repeated-error'];
const USAGE = 'usage: z10-reconstruct.mjs --store <dir> --session <id> (--memory <id> | --key <text>) [--transcript <file>] [--labels <file>] [--tenant <t>] [--global <dir>|--no-global]';

class UsageError extends Error {}

const openDb = (root) => {
  const file = path.join(root, 'hippo.db');
  return fs.existsSync(file) ? new DatabaseSync(file, { readOnly: true }) : null;
};
const hasTable = (db, name) => db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

function findMemories(stores, tenant, opts) {
  const found = [];
  for (const { db, name } of stores) {
    const rows = opts.memory !== undefined
      ? db.prepare('SELECT id, created FROM memories WHERE tenant_id = ? AND id = ?').all(tenant, opts.memory)
      : db.prepare('SELECT id, created FROM memories WHERE tenant_id = ? AND instr(content, ?) > 0').all(tenant, opts.key);
    for (const r of rows) found.push({ id: r.id, created: r.created, store: name });
  }
  return found;
}

function loadSession(db, tenant, session, storeHash, notes) {
  const all = db.prepare('SELECT * FROM delivery_events WHERE tenant_id = ? AND session_id = ? ORDER BY id').all(tenant, session);
  const rows = [];
  for (const r of all) {
    if (r.store_hash !== storeHash) notes.push(`foreign-store:${r.id}`);
    else rows.push(r);
  }
  return rows;
}

function splitRows(rows, targetCands, notes) {
  const mains = [];
  const dups = new Map();
  const compactIds = [];
  for (const r of rows) {
    if (r.session_state === 'subagent') {
      notes.push(`subagent:${r.id}`, `subagent-outcome:${r.id}:${targetCands.get(r.id)?.outcome ?? 'none'}`);
    } else if (r.event_type === 'session-end') {
      notes.push(`session-end:${r.id}`);
    } else if (r.event_type === 'pre-compact' || r.event_type === 'compact-resume') {
      compactIds.push(r.id);
      notes.push(`${r.event_type}:${r.id}`);
    } else if (r.duplicate_of !== null) {
      dups.set(r.duplicate_of, [...(dups.get(r.duplicate_of) ?? []), r]);
    } else if (r.turn_seq !== null || r.event_type !== 'prompt-submit') {
      mains.push(r);
    } else {
      notes.push(`unnumbered:${r.id}`);
    }
  }
  // Only a main row owns a group, so a duplicate of any other row is dropped and noted.
  const mainIds = new Set(mains.map((r) => r.id));
  for (const [original, list] of dups) {
    if (!mainIds.has(original)) for (const r of list) notes.push(`orphan-duplicate:${r.id}`);
  }
  return { mains, dups, compactIds };
}

function makeGroups(mains, dups, targetCands) {
  return mains.map((row) => {
    const members = [row, ...(dups.get(row.id) ?? [])];
    const emitters = members.filter((r) => targetCands.get(r.id)?.outcome === 'emitted');
    const cand = emitters.length > 0 ? targetCands.get(emitters[0].id) : targetCands.get(row.id) ?? null;
    return { row, members, emitters, cand, surface: row.event_type !== 'prompt-submit' };
  });
}

const proven = (reached, why, delivery = 'n/a') => ({ stage_reached: reached, range: null, why, delivery });
const unconfirmed = (why) => proven('delivery-unconfirmed', why, 'unconfirmed');
const ranged = (lo, hi, why) => ({ stage_reached: null, range: [lo, hi], why, delivery: 'n/a' });

function emittedDelivery(g, env) {
  if (!env.parsed) return unconfirmed('no-transcript');
  const pair = env.pairs.get(g.row.id);
  if (!pair) return unconfirmed('no-paired-prompt');
  const sent = new Set(g.emitters.map((r) => r.emitted_hash).filter((h) => h !== null));
  const seen = env.parsed.candidates[pair.cand].attachments.map((a) => blockHash(a));
  return seen.some((h) => sent.has(h)) ? proven('application-unknown', null, 'confirmed') : unconfirmed('no-attachment');
}

// Positions bounding where a turn's prompt can sit: its own pairing, else the nearest pairings either side.
function span(env, gi) {
  const posOf = (i) => {
    const pair = env.pairs.get(env.prompts[i].row.id);
    return pair ? env.parsed.candidates[pair.cand].pos : null;
  };
  const own = posOf(gi);
  if (own !== null) return [own, own];
  let lo = -Infinity;
  let hi = Infinity;
  for (let i = gi - 1; i >= 0 && lo === -Infinity; i--) lo = posOf(i) ?? -Infinity;
  for (let i = gi + 1; i < env.prompts.length && hi === Infinity; i++) hi = posOf(i) ?? Infinity;
  return [lo, hi];
}

function compactedBetween(env, j, k) {
  if (env.compactIds.some((id) => id > env.prompts[j].row.id && id < env.prompts[k].row.id)) return true;
  if (!env.parsed) return false;
  const lo = span(env, j)[0];
  const hi = span(env, k)[1];
  return env.parsed.compactions.some((c) => c.pos > lo && c.pos < hi);
}

function reusedDelivery(env, gi) {
  const k = env.prompts[gi];
  let j = -1;
  for (let i = gi - 1; i >= 0 && j < 0; i--) {
    const c = env.prompts[i];
    if (k.row.static_hash !== null && c.emitters.some((e) => e.block_state === 'sent' && e.static_hash === k.row.static_hash)) j = i;
  }
  if (j < 0) return unconfirmed('no-original');
  if (compactedBetween(env, j, gi)) return unconfirmed('compacted-since-send');
  return { ...env.done.get(env.prompts[j].row.id), via_event_id: env.prompts[j].row.id };
}

function absentReason(env, ts) {
  if (env.memory) return env.memory.created <= ts ? null : 'written-after';
  return env.hasCandidates ? null : 'no-row';
}

function judge(env, g, gi) {
  const { row, cand } = g;
  if (row.block_state === 'disabled') {
    return absentReason(env, row.ts) === 'written-after' ? proven('not-written', 'written-after') : proven('rejected', 'block-disabled');
  }
  if (cand?.outcome === 'rejected') return proven('rejected', cand.reason);
  if (cand && g.surface) return unconfirmed('surface-unjoined');
  if (cand?.outcome === 'emitted') return emittedDelivery(g, env);
  if (cand?.outcome === 'reused') return reusedDelivery(env, gi);
  const absent = absentReason(env, row.ts);
  if (absent) return proven('not-written', absent);
  if (g.surface) return ranged('not-retrieved', 'rejected', 'context-surface');
  if (row.rejected_unlisted === 0) return proven('not-retrieved', 'not-loaded');
  return ranged('not-retrieved', 'rejected', row.rejected_count - row.rejected_unlisted < ROW_CAP ? 'undecided' : 'unlisted');
}

function turnOf(env, g, gi) {
  const { row, cand } = g;
  const verdict = g.surface ? judge(env, g, -1) : judge(env, g, gi);
  if (!g.surface) env.done.set(row.id, verdict);
  return {
    event_id: row.id, turn_seq: row.turn_seq, event_type: row.event_type, block_state: row.block_state,
    outcome: cand?.outcome ?? null, stage: cand?.stage ?? null, cand_reason: cand?.reason ?? null, pool: cand?.pool ?? null,
    source_store: cand?.source_store ?? null, via_event_id: null, paired_by: env.pairs.get(row.id)?.by ?? null,
    duplicates: g.members.slice(1).map((r) => r.id), ...verdict,
  };
}

function gapTurn(gap, notes) {
  notes.push(`gap:${gap.ordinal}`);
  return {
    event_id: null, turn_seq: null, event_type: null, block_state: null, outcome: null, stage: null, cand_reason: null, pool: null,
    source_store: null, via_event_id: null, paired_by: null, duplicates: [], ...ranged('not-retrieved', 'application-unknown', 'no-event-row'),
  };
}

function checkLabel(l) {
  if (!APPLICATIONS.includes(l.application)) return 'application';
  if (!SIGNALS.includes(l.signal)) return 'signal';
  if (l.application !== 'unknown' && !(isText(l.evidence) && l.evidence.trim() !== '')) return 'evidence';
  return null;
}

function pickLabel(labels, session, memoryIds, notes) {
  const valid = [];
  for (const l of labels ?? []) {
    if (!(l instanceof Object) || l.session_id !== session || !memoryIds.includes(l.memory_id)) continue;
    const bad = checkLabel(l);
    if (bad) notes.push(`label-error:${bad}`);
    else valid.push(l);
  }
  if (valid.length > 1) {
    notes.push('label-error:duplicate');
    return null;
  }
  return valid[0] ?? null;
}

function labelClass(label) {
  if (label === null || label.application === 'unknown') return { class: 'application-unknown', reason: null };
  if (label.signal === 'resolved-check') return { class: 'applied-supported', reason: null };
  if (WRONG.includes(label.signal)) return { class: 'applied-but-wrong', reason: null };
  return { class: 'indeterminate', reason: 'outcome-unknown' };
}

function fold(turns, label) {
  const reached = turns.filter((t) => t.stage_reached !== null);
  const best = reached.reduce((m, t) => Math.max(m, RANK[t.stage_reached]), -1);
  const first = reached.find((t) => RANK[t.stage_reached] === best);
  const topRange = turns.filter((t) => t.range !== null).reduce((m, t) => (m === null || RANK[t.range[1]] > RANK[m.range[1]] ? t : m), null);
  let out;
  if (topRange !== null && RANK[topRange.range[1]] > best) {
    out = { turn: topRange, class: 'indeterminate', reason: topRange.why };
  } else {
    out = { turn: first, class: first.stage_reached, reason: first.why };
    if (first.stage_reached === 'application-unknown') out = { turn: first, ...labelClass(label) };
  }
  return out;
}

// A label acts only on application-unknown; on any other class it is noted, never applied.
function noteLabelMisfit(label, part, notes) {
  if (label === null) return false;
  if (part.class === 'application-unknown' || part.class.startsWith('applied') || part.reason === 'outcome-unknown') return true;
  notes.push(part.class === 'indeterminate' ? 'label-unused' : 'label-conflict');
  return false;
}

function forgotten(stores, tenant, id, firstTs) {
  for (const { db } of stores) {
    if (!hasTable(db, 'audit_log')) continue;
    const row = db.prepare("SELECT ts FROM audit_log WHERE op = 'forget' AND target_id = ? AND tenant_id = ? ORDER BY id LIMIT 1").get(id, tenant);
    if (row !== undefined) return firstTs === null || row.ts > firstTs ? 'forgotten' : 'forgotten-before';
  }
  // Several delete paths write no forget row, so a trace of the id anywhere still means it existed.
  for (const { db } of stores) {
    if (hasTable(db, 'delivery_candidates') && db.prepare('SELECT 1 AS x FROM delivery_candidates WHERE tenant_id = ? AND memory_id = ? LIMIT 1').get(tenant, id) !== undefined) return 'forgotten';
    if (hasTable(db, 'recall_trace_results') && db.prepare('SELECT 1 AS x FROM recall_trace_results WHERE tenant_id = ? AND memory_id = ? LIMIT 1').get(tenant, id) !== undefined) return 'forgotten';
  }
  return null;
}

function build(local, opts, base) {
  const { session, tenant } = base;
  const storeHash = base.store_hash;
  const stores = [{ db: local, name: 'local' }];
  if (opts.globalDb) stores.push({ db: opts.globalDb, name: 'global' });
  const env = { stores };
  if (!hasTable(local, 'delivery_events')) {
    base.memory_id = opts.memory ?? null;
    base.label = pickLabel(opts.labels, session, opts.memory === undefined ? [] : [opts.memory], base.notes);
    return { class: 'indeterminate', reason: 'no-ledger-table' };
  }
  const found = findMemories(stores, tenant, opts);
  if (found.length > 1 && opts.key !== undefined) {
    base.label = pickLabel(opts.labels, session, found.map((m) => m.id), base.notes);
    return { class: 'indeterminate', reason: 'key-ambiguous' };
  }
  env.memory = found[0] ?? null;
  base.memory_id = env.memory?.id ?? opts.memory ?? null;
  base.label = pickLabel(opts.labels, session, base.memory_id === null ? [] : [base.memory_id], base.notes);
  base.memory_store = env.memory?.store ?? null;

  const rows = loadSession(local, tenant, session, storeHash, base.notes);
  const targetCands = new Map();
  if (base.memory_id !== null) {
    for (const c of local.prepare('SELECT * FROM delivery_candidates WHERE tenant_id = ? AND memory_id = ?').all(tenant, base.memory_id)) {
      if (rows.some((r) => r.id === c.event_id)) targetCands.set(c.event_id, c);
    }
  }
  env.hasCandidates = targetCands.size > 0;
  if (env.memory === null && !env.hasCandidates) {
    const why = base.memory_id === null ? null : forgotten(stores, tenant, base.memory_id, rows[0]?.ts ?? null);
    return why === 'forgotten' ? { class: 'indeterminate', reason: why } : { class: 'not-written', reason: why ?? 'no-row' };
  }
  return foldSession(env, { rows, targetCands, opts, base });
}

function foldSession(env, { rows, targetCands, opts, base }) {
  const { mains, dups, compactIds } = splitRows(rows, targetCands, base.notes);
  const groups = makeGroups(mains, dups, targetCands);
  env.compactIds = compactIds;
  env.prompts = groups.filter((g) => !g.surface);
  env.done = new Map();
  env.parsed = opts.transcript === undefined ? null : parseTranscript(fs.readFileSync(opts.transcript, 'utf8'), base.session);
  if (env.parsed?.foreign > 0) base.notes.push(`transcript-foreign-lines:${env.parsed.foreign}`);
  if (env.parsed?.skipped.length > 0) base.notes.push(`transcript-skipped-lines:${env.parsed.skipped.length}`);
  env.pairs = new Map();
  let gaps = [];
  if (env.parsed) {
    const input = env.prompts.map((g) => ({ id: g.row.id, prompt_hash: g.row.prompt_hash, emitted: g.members.map((r) => r.emitted_hash).filter((h) => h !== null) }));
    ({ pairs: env.pairs, gaps } = pairTurns(env.parsed, input, blockHash));
  }
  const turns = groups.map((g) => turnOf(env, g, env.prompts.indexOf(g)));
  if (turns.length === 0) return { class: 'indeterminate', reason: 'no-event-row', turns: gaps.map((x) => gapTurn(x, base.notes)) };
  turns.push(...gaps.map((x) => gapTurn(x, base.notes)));
  const out = fold(turns, base.label);
  const { turn } = out;
  return {
    class: out.class, reason: out.reason, turn: turn.event_id === null ? null : { event_id: turn.event_id, turn_seq: turn.turn_seq },
    stage: turn.stage, cand_reason: turn.cand_reason, turns,
  };
}

/** One lesson in one session of one store; `memory` (id) or `key` (text substring), `global` a root, or false for none. */
export function reconstruct(opts) {
  const { store, session, tenant = 'default' } = opts;
  if (store === undefined || session === undefined || (opts.memory === undefined) === (opts.key === undefined)) {
    throw new UsageError('reconstruct needs store, session and exactly one of memory or key');
  }
  const local = openDb(store);
  if (local === null) throw new Error(`no hippo.db in ${store}`);
  // The writer hashes the canonical path, so a symlinked path would read every row as foreign.
  const canonical = (p) => path.resolve(realpathOrResolve(p));
  const storeCanonical = canonical(store);
  const globalRoot = opts.global === false ? null : canonical(opts.global ?? resolveGlobalRootDir());
  const globalDb = globalRoot !== null && globalRoot !== storeCanonical ? openDb(globalRoot) : null;
  const base = {
    store_hash: blockHash(storeCanonical), tenant, session, memory_id: null, memory_store: null, notes: [], label: null,
  };
  try {
    const part = build(local, { ...opts, globalDb }, base);
    const acted = noteLabelMisfit(base.label, part, base.notes);
    return {
      class: part.class, reason: part.reason, store_hash: base.store_hash, tenant_id: tenant, session_id: session,
      memory_id: base.memory_id, memory_store: base.memory_store, turn: part.turn ?? null, stage: part.stage ?? null,
      cand_reason: part.cand_reason ?? null, turns: part.turns ?? [], label: acted ? base.label : null, notes: base.notes,
    };
  } finally {
    local.close();
    globalDb?.close();
  }
}

const FLAGS = { '--store': 'store', '--session': 'session', '--memory': 'memory', '--key': 'key', '--transcript': 'transcript', '--labels': 'labels', '--tenant': 'tenant', '--global': 'global' };

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-global') out.global = false;
    else if (FLAGS[a] !== undefined && argv[i + 1] !== undefined) out[FLAGS[a]] = argv[++i];
    else throw new UsageError(`bad argument: ${a}`);
  }
  if (!out.store || !out.session || (out.memory === undefined) === (out.key === undefined)) throw new UsageError('need --store, --session and one of --memory or --key');
  return out;
}

function loadLabels(file) {
  const text = fs.readFileSync(file, 'utf8');
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  }
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const labels = args.labels === undefined ? undefined : loadLabels(args.labels);
    console.log(JSON.stringify(reconstruct({ ...args, labels })));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n${USAGE}`);
      process.exit(2);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const entry = process.argv[1];
if (entry && fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url))) main();
