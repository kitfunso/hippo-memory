// Every member-callable write route and MCP write tool, with its CD5 screen decision. WRITE_TOOLS stays complete
// because tests/cli/read-only-mode.process.test.ts:195-202 refuses any tool that writes outside it.
import { describe, expect, it } from 'vitest';
import { routeLabel, V1_ROUTES } from '../../src/surface/server/route-table.js';
import { WRITE_TOOLS } from '../../src/surface/mcp/tools.js';

const MEMBER_WRITE_ROUTES = {
  'POST /v1/memories': { screen: 'screened', gate: 'caller project' },
  'POST /v1/memories/:id/supersede': { screen: 'screened', gate: 'row origin' },
  'POST /v1/memories/:id/archive': { screen: 'no new text', gate: 'row origin' },
  'POST /v1/memories/:id/promote': {
    screen: 'no new text',
    gate: 'not gated: promote checks the caller project itself',
  },
  'DELETE /v1/memories/:id': { screen: 'no new text', gate: 'row origin' },
  'POST /v1/outcome': { screen: 'no new text', gate: 'row origin' },
  'POST /v1/vectors/nearest': { screen: 'read', gate: 'not gated: a read' },
  'DELETE /v1/auth/keys/:keyId': {
    screen: 'no new text',
    gate: 'not gated: a key row, not a memory',
  },
} satisfies Record<string, { screen: string; gate: string }>;

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

const OBJECT_KIND_GATE = 'not gated: an object carries no caller project';

const MCP_WRITE_TOOLS = {
  hippo_remember: { screen: 'screened', gate: 'caller project' },
  hippo_outcome: { screen: 'no new text', gate: 'row origin' },
  hippo_learn: { screen: 'host admin only', gate: 'not gated: host admin only' },
  hippo_resolve: { screen: 'no new text', gate: 'row origin; null for a reject' },
  hippo_share: { screen: 'no new text', gate: 'not gated: a copy, off on a shared store' },
} satisfies Record<string, { screen: string; gate: string }>;

const GATE_DECISION = /^(caller project|row origin(; null for a reject)?|not gated: .+)$/;

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

  it('gives every write a gate decision of a known form', () => {
    const decided = [...Object.values(MEMBER_WRITE_ROUTES), ...Object.values(MCP_WRITE_TOOLS)];
    for (const gate of [...decided.map((write) => write.gate), OBJECT_KIND_GATE]) {
      expect(gate).toMatch(GATE_DECISION);
    }
  });
});
