/**
 * J1 anchoring — audit-op lockstep verification.
 *
 * v1.11.5 CRIT A institutional rule: any new AuditOp must appear in ALL
 * THREE sites in lockstep (audit.ts AuditOp union, cli.ts VALID_AUDIT_OPS,
 * server.ts VALID_AUDIT_OPS). This test parses each file and asserts each
 * of J1's three new ops appears in each site = 9 cells total.
 *
 * Note on counting: cli.ts has TWO physical edit regions for J1 (the
 * module-level Map + helpers AND the VALID_AUDIT_OPS Set), but counts as
 * ONE lockstep site (there is exactly ONE VALID_AUDIT_OPS Set in cli.ts).
 *
 * Plan: docs/plans/2026-05-26-j1-anchoring-detector.md.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const J1_OPS = [
  'recall_anchor_detected_query_repeat',
  'recall_anchor_detected_memory_dominance',
  'recall_anchor_skipped_no_session',
] as const;

describe('J1 audit-op lockstep (v1.11.5 CRIT A institutional rule)', () => {
  it('audit.ts AuditOp union contains all three J1 ops', () => {
    const text = readFileSync(join(repoRoot, 'src/audit.ts'), 'utf8');
    for (const op of J1_OPS) {
      expect(text, `audit.ts missing '${op}' in AuditOp union`).toContain(`'${op}'`);
    }
  });

  it('cli.ts VALID_AUDIT_OPS Set contains all three J1 ops', () => {
    const text = readFileSync(join(repoRoot, 'src/cli.ts'), 'utf8');
    for (const op of J1_OPS) {
      expect(text, `cli.ts missing '${op}' in VALID_AUDIT_OPS`).toContain(`'${op}'`);
    }
  });

  it('server.ts VALID_AUDIT_OPS Set contains all three J1 ops', () => {
    const text = readFileSync(join(repoRoot, 'src/server.ts'), 'utf8');
    for (const op of J1_OPS) {
      expect(text, `server.ts missing '${op}' in VALID_AUDIT_OPS`).toContain(`'${op}'`);
    }
  });
});
