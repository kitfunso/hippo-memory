// served() turns a sync group into an async one without changing what the methods do.
import { describe, expect, it } from 'vitest';
import { served } from '../src/store/sqlite/served.js';

interface Probe {
  boom(): Promise<void>;
  twice(n: number): Promise<number>;
  self(): Promise<SyncProbe>;
  label: string;
}

interface SyncProbe {
  readonly label: string;
  boom(): void;
  twice(n: number): number;
  self(): SyncProbe;
}

describe('served', () => {
  const group: SyncProbe = {
    label: 'plain',
    boom() { throw new Error('nope'); },
    twice: (n) => n * 2,
    self() { return this; },
  };
  const wrapped = served<Probe>(group);

  it('rejects instead of throwing when the sync method throws', async () => {
    let result: Promise<void> | undefined;
    expect(() => { result = wrapped.boom(); }).not.toThrow();
    await expect(result).rejects.toThrow('nope');
  });

  it('answers through a Promise', async () => {
    await expect(wrapped.twice(4)).resolves.toBe(8);
  });

  it('copies a non-function property as is', () => {
    expect(wrapped.label).toBe('plain');
  });

  it('runs each method with the sync group as this', async () => {
    expect(await wrapped.self()).toBe(group);
  });
});
