/**
 * J3.2 — CLI parity guard for the zero-memory-results branch (codex
 * review round 1 catch).
 *
 * Codex flagged: cmdRecall computes cmdPlanningFallacyHint but only
 * rendered it in the populated-results branch. The early
 * `results.length === 0` return silently dropped the hint, breaking
 * parity with HTTP/MCP which surface it regardless of memory matches.
 *
 * A behavioural subprocess test fights hippo's hybrid memory pattern:
 * savePrediction creates a memory mirror tagged with the class_tag, so
 * any query that resolves the class via class_tag overlap will also
 * surface the mirror in BM25 recall (because the tag matches). Forcing
 * the zero-memory case while keeping the class resolvable would
 * require deleting the mirrors AND the recall-index state AND the
 * physics-store mirrors — too brittle to maintain. Codex's underlying
 * scenario ("after the prediction mirror has been forgotten") is real
 * but the test environment can't isolate it cleanly.
 *
 * Instead, this is a STRUCTURAL guard: parse cli.ts and assert the
 * zero-result branch references `cmdPlanningFallacyHint` in both the
 * JSON output object AND the text render block. If a future refactor
 * removes the guards, this fails loudly. The behavioural path is
 * covered end-to-end by api-recall-autodebias.test.ts (the orchestrator
 * returns the right hint object regardless of memory matches) +
 * mcp/http-recall-autodebias.test.ts (the response-side serialisation).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe('cli.ts cmdRecall zero-result branch preserves planningFallacyHint (J3.2 codex round-1 guard)', () => {
  let cliText: string;
  let zeroResultBlock: string;

  it('the codex-catch comment is present (anchor)', () => {
    cliText = readFileSync(join(repoRoot, 'src/cli.ts'), 'utf8');
    expect(cliText).toContain('Codex review round 1 catch');
  });

  it('isolate the zero-result block by line range', () => {
    // Find the `if (results.length === 0) {` block and slice ~50 lines.
    // Captures the JSON + text early-return paths the codex fix targets.
    const startIdx = cliText.indexOf('if (results.length === 0)');
    expect(startIdx).toBeGreaterThan(0);
    zeroResultBlock = cliText.slice(startIdx, startIdx + 3000);
  });

  it('zero-result JSON output spreads planningFallacyHint when truthy', () => {
    // Lock the exact spread pattern that codex's fix added. A future
    // refactor that drops the spread will trip this test.
    expect(zeroResultBlock).toMatch(/cmdPlanningFallacyHint\s*\?\s*\{\s*planningFallacyHint:\s*cmdPlanningFallacyHint/);
  });

  it('zero-result text render path emits the Planning fallacy hint line', () => {
    // The text-output branch (continuity OR plain no-memories print)
    // must call the hint render BEFORE the no-memories message.
    expect(zeroResultBlock).toContain('if (cmdPlanningFallacyHint)');
    expect(zeroResultBlock).toContain('Planning fallacy hint');
  });

  it('detectedPhrase is sanitised via JSON.stringify on the zero-result text path', () => {
    // Plan-eng-critic round 2 LOW + codex hardening: regex match text
    // could contain quotes/parens; JSON.stringify keeps the render
    // unambiguous regardless of input shape.
    expect(zeroResultBlock).toMatch(/JSON\.stringify\(cmdPlanningFallacyHint\.detectedPhrase\)/);
  });
});
