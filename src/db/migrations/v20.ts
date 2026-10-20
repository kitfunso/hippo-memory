import type { Migration } from './types.js';
import { isJsonString } from '../../base/util/json.js';
import { parseStoredObject } from '../../base/util/stored-json.js';

export const v20: Migration = {
  version: 20,
  up: (db) => {
    // GDPR Path A backfill: redact every existing raw_archive.payload_json to the metadata-only shape
    // (store/raw-archive.ts); unparseable legacy JSON gets tenant_id='unknown', kind='unknown'. The audit_log remains
    // the compliance record.
    const rows = db.prepare(`SELECT id, archived_at, reason, payload_json FROM raw_archive`).all() as Array<{
      id: number;
      archived_at: string;
      reason: string;
      payload_json: string;
    }>;
    const update = db.prepare(`UPDATE raw_archive SET payload_json = ? WHERE id = ?`);
    for (const row of rows) {
      // A damaged row is still redacted, with unknowns; the warning says which one lost its tenant and kind.
      const payload = parseStoredObject({ table: 'raw_archive', id: row.id, column: 'payload_json' }, row.payload_json);
      const tenant = isJsonString(payload?.tenant_id) ? payload.tenant_id : 'unknown';
      const kind = isJsonString(payload?.kind) ? payload.kind : 'unknown';
      const redacted = JSON.stringify({
        redacted: true,
        archived_at: row.archived_at,
        tenant_id: tenant,
        kind,
        reason: row.reason,
        migration: 'v20_redact',
      });
      update.run(redacted, row.id);
    }
  },
};
