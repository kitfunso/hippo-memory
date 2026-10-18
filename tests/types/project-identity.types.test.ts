/** The types an integrator sees from `hippo-memory/project-identity` (src/entry/project-identity.ts). */

import { typeOnly } from './_type-only.js';
import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  MAX_PROJECT_ALIASES,
  MCP_PROJECT_SCOPED_HEADER,
  resolveProjectIdentity,
  type ProjectIdentity,
  type ResolveProjectIdentityOpts,
} from '../../src/entry/project-identity.js';

describe('hippo-memory/project-identity entry types', () => {
  it('resolveProjectIdentity takes an optional cwd and options and returns a ProjectIdentity', () => {
    expectTypeOf(resolveProjectIdentity).parameters.toEqualTypeOf<[cwd?: string, opts?: ResolveProjectIdentityOpts]>();
    expectTypeOf(resolveProjectIdentity).returns.toEqualTypeOf<ProjectIdentity>();
    // @ts-expect-error the working directory is a string
    typeOnly(() => resolveProjectIdentity(42));
    // @ts-expect-error the options come second
    typeOnly(() => resolveProjectIdentity({ homeDir: '/h' }));
  });

  it('ProjectIdentity pins the fields a caller reads', () => {
    expectTypeOf<ProjectIdentity['root']>().toEqualTypeOf<string>();
    expectTypeOf<ProjectIdentity['name']>().toEqualTypeOf<string>();
    expectTypeOf<ProjectIdentity['legacyName']>().toEqualTypeOf<string>();
    expectTypeOf<ProjectIdentity['aliases']>().toEqualTypeOf<readonly string[] | undefined>();
  });

  it('ResolveProjectIdentityOpts holds two optional directories', () => {
    expectTypeOf<ResolveProjectIdentityOpts>().toEqualTypeOf<{ homeDir?: string; stopDir?: string }>();
  });

  it('the constants keep their literal types', () => {
    expectTypeOf<typeof MAX_PROJECT_ALIASES>().toEqualTypeOf<10>();
    expectTypeOf<typeof MCP_PROJECT_SCOPED_HEADER>().toEqualTypeOf<'X-Hippo-Project-Scoped'>();
    expect(MAX_PROJECT_ALIASES).toBe(10);
  });
});
