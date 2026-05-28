/**
 * E2 decision — audit-op lockstep verification.
 *
 * v1.11.5 CRIT A institutional rule: any new AuditOp must appear in ALL THREE
 * sites in lockstep (audit.ts AuditOp union, cli.ts VALID_AUDIT_OPS, server.ts
 * VALID_AUDIT_OPS). The existing audit-ops-*-lockstep tests hard-code their own
 * episode's ops, so this new test pins the three decision ops.
 *
 * Plan: docs/plans/2026-05-28-e2-decision-object.md.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const DECISION_OPS = [
  'decision_create',
  'decision_supersede',
  'decision_close',
] as const;

describe('E2 decision audit-op lockstep (v1.11.5 CRIT A institutional rule)', () => {
  it('audit.ts AuditOp union contains all three decision ops', () => {
    const text = readFileSync(join(repoRoot, 'src/audit.ts'), 'utf8');
    for (const op of DECISION_OPS) {
      expect(text, `audit.ts missing '${op}' in AuditOp union`).toContain(`'${op}'`);
    }
  });

  it('cli.ts VALID_AUDIT_OPS Set contains all three decision ops', () => {
    const text = readFileSync(join(repoRoot, 'src/cli.ts'), 'utf8');
    for (const op of DECISION_OPS) {
      expect(text, `cli.ts missing '${op}' in VALID_AUDIT_OPS`).toContain(`'${op}'`);
    }
  });

  it('server.ts VALID_AUDIT_OPS Set contains all three decision ops', () => {
    const text = readFileSync(join(repoRoot, 'src/server.ts'), 'utf8');
    for (const op of DECISION_OPS) {
      expect(text, `server.ts missing '${op}' in VALID_AUDIT_OPS`).toContain(`'${op}'`);
    }
  });
});
