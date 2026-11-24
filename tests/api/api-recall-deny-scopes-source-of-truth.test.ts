import { describe, it, expect } from 'vitest';
import { RECALL_DEFAULT_DENY_SCOPES } from '../../src/base/scope/recall-scope.js';
import { passesScopeFilterForRecall } from '../../src/api/index.js';

describe('RECALL_DEFAULT_DENY_SCOPES: single source of truth', () => {
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

  it('contains unknown:legacy (regression pin)', () => {
    expect(RECALL_DEFAULT_DENY_SCOPES).toContain('unknown:legacy');
  });
});
