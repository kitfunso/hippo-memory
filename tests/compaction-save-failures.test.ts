import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveCompaction, type PostCompactPayload } from '../src/capture/compaction-record.js';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { initStore } from '../src/store/open.js';
import { log as logger } from '../src/util/log.js';
import { removeScratch, scratch, summaryWith, type Scratch } from './_helpers/compaction-hooks.js';

let s: Scratch;
let logs: string[];

beforeEach(() => {
  s = scratch();
  logs = [];
  initStore(s.hippoRoot);
});
afterEach(() => {
  vi.restoreAllMocks();
  removeScratch(s);
});

const payload = (): PostCompactPayload => ({
  sessionId: 's1',
  trigger: 'auto',
  cwd: s.proj,
  transcriptPath: null,
  compactSummary: summaryWith(['The billing service uses pnpm, so npm install is never run there.']),
});

describe('saveCompaction reports each failure once', () => {
  it('a busy store spools the summary and says so once, with no error log', () => {
    const errors = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const db = openHippoDb(s.hippoRoot);
    try {
      db.exec('BEGIN IMMEDIATE');
      const result = saveCompaction(s.hippoRoot, payload(), (m) => logs.push(m));
      expect(result.deferred).toBe(true);
    } finally {
      db.exec('ROLLBACK');
      closeHippoDb(db);
    }
    expect(logs.filter((m) => m.startsWith('store busy, summary spooled'))).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
  }, 60_000);

  it('a spool that cannot be written is logged once to the hook and once to the structured log', () => {
    const errors = vi.spyOn(logger, 'error').mockImplementation(() => {});
    fs.writeFileSync(path.join(s.hippoRoot, 'compactions-spool'), 'a file where the directory should be');
    const db = openHippoDb(s.hippoRoot);
    try {
      db.exec('BEGIN IMMEDIATE');
      const result = saveCompaction(s.hippoRoot, payload(), (m) => logs.push(m));
      expect(result.deferred).toBe(false);
    } finally {
      db.exec('ROLLBACK');
      closeHippoDb(db);
    }
    expect(logs.filter((m) => m.startsWith('spool failed'))).toHaveLength(1);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toContain('post-compact: spool failed');
  }, 60_000);
});
