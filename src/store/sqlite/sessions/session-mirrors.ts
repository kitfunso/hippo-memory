// The buffer files that mirror the active task snapshot and the recent session trail, per tenant.

import { DEFAULT_TENANT_ID } from '../../../base/util/tenant.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dumpFrontmatter } from '../../../base/util/yaml.js';
import type { TaskSnapshot, SessionEvent } from '../../../base/records/sessions.js';
import { PRIVATE_DIR } from '../../../host/private-dir.js';
import { writeMirror } from '../folder-files/mirrors.js';

// Tenant-scoped mirror paths: the 'default' tenant keeps the original `active-task.md` / `recent-session.md` names;
// other tenants get a `.<tenantId>` suffix so one cannot overwrite another's mirror.
function activeTaskMirrorPath(hippoRoot: string, tenantId: string): string {
  const file = tenantId === DEFAULT_TENANT_ID ? 'active-task.md' : `active-task.${tenantId}.md`;
  return path.join(hippoRoot, 'buffer', file);
}

function recentSessionMirrorPath(hippoRoot: string, tenantId: string): string {
  const file =
    tenantId === DEFAULT_TENANT_ID ? 'recent-session.md' : `recent-session.${tenantId}.md`;
  return path.join(hippoRoot, 'buffer', file);
}

export function writeActiveTaskMirror(
  hippoRoot: string,
  tenantId: string,
  snapshot: TaskSnapshot,
): void {
  const filePath = activeTaskMirrorPath(hippoRoot, tenantId);
  const fm = dumpFrontmatter({
    id: snapshot.id,
    task: snapshot.task,
    status: snapshot.status,
    source: snapshot.source,
    session_id: snapshot.sessionId,
    created_at: snapshot.createdAt,
    updated_at: snapshot.updatedAt,
    next_step: snapshot.nextStep,
  });

  const body = [
    `# Active Task Snapshot`,
    '',
    `## Summary`,
    snapshot.summary,
    '',
    `## Next step`,
    snapshot.nextStep,
    '',
    `## Task`,
    snapshot.task,
    '',
  ];

  if (snapshot.sessionId) {
    body.push(`## Session`, snapshot.sessionId, '');
  }

  fs.mkdirSync(path.dirname(filePath), PRIVATE_DIR);
  writeMirror(filePath, `${fm}\n\n${body.join('\n')}`);
}

export function removeActiveTaskMirror(hippoRoot: string, tenantId: string): void {
  const filePath = activeTaskMirrorPath(hippoRoot, tenantId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function writeRecentSessionMirror(
  hippoRoot: string,
  tenantId: string,
  events: SessionEvent[],
): void {
  const filePath = recentSessionMirrorPath(hippoRoot, tenantId);
  if (events.length === 0) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    return;
  }

  const latest = events[events.length - 1]!;
  const fm = dumpFrontmatter({
    session_id: latest.sessionId,
    task: latest.task,
    event_count: events.length,
    updated_at: latest.createdAt,
  });

  const lines = [
    '# Recent Session Trail',
    '',
    `- Session: ${latest.sessionId}`,
    `- Task: ${latest.task ?? 'n/a'}`,
    `- Updated: ${latest.createdAt}`,
    '',
    '## Events',
    '',
  ];

  for (const event of events) {
    lines.push(`- [${event.createdAt}] (${event.eventType}) ${event.content}`);
  }

  lines.push('');

  fs.mkdirSync(path.dirname(filePath), PRIVATE_DIR);
  writeMirror(filePath, `${fm}\n\n${lines.join('\n')}`);
}
