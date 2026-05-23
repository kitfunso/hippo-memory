/**
 * Type-level contract tests for the api.ts refactor (Episode A, Task 2).
 *
 * Assert the public shape of `getContext`, `sleep`, and
 * `outcomeForLastRecall` exists in `src/api.ts`. Runtime behavior is
 * covered separately in:
 *   - tests/api-outcome-for-last-recall.test.ts (Task 3)
 *   - tests/api-sleep.test.ts (Task 4)
 *   - tests/api-context.test.ts (Task 5)
 *   - tests/cli-context-render-snapshot.test.ts (Task 5 CLI byte-identical gate)
 */

import { describe, it, expectTypeOf } from 'vitest';
import type {
  Context,
  ContextOpts,
  ContextResult,
  ContextResultEntry,
  SleepOpts,
  SleepResult,
} from '../src/api.js';
import { getContext, sleep, outcomeForLastRecall } from '../src/api.js';

describe('api contract types — Episode A scaffolding', () => {
  it('getContext is an async function returning ContextResult', () => {
    expectTypeOf(getContext).toBeFunction();
    expectTypeOf(getContext).parameter(0).toMatchTypeOf<Context>();
    expectTypeOf(getContext).parameter(1).toMatchTypeOf<ContextOpts | undefined>();
    expectTypeOf(getContext).returns.toMatchTypeOf<Promise<ContextResult>>();
  });

  it('sleep is an async function returning SleepResult', () => {
    expectTypeOf(sleep).toBeFunction();
    expectTypeOf(sleep).parameter(0).toMatchTypeOf<Context>();
    expectTypeOf(sleep).parameter(1).toMatchTypeOf<SleepOpts | undefined>();
    expectTypeOf(sleep).returns.toMatchTypeOf<Promise<SleepResult>>();
  });

  it('outcomeForLastRecall returns { applied, ids }', () => {
    expectTypeOf(outcomeForLastRecall).toBeFunction();
    expectTypeOf(outcomeForLastRecall).parameter(0).toMatchTypeOf<Context>();
    expectTypeOf(outcomeForLastRecall).parameter(1).toMatchTypeOf<boolean>();
    expectTypeOf(outcomeForLastRecall).returns.toMatchTypeOf<{
      applied: number;
      ids: string[];
    }>();
  });

  it('ContextOpts exposes the data-loading flag set (rendering opts CLI-only)', () => {
    expectTypeOf<ContextOpts>().toMatchTypeOf<{
      q?: string;
      budget?: number;
      limit?: number;
      pinnedOnly?: boolean;
      scope?: string;
      includeRecent?: number;
    }>();
  });

  it('SleepOpts exposes dryRun + noShare (auto-learn is CLI-only)', () => {
    expectTypeOf<SleepOpts>().toMatchTypeOf<{
      dryRun?: boolean;
      noShare?: boolean;
    }>();
  });

  it('ContextResultEntry exposes entry + score + tokens', () => {
    expectTypeOf<ContextResultEntry>().toMatchTypeOf<{
      score: number;
      tokens: number;
      isGlobal?: boolean;
      isFreshTail?: boolean;
    }>();
  });

  it('SleepResult exposes the consolidation counters', () => {
    expectTypeOf<SleepResult>().toMatchTypeOf<{
      active: number;
      removed: number;
      mergedEpisodic: number;
      newSemantic: number;
      dryRun: boolean;
    }>();
  });
});
