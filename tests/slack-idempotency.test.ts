import { describe, it, expect, beforeEach } from 'vitest';
import { openHippoDb, closeHippoDb } from '../src/db/index.js';
import { slackEventSeenAt as hasSeenEvent, markSlackEventSeenAt as markEventSeen, slackEventMemoryAt as lookupMemoryByEvent } from '../src/store/connectors/slack.js';
import { makeRoot } from './_helpers/make-root.js';

describe('slack idempotency', () => {
  let root: string;
  beforeEach(() => { root = makeRoot('slack-idem');  });

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
