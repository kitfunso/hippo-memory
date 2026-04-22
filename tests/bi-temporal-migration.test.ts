import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, writeEntry, readEntry } from '../src/store.js';
import { createMemory, Layer } from '../src/memory.js';

describe('bi-temporal schema v11', () => {
  it('new entries have valid_from defaulting to created and superseded_by null', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-bt-'));
    initStore(home);
    const e = createMemory('test bi-temporal', { layer: Layer.Episodic });
    writeEntry(home, e);
    const read = readEntry(home, e.id);
    expect(read).not.toBeNull();
    expect(read!.valid_from).toBe(e.created);
    expect(read!.superseded_by).toBeNull();
    rmSync(home, { recursive: true, force: true });
  });

  it('valid_from can be overridden in createMemory', () => {
    const home = mkdtempSync(join(tmpdir(), 'hippo-bt-'));
    initStore(home);
    const pastDate = '2025-01-01T00:00:00.000Z';
    const e = createMemory('historical fact', { layer: Layer.Episodic, valid_from: pastDate });
    expect(e.valid_from).toBe(pastDate);
    writeEntry(home, e);
    const read = readEntry(home, e.id);
    expect(read!.valid_from).toBe(pastDate);
    rmSync(home, { recursive: true, force: true });
  });
});
