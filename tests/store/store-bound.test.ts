// bound() and answered() give a group's methods the port's async form without changing what the bodies do.
import { storeFilesOf } from '../../src/store/sqlite/handles.js';
import { describe, expect, it } from 'vitest';
import type { DatabaseSyncLike } from '../../src/db/index.js';
import { StoreBusyError } from '../../src/store/port.js';
import { answered, bound } from '../../src/store/sqlite/bound.js';
import type { OnHandle } from '../../src/store/sqlite/open.js';

interface Probe {
  boom(): Promise<void>;
  busy(): Promise<void>;
  twice(n: number): Promise<number>;
  note(text: string): Promise<void>;
}

// SAFETY: no body here reads the handle; each only checks it is the one `on` passed.
const handle = {} as DatabaseSyncLike;

describe('bound', () => {
  const opened: DatabaseSyncLike[] = [];
  const notes: string[] = [];
  const on: OnHandle = (fn) => {
    opened.push(handle);
    return fn(handle, storeFilesOf('/nowhere'));
  };
  const group = bound<Probe>(on, {
    boom: () => {
      throw new Error('nope');
    },
    busy: () => {
      throw Object.assign(new Error('database is locked'), { errcode: 5 });
    },
    twice: (db, n) => (db === handle ? n * 2 : -1),
    note: (_db, text) => {
      notes.push(text);
    },
  });

  it('rejects instead of throwing when the body throws', async () => {
    let result: Promise<void> | undefined;
    expect(() => {
      result = group.boom();
    }).not.toThrow();
    await expect(result).rejects.toThrow('nope');
  });

  it("rejects a busy code in the port's terms", async () => {
    await expect(group.busy()).rejects.toBeInstanceOf(StoreBusyError);
  });

  it('answers through a Promise, with the handle first', async () => {
    await expect(group.twice(4)).resolves.toBe(8);
  });

  it('runs the body to its end before the Promise settles', async () => {
    const pending = group.note('written');
    expect(notes).toEqual(['written']);
    await pending;
  });
});

describe('answered', () => {
  it('rejects instead of throwing, in the port terms', async () => {
    let result: Promise<void> | undefined;
    expect(() => {
      result = answered(() => {
        throw Object.assign(new Error('database is locked'), { errcode: 5 });
      });
    }).not.toThrow();
    await expect(result).rejects.toBeInstanceOf(StoreBusyError);
  });

  it("answers the run's value", async () => {
    await expect(answered(() => 3)).resolves.toBe(3);
  });
});
