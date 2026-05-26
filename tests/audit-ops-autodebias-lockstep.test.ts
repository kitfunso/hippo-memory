/**
 * J3.2 — audit-op lockstep verification.
 *
 * The v1.11.5 CRIT A institutional rule: any new AuditOp must appear in
 * ALL THREE sites in lockstep:
 *   - src/audit.ts (AuditOp union)
 *   - src/cli.ts (VALID_AUDIT_OPS Set)
 *   - src/server.ts (VALID_AUDIT_OPS Set)
 *
 * This test covers J3.2's three new ops (recall_autodebias_hint,
 * recall_autodebias_hint_no_class_match, recall_autodebias_hint_tiebreak)
 * across all three sites = 9 cells.
 *
 * NOTE on scope: this test was originally specified to use a non-existent
 * `tests/audit-ops-lockstep.test.ts` as the safety net. Plan-eng-critic
 * round 1 (HIGH issue 2) caught that file doesn't exist. Created as a
 * J3.2-scoped lockstep file rather than a generic one because the parse-
 * source pattern needs per-set token enumeration and a generic test would
 * have to walk the entire AuditOp union — out of scope for v1. Future
 * audit ops should either extend this file's `J32_OPS` array (rename
 * file accordingly) or add a per-op assertion to their own integration
 * test. Pattern modeled on the parse-source approach used elsewhere in
 * the test suite (e.g. dag-dirty-flag-schema.test.ts).
 *
 * Plan: docs/plans/2026-05-26-j32-auto-injection.md (Task 3, Task 9).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const J32_OPS = [
  'recall_autodebias_hint',
  'recall_autodebias_hint_no_class_match',
  'recall_autodebias_hint_tiebreak',
] as const;

describe('J3.2 audit-op lockstep (v1.11.5 CRIT A institutional rule)', () => {
  it('audit.ts AuditOp union contains all three new ops', () => {
    const text = readFileSync(join(repoRoot, 'src/audit.ts'), 'utf8');
    for (const op of J32_OPS) {
      expect(text, `audit.ts missing '${op}' in AuditOp union`).toContain(`'${op}'`);
    }
  });

  it('cli.ts VALID_AUDIT_OPS Set contains all three new ops', () => {
    const text = readFileSync(join(repoRoot, 'src/cli.ts'), 'utf8');
    for (const op of J32_OPS) {
      expect(text, `cli.ts missing '${op}' in VALID_AUDIT_OPS`).toContain(`'${op}'`);
    }
  });

  it('server.ts VALID_AUDIT_OPS Set contains all three new ops', () => {
    const text = readFileSync(join(repoRoot, 'src/server.ts'), 'utf8');
    for (const op of J32_OPS) {
      expect(text, `server.ts missing '${op}' in VALID_AUDIT_OPS`).toContain(`'${op}'`);
    }
  });
});
