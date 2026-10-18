// Two replayers interleaved by an ordering hook: the second runs inside the first's importer, so the overlap happens on every run.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importSpool, spool } from '../../src/capture/compaction-spool.js';

const FILES = 20;

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-spool-race-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

describe('two replayers over one spool', () => {
  it('the second one never imports a file the first holds, and each file lands once', () => {
    const ids = Array.from({ length: FILES }, (_, i) => `s${String(i).padStart(4, '0')}`);
    for (const id of ids) {
      spool(
        root,
        'default',
        { sessionId: id, trigger: 'auto', cwd: null, transcriptPath: null, compactSummary: null },
        { summary: id, items: [] },
        new Date(),
      );
    }
    const logs: string[] = [];
    const log = (message: string): void => void logs.push(message);
    const imported: string[] = [];
    const nested: number[] = [];

    const first = importSpool(root, 'default', log, Number.POSITIVE_INFINITY, (spooled, recorded) => {
      imported.push(spooled.payload.sessionId);
      // The rival starts while the first still holds its claim and the lock.
      nested.push(
        importSpool(root, 'default', log, Number.POSITIVE_INFINITY, (rival, done) => {
          imported.push(rival.payload.sessionId);
          done();
        }),
      );
      recorded();
    });

    expect(first).toBe(FILES);
    expect(nested).toEqual(Array(FILES).fill(0));
    expect([...imported].sort()).toEqual(ids);
    expect(fs.readdirSync(path.join(root, 'compactions-spool'))).toEqual([]);
    expect(logs.filter((l) => !l.startsWith('spool left to another replayer'))).toEqual([]);
    expect(logs).toHaveLength(FILES);
  });

  it('a rival that starts after the first one is done finds nothing left', () => {
    spool(
      root,
      'default',
      { sessionId: 'only', trigger: 'auto', cwd: null, transcriptPath: null, compactSummary: null },
      { summary: 'only', items: [] },
      new Date(),
    );
    const seen: string[] = [];
    const record = (s: { payload: { sessionId: string } }, done: () => void): void => {
      seen.push(s.payload.sessionId);
      done();
    };
    expect(importSpool(root, 'default', () => undefined, Number.POSITIVE_INFINITY, record)).toBe(1);
    expect(importSpool(root, 'default', () => undefined, Number.POSITIVE_INFINITY, record)).toBe(0);
    expect(seen).toEqual(['only']);
  });
});
