/**
 * LC2-E3 mv_rescue — audit-op lockstep verification.
 *
 * v1.11.5 CRIT A institutional rule: any new AuditOp must appear in ALL THREE
 * sites in lockstep (audit.ts AuditOp union, cli.ts VALID_AUDIT_OPS, server.ts
 * VALID_AUDIT_OPS). Pins 'mv_rescue' (review-round F3 — no prior CI guard
 * pinned it across the three sites).
 *
 * Plan: docs/plans/2026-08-10-lc2-e3-mv-wiring.md.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const MV_RESCUE_OP = 'mv_rescue';

describe('LC2-E3 mv_rescue audit-op lockstep (v1.11.5 CRIT A institutional rule)', () => {
  it('audit.ts AuditOp union contains mv_rescue', () => {
    const text = readFileSync(join(repoRoot, 'src/audit.ts'), 'utf8');
    expect(text, `audit.ts missing '${MV_RESCUE_OP}' in AuditOp union`).toContain(`'${MV_RESCUE_OP}'`);
  });

  it('cli.ts VALID_AUDIT_OPS Set contains mv_rescue', () => {
    const text = readFileSync(join(repoRoot, 'src/cli.ts'), 'utf8');
    expect(text, `cli.ts missing '${MV_RESCUE_OP}' in VALID_AUDIT_OPS`).toContain(`'${MV_RESCUE_OP}'`);
  });

  it('server.ts VALID_AUDIT_OPS Set contains mv_rescue', () => {
    const text = readFileSync(join(repoRoot, 'src/server.ts'), 'utf8');
    expect(text, `server.ts missing '${MV_RESCUE_OP}' in VALID_AUDIT_OPS`).toContain(`'${MV_RESCUE_OP}'`);
  });
});
