// The error reply of each typed-object route for a bad request, one table row per case.
import { describe, it, expect } from 'vitest';
import { handle, useObjectsServer, authHeaders } from '../_helpers/http-objects-server.js';
import {
  type Reply,
  DECISION_REPLIES,
  NOTE_REPLIES,
  INCIDENT_REPLIES,
  POLICY_REPLIES,
} from '../_helpers/http-objects-replies-a.js';
import { PROCESS_REPLIES, BRIEF_REPLIES, SKILL_REPLIES } from '../_helpers/http-objects-replies-b.js';

useObjectsServer();

function named(kind: string, rows: readonly Reply[]): Reply[] {
  return rows.map(([name, method, path, body, status, error]) => [
    `${kind} ${name}`,
    method,
    path,
    body,
    status,
    error,
  ]);
}

const REPLIES: readonly Reply[] = [
  ...named('decision', DECISION_REPLIES),
  ...named('customer note', NOTE_REPLIES),
  ...named('incident', INCIDENT_REPLIES),
  ...named('policy', POLICY_REPLIES),
  ...named('process', PROCESS_REPLIES),
  ...named('project brief', BRIEF_REPLIES),
  ...named('skill', SKILL_REPLIES),
];

describe('HTTP typed-object replies', () => {
  it.each(REPLIES)('%s', async (_name, method, path, body, status, error) => {
    const init = { method, headers: authHeaders(), body: body && JSON.stringify(body) };
    const res = await fetch(`${handle.url}${path}`, init);
    expect([res.status, await res.text()]).toEqual([status, JSON.stringify({ error })]);
  });
});
