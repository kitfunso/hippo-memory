// Two replayers interleaved by an ordering hook: the second runs inside the first's importer, so the overlap happens on every run.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importSpool, spool } from '../../src/surface/capture/compaction-spool.js';

const FILES = 20;

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-spool-race-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

describe('two replayers over one spool', () => {
  it('the second one never imports a file the first holds, and each file lands once', async () => {
    const ids = Array.from({ length: FILES }, (_, i) => `s${String(i).padStart(4, '0')}`);
    for (const id of ids) {
      spool({
        hippoRoot: root,
        tenantId: 'default',
        payload: { sessionId: id, trigger: 'auto', cwd: null, transcriptPath: null, compactSummary: null },
        text: { summary: id, items: [] },
        at: new Date(),
      });
    }
    const logs: string[] = [];
    const log = (message: string): void => void logs.push(message);
    const imported: string[] = [];
    const nested: Promise<number>[] = [];

    const first = await importSpool({
      hippoRoot: root,
      tenantId: 'default',
      log,
      deadline: Number.POSITIVE_INFINITY,
      importOne: async (spooled, recorded) => {
        imported.push(spooled.payload.sessionId);
        // The rival starts while the first still holds its claim and the lock.
        nested.push(
          importSpool({
            hippoRoot: root,
            tenantId: 'default',
            log,
            deadline: Number.POSITIVE_INFINITY,
            importOne: async (rival, done) => {
              imported.push(rival.payload.sessionId);
              done();
              return null;
            },
          }),
        );
        recorded();
        return null;
      },
    });

    expect(first).toBe(FILES);
    expect(await Promise.all(nested)).toEqual(Array(FILES).fill(0));
    expect([...imported].sort()).toEqual(ids);
    expect(fs.readdirSync(path.join(root, 'compactions-spool'))).toEqual([]);
    expect(logs.filter((l) => !l.startsWith('spool left to another replayer'))).toEqual([]);
    expect(logs).toHaveLength(FILES);
  });

  it('a rival that starts after the first one is done finds nothing left', async () => {
    spool({
      hippoRoot: root,
      tenantId: 'default',
      payload: { sessionId: 'only', trigger: 'auto', cwd: null, transcriptPath: null, compactSummary: null },
      text: { summary: 'only', items: [] },
      at: new Date(),
    });
    const seen: string[] = [];
    const record = async (s: { payload: { sessionId: string } }, done: () => void): Promise<null> => {
      seen.push(s.payload.sessionId);
      done();
      return null;
    };
    const replay = (): Promise<number> =>
      importSpool({
        hippoRoot: root,
        tenantId: 'default',
        log: () => undefined,
        deadline: Number.POSITIVE_INFINITY,
        importOne: record,
      });
    expect(await replay()).toBe(1);
    expect(await replay()).toBe(0);
    expect(seen).toEqual(['only']);
  });
});
