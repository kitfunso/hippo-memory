// Moving the imported embeddings.json aside: a rename blocked by an open handle is logged and copied; any other rename failure leaves the file for the next open.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory, DEFAULT_HALF_LIFE_DAYS } from '../src/core/memory.js';
import { loadEmbeddingIndex } from '../src/store/vector-index.js';

let root: string;
let legacy: string;
let stderr: MockInstance<typeof process.stderr.write>;
const RAW = (id: string): string => JSON.stringify({ [id]: [1, 0] });
const asides = (): string[] => fs.readdirSync(root).filter((f) => f.startsWith('embeddings.json.'));
const logged = (): string => stderr.mock.calls.map((c) => String(c[0])).join('');

/** Fails `op` on the legacy file only, with an errno `code`; every other path goes through. */
function failOnLegacy(op: 'renameSync' | 'rmSync', code: string): void {
  const blocked = (target: fs.PathLike): void => {
    if (String(target) === legacy) throw Object.assign(new Error(`${code}: operation blocked, '${legacy}'`), { code });
  };
  if (op === 'renameSync') {
    const real = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      blocked(from);
      real(from, to);
    });
  } else {
    const real = fs.rmSync;
    vi.spyOn(fs, 'rmSync').mockImplementation((target, opts) => {
      blocked(target);
      real(target, opts);
    });
  }
  syncBuiltinESMExports();
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-move-aside-')));
  legacy = path.join(root, 'embeddings.json');
  initStore(root);
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  fs.rmSync(root, { recursive: true, force: true });
});

function seedLegacyIndex(): string {
  const entry = createMemory('alpha note', { tenantId: 'default', baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS });
  writeEntry(root, entry);
  fs.writeFileSync(legacy, RAW(entry.id), 'utf8');
  return entry.id;
}

describe('moving the imported embeddings.json aside', () => {
  it('logs a rename an open handle blocks, with the error class, and keeps the bytes as a copy', () => {
    const id = seedLegacyIndex();
    failOnLegacy('renameSync', 'EBUSY');

    expect(loadEmbeddingIndex(root)).toEqual({ [id]: [1, 0] });

    expect(fs.existsSync(legacy)).toBe(false);
    expect(asides()).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, asides()[0]!), 'utf8')).toBe(RAW(id));
    expect(logged()).toMatch(/\[hippo\] warn: could not rename embeddings\.json aside \(EBUSY\); copying it instead .*errorClass=Error/);
  });

  it('leaves the file in place for the next open on any other rename failure, without a copy', () => {
    const id = seedLegacyIndex();
    failOnLegacy('renameSync', 'EIO');

    expect(loadEmbeddingIndex(root)).toEqual({ [id]: [1, 0] });

    expect(fs.readFileSync(legacy, 'utf8')).toBe(RAW(id));
    expect(asides()).toEqual([]);
    expect(logged()).toContain('embeddings.json import failed; the next open retries it (EIO: operation blocked');
  });

  it('removes its copy when the original cannot be deleted either, so copies do not pile up', () => {
    const id = seedLegacyIndex();
    failOnLegacy('renameSync', 'EPERM');
    failOnLegacy('rmSync', 'EPERM');

    expect(loadEmbeddingIndex(root)).toEqual({ [id]: [1, 0] });

    expect(fs.readFileSync(legacy, 'utf8')).toBe(RAW(id));
    expect(asides()).toEqual([]);
  });
});
