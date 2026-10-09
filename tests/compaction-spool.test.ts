import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostCompactPayload } from '../src/capture/compaction-record.js';
import { __setSpoolFs, importSpool, spool, spoolCounts, type SpoolFs, type SpoolImporter } from '../src/capture/compaction-spool.js';

let root: string;
let logs: string[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-spool-'));
  logs = [];
});
afterEach(() => {
  __setSpoolFs(null);
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const MINUTE = 60_000;
const log = (message: string): void => {
  logs.push(message);
};
const spoolDir = (): string => path.join(root, 'compactions-spool');
const lockFile = (): string => path.join(spoolDir(), 'replay.lock');
const stamp = (ms: number): string => String(ms).padStart(13, '0');
const realFs: SpoolFs = fs;
const withFs = (over: Partial<SpoolFs>): void => __setSpoolFs({ ...realFs, ...over });
const fsError = (code: string): Error => Object.assign(new Error(`${code}: simulated`), { code });
const leftToAnother = (): string[] => logs.filter((l) => l.startsWith('spool left to another replayer'));
const payload = (sessionId: string): PostCompactPayload => ({ sessionId, trigger: 'auto', cwd: null, transcriptPath: null, compactSummary: null });

function put(name: string, sessionId: string): string {
  fs.mkdirSync(spoolDir(), { recursive: true });
  const file = path.join(spoolDir(), name);
  fs.writeFileSync(file, JSON.stringify({ tenantId: 'default', sessionId, trigger: 'auto', cwd: null, transcriptPath: null, at: new Date().toISOString(), summary: `summary of ${sessionId}`, items: [] }));
  return file;
}

interface Collector {
  seen: string[];
  importer: SpoolImporter;
}

/** An importer that notes each session id it is handed and finishes the file. */
function collector(): Collector {
  const seen: string[] = [];
  return { seen, importer: (spooled, recorded) => { seen.push(spooled.payload.sessionId); recorded(); } };
}

const replay = (importer: SpoolImporter): number => importSpool(root, 'default', log, Number.POSITIVE_INFINITY, importer);

describe('spool names and order', () => {
  it('imports oldest first across sessions and legacy names', () => {
    put('zz-1000.json', 'zz');
    put('0000000002000-aaaaaaaa.a0.json', 'b');
    put('aa-3000.json', 'aa');
    put('0000000000500-bbbbbbbb.a1.json', 'y');
    const { seen, importer } = collector();
    expect(replay(importer)).toBe(4);
    expect(seen).toEqual(['y', 'zz', 'b', 'aa']);
    expect(fs.readdirSync(spoolDir())).toEqual([]);
  });

  it('two spools for one session in one millisecond both land', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_760_000_000_000);
    spool(root, 'default', payload('s1'), { summary: 'first', items: [] }, new Date(1_760_000_000_000));
    spool(root, 'default', payload('s1'), { summary: 'second', items: [] }, new Date(1_760_000_000_000));
    vi.restoreAllMocks();
    expect(fs.readdirSync(spoolDir())).toHaveLength(2);
    const summaries: string[] = [];
    expect(replay((spooled, recorded) => { summaries.push(spooled.text.summary); recorded(); })).toBe(2);
    expect(summaries.sort()).toEqual(['first', 'second']);
  });
});

