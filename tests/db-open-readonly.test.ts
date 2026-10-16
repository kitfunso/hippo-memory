import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeHippoDb, openHippoDb, openHippoDbReadOnly } from '../src/db/index.js';

describe('openHippoDbReadOnly', () => {
  it('reads audit_log from a store built with openHippoDb', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-ro-'));
    try {
      const db = openHippoDb(root);
      db.prepare(
        `INSERT INTO audit_log (ts, tenant_id, actor, op, target_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('2026-10-03T00:00:00.000Z', 'default', 'cli', 'remember', 'm1', '{}');
      closeHippoDb(db);

      const ro = openHippoDbReadOnly(root);
      try {
        const row = ro.prepare('SELECT op, target_id FROM audit_log').get();
        expect(row).toMatchObject({ op: 'remember', target_id: 'm1' });
      } finally {
        closeHippoDb(ro);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a missing store and creates nothing', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-ro-'));
    const root = path.join(parent, 'absent');
    try {
      expect(() => openHippoDbReadOnly(root)).toThrow();
      expect(fs.existsSync(root)).toBe(false);
      expect(fs.readdirSync(parent)).toEqual([]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
