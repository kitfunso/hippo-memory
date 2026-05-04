import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { hasSeenKey, markKeySeen, lookupMemoryByKey } from '../src/connectors/github/idempotency.js';

describe('github idempotency', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-gh-idem-'));
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('hasSeenKey returns false then true after markKeySeen', () => {
    const db = openHippoDb(root);
    try {
      expect(hasSeenKey(db, 'k1')).toBe(false);
      markKeySeen(db, { idempotencyKey: 'k1', deliveryId: 'd1', eventName: 'issues', memoryId: 'm123' });
      expect(hasSeenKey(db, 'k1')).toBe(true);
    } finally {
      closeHippoDb(db);
    }
  });

  it('lookupMemoryByKey returns the recorded memory_id', () => {
    const db = openHippoDb(root);
    try {
      markKeySeen(db, { idempotencyKey: 'k2', deliveryId: 'd2', eventName: 'pull_request', memoryId: 'mABC' });
      expect(lookupMemoryByKey(db, 'k2')).toBe('mABC');
    } finally {
      closeHippoDb(db);
    }
  });

  it('lookupMemoryByKey returns null when the key has not been seen', () => {
    const db = openHippoDb(root);
    try {
      expect(lookupMemoryByKey(db, 'never')).toBeNull();
    } finally {
      closeHippoDb(db);
    }
  });

  it('markKeySeen accepts memoryId=null (early-write before memory persists)', () => {
    const db = openHippoDb(root);
    try {
      markKeySeen(db, { idempotencyKey: 'k3', deliveryId: 'd3', eventName: 'push', memoryId: null });
      expect(hasSeenKey(db, 'k3')).toBe(true);
      expect(lookupMemoryByKey(db, 'k3')).toBeNull();
    } finally {
      closeHippoDb(db);
    }
  });

  it('INSERT OR IGNORE: duplicate markKeySeen does not throw or overwrite', () => {
    const db = openHippoDb(root);
    try {
      markKeySeen(db, { idempotencyKey: 'k4', deliveryId: 'd4', eventName: 'issues', memoryId: 'm-first' });
      // Second call with different metadata must not throw and must not overwrite memory_id.
      markKeySeen(db, { idempotencyKey: 'k4', deliveryId: 'd4-other', eventName: 'pull_request', memoryId: 'm-second' });
      expect(lookupMemoryByKey(db, 'k4')).toBe('m-first');
    } finally {
      closeHippoDb(db);
    }
  });
});
