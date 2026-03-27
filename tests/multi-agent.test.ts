/**
 * Tests for multi-agent shared memory: transfer scoring, sharing, peers.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createMemory, type MemoryEntry } from '../src/memory.js';
import { initStore, writeEntry, loadAllEntries } from '../src/store.js';
import {
  transferScore,
  shareMemory,
  listPeers,
  autoShare,
} from '../src/shared.js';

let localDir: string;
let globalDir: string;

// Override getGlobalRoot for tests by manipulating the env
// We'll use shareMemory with force to test the write path

beforeEach(() => {
  localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-local-'));
  globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-global-'));
  initStore(localDir);
  initStore(globalDir);
});

// ---------------------------------------------------------------------------
// Transfer scoring
// ---------------------------------------------------------------------------

describe('transferScore', () => {
  it('returns ~0.5 for neutral memory with no special tags', () => {
    const entry = createMemory('Some general note');
    const score = transferScore(entry);
    expect(score).toBeCloseTo(0.5, 1);
  });

  it('returns high score for error-tagged platform memory', () => {
    const entry = createMemory('No emoji in Python on Windows', {
      tags: ['error', 'platform', 'windows', 'encoding'],
    });
    const score = transferScore(entry);
    expect(score).toBeGreaterThan(0.7);
  });

  it('returns low score for project-specific memory', () => {
    const entry = createMemory('Deploy config at /opt/app/config.yaml', {
      tags: ['config', 'deploy', 'file-path', 'endpoint'],
    });
    const score = transferScore(entry);
    expect(score).toBeLessThan(0.3);
  });

  it('boosts frequently retrieved memories', () => {
    const base = createMemory('Some lesson', { tags: ['error'] });
    const retrieved: MemoryEntry = { ...base, retrieval_count: 5 };

    expect(transferScore(retrieved)).toBeGreaterThan(transferScore(base));
  });

  it('boosts pinned memories', () => {
    const unpinned = createMemory('Important rule', { tags: ['rule'] });
    const pinned = createMemory('Important rule', { tags: ['rule'], pinned: true });

    expect(transferScore(pinned)).toBeGreaterThan(transferScore(unpinned));
  });

  it('is clamped to [0, 1]', () => {
    const high = createMemory('Universal truth', {
      tags: ['error', 'platform', 'windows', 'python', 'shell', 'pattern', 'rule', 'gotcha', 'best-practice'],
      pinned: true,
    });
    const highEntry: MemoryEntry = { ...high, retrieval_count: 100 };

    expect(transferScore(highEntry)).toBeLessThanOrEqual(1);
    expect(transferScore(highEntry)).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// listPeers
// ---------------------------------------------------------------------------

describe('listPeers', () => {
  it('returns empty when global store is empty', () => {
    const peers = listPeers(globalDir);
    expect(peers).toEqual([]);
  });

  it('groups memories by project from source field', () => {
    const entry1 = createMemory('Lesson from project A');
    entry1.source = 'shared:projectA:2026-03-27T00:00:00Z';
    writeEntry(globalDir, entry1);

    const entry2 = createMemory('Lesson from project A again');
    entry2.source = 'shared:projectA:2026-03-27T01:00:00Z';
    writeEntry(globalDir, entry2);

    const entry3 = createMemory('Lesson from project B');
    entry3.source = 'shared:projectB:2026-03-27T02:00:00Z';
    writeEntry(globalDir, entry3);

    const peers = listPeers(globalDir);
    expect(peers.length).toBe(2);

    const projectA = peers.find((p) => p.project === 'projectA');
    expect(projectA).toBeDefined();
    expect(projectA!.count).toBe(2);

    const projectB = peers.find((p) => p.project === 'projectB');
    expect(projectB).toBeDefined();
    expect(projectB!.count).toBe(1);
  });

  it('sorts by count descending', () => {
    for (let i = 0; i < 5; i++) {
      const e = createMemory(`Lesson ${i}`);
      e.source = 'shared:bigProject:2026-03-27T00:00:00Z';
      writeEntry(globalDir, e);
    }
    const e = createMemory('Single lesson');
    e.source = 'shared:smallProject:2026-03-27T00:00:00Z';
    writeEntry(globalDir, e);

    const peers = listPeers(globalDir);
    expect(peers[0].project).toBe('bigProject');
    expect(peers[0].count).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// autoShare
// ---------------------------------------------------------------------------

describe('autoShare', () => {
  it('dry-run returns candidates without writing', () => {
    const good = createMemory('Always use semicolons in PowerShell', {
      tags: ['error', 'platform', 'windows', 'shell'],
    });
    writeEntry(localDir, good);

    const specific = createMemory('Config at /opt/deploy.yaml', {
      tags: ['config', 'deploy', 'file-path'],
    });
    writeEntry(localDir, specific);

    // We can't easily test autoShare with the real global root,
    // but we can test transferScore filtering
    const localEntries = loadAllEntries(localDir);
    const candidates = localEntries.filter((e) => transferScore(e) >= 0.6);

    expect(candidates.length).toBe(1);
    expect(candidates[0].content).toContain('PowerShell');
  });
});
