import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ServerHandle } from '../../src/server.js';
import { routeLabel, V1_ROUTES } from '../../src/surface/server/route-table.js';
import { serveAsAdmin } from '../_helpers/admin-server.js';
import { makeRoot } from '../_helpers/make-root.js';
import { needsHippoDb } from '../_helpers/store-switch.js';

const METHODS = ['GET', 'POST', 'DELETE', 'PUT'] as const;

const ROWS = [
  'POST /v1/memories',
  'GET /v1/graph',
  'GET /v1/memories',
  'GET /v1/sessions/:id/assemble',
  'GET /v1/recall/drill/:id',
  'POST /v1/memories/:id/archive',
  'POST /v1/memories/:id/supersede',
  'POST /v1/memories/:id/promote',
  'DELETE /v1/memories/:id',
  'POST /v1/outcome',
  'GET /v1/context',
  'POST /v1/vectors/nearest',
  'POST /v1/sleep',
  'POST /v1/auth/keys',
  'GET /v1/auth/keys',
  'DELETE /v1/auth/keys/:keyId',
  'POST /v1/auth/keys/:keyId/grants',
  'DELETE /v1/auth/keys/:keyId/grants',
  'GET /v1/quarantine',
  'POST /v1/quarantine/:id/approve',
  'POST /v1/quarantine/:id/reject',
  'POST /v1/quarantine/:id/edit',
  'GET /v1/audit',
  'POST /v1/predictions',
  'GET /v1/predictions',
  'GET /v1/predictions/stats',
  'GET /v1/predictions/:id',
  'POST /v1/predictions/:id/close',
  ...['decisions', 'processes', 'policies', 'skills', 'project-briefs', 'customer-notes'].flatMap((kind) => [
    `POST /v1/${kind}`,
    `GET /v1/${kind}`,
    `POST /v1/${kind}/:id/supersede`,
    `POST /v1/${kind}/:id/close`,
    `GET /v1/${kind}/:id`,
  ]),
  'POST /v1/incidents',
  'GET /v1/incidents',
  'POST /v1/incidents/:id/resolve',
  'POST /v1/incidents/:id/close',
  'GET /v1/incidents/:id',
  'GET /v1/policies/asof',
  'GET /v1/skills/export',
  'POST /v1/project-briefs/refresh',
  'POST /v1/connectors/slack/events',
  'POST /v1/connectors/github/events',
];

const IDS = ['1', '007', 'abc', '-1', '%31', ''];

function pathsOf(template: string): string[] {
  if (!template.includes(':')) return [template, `${template}/`];
  const fill = (id: string): string => template.replace(/:[A-Za-z]+/g, id);
  return [...IDS.map(fill), `${fill('1')}/`];
}

async function replyLine(base: string, method: string, path: string): Promise<string> {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' } });
  const text = await res.text();
  const body: { error?: string } = text.length === 0 ? {} : JSON.parse(text);
  return `${method} ${path} -> ${res.status}${body.error === undefined ? '' : ` ${body.error}`}`;
}

const TEMPLATES = [...new Set(ROWS.map((row) => row.slice(row.indexOf(' ') + 1)))];
const fileStem = (template: string): string =>
  template
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();

describe('every /v1 route shape under every method', () => {
  let handle: ServerHandle;

  beforeAll(async () => {
    vi.stubEnv('HIPPO_V1_RPS', '0');
    vi.stubEnv('HIPPO_HOME', makeRoot('route-shapes-global'));
    handle = await serveAsAdmin({ hippoRoot: makeRoot('route-shapes'), port: 0 });
  });

  afterAll(async () => {
    await handle.stop();
    vi.unstubAllEnvs();
  });

  it('lists every row of the table', () => {
    const rows = V1_ROUTES.map((route) => `${route.method} ${routeLabel(route)}`);
    expect([...rows].sort()).toEqual([...ROWS].sort());
  });

  const eachTemplate = needsHippoDb('team') ? it.skip.each(TEMPLATES) : it.each(TEMPLATES);
  eachTemplate('answers %s with the same status and error text', async (template) => {
    const lines: string[] = [];
    for (const path of pathsOf(template)) {
      for (const method of METHODS) lines.push(await replyLine(handle.url, method, path));
    }
    await expect(`${lines.join('\n')}\n`).toMatchFileSnapshot(`./__snapshots__/route-shapes/${fileStem(template)}.txt`);
  });
});