describe('one replayer at a time', () => {
  const A = '0000000001000-aaaaaaaa';
  const B = '0000000002000-bbbbbbbb';

  it('skips the spool while another replayer holds a fresh lock', () => {
    put(`${A}.a0.json`, 's1');
    fs.writeFileSync(lockFile(), JSON.stringify({ pid: 4242, at: Date.now(), token: 'other' }));
    const { seen, importer } = collector();
    expect(replay(importer)).toBe(0);
    expect(seen).toEqual([]);
    expect(JSON.parse(fs.readFileSync(lockFile(), 'utf8')).token).toBe('other');
    expect(logs).toEqual(['spool left to another replayer (lock held by pid 4242)']);
  });

  it('takes over a lock older than 10 minutes', () => {
    put(`${A}.a0.json`, 's1');
    fs.writeFileSync(lockFile(), JSON.stringify({ pid: 4242, at: Date.now() - 11 * MINUTE, token: 'dead' }));
    const { seen, importer } = collector();
    expect(replay(importer)).toBe(1);
    expect(seen).toEqual(['s1']);
    expect(fs.readdirSync(spoolDir())).toEqual([]);
  });

  it('a lock dated 20 minutes ahead is taken over', () => {
    put(`${A}.a0.json`, 's1');
    fs.writeFileSync(lockFile(), JSON.stringify({ pid: 4242, at: Date.now() + 20 * MINUTE, token: 'future' }));
    const { seen, importer } = collector();
    expect(replay(importer)).toBe(1);
    expect(seen).toEqual(['s1']);
    expect(fs.readdirSync(spoolDir())).toEqual([]);
  });

  it('judges an unparsable lock by its mtime', () => {
    put(`${A}.a0.json`, 's1');
    fs.writeFileSync(lockFile(), '{"pid": 42');
    const { seen, importer } = collector();
    expect(replay(importer)).toBe(0);
    expect(leftToAnother()).toHaveLength(1);

    const old = new Date(Date.now() - 11 * MINUTE);
    fs.utimesSync(lockFile(), old, old);
    expect(replay(importer)).toBe(1);
    expect(seen).toEqual(['s1']);
    expect(fs.readdirSync(spoolDir())).toEqual([]);
  });

  it('leaves no lock behind after a run, including after an importer throw', () => {
    put(`${A}.a0.json`, 's1');
    put(`${B}.a0.json`, 's2');
    const held: boolean[] = [];
    replay((spooled, recorded) => {
      held.push(fs.existsSync(lockFile()));
      if (spooled.payload.sessionId === 's1') throw new Error('boom');
      recorded();
    });
    expect(held).toEqual([true, true]);
    expect(fs.existsSync(lockFile())).toBe(false);
  });

  it('puts a stale claim back with the next attempt number', () => {
    const stale = `${A}.a0.claim-${stamp(Date.now() - 11 * MINUTE)}`;
    const live = `${B}.a0.claim-${stamp(Date.now())}`;
    put(stale, 's1');
    put(live, 's2');
    expect(importSpool(root, 'default', log, 0, collector().importer)).toBe(0);
    expect(fs.readdirSync(spoolDir()).sort()).toEqual([`${A}.a1.json`, live]);
    expect(logs).toContain(`spool file ${stale} was claimed by a replayer that never finished, put back (try 1 of 3)`);
  });

  it('recovery leaves a claim fresh by name whose mtime is an hour old', () => {
    const live = `${A}.a0.claim-${stamp(Date.now())}`;
    const old = new Date(Date.now() - 60 * MINUTE);
    fs.utimesSync(put(live, 's1'), old, old);
    expect(importSpool(root, 'default', log, 0, collector().importer)).toBe(0);
    expect(fs.readdirSync(spoolDir())).toEqual([live]);
    expect(logs).toEqual([]);
  });

  it('a second replayer never recovers a live claim', () => {
    const file = put(`${A}.a0.json`, 's1');
    const old = new Date(Date.now() - 11 * MINUTE);
    fs.utimesSync(file, old, old);
    let fired = false;
    let nested: number | null = null;
    withFs({
      renameSync: (from, to) => {
        fs.renameSync(from, to);
        if (fired || !String(to).includes('.claim')) return;
        fired = true;
        nested = importSpool(root, 'default', log, Number.POSITIVE_INFINITY, collector().importer);
      },
    });
    const outer = collector();
    replay(outer.importer);
    expect(nested).toBe(0);
    expect(leftToAnother()).toHaveLength(1);
    expect(outer.seen).toEqual(['s1']);
  });

  it('stops after the current file when the lock is taken over', () => {
    put(`${A}.a0.json`, 's1');
    put(`${B}.a0.json`, 's2');
    const seen: string[] = [];
    replay((spooled, recorded) => {
      seen.push(spooled.payload.sessionId);
      recorded();
      fs.writeFileSync(lockFile(), JSON.stringify({ pid: 4242, at: Date.now(), token: 'successor' }));
    });
    expect(seen).toEqual(['s1']);
    expect(logs).toContain('spool left to another replayer (lock taken over)');
    expect(JSON.parse(fs.readFileSync(lockFile(), 'utf8')).token).toBe('successor');
    expect(fs.readdirSync(spoolDir()).sort()).toEqual([`${B}.a0.json`, 'replay.lock']);
  });

  it('a lock create that hits EPERM or EBUSY skips quietly', () => {
    put(`${A}.a0.json`, 's1');
    for (const code of ['EPERM', 'EBUSY']) {
      logs = [];
      withFs({
        writeFileSync: (file, data, options) => {
          if (String(file).endsWith('replay.lock')) throw fsError(code);
          fs.writeFileSync(file, data, options);
        },
      });
      const { seen, importer } = collector();
      expect(replay(importer)).toBe(0);
      expect(seen).toEqual([]);
      expect(logs).toHaveLength(1);
      expect(leftToAnother()).toHaveLength(1);
    }
    expect(fs.readdirSync(spoolDir())).toEqual([`${A}.a0.json`]);
  });

  it('a lock released between EEXIST and the read is retaken', () => {
    put(`${A}.a0.json`, 's1');
    fs.writeFileSync(lockFile(), JSON.stringify({ pid: 4242, at: Date.now(), token: 'leaving' }));
    let released = false;
    withFs({
      readFileSync: (file, encoding) => {
        if (!released && String(file).endsWith('replay.lock')) {
          released = true;
          fs.unlinkSync(file);
        }
        return fs.readFileSync(file, encoding);
      },
    });
    const { seen, importer } = collector();
    expect(replay(importer)).toBe(1);
    expect(released).toBe(true);
    expect(seen).toEqual(['s1']);
    expect(logs).toEqual([]);
    expect(fs.readdirSync(spoolDir())).toEqual([]);
  });

  it('a busy lock read stops the run, says so, and leaves no lock behind', () => {
    put(`${A}.a0.json`, 's1');
    put(`${B}.a0.json`, 's2');
    const seen: string[] = [];
    withFs({
      readFileSync: (file, encoding) => {
        if (seen.length > 0 && String(file).endsWith('replay.lock')) throw fsError('EBUSY');
        return fs.readFileSync(file, encoding);
      },
    });
    expect(replay((spooled, recorded) => { seen.push(spooled.payload.sessionId); recorded(); })).toBe(1);
    expect(seen).toEqual(['s1']);
    expect(logs).toEqual(['spool lock could not be read, stopping']);
    expect(fs.readdirSync(spoolDir())).toEqual([`${B}.a0.json`]);
    __setSpoolFs(null);
    expect(replay(collector().importer)).toBe(1);
  });
});

