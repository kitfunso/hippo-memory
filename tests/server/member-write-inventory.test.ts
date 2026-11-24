// Every member-callable write route and MCP write tool, with its CD5 screen decision. WRITE_TOOLS stays complete
// because tests/cli/read-only-mode.process.test.ts:195-202 refuses any tool that writes outside it.
import { describe, expect, it } from 'vitest';
import { routeLabel, V1_ROUTES } from '../../src/surface/server/route-table.js';
import { WRITE_TOOLS } from '../../src/surface/mcp/tools.js';

const MEMBER_WRITE_ROUTES = {
  'POST /v1/memories': 'screened',
  'POST /v1/memories/:id/supersede': 'screened',
  'POST /v1/memories/:id/archive': 'no new text',
  'POST /v1/memories/:id/promote': 'no new text',
  'DELETE /v1/memories/:id': 'no new text',
  'POST /v1/outcome': 'no new text',
  'POST /v1/vectors/nearest': 'read',
  'DELETE /v1/auth/keys/:keyId': 'no new text',
} satisfies Record<string, string>;

// Follow-up O1: each kind writes a mirror memory with a null scope that no screen runs on yet.
const OBJECT_KINDS = [
  '/v1/predictions',
  '/v1/decisions',
  '/v1/incidents',
  '/v1/processes',
  '/v1/policies',
  '/v1/skills',
  '/v1/project-briefs',
  '/v1/customer-notes',
];

const MCP_WRITE_TOOLS = {
  hippo_remember: 'screened',
  hippo_outcome: 'no new text',
  hippo_learn: 'host admin only',
  hippo_resolve: 'no new text',
  hippo_share: 'no new text',
} satisfies Record<string, string>;

const memberWrites = V1_ROUTES.filter(
  (route) => (route.auth === 'viewer' || route.auth === 'editor') && route.method !== 'GET',
);
const isObjectRoute = (route: (typeof V1_ROUTES)[number]): boolean => route.storeReady === 'objects';

describe('the member write inventory', () => {
  it('classifies every member-callable route that is not an object kind', () => {
    const keys = memberWrites
      .filter((route) => !isObjectRoute(route))
      .map((route) => `${route.method} ${routeLabel(route)}`)
      .sort();

    expect(keys).toEqual(Object.keys(MEMBER_WRITE_ROUTES).sort());
  });

  it('names the kind of every object route', () => {
    const objectRows = memberWrites.filter(isObjectRoute);

    expect(objectRows.length).toBeGreaterThan(0);
    for (const route of objectRows) {
      const label = routeLabel(route);
      expect(
        OBJECT_KINDS.some((kind) => label === kind || label.startsWith(`${kind}/`)),
        label,
      ).toBe(true);
    }
  });

  it('classifies every MCP write tool', () => {
    expect([...WRITE_TOOLS].sort()).toEqual(Object.keys(MCP_WRITE_TOOLS).sort());
  });
});
