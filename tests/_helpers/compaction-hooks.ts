import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type SpawnSyncReturns } from 'node:child_process';
import { expect } from 'vitest';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { COMPACTION_MEMORY_TAG } from '../../src/core/memory.js';
import { hippoRun } from './spawn-hippo.js';
const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'compaction', 'post-compact-payloads.jsonl');

export interface Scratch {
  dir: string;
  /** A git-marked project under the scratch home, so its origin is 'proj'. */
  proj: string;
  env: NodeJS.ProcessEnv;
  hippoRoot: string;
  globalRoot: string;
}

export function scratch(): Scratch {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-compaction-'));
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  const globalRoot = path.join(dir, 'global');
  const env: NodeJS.ProcessEnv = { ...process.env, HIPPO_HOME: globalRoot, HOME: dir, USERPROFILE: dir };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.HIPPO_SESSION_ID;
  return { dir, proj, env, hippoRoot: path.join(proj, '.hippo'), globalRoot };
}

export function removeScratch(s: Scratch): void {
  fs.rmSync(s.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export function runHippo(args: string[], cwd: string, env: NodeJS.ProcessEnv, input?: string): SpawnSyncReturns<string> {
  return hippoRun(args, { cwd, env, input });
}

export function initProject(s: Scratch): void {
  expect(runHippo(['init', '--no-hooks', '--no-schedule', '--no-learn'], s.proj, s.env).status).toBe(0);
}

export function initGlobal(s: Scratch): void {
  expect(runHippo(['init', '--global', '--no-hooks', '--no-schedule', '--no-learn'], s.proj, s.env).status).toBe(0);
}

export interface FixturePayload {
  session_id: string;
  compact_summary: string;
  trigger: string;
}

/** One of the five real PostCompact payloads, with the machine paths swapped for the scratch project. */
export function fixturePayload(index: number, over: Record<string, string> = {}): string {
  const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);
  return JSON.stringify({ ...JSON.parse(lines[index]), ...over });
}

export function postCompactPayload(sessionId: string, cwd: string, summary: string | null, extra: Record<string, string> = {}): string {
  const base = { session_id: sessionId, cwd, hook_event_name: 'PostCompact', trigger: 'auto', ...extra };
  return JSON.stringify(summary === null ? base : { ...base, compact_summary: summary });
}

/** A compact_summary shaped like Claude Code's, with the requested memories list. */
export function summaryWith(items: string[], body = '1. Primary Request: fix the flaky login test.'): string {
  const list = items.map((item) => `- ${item}`).join('\n');
  return `<analysis>\nScratch thinking that must not be stored.\n</analysis>\n\n<summary>\n${body}\n\nMemories for hippo:\n${list}\n</summary>`;
}

function all<T>(hippoRoot: string, sql: string, ...params: string[]): T[] {
  const db = openHippoDb(hippoRoot);
  try {
    // SAFETY: every caller names the columns its row type declares.
    return db.prepare(sql).all(...params) as T[];
  } finally {
    closeHippoDb(db);
  }
}

export interface CompactionRow {
  id: string;
  session_id: string;
  origin_project: string;
  compact_trigger: string | null;
  cwd: string | null;
  transcript_path: string | null;
  snapshot_saved: number;
  started_at: string;
  summarised_at: string | null;
  summary: string | null;
  items_json: string | null;
  items_written: number;
  status: string;
}

export function compactionRows(hippoRoot: string): CompactionRow[] {
  return all<CompactionRow>(hippoRoot, `SELECT * FROM compactions ORDER BY started_at, id`);
}

export interface CompactionMemoryRow {
  content: string;
  source: string;
  source_session_id: string | null;
  origin_project: string | null;
  kind: string;
  layer: string;
  confidence: string;
}

export function compactionMemories(hippoRoot: string): CompactionMemoryRow[] {
  return all<CompactionMemoryRow>(
    hippoRoot,
    `SELECT content, source, source_session_id, origin_project, kind, layer, confidence FROM memories WHERE instr(tags_json, ?) > 0 ORDER BY content`,
    `"${COMPACTION_MEMORY_TAG}"`,
  );
}

export function run(hippoRoot: string, sql: string, ...params: Array<string | number | null>): void {
  const db = openHippoDb(hippoRoot);
  try {
    db.prepare(sql).run(...params);
  } finally {
    closeHippoDb(db);
  }
}

/** The stdout of a hook that must print one line: that line, with its newline. */
export function oneLine(stdout: string): string {
  expect(stdout.endsWith('\n')).toBe(true);
  expect(stdout.slice(0, -1)).not.toContain('\n');
  return stdout.slice(0, -1);
}
