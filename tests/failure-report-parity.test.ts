// A failure read with no store must hash like the local failure log, or repeat counts split between a laptop and its server.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { initStore } from '../src/store/open.js';
import { closeHippoDb, openHippoDb } from '../src/db.js';
import { captureToolFailure } from '../src/capture-error.js';
import { failureHash, failureReport } from '../src/capture/failure-reading.js';
import type { JsonValue } from '../src/json.js';

interface LogRow {
  tool: string | null;
  outcome: string;
  skip_rule: string | null;
  sig_hash: string | null;
  detail_hash: string | null;
}

let dir: string;
let root: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-failure-report-'));
  for (const name of ['HOME', 'USERPROFILE', 'HIPPO_HOME']) vi.stubEnv(name, dir);
  root = path.join(dir, '.hippo');
  initStore(root);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

function logRows(): LogRow[] {
  const db = openHippoDb(root);
  try {
    // SAFETY: the SELECT names exactly LogRow's columns.
    return db.prepare(`SELECT tool, outcome, skip_rule, sig_hash, detail_hash FROM failure_log`).all() as LogRow[];
  } finally {
    closeHippoDb(db);
  }
}

const LONG_TAIL = 'only-in-the-untruncated-detail';
const LONG_ERROR = `Exit code 2\n${'src/deep/module.ts(12,3): error TS2304: Cannot find name foo. '.repeat(8)}${LONG_TAIL}`;

const PAYLOADS: Array<[string, JsonValue]> = [
  ['a lesson', { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'cd src && npm run build' }, error: 'Exit code 2\nsrc/a.ts(12,3): error TS2304: Cannot find name foo' }],
  ['an error past 200 chars', { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'npm run build' }, error: LONG_ERROR }],
  ['a routine skip', { session_id: 's1', tool_name: 'Grep', error: 'No matches found for pattern foo' }],
  ['an interrupt', { session_id: 's1', tool_name: 'Bash', error: 'Interrupted by user', is_interrupt: true }],
  ['no tool name', { session_id: 's1', error: 'ENOENT: no such file or directory, open config.json' }],
];

describe('failureReport', () => {
  it.each(PAYLOADS)('%s: matches the row the local failure log writes', (_name, payload) => {
    captureToolFailure(root, 'default', payload);
    const rows = logRows();
    expect(rows).toHaveLength(1);
    const report = failureReport(payload);
    expect(report.detail_hash).toBe(rows[0].detail_hash);
    expect(report.text === null ? null : failureHash(report.text)).toBe(rows[0].sig_hash);
    expect(report.tool).toBe(rows[0].tool);
    expect(report.rule).toBe(rows[0].skip_rule);
    expect(report.skip ?? 'stored').toBe(rows[0].outcome);
  });

  it('sends at most 200 chars of text and never the untruncated detail', () => {
    const report = failureReport(PAYLOADS[1][1]);
    expect(report.text).not.toBeNull();
    expect(report.text!.length).toBe(200);
    expect(Object.keys(report).sort()).toEqual(['detail_hash', 'rule', 'skip', 'text', 'tool']);
    expect(JSON.stringify(report)).not.toContain(LONG_TAIL);
  });
});
