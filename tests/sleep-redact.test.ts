/**
 * D1 v1.12.10 — redactSleepResultForCaller helper tests.
 */

import { describe, it, expect } from 'vitest';
import type { SleepResult } from '../src/api.js';
import { redactSleepResultForCaller } from '../src/sleep-redact.js';

function fullResult(): SleepResult {
  return {
    active: 100,
    removed: 5,
    mergedEpisodic: 10,
    newSemantic: 3,
    dryRun: false,
    deduped: { removed: 5, semDups: 12, epiDups: 8, crossDups: 4 },
    audit: { errorsRemoved: 2, warningCount: 7 },
    ambient: { totalMemories: 999, avgStrength: 0.73 },
    shared: 3,
    details: ['Merged: 3 entries about caching'],
  };
}

describe('redactSleepResultForCaller', () => {
  it('loopback caller: pass-through unchanged', () => {
    const r = fullResult();
    const out = redactSleepResultForCaller(r, { isLoopback: true, callerTenant: 'acme' });
    expect(out).toEqual(r);
  });

  it('__host__ caller: pass-through unchanged (system-reserved tenant)', () => {
    const r = fullResult();
    const out = redactSleepResultForCaller(r, { isLoopback: false, callerTenant: '__host__' });
    expect(out).toEqual(r);
  });

  it('non-loopback non-self admin: redacts cross-tenant counters', () => {
    const r = fullResult();
    const out = redactSleepResultForCaller(r, { isLoopback: false, callerTenant: 'acme' });

    // Per-invocation counters preserved (not cross-tenant accounting).
    expect(out.active).toBe(100);
    expect(out.removed).toBe(5);
    expect(out.mergedEpisodic).toBe(10);
    expect(out.newSemantic).toBe(3);
    expect(out.dryRun).toBe(false);
    expect(out.shared).toBe(3);
    expect(out.details).toEqual(['Merged: 3 entries about caching']);

    // Cross-tenant counters redacted to zero.
    expect(out.deduped?.crossDups).toBe(0);
    expect(out.deduped?.semDups).toBe(0);
    expect(out.deduped?.epiDups).toBe(0);
    expect(out.audit?.errorsRemoved).toBe(0);
    expect(out.audit?.warningCount).toBe(0);
    expect(out.ambient?.totalMemories).toBe(0);
    expect(out.ambient?.avgStrength).toBe(0);

    // .removed inside deduped is per-invocation work, preserved.
    expect(out.deduped?.removed).toBe(5);
  });

  it('preserves missing optional shape sections (deduped/audit/ambient undefined)', () => {
    const minimal: SleepResult = {
      active: 5, removed: 0, mergedEpisodic: 0, newSemantic: 0, dryRun: true,
    };
    const out = redactSleepResultForCaller(minimal, { isLoopback: false, callerTenant: 'acme' });
    expect(out).toEqual(minimal);
    expect(out.deduped).toBeUndefined();
    expect(out.audit).toBeUndefined();
    expect(out.ambient).toBeUndefined();
  });

  it('does not mutate the input', () => {
    const r = fullResult();
    const before = JSON.stringify(r);
    redactSleepResultForCaller(r, { isLoopback: false, callerTenant: 'acme' });
    expect(JSON.stringify(r)).toBe(before);
  });
});