describe('spool counts', () => {
  it('skips a file whose stat stays busy instead of throwing', () => {
    const old = new Date(Date.now() - 20 * MINUTE);
    for (const name of ['s1-1.json', 's2-1.json']) fs.utimesSync(put(name, name), old, old);
    withFs({
      statSync: (file) => {
        if (path.basename(file) === 's1-1.json') throw fsError('EBUSY');
        return fs.statSync(file);
      },
    });
    expect(spoolCounts(root, new Date(), 10 * MINUTE)).toEqual({ waiting: 1, stale: 0, bad: 0 });
  });
});

describe('failures are counted and set aside', () => {
  const A = '0000000001000-aaaaaaaa';
  const B = '0000000002000-bbbbbbbb';
  const busyError = (): Error => Object.assign(new Error('database is locked'), { errcode: 5 });

  it('a non-busy throw moves a0 to a1, a2, then failed.bad', () => {
    const body = fs.readFileSync(put(`${A}.a0.json`, 's1'), 'utf8');
    const failing: SpoolImporter = () => {
      throw new Error('blocked');
    };
    expect(replay(failing)).toBe(0);
    expect(fs.readdirSync(spoolDir())).toEqual([`${A}.a1.json`]);
    expect(replay(failing)).toBe(0);
    expect(fs.readdirSync(spoolDir())).toEqual([`${A}.a2.json`]);
    expect(replay(failing)).toBe(0);
    expect(fs.readdirSync(spoolDir())).toEqual([`${A}.failed.bad`]);
    expect(fs.readFileSync(path.join(spoolDir(), `${A}.failed.bad`), 'utf8')).toBe(body);
    expect(logs).toEqual([
      `spool file ${A}.a0.json failed to import (try 1 of 3): blocked`,
      `spool file ${A}.a1.json failed to import (try 2 of 3): blocked`,
      `spool file ${A}.a2.json set aside as .bad after 3 tries: blocked`,
    ]);
  });

  it('a busy throw keeps a0 and stops the loop', () => {
    put(`${A}.a0.json`, 's1');
    put(`${B}.a0.json`, 's2');
    const seen: string[] = [];
    expect(replay((spooled) => {
      seen.push(spooled.payload.sessionId);
      throw busyError();
    })).toBe(0);
    expect(seen).toEqual(['s1']);
    expect(fs.readdirSync(spoolDir()).sort()).toEqual([`${A}.a0.json`, `${B}.a0.json`]);
    expect(logs).toEqual([`spool file ${A}.a0.json waits for the next run: the store is busy`]);
  });

  it('a stale claim at a2 becomes interrupted.bad', () => {
    const stale = `${A}.a2.claim-${stamp(Date.now() - 11 * MINUTE)}`;
    const body = fs.readFileSync(put(stale, 's1'), 'utf8');
    expect(importSpool(root, 'default', log, 0, collector().importer)).toBe(0);
    expect(fs.readdirSync(spoolDir())).toEqual([`${A}.interrupted.bad`]);
    expect(fs.readFileSync(path.join(spoolDir(), `${A}.interrupted.bad`), 'utf8')).toBe(body);
    expect(logs).toEqual([`spool file ${stale} was claimed by a replayer that never finished 3 times, set aside as .bad`]);
  });

  it('a stale claim whose .bad already landed is removed, not set aside a second time', () => {
    put(`${A}.failed.bad`, 's1');
    put(`${A}.a2.claim-${stamp(Date.now() - 11 * MINUTE)}`, 's1');
    expect(importSpool(root, 'default', log, 0, collector().importer)).toBe(0);
    expect(fs.readdirSync(spoolDir())).toEqual([`${A}.failed.bad`]);
    expect(logs).toEqual([]);
  });

  it('only a busy claim rename is reported as locked by another program', () => {
    put(`${A}.a0.json`, 's1');
    const claimFails = (code: string): string[] => {
      logs = [];
      withFs({
        renameSync: (from, to) => {
          if (to.includes('.claim')) throw fsError(code);
          fs.renameSync(from, to);
        },
      });
      expect(replay(collector().importer)).toBe(0);
      expect(fs.readdirSync(spoolDir())).toEqual([`${A}.a0.json`]);
      return logs;
    };
    expect(claimFails('EPERM')).toEqual([`spool file ${A}.a0.json is locked by another program, left for the next run`]);
    expect(claimFails('EIO')).toEqual([`spool problem: spool file ${A}.a0.json not claimed: EIO: simulated`]);
  });

  it('EPERM on the .bad write releases the claim and the rest of the spool still imports', () => {
    fs.mkdirSync(spoolDir(), { recursive: true });
    fs.writeFileSync(path.join(spoolDir(), `${A}.a0.json`), '{ not json');
    put(`${B}.a0.json`, 's2');
    withFs({
      writeFileSync: (file, data, options) => {
        if (file.includes('.bad')) throw fsError('EPERM');
        fs.writeFileSync(file, data, options);
      },
      renameSync: (from, to) => {
        if (to.endsWith('.bad')) throw fsError('EPERM');
        fs.renameSync(from, to);
      },
    });
    const { seen, importer } = collector();
    expect(replay(importer)).toBe(1);
    expect(seen).toEqual(['s2']);
    expect(fs.readdirSync(spoolDir())).toEqual([`${A}.a0.json`]);
  });

  it('a claim that vanishes before the read is skipped and the rest still import', () => {
    put(`${A}.a0.json`, 's1');
    put(`${B}.a0.json`, 's2');
    withFs({
      readFileSync: (file, encoding) => {
        if (path.basename(file).startsWith(`${A}.a0.claim-`)) fs.unlinkSync(file);
        return fs.readFileSync(file, encoding);
      },
    });
    const { seen, importer } = collector();
    expect(replay(importer)).toBe(1);
    expect(seen).toEqual(['s2']);
    expect(logs).toEqual([`spool file ${A}.a0.json vanished`]);
    expect(fs.readdirSync(spoolDir())).toEqual([]);
  });

  it('EPERM on the claim unlink after the record logs the duplicate risk', () => {
    put(`${A}.a0.json`, 's1');
    withFs({
      unlinkSync: (file) => {
        if (file.includes('.claim')) throw fsError('EPERM');
        fs.unlinkSync(file);
      },
    });
    const { seen, importer } = collector();
    expect(replay(importer)).toBe(1);
    expect(seen).toEqual(['s1']);
    expect(logs).toEqual([`spool file ${A}.a0.json saved; its claim could not be removed (EPERM); it will be imported again`]);
  });
});

