import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { initStore } from '../src/store.js';
import { openHippoDb, closeHippoDb } from '../src/db.js';
import { hasSeenEvent, markEventSeen, lookupMemoryByEvent } from '../src/connectors/slack/idempotency.js';

describe('slack idempotency', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hippo-slack-idem-')); initStore(root); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('hasSeenEvent returns false then true after marking', () => {
    const db = openHippoDb(root);
    try {
      expect(hasSeenEvent(db, 'Ev1')).toBe(false);
      markEventSeen(db, 'Ev1', 'm123');
      expect(hasSeenEvent(db, 'Ev1')).toBe(true);
      expect(lookupMemoryByEvent(db, 'Ev1')).toBe('m123');
    } finally { closeHippoDb(db); }
  });

  it('markEventSeen is a no-op on duplicate (INSERT OR IGNORE)', () => {
    const db = openHippoDb(root);
    try {
      markEventSeen(db, 'Ev1', 'm123');
      // Second call must not throw and must not overwrite the original memory_id.
      markEventSeen(db, 'Ev1', 'mDIFFERENT');
      expect(lookupMemoryByEvent(db, 'Ev1')).toBe('m123');
    } finally { closeHippoDb(db); }
  });
});
