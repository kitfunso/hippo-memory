import type { Migration } from './types.js';

export const v63: Migration = {
  version: 63,
  up: (db) => {
    // Skip a NULL or unknown kind: trg_memories_kind_check_update is not column-scoped and would abort the open.
    db.exec(
      `UPDATE memories SET superseded_by = NULL WHERE superseded_by = '' ` +
        `AND kind IN ('raw','distilled','superseded','archived')`,
    );
  },
};
