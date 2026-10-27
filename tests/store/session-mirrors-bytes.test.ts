import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeRoot } from '../_helpers/make-root.js';
import { writeActiveTaskMirror, writeRecentSessionMirror } from '../../src/store/sqlite/mirrors.js';
import type { SessionEvent, TaskSnapshot } from '../../src/base/ports/store/sessions.js';

const SNAPSHOT: TaskSnapshot = {
  id: 7,
  task: 'ship the split',
  summary: 'two files moved',
  nextStep: 'run the gates',
  status: 'active',
  source: 'test',
  sessionId: 'sess-1',
  scope: null,
  createdAt: '2026-10-27T06:00:00.000Z',
  updatedAt: '2026-10-27T06:30:00.000Z',
};

const EVENTS: SessionEvent[] = [
  {
    id: 1,
    sessionId: 'sess-1',
    task: 'ship the split',
    eventType: 'note',
    content: 'first',
    source: 'test',
    scope: null,
    metadata: {},
    createdAt: '2026-10-27T06:10:00.000Z',
  },
  {
    id: 2,
    sessionId: 'sess-1',
    task: null,
    eventType: 'tool',
    content: 'second',
    source: 'test',
    scope: null,
    metadata: {},
    createdAt: '2026-10-27T06:20:00.000Z',
  },
];

const bufferFile = (root: string, name: string): string => fs.readFileSync(path.join(root, 'buffer', name), 'utf8');

describe('session mirror bytes', () => {
  it('writes the default tenant active-task.md and recent-session.md', () => {
    const root = makeRoot('session-mirrors-default');
    writeActiveTaskMirror(root, 'default', SNAPSHOT);
    writeRecentSessionMirror(root, 'default', EVENTS);
    expect(bufferFile(root, 'active-task.md')).toBe(
      [
        '---',
        'id: 7',
        'task: ship the split',
        'status: active',
        'source: test',
        'session_id: sess-1',
        'created_at: "2026-10-27T06:00:00.000Z"',
        'updated_at: "2026-10-27T06:30:00.000Z"',
        'next_step: run the gates',
        '---',
        '',
        '# Active Task Snapshot',
        '',
        '## Summary',
        'two files moved',
        '',
        '## Next step',
        'run the gates',
        '',
        '## Task',
        'ship the split',
        '',
        '## Session',
        'sess-1',
        '',
      ].join('\n'),
    );
    expect(bufferFile(root, 'recent-session.md')).toBe(
      [
        '---',
        'session_id: sess-1',
        'task: null',
        'event_count: 2',
        'updated_at: "2026-10-27T06:20:00.000Z"',
        '---',
        '',
        '# Recent Session Trail',
        '',
        '- Session: sess-1',
        '- Task: n/a',
        '- Updated: 2026-10-27T06:20:00.000Z',
        '',
        '## Events',
        '',
        '- [2026-10-27T06:10:00.000Z] (note) first',
        '- [2026-10-27T06:20:00.000Z] (tool) second',
        '',
      ].join('\n'),
    );
  });

  it('writes a tenant-suffixed pair for another tenant', () => {
    const root = makeRoot('session-mirrors-tenant');
    writeActiveTaskMirror(root, 'acme', { ...SNAPSHOT, sessionId: null });
    writeRecentSessionMirror(root, 'acme', EVENTS.slice(1));
    expect(bufferFile(root, 'active-task.acme.md')).toBe(
      [
        '---',
        'id: 7',
        'task: ship the split',
        'status: active',
        'source: test',
        'session_id: null',
        'created_at: "2026-10-27T06:00:00.000Z"',
        'updated_at: "2026-10-27T06:30:00.000Z"',
        'next_step: run the gates',
        '---',
        '',
        '# Active Task Snapshot',
        '',
        '## Summary',
        'two files moved',
        '',
        '## Next step',
        'run the gates',
        '',
        '## Task',
        'ship the split',
        '',
      ].join('\n'),
    );
    expect(bufferFile(root, 'recent-session.acme.md')).toBe(
      [
        '---',
        'session_id: sess-1',
        'task: null',
        'event_count: 1',
        'updated_at: "2026-10-27T06:20:00.000Z"',
        '---',
        '',
        '# Recent Session Trail',
        '',
        '- Session: sess-1',
        '- Task: n/a',
        '- Updated: 2026-10-27T06:20:00.000Z',
        '',
        '## Events',
        '',
        '- [2026-10-27T06:20:00.000Z] (tool) second',
        '',
      ].join('\n'),
    );
  });
});
