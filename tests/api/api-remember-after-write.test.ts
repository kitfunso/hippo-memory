import { describe, it, expect, beforeEach } from 'vitest';
import { closeHippoDb, openHippoDb } from '../../src/db/index.js';
import { loadAllEntries } from '../../src/store/entry-reads.js';
import { remember } from '../../src/api/index.js';
import { apiCtx } from '../_helpers/api-ctx.js';
import { makeRoot } from '../_helpers/make-root.js';

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
  beforeEach(() => { root = makeRoot('after');  });

  it('rolls back the memory row when the event log write throws', async () => {
    breakEventLog(root);
    await expect(remember(apiCtx(root, 'default', { subject: 'test', role: 'admin' }), {
        content: 'doomed',
        event: { connector: 'slack', eventId: 'Ev_doomed' },
      }),
    ).rejects.toThrow(/boom/);
    expect(loadAllEntries(root, 'default').filter((e) => e.content === 'doomed')).toHaveLength(0);
  });
});
