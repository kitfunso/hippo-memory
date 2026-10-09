import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { initStore } from '../src/store/open.js';
import { loadAllEntries } from '../src/store/entry-reads.js';
import { remember } from '../src/api/index.js';

/** Makes every insert into the Slack event log fail, as a real constraint would. */
function breakEventLog(root: string): void {
  const db = openHippoDb(root);
  try {
    db.exec(`CREATE TRIGGER event_log_broken BEFORE INSERT ON slack_event_log BEGIN SELECT RAISE(ABORT, 'boom'); END`);
  } finally {
    closeHippoDb(db);
  }
}

describe('remember with a connector event is transactional', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'hippo-after-')); initStore(root); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('rolls back the memory row when the event log write throws', () => {
    breakEventLog(root);
    expect(() =>
      remember({ hippoRoot: root, tenantId: 'default', actor: { subject: 'test', role: 'admin' } }, {
        content: 'doomed',
        event: { connector: 'slack', eventId: 'Ev_doomed' },
      }),
    ).toThrow(/boom/);
    expect(loadAllEntries(root).filter((e) => e.content === 'doomed')).toHaveLength(0);
  });
});
