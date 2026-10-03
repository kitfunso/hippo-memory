// Memory surfaces (prereg 104, 114): hashed into the run ledger before each session, copied aside, put back on a retry.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { instructionSnapshot } from './workspace.mjs';

/** Every surface a retry restores; `instructions` is restored by restoreInstructions from memory. */
export const RESTORABLE = ['autoMemory', 'userInstructions', 'codexMemories', 'hippoGlobal', 'hippoWork'];

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const relOf = (run, abs) => path.relative(run.dirs.root, abs).split(path.sep).join('/');
const lexists = (p) => fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined;
const errCode = (err) => err.code ?? 'EIO';
export const cellName = (run, t) => `${run.s.id} ${t.id} ${run.arm} seed${run.seed}`;

/** Each surface's roots now, as `{name, abs}`; a root may be absent, so a restore deletes what the attempt made there. */
function surfaceRoots(run) {
  const { claudeConfig, codexHome, hippoHome, work } = run.dirs;
  const projects = path.join(claudeConfig, 'projects');
  const folders = fs.existsSync(projects) ? fs.readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [];
  return {
    autoMemory: folders.map((name) => ({ name, abs: path.join(projects, name, 'memory') })),
    userInstructions: [{ name: 'CLAUDE.md', abs: path.join(claudeConfig, 'CLAUDE.md') }, { name: 'rules', abs: path.join(claudeConfig, 'rules') }],
    codexMemories: [{ name: 'memories', abs: path.join(codexHome, 'memories') }],
    hippoGlobal: [{ name: 'hippo-home', abs: hippoHome }],
    hippoWork: [{ name: '.hippo', abs: path.join(work, '.hippo') }],
  };
}

/** Files under `abs`, never following a link; a read error is kept on its entry, never thrown. */
function walk(run, abs, out) {
  let st;
  try {
    st = fs.lstatSync(abs, { throwIfNoEntry: false });
  } catch (err) {
    out.push({ path: relOf(run, abs), error: errCode(err) });
    return out;
  }
  if (!st) return out;
  try {
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) walk(run, path.join(abs, name), out);
    } else if (st.isSymbolicLink()) {
      out.push({ path: relOf(run, abs), sha256: sha256(fs.readlinkSync(abs)), size: st.size, link: true });
    } else {
      const bytes = fs.readFileSync(abs);
      out.push({ path: relOf(run, abs), sha256: sha256(bytes), size: bytes.length });
    }
  } catch (err) {
    out.push({ path: relOf(run, abs), error: errCode(err) });
  }
  return out;
}

/** Every surface's files as ledger entries, keyed by surface. */
export function surfaceFiles(run) {
  const roots = surfaceRoots(run);
  const files = Object.fromEntries(RESTORABLE.map((key) => [key, roots[key].flatMap((r) => walk(run, r.abs, []))]));
  files.instructions = [...instructionSnapshot(run.dirs.work)].map(([rel, bytes]) => ({ path: `work/${rel}`, sha256: sha256(bytes), size: bytes.length }));
  return files;
}

function ledgerLine(ctx, run, step, when, fields) {
  const line = {
    schema: 'z0-ledger/1', runName: run.runName, sequence: run.s.id, arm: run.arm, seed: run.seed, position: step.position, order: step.order,
    taskId: step.t.id, when, at: new Date().toISOString(), verified: null, restorable: null, copyErrors: [], ...fields,
  };
  fs.appendFileSync(ctx.ledgerFile, `${JSON.stringify(line)}\n`);
  return line;
}

let cpSync = fs.cpSync;

/** Test seam in place of mocking node:fs (the lint bans module mocks); null puts the real copy back. */
export function __setSurfaceCopy(fn) {
  cpSync = fn ?? fs.cpSync;
}

