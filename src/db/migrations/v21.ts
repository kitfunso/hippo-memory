import { tableHasColumn } from '../tables.js';
import type { Migration } from './types.js';

export const v21: Migration = {
    version: 21,
    up: (db) => {
      // v0.39 codex round 3: per-row mirror cleanup tracking. Replaces the
      // global gdpr_v20_mirror_cleanup meta gate (which made the reaper
      // one-shot and silently swallowed failed unlinks). With this column the
      // reaper processes only rows WHERE mirror_cleaned_at IS NULL, sets the
      // timestamp on success, and leaves it NULL on any unlink failure so the
      // next openHippoDb retries automatically.
      if (!tableHasColumn(db, 'raw_archive', 'mirror_cleaned_at')) {
        db.exec(`ALTER TABLE raw_archive ADD COLUMN mirror_cleaned_at TEXT`);
      }
    },
};
