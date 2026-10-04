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
  let recordText: string;

  it('reads the recall verb module and the recall record module (anchor for the rest of the tests)', () => {
    cliText = readFileSync(join(repoRoot, 'src/cli/recall.ts'), 'utf8');
    recordText = readFileSync(join(repoRoot, 'src/api/recall-record.ts'), 'utf8');
    expect(cliText.length).toBeGreaterThan(0);
    expect(recordText.length).toBeGreaterThan(0);
  });

  it('imports the detector from recall-history and the ring from recall-record', () => {
    expect(cliText).toContain("from '../recall-history.js'");
    expect(cliText).toContain('detectAnchoring');
    expect(cliText).toContain('hashQueryText');
    expect(cliText).toContain('snapshotRing');
    expect(cliText).toContain("from '../api/recall-record.js'");
  });

  it('keys the CLI ring by surface, tenant and session', () => {
    expect(cliText).toMatch(/sessionRing\('cli',\s*tenantId,\s*sessionId\)/);
  });

  it('exports __resetSessionRecallHistoryCli for test isolation', () => {
    expect(cliText).toMatch(/export function __resetSessionRecallHistoryCli\s*\(/);
  });

  it('gates the ring behind HIPPO_ANCHORING before any lookup, keyed with buildSessionKey', () => {
    const ringFn = recordText.slice(recordText.indexOf('export function sessionRing('), recordText.indexOf('export function peekSessionRing('));
    expect(ringFn.indexOf("biasHintEnabled('anchoring')")).toBeGreaterThan(-1);
    expect(ringFn.indexOf("biasHintEnabled('anchoring')")).toBeLessThan(ringFn.indexOf('getOrCreateRing('));
    expect(ringFn).toMatch(/buildSessionKey\(tenantId,\s*sessionId\)/);
  });

  it('bumps cmdSuppressionSummary.suppressedByInterference on R2', () => {
    expect(cliText).toMatch(/suppressedByInterference:\s*anchoring\?\.reason\s*===\s*['"]memory_dominance['"]\s*\?\s*1\s*:\s*0/);
  });

  it('renders the anchoring hint line above the result list', () => {
    expect(cliText).toContain('[anchored_on: ${h.anchoring.memoryId}]');
    expect(cliText.indexOf('[anchored_on: ${h.anchoring.memoryId}]')).toBeLessThan(cliText.indexOf('console.log(recallHeading('));
  });

  it('feeds the ring after the final detect, with anchoredOn from the shown hint (cooldown feed)', () => {
    expect(cliText).toMatch(/recordShownRecall\(who,\s*\{\s*query,\s*ring:\s*fit\.anchorRing,\s*topId:\s*results\[0\]\?\.entry\.id \?\? null,\s*anchoring:\s*hints\.anchoring/);
    expect(recordText).toMatch(/noteRecall\(shown\.ring,\s*shown\.query,\s*shown\.topId,\s*shown\.anchoring\?\.memoryId\)/);
  });

  it('emits recall_anchor_skipped_no_session telemetry when sessionId absent', () => {
    expect(recordText).toContain("'recall_anchor_skipped_no_session'");
  });
});