describe('temp files a spool left', () => {
  const A = '0000000001000-aaaaaaaa';
  const B = '0000000002000-bbbbbbbb';
  const age = (file: string): void => {
    const old = new Date(Date.now() - 11 * MINUTE);
    fs.utimesSync(file, old, old);
  };

  it('promotes an old parsable tmp and imports it in the same run', () => {
    age(put(`${A}.a0.json.tmp`, 's1'));
    const { seen, importer } = collector();
    expect(replay(importer)).toBe(1);
    expect(seen).toEqual(['s1']);
    expect(fs.readdirSync(spoolDir())).toEqual([]);
    expect(logs).toEqual([`spool file ${A}.a0.json.tmp was never renamed into place, promoted`]);
  });

  it('sets an old torn tmp aside as unreadable.bad', () => {
    fs.mkdirSync(spoolDir(), { recursive: true });
    const torn = path.join(spoolDir(), `${A}.a0.json.tmp`);
    fs.writeFileSync(torn, '{"sessionId": "s1", "summ');
    age(torn);
    expect(replay(collector().importer)).toBe(0);
    expect(fs.readdirSync(spoolDir())).toEqual([`${A}.unreadable.bad`]);
    expect(fs.readFileSync(path.join(spoolDir(), `${A}.unreadable.bad`), 'utf8')).toBe('{"sessionId": "s1", "summ');
    expect(logs).toEqual([`spool file ${A}.a0.json.tmp was never finished, set aside as .bad`]);
  });

  it('removes an old .bad tmp a cut-off set-aside left, and keeps a fresh one', () => {
    age(put(`${A}.failed.bad.0123abcd.tmp`, 's1'));
    put(`${B}.unreadable.bad.89abcdef.tmp`, 's2');
    expect(replay(collector().importer)).toBe(0);
    expect(fs.readdirSync(spoolDir())).toEqual([`${B}.unreadable.bad.89abcdef.tmp`]);
    expect(logs).toEqual([]);
  });

  it('leaves a fresh tmp alone', () => {
    age(put(`${A}.a0.json.tmp`, 's1'));
    put(`${B}.a0.json.tmp`, 's2');
    const { seen, importer } = collector();
    expect(replay(importer)).toBe(1);
    expect(seen).toEqual(['s1']);
    expect(fs.readdirSync(spoolDir())).toEqual([`${B}.a0.json.tmp`]);
  });

  it('promotes a legacy <sid>-<ms>.json.tmp', () => {
    age(put('s1-1700000000000.json.tmp', 's1'));
    const { seen, importer } = collector();
    expect(replay(importer)).toBe(1);
    expect(seen).toEqual(['s1']);
    expect(fs.readdirSync(spoolDir())).toEqual([]);
  });

  it('a spool whose rename stays busy leaves a whole tmp for promotion', () => {
    withFs({
      renameSync: (from, to) => {
        if (from.endsWith('.tmp')) throw fsError('EPERM');
        fs.renameSync(from, to);
      },
    });
    expect(() => spool(root, 'default', payload('s1'), { summary: 'kept', items: [] }, new Date())).not.toThrow();
    __setSpoolFs(null);
    const [name] = fs.readdirSync(spoolDir());
    expect(name).toMatch(/^\d{13}-[0-9a-f]{8}\.a0\.json\.tmp$/);
    age(path.join(spoolDir(), name));
    const summaries: string[] = [];
    expect(replay((spooled, recorded) => { summaries.push(spooled.text.summary); recorded(); })).toBe(1);
    expect(summaries).toEqual(['kept']);
  });
});
