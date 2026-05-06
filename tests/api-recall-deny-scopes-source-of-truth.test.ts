/**
 * v1.7.2 T2 — RECALL_DEFAULT_DENY_SCOPES is the single source of truth.
 *
 * Pre-T2: SQL clause in loadSearchRows hardcodes `m.scope != 'unknown:legacy'`;
 * JS `passesScopeFilterForRecall` independently checks `scope === 'unknown:legacy'`.
 * Two places to update if the deny list grows.
 *
 * T2: extract `RECALL_DEFAULT_DENY_SCOPES` as a const array. SQL reads it
 * via NOT IN (?, ...) bindings; JS reads via .includes(). This test pins
 * that adding a scope to the constant correctly excludes it from the JS
 * path; corresponding SQL coverage is via the existing
 * api-recall-unknown-legacy-filter.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { RECALL_DEFAULT_DENY_SCOPES } from '../src/store.js';
import { passesScopeFilterForRecall } from '../src/api.js';

describe('RECALL_DEFAULT_DENY_SCOPES — single source of truth (v1.7.2 T2)', () => {
  it('every literal in the constant is excluded by passesScopeFilterForRecall when no scope is requested', () => {
    for (const scope of RECALL_DEFAULT_DENY_SCOPES) {
      expect(passesScopeFilterForRecall(scope, undefined)).toBe(false);
    }
  });

  it('every literal in the constant is admitted when explicitly requested', () => {
    for (const scope of RECALL_DEFAULT_DENY_SCOPES) {
      expect(passesScopeFilterForRecall(scope, scope)).toBe(true);
    }
  });

  it('contains unknown:legacy at v1.7.2 ship time (regression-pin)', () => {
    expect(RECALL_DEFAULT_DENY_SCOPES).toContain('unknown:legacy');
  });

  it('is non-empty (codex P1-5: empty list silently allows quarantine)', () => {
    // Module-load invariant: blanking the array silently allows
    // unknown:legacy through. Pin loudly so a maintainer sees the test fail.
    expect(RECALL_DEFAULT_DENY_SCOPES.length).toBeGreaterThan(0);
  });
});
