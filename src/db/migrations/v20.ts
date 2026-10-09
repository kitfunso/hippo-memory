import type { Migration } from './types.js';
import { warnDamagedColumn } from '../../util/stored-json.js';

export const v20: Migration = {
    version: 20,
    up: (db) => {
      // GDPR Path A backfill: redact every existing
      // raw_archive.payload_json so historical archives match the new
      // metadata-only contract from src/store/raw-archive.ts. Read each row, parse
      // the existing JSON to extract tenant_id and kind (best effort), then
      // UPDATE with the redacted shape. Rows with unparseable legacy JSON get
      // redacted with tenant_id='unknown', kind='unknown'. The audit_log
      // remains the compliance record.
      // SAFETY: rows' shape matches the four columns named in the SELECT above.
      const rows = db
        .prepare(`SELECT id, archived_at, reason, payload_json FROM raw_archive`)
        .all() as Array<{
        id: number;
        archived_at: string;
        reason: string;
        payload_json: string;
      }>;
      const update = db.prepare(`UPDATE raw_archive SET payload_json = ? WHERE id = ?`);
      for (const row of rows) {
        let tenant = 'unknown';
        let kind = 'unknown';
        try {
          // SAFETY: parsed is a best-effort JSON.parse of legacy payload_json;
          // an unexpected shape only yields undefined fields (falling back to
          // 'unknown' below), and a parse failure is caught, so this never crashes.
          const parsed = JSON.parse(row.payload_json) as {
            tenant_id?: string;
            kind?: string;
          };
          tenant = parsed.tenant_id ?? 'unknown';
          kind = parsed.kind ?? 'unknown';
        } catch {
          // The row is still redacted, with unknowns; the line says which one lost its tenant and kind.
          warnDamagedColumn({ table: 'raw_archive', id: row.id, column: 'payload_json' }, 'not valid JSON');
        }
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