function copyRoot(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

/** Hash every surface into the ledger; at `pre-*` also copy each restorable surface aside. A failed copy marks the snapshot unrestorable, never the run. */
export function snapshotSurfaces(ctx, run, when, step) {
  const surfaces = surfaceFiles(run);
  if (!when.startsWith('pre-')) return { when, surfaces, line: ledgerLine(ctx, run, step, when, { surfaces }) };
  const copyDir = path.join(ctx.snapDir, run.runName, run.arm, `seed${run.seed}`, when);
  const roots = surfaceRoots(run);
  const copied = new Map();
  const copyErrors = [];
  const fail = (surface, err) => {
    copyErrors.push({ surface, code: errCode(err) });
    ctx.log(`${cellName(run, step.t)}: ${when} copy of ${surface} failed (${errCode(err)}); a retry cannot restore it`);
  };
  try {
    fs.rmSync(copyDir, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    fail('*', err);
  }
  for (const key of copyErrors.length ? [] : RESTORABLE) {
    try {
      for (const r of roots[key]) if (lexists(r.abs)) copyRoot(r.abs, path.join(copyDir, key, r.name));
      copied.set(key, roots[key]);
    } catch (err) {
      fail(key, err);
    }
  }
  const restorable = copyErrors.length === 0;
  return { when, surfaces, copyDir, copied, restorable, line: ledgerLine(ctx, run, step, when, { restorable, copyErrors, surfaces }) };
}

const IMPORTED = 'agent-memory:';
/** A row hippo imported from a coding agent's own notes (src/agent-memories/tools.ts). */
export const isImported = (e) => String(e.source ?? '').startsWith(IMPORTED);
// The tool stays in an imported row's prefix (agent-memory:claude-code); other sources keep their first part.
const prefixOf = (e) => String(e.source ?? '').split(':').slice(0, isImported(e) ? 2 : 1).join(':');
export const collapse = (s) => s.replace(/\s+/g, ' ').trim();
// One context-render.ts contextLine bullet, as scripts/z1-replay.mjs parses it.
const BULLET = /^- \*\*\[[^\]]+\](?: ⚠️)? (?:Previously observed \(\d{4}-\d{2}-\d{2}\): |Consider checking: )?(?:\[global\] )?([\s\S]*)\*\*(?: \[[^\]]*\])?(?: \(\d+%\))?$/;

/** Store entries whose content a bullet printed; a `[truncated]` bullet matches by prefix (z1-replay.mjs). */
function bulletEntries(byContent, bullet) {
  const m = BULLET.exec(bullet);
  if (!m) return [];
  const text = collapse(m[1]);
  if (byContent.has(text) || !text.endsWith(' [truncated]')) return byContent.get(text) ?? [];
  const head = text.slice(0, -' [truncated]'.length);
  return [...byContent].filter(([k]) => k.startsWith(head)).flatMap(([, es]) => es);
}

/** Hippo rows in hook-added texts, matched by content to `entries` (each with `global`); every repeat counts, as it is paid again (prereg 93). */
export function injectedRows(texts, entries) {
  const byContent = new Map();
  for (const e of entries) byContent.set(collapse(e.content), [...(byContent.get(collapse(e.content)) ?? []), e]);
  const counts = { rows: 0, importedRows: 0, chars: 0, importedChars: 0, unmatched: 0, ambiguous: 0 };
  const rows = [];
  for (const part of texts.flatMap((t) => t.split(/\n(?=- \*\*\[)/))) {
    if (!part.startsWith('- **[')) continue;
    const bullet = part.split('\n\n')[0].trim();
    counts.rows++;
    counts.chars += bullet.length;
    const hits = bulletEntries(byContent, bullet);
    const imported = hits.filter(isImported).length;
    if (!hits.length) counts.unmatched++;
    else if (imported && imported < hits.length) counts.ambiguous++;
    else rows.push({ prefix: prefixOf(hits[0]), global: Boolean(hits[0].global), chars: bullet.length });
    if (hits.length && imported === hits.length) {
      counts.importedRows++;
      counts.importedChars += bullet.length;
    }
  }
  return { counts, rows };
}

/** The injected rows' counts for the record, with each matched row's source prefix written to the ledger. */
export function recordInjected(ctx, run, step, texts, entries) {
  const { counts, rows } = injectedRows(texts, entries);
  ledgerLine(ctx, run, step, 'injected', { rows });
  return counts;
}

const sameFiles = (a = [], b = []) => JSON.stringify(a) === JSON.stringify(b);

/** Put every surface that copied back as the snapshot holds it, then re-hash; true only if the snapshot was whole and every hash matches. */
export function restoreSurfaces(ctx, run, snap, when, step) {
  let ok = snap.restorable;
  const now = surfaceRoots(run);
  for (const [key, roots] of snap.copied) {
    // The cut-off attempt can start a memory dir for a project folder the snapshot never saw.
    const extra = key === 'autoMemory' ? now.autoMemory.filter((r) => !roots.some((s) => s.abs === r.abs)) : [];
    try {
      for (const r of [...roots, ...extra]) fs.rmSync(r.abs, { recursive: true, force: true, maxRetries: 3 });
      for (const r of roots) {
        const from = path.join(snap.copyDir, key, r.name);
        if (lexists(from)) copyRoot(from, r.abs);
      }
    } catch (err) {
      ok = false;
      ctx.log(`${cellName(run, step.t)}: ${when} of ${key} failed (${errCode(err)})`);
    }
  }
  // Only what this restore put back is compared; restoreInstructions restores and owns `instructions`.
  const after = surfaceFiles(run);
  const keys = [...snap.copied.keys()];
  const verified = keys.every((k) => sameFiles(after[k], snap.surfaces[k]));
  ledgerLine(ctx, run, step, when, { verified, surfaces: Object.fromEntries(keys.map((k) => [k, after[k]])) });
  return ok && verified;
}
