// Prompts, error texts and readers the tool-failure ledger tests share; toolFailureScratch binds the readers to the current project.
import { expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { DELIVERY_LEDGER_VERSION } from '../../src/base/session/delivery.js';
import type { JsonValue } from '../../src/base/util/json.js';
import { trySymlink } from '../_helpers/symlink.js';
import {
  dispose,
  hippo,
  hippoIn,
  project,
  type Config as ProjectConfig,
  type Project,
  type RunOptions,
} from '../_helpers/delivery-boundary.js';
import {
  listingOf,
  verdictOf,
  writeHostTranscript,
  type ReadOptions,
  type TurnSpec,
} from '../_helpers/host-transcript.js';

// Capture-error runs in process; TF1, TF12 and TF13 spawn it once each, far inside the 30 s process-project timeout.

export const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'z10-reconstruct.mjs');
export const V = DELIVERY_LEDGER_VERSION;
const HIPPO_JS = path.resolve(__dirname, '..', '..', 'bin', 'hippo.js');
export const P1 = 'first question about deploys';
export const P2 = 'second question about the test suite';
export const ERR_ALPHA = 'Command failed with exit code 2: the alpha package build cannot find its manifest file';
export const ERR_BETA = 'Command failed with exit code 3: the beta service migration lost its database connection';
export const RECALL_PROMPT = 'why does the alpha package build keep failing, it cannot find the manifest file';
export const ROUTINE = {
  tool_input: { command: 'grep -r zebra src' },
  error: 'Command failed with exit code 1: no output produced',
};

type Row = { [column: string]: string | number | null };
type Param = string | number;
type Over = { [field: string]: JsonValue | undefined };

export function rowsAt(root: string, sql: string, params: Param[] = []): Row[] {
  const db = new DatabaseSync(path.join(root, 'hippo.db'), { readOnly: true });
  try {
    // SAFETY: callers pass a SELECT; rows are column-name to cell maps.
    return db.prepare(sql).all(...params) as Row[];
  } finally {
    db.close();
  }
}

export const callKey = (e: Row) => [e.event_type, e.turn_seq, e.duplicate_of, e.tool_use_id];
export const num = (v: string | number | null | undefined): number => Number(v);

export const payload = (session: string, over: Over = {}): string =>
  JSON.stringify({
    session_id: session,
    hook_event_name: 'PostToolUseFailure',
    tool_name: 'Bash',
    tool_input: { command: 'npm run build' },
    error: ERR_ALPHA,
    tool_use_id: 'toolu_1',
    ...over,
  });

/** One `hippo capture-error` run, in process unless `spawned`; the hook prints nothing and always exits 0. */
export async function fail(
  at: Project,
  session: string,
  over: Over = {},
  opts: RunOptions & { args?: string[]; spawned?: boolean } = {},
) {
  const { args = ['capture-error'], spawned = false, ...run } = opts;
  const r = spawned
    ? hippo(at, args, { ...run, input: payload(session, over) })
    : await hippoIn(at, args, { ...run, input: payload(session, over) });
  expect([r.status, r.stdout]).toEqual([0, '']);
  return r;
}

/** One `hippo capture-error` run with every prepared statement that starts with `sqlPrefix` made to throw. */
export function failWhere(at: Project, session: string, sqlPrefix: string, over: Over = {}) {
  const preload = path.join(at.dir, `throw-${sqlPrefix.replace(/\W+/g, '-')}.mjs`);
  fs.writeFileSync(
    preload,
    `
import { DatabaseSync } from 'node:sqlite';
const original = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql, ...rest) {
  if (sql.trimStart().startsWith(${JSON.stringify(sqlPrefix)})) throw new Error('injected failure');
  return original.call(this, sql, ...rest);
};
`,
  );
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, HIPPO_JS, 'capture-error'], {
    cwd: at.cwd,
    env: at.env,
    input: payload(session, over),
    encoding: 'utf8',
  });
  expect([r.status, r.stdout]).toEqual([0, '']);
  return r;
}

/** A junction to `target`, or null when this machine cannot create one. */
export function link(target: string, l: string): string | null {
  return trySymlink(target, l, 'junction') ? l : null;
}

export function toolFailureScratch(getP: () => Project) {
  const made: Project[] = [];
  afterEach(() => {
    for (const x of made.splice(0)) dispose(x);
  });

  const mk = (config?: ProjectConfig): Project => {
    const x = project(config);
    made.push(x);
    return x;
  };

  const rows = (sql: string, root: string = getP().hippoRoot, params: Param[] = []): Row[] => rowsAt(root, sql, params);
  const EV_COLS =
    'id, event_type, turn_seq, duplicate_of, tool_use_id, failure_id, ledger_version, runtime, session_state, tenant_id, store_hash';
  const events = (session: string, root: string = getP().hippoRoot, tenant = 'default'): Row[] =>
    rows(`SELECT ${EV_COLS} FROM delivery_events WHERE tenant_id = ? AND session_id = ? ORDER BY id`, root, [
      tenant,
      session,
    ]);
  const logs = (root: string = getP().hippoRoot): Row[] =>
    rows('SELECT id, outcome, tool, sig_hash FROM failure_log ORDER BY id', root);
  const lessons = (root: string = getP().hippoRoot): Row[] =>
    rows("SELECT id, content FROM memories WHERE source = 'tool-failure' ORDER BY created, id", root);
  const lessonWith = (word: string): string => String(lessons().find((m) => String(m.content).includes(word))?.id);

  const list = (session: string, extra: { store?: string; global?: string | false; tenant?: string } = {}) =>
    listingOf({ store: getP().hippoRoot, session, ...extra });
  const read = (session: string, memory: string, extra: ReadOptions & { store?: string } = {}) =>
    verdictOf({ store: getP().hippoRoot, session, memory, ...extra });
  const doc = (session: string, specs: TurnSpec[]): string => writeHostTranscript(getP(), specs, { name: session });

  return { mk, rows, events, logs, lessons, lessonWith, list, read, doc };
}
