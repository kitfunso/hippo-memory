/**
 * E2 policy - audit-op lockstep verification.
 *
 * v1.11.5 CRIT A institutional rule: any new AuditOp must appear in ALL THREE
 * sites in lockstep (audit.ts AuditOp union, cli.ts VALID_AUDIT_OPS, server.ts
 * VALID_AUDIT_OPS). Pins the three policy ops.
 *
 * Plan: docs/plans/2026-05-30-e2-policy-object.md.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const POLICY_OPS = ['policy_create', 'policy_supersede', 'policy_close'] as const;

describe('E2 policy audit-op lockstep (v1.11.5 CRIT A institutional rule)', () => {
  it('audit.ts AuditOp union contains all three policy ops', () => {
    const text = readFileSync(join(repoRoot, 'src/audit.ts'), 'utf8');
    for (const op of POLICY_OPS) {
      expect(text, `audit.ts missing '${op}' in AuditOp union`).toContain(`'${op}'`);
    }
  });

  it('cli.ts VALID_AUDIT_OPS Set contains all three policy ops', () => {
    const text = readFileSync(join(repoRoot, 'src/cli.ts'), 'utf8');
    for (const op of POLICY_OPS) {
      expect(text, `cli.ts missing '${op}' in VALID_AUDIT_OPS`).toContain(`'${op}'`);
    }
  });

  it('server.ts VALID_AUDIT_OPS Set contains all three policy ops', () => {
    const text = readFileSync(join(repoRoot, 'src/server.ts'), 'utf8');
    for (const op of POLICY_OPS) {
      expect(text, `server.ts missing '${op}' in VALID_AUDIT_OPS`).toContain(`'${op}'`);
    }
  });
});
