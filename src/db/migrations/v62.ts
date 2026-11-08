import type { Migration } from './types.js';

const CREATE_TRIGGER_TASK_SNAPSHOTS_STATUS_CHECK_INSERT_SQL = `
        CREATE TRIGGER IF NOT EXISTS trg_task_snapshots_status_check_insert
        BEFORE INSERT ON task_snapshots
        WHEN NEW.status NOT IN ('active','superseded','cleared','done','session-ended')
        BEGIN
          SELECT RAISE(ABORT, 'invalid task snapshot status: must be active|superseded|cleared|done|session-ended');
        END
      `;

const CREATE_TRIGGER_TASK_SNAPSHOTS_STATUS_CHECK_UPDATE_SQL = `
        CREATE TRIGGER IF NOT EXISTS trg_task_snapshots_status_check_update
        BEFORE UPDATE OF status ON task_snapshots
        WHEN NEW.status NOT IN ('active','superseded','cleared','done','session-ended')
        BEGIN
          SELECT RAISE(ABORT, 'invalid task snapshot status: must be active|superseded|cleared|done|session-ended');
        END
      `;

const CREATE_TRIGGER_MEMORY_CONFLICTS_STATUS_CHECK_INSERT_SQL = `
        CREATE TRIGGER IF NOT EXISTS trg_memory_conflicts_status_check_insert
        BEFORE INSERT ON memory_conflicts
        WHEN NEW.status NOT IN ('open','resolved')
        BEGIN
          SELECT RAISE(ABORT, 'invalid conflict status: must be open|resolved');
        END
      `;

const CREATE_TRIGGER_MEMORY_CONFLICTS_STATUS_CHECK_UPDATE_SQL = `
        CREATE TRIGGER IF NOT EXISTS trg_memory_conflicts_status_check_update
        BEFORE UPDATE OF status ON memory_conflicts
        WHEN NEW.status NOT IN ('open','resolved')
        BEGIN
          SELECT RAISE(ABORT, 'invalid conflict status: must be open|resolved');
        END
      `;

export const v62: Migration = {
  version: 62,
  up: (db) => {
    // UPDATE OF status, not UPDATE: a stored row outside the list stays editable in its other columns.
    db.exec(CREATE_TRIGGER_TASK_SNAPSHOTS_STATUS_CHECK_INSERT_SQL);
    db.exec(CREATE_TRIGGER_TASK_SNAPSHOTS_STATUS_CHECK_UPDATE_SQL);
    db.exec(CREATE_TRIGGER_MEMORY_CONFLICTS_STATUS_CHECK_INSERT_SQL);
    db.exec(CREATE_TRIGGER_MEMORY_CONFLICTS_STATUS_CHECK_UPDATE_SQL);
  },
};
