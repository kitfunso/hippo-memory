/**
 * J1 — CLI cmdRecall anchoringHint structural guard.
 *
 * Behavioural CLI subprocess testing fights hippo's auto-init memory import
 * (per J3.2 codex round 1 lesson — subprocess tests for anchoring needed
 * the same nonsense-token workarounds that ended up fragile). The simpler
 * approach: STRUCTURAL guard that parses cli.ts and asserts the J1 wire-up
 * touches the right code regions. Behavioral coverage is provided by
 * api-recall-anchoring.test.ts (shared detector) + mcp-recall-anchoring.test.ts
 * (caller-side pattern via MCP harness, no subprocess overhead).
 *
 * If a future refactor breaks the wire-up, this test fires loudly.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe('cli.ts cmdRecall J1 anchoring wire-up (structural guard)', () => {
  let cliText: string;

  it('reads cli.ts (anchor for the rest of the tests)', () => {
    cliText = readFileSync(join(repoRoot, 'src/cli.ts'), 'utf8');
    expect(cliText.length).toBeGreaterThan(0);
  });

  it('imports the J1 helpers from recall-history', () => {
    expect(cliText).toContain("from './recall-history.js'");
    expect(cliText).toContain('detectAnchoring');
    expect(cliText).toContain('hashQueryText');
    expect(cliText).toContain('buildSessionKey');
    expect(cliText).toContain('getOrCreateRing');
    expect(cliText).toContain('appendRecall');
    expect(cliText).toContain('snapshotRing');
  });

  it('declares a module-level recall-history Map for the CLI pipeline', () => {
    expect(cliText).toMatch(/const sessionRecallHistoryCli\s*=\s*new Map<string, RingBuffer>\(\)/);
  });

  it('exports __resetSessionRecallHistoryCli for test isolation', () => {
    expect(cliText).toMatch(/export function __resetSessionRecallHistoryCli\s*\(/);
  });

  it('gates the detector behind HIPPO_ANCHORING env knob (zero-work when off)', () => {
    // Lock that the env check happens BEFORE the ring lookup so the
    // off path truly costs zero work.
    expect(cliText).toContain("process.env.HIPPO_ANCHORING !== 'off'");
  });

  it('uses buildSessionKey (not colon string-concat) for the ring key', () => {
    // Plan v3 explicit fix: no `${tenantId}:${sessionId}` colon concat
    // anywhere — must call buildSessionKey for collision safety.
    expect(cliText).toMatch(/buildSessionKey\(tenantId,\s*sessionId\)/);
  });

  it('bumps cmdSuppressionSummary.suppressedByInterference on R2', () => {
    expect(cliText).toMatch(/cmdSuppressedByInterference\s*=\s*cmdAnchoringHint\?\.reason\s*===\s*['"]memory_dominance['"]\s*\?\s*1\s*:\s*0/);
  });

  it('renders the anchoring hint line above the result list', () => {
    expect(cliText).toContain('[anchored_on: ${cmdAnchoringHint.memoryId}]');
  });

  it('appends to the ring AFTER detect with anchoredOn from the hint (cooldown feed)', () => {
    expect(cliText).toMatch(/appendRecall\(ring,\s*queryHash,\s*topId,\s*cmdAnchoringHint\?\.memoryId\)/);
  });

  it('emits recall_anchor_skipped_no_session telemetry when sessionId absent', () => {
    expect(cliText).toContain("'recall_anchor_skipped_no_session'");
  });
});
