#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import * as os from 'node:os';

const dbPath = path.join(os.homedir(), '.hippo', 'hippo.db');
const db = new DatabaseSync(dbPath);

const before = db
  .prepare(`SELECT reason, COUNT(*) as n FROM memory_conflicts WHERE status = 'open' GROUP BY reason`)
  .all();
console.log(`open conflicts before:`, before);

const r = db
  .prepare(
    `UPDATE memory_conflicts
   SET status = 'resolved', updated_at = datetime('now')
   WHERE status = 'open'
     AND reason IN (
       'negation polarity mismatch on overlapping statement',
       'enabled/disabled mismatch on overlapping statement',
       'true/false mismatch on overlapping statement',
       'always/never mismatch on overlapping statement'
     )`,
  )
  .run();
console.log(`rows updated: ${r.changes ?? 0}`);

const after = db.prepare(`SELECT COUNT(*) as n FROM memory_conflicts WHERE status = 'open'`).get();
console.log(`open conflicts remaining: ${after.n}`);

db.close();
