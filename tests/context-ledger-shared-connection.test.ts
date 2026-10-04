// the static and recall token-ledger rows each opened their own connection
// via withLedgerDb. Drives the built CLI, no mocks.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { initStore, writeEntry } from '../src/store.js';
import { createMemory, type MemoryEntry, DEFAULT_HALF_LIFE_DAYS } from '../src/memory.js';

const HIPPO_JS = path.resolve(__dirname, '..', 'bin', 'hippo.js');

const PRELOAD_SRC = `
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync } from 'node:fs';
const logPath = process.env.F5_CONN_LOG;
const ids = new WeakMap();
let next = 0;
const original = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql, ...rest) {
  if (logPath && sql.includes('INSERT INTO token_ledger')) {
    if (!ids.has(this)) ids.set(this, next++);
    appendFileSync(logPath, ids.get(this) + '\\t' + sql.replace(/\\s+/g, ' ') + '\\n');
  }
  return original.call(this, sql, ...rest);
};
`;

let cliTmp: string;
let hippoDir: string;
let globalDir: string;
let preloadPath: string;
let logPath: string;

function seedCli(content: string, extra: Partial<MemoryEntry> = {}) {
  writeEntry(hippoDir, { ...createMemory(content, { baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS }), ...extra });
}

function enablePromptRecall(root: string) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    pinnedInject: { promptRecall: true, promptRecallThreshold: 0.1, promptRecallMinShared: 1 },
  }));
}

beforeEach(() => {
  cliTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-f5-ledger-conn-'));
  hippoDir = path.join(cliTmp, '.hippo');
  globalDir = path.join(cliTmp, 'global');
  fs.mkdirSync(hippoDir, { recursive: true });
  initStore(hippoDir);
  enablePromptRecall(hippoDir);
  preloadPath = path.join(cliTmp, 'f5-preload.mjs');
  fs.writeFileSync(preloadPath, PRELOAD_SRC);
  logPath = path.join(cliTmp, 'f5-conn.log');
});

afterEach(() => {
  fs.rmSync(cliTmp, { recursive: true, force: true });
});

describe('the static and recall ledger rows share one connection', () => {
  it('writes both token_ledger inserts through the same DatabaseSync connection', () => {
    seedCli('the deploy rollback plan for the postgres migration', { created: '2026-01-01T00:00:00.000Z' });
    seedCli('PINNED: always check the rollback plan before deploy', { pinned: true });

    execFileSync(process.execPath, [
      '--import', pathToFileURL(preloadPath).href, HIPPO_JS,
      'context', '--pinned-only', '--include-recent', '5', '--format', 'additional-context',
    ], {
      env: { ...process.env, HIPPO_HOME: globalDir, F5_CONN_LOG: logPath },
      cwd: cliTmp,
      input: JSON.stringify({ session_id: 'sess-f5-1', prompt: 'postgres migration rollback plan' }),
      encoding: 'utf8',
    });

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    const connIds = new Set(lines.map((l) => l.split('\t')[0]));
    expect(lines.length).toBe(2);
    expect(connIds.size).toBe(1);
  });
});
