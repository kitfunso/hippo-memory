// Quality repair's protection is data the store applies: each field keeps the rows it names, and only those.
import { describe, expect, it } from 'vitest';
import { PROTECTED_ROWS as repairProtection, repairKeeps, type RepairProtection } from '../../src/core/memory-audit.js';
import { createMemory } from '../_helpers/default-half-life-memory.js';
import type { MemoryEntry } from '../../src/core/memory.js';

const NONE: RepairProtection = { pinned: false, raw: false, trusted: false, objectBacked: false };
const row = (extra: Partial<MemoryEntry> = {}): MemoryEntry => ({ ...createMemory('bump build 78 for testflight deploy'), ...extra });
const imported = { tags: ['claude-code-memory'], source: 'agent-memory:claude-code:p-001/note.md#abc' };

const CASES: ReadonlyArray<readonly [field: keyof RepairProtection, entry: MemoryEntry, backsObject: boolean, label: string]> = [
  ['pinned', row({ pinned: true }), false, 'pinned'],
  ['raw', row({ kind: 'raw' }), false, 'raw receipt'],
  ['trusted', row(imported), false, 'trusted imported note'],
  ['objectBacked', row(), true, 'backs an object'],
];

describe('repairKeeps', () => {
  it.each(CASES)('%s keeps its row under the api protection, and lets it go once off', (field, entry, backsObject, label) => {
    expect(repairKeeps(entry, backsObject, repairProtection)).toBe(label);
    expect(repairKeeps(entry, backsObject, { ...repairProtection, [field]: false })).toBeUndefined();
    expect(repairKeeps(entry, backsObject, { ...NONE, [field]: true })).toBe(label);
  });

  it('keeps a pinned raw object-backed row as pinned first, as the rule reads in order', () => {
    expect(repairKeeps(row({ pinned: true, kind: 'raw' }), true, repairProtection)).toBe('pinned');
    expect(repairKeeps(row({ pinned: true, kind: 'raw' }), true, { ...repairProtection, pinned: false })).toBe('raw receipt');
  });

  it('lets a plain row go under every protection', () => {
    expect(repairKeeps(row(), false, repairProtection)).toBeUndefined();
  });

  it('the default keeps every row the old api function kept', () => {
    expect(repairProtection).toEqual({ pinned: true, raw: true, trusted: true, objectBacked: true });
  });
});
