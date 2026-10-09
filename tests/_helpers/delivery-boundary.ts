// Scratch projects and CLI runs for the compaction boundary rows of the delivery ledger.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { expect } from 'vitest';
import { closeHippoDb, openHippoDb } from '../../src/db.js';
import { readDeliveryEvents, type DeliveryEventRow } from '../../src/store/recall-trace.js';
import { initStore } from '../../src/store/open.js';
import { writeEntry } from '../../src/store/entry-writes.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../../src/memory.js';
import { saveActiveTaskSnapshot } from '../../src/store/sessions.js';
import type { DeliveryFault } from '../../src/delivery-recorder.js';
import { removeScratch, scratch, type Scratch } from './compaction-hooks.js';

const HIPPO_JS = path.resolve(__dirname, '..', '..', 'bin', 'hippo.js');
const FAULT_CLI = path.resolve(__dirname, '..', 'fixtures', 'delivery-fault-cli.mjs');

export const PROMPT_HOOK = ['context', '--pinned-only', '--include-recent', '5', '--format', 'additional-context'];
export const PIN = 'PINNED: always check the rollback plan before deploy';
export const SNAPSHOT_TASK = 'finish the boundary ledger rows for the compaction hooks';

export interface Project extends Scratch {
  /** The folder the hooks run in. */
  cwd: string;
}

export interface Config {
  ledger?: boolean;
  holdout?: boolean;
}

interface ConfigFile {
  deliveryLedger: { enabled: boolean };
  pinnedInject: { promptRecall: boolean };
  pilot?: { holdoutRateBp: number };
}

export function writeConfig(p: Project, { ledger = true, holdout = false }: Config = {}): void {
  const config: ConfigFile = {
    deliveryLedger: { enabled: ledger },
    pinnedInject: { promptRecall: false },
  };
  if (holdout) config.pilot = { holdoutRateBp: 10_000 };
  fs.writeFileSync(path.join(p.hippoRoot, 'config.json'), JSON.stringify(config));
}

/** A scratch project with a store, the ledger on and one pinned memory. */
export function project(config: Config = {}): Project {
  const s = scratch();
  initStore(s.hippoRoot);
  // Copilot and VS Code folders sit inside the scratch home so no run reads the real ones.
  const env = { ...s.env, COPILOT_HOME: path.join(s.dir, '.copilot'), APPDATA: path.join(s.dir, 'appdata'), XDG_CONFIG_HOME: path.join(s.dir, 'xdg-config') };
  const p: Project = { ...s, env, cwd: s.proj };
  writeConfig(p, config);
  writeEntry(s.hippoRoot, { ...createMemory(PIN, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), pinned: true });
  return p;
}

export function dispose(p: Project): void {
  removeScratch(p);
}

export interface RunOpts {
  input?: string;
  env?: NodeJS.ProcessEnv;
  fault?: DeliveryFault;
  cwd?: string;
}

export function hippo(p: Project, args: string[], opts: RunOpts = {}): SpawnSyncReturns<string> {
  const entry = opts.fault ? [FAULT_CLI, opts.fault] : [HIPPO_JS];
  return spawnSync(process.execPath, [...entry, ...args], {
    cwd: opts.cwd ?? p.cwd, env: { ...p.env, ...opts.env }, input: opts.input ?? '', encoding: 'utf8',
  });
}

export interface AsyncRun { status: number | null; stdout: string; stderr: string }

/** One CLI run that does not block the test thread; `input: null` leaves stdin open and idle. */
export function hippoAsync(p: Project, args: string[], opts: Omit<RunOpts, 'input'> & { input: string | null }): Promise<AsyncRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HIPPO_JS, ...args], { cwd: p.cwd, env: { ...p.env, ...opts.env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    if (opts.input !== null) child.stdin.end(opts.input);
  });
}

/** The default transcript does not exist, so the hook records the boundary and skips the snapshot. */
export const preCompactPayload = (sessionId: string, extra: { [field: string]: string } = {}): string =>
  JSON.stringify({ session_id: sessionId, transcript_path: 'no-such-transcript.jsonl', hook_event_name: 'PreCompact', trigger: 'auto', ...extra });

export const resumePayload = (sessionId: string, extra: { [field: string]: string } = {}): string =>
  JSON.stringify({ session_id: sessionId, hook_event_name: 'SessionStart', source: 'compact', ...extra });

export const promptPayload = (sessionId: string, prompt = 'how should the postgres migration rollback plan work'): string =>
  JSON.stringify({ session_id: sessionId, prompt, hook_event_name: 'UserPromptSubmit' });

/** A Claude Code transcript the pre-compact hook can derive a snapshot from. */
export function writeTranscript(p: Project, name = 'transcript'): string {
  const file = path.join(p.dir, `${name}.jsonl`);
  const lines = [
    { type: 'user', message: { role: 'user', content: SNAPSHOT_TASK } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Next step: run the delivery ledger tests.' }] } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

/** A stub chat log where VS Code keeps it, so a Claude-style PreCompact payload reads as a VS Code one. */
export function writeVscodeTranscript(p: Project): string {
  const file = path.join(p.dir, 'vscode-data', 'Code', 'User', 'workspaceStorage', 'h1', 'github.copilot-chat', 'transcripts', 'vscode-sess-1.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}\n');
  return file;
}

export function installCopilotHooksFile(p: Project): void {
  const dir = path.join(p.dir, '.copilot', 'hooks');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hippo.json'), '{}');
}

export function saveSnapshot(p: Project, sessionId: string | null): void {
  saveActiveTaskSnapshot(p.hippoRoot, 'default', { task: SNAPSHOT_TASK, summary: 'summary of the work', next_step: 'run the tests', session_id: sessionId, source: 'pre-compact' });
}

/** Runs `fn` on a handle to the project's store. */
export function withDb<T>(p: Project, fn: (db: ReturnType<typeof openHippoDb>) => T): T {
  const db = openHippoDb(p.hippoRoot);
  try {
    return fn(db);
  } finally {
    closeHippoDb(db);
  }
}

export function events(p: Project, sessionId: string | null): DeliveryEventRow[] {
  return withDb(p, (db) => readDeliveryEvents(db, 'default', sessionId));
}

/** A session's events, asserting the count first so a second write cannot hide behind destructuring. */
export function eventsN(p: Project, sessionId: string | null, n: number): DeliveryEventRow[] {
  const rows = events(p, sessionId);
  expect(rows).toHaveLength(n);
  return rows;
}

export function eventCount(p: Project): number {
  // SAFETY: a single COUNT(*) aggregate aliased `c`.
  return withDb(p, (db) => (db.prepare('SELECT COUNT(*) AS c FROM delivery_events').get() as { c: number }).c);
}

export function tableRows(p: Project, sql: string): Array<{ [column: string]: string | number | null }> {
  // SAFETY: callers pass a SELECT; rows are column-name to cell maps.
  return withDb(p, (db) => db.prepare(sql).all() as Array<{ [column: string]: string | number | null }>);
}

export const ledgerLines = (stderr: string): string[] => stderr.split('\n').filter((l) => l.includes('delivery ledger'));
