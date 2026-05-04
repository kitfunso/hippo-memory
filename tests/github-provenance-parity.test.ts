/**
 * Task 17: Provenance gate parity check.
 *
 * After ingesting a batch of GitHub events, every kind='raw' row must satisfy
 * the same envelope contract Slack rows do: owner + artifact_ref populated,
 * coverage 1.0. This guards against a future transform regression silently
 * dropping the `user:github:<login>` owner stamp and slipping past CI.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, loadAllEntries } from '../src/store.js';
import { ingestEvent, type IngestEvent } from '../src/connectors/github/ingest.js';
import { buildProvenanceCoverage } from '../src/provenance-coverage.js';
import type {
  GitHubIssueEvent,
  GitHubIssueCommentEvent,
} from '../src/connectors/github/types.js';
import type { Context } from '../src/api.js';

const PUBLIC_REPO = {
  full_name: 'acme/public-repo',
  private: false,
  owner: { login: 'acme' },
  name: 'public-repo',
} as const;

function ctxFor(root: string): Context {
  return { hippoRoot: root, tenantId: 'default', actor: 'connector:github' };
}

function makeIssue(i: number): IngestEvent {
  const payload: GitHubIssueEvent = {
    action: 'opened',
    repository: { ...PUBLIC_REPO },
    issue: {
      number: 100 + i,
      title: `prov-issue-${i}`,
      body: `body ${i}`,
      user: { login: `user${i}`, id: i + 1 },
    },
  };
  return { eventName: 'issues', payload };
}

function makeIssueComment(i: number): IngestEvent {
  const payload: GitHubIssueCommentEvent = {
    action: 'created',
    repository: { ...PUBLIC_REPO },
    issue: { number: 200 + i },
    comment: {
      id: 7000 + i,
      body: `prov-comment-${i}`,
      user: { login: `user${i}`, id: i + 1 },
    },
  };
  return { eventName: 'issue_comment', payload };
}

describe('GitHub connector — provenance coverage parity', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hippo-gh-prov-'));
    mkdirSync(join(root, '.hippo'), { recursive: true });
    initStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('every ingested GitHub raw row carries owner + artifact_ref (coverage = 1.0)', () => {
    const ctx = ctxFor(root);
    // 25 issues + 25 comments = 50 raw rows, all distinct artifact_refs.
    for (let i = 0; i < 25; i++) {
      const ev = makeIssue(i);
      ingestEvent(ctx, {
        event: ev,
        rawBody: JSON.stringify(ev.payload),
        deliveryId: `iss-${i}`,
      });
    }
    for (let i = 0; i < 25; i++) {
      const ev = makeIssueComment(i);
      ingestEvent(ctx, {
        event: ev,
        rawBody: JSON.stringify(ev.payload),
        deliveryId: `com-${i}`,
      });
    }

    const entries = loadAllEntries(root);
    const coverage = buildProvenanceCoverage(entries);

    expect(coverage.rawTotal).toBeGreaterThanOrEqual(50);
    expect(coverage.gaps).toHaveLength(0);
    expect(coverage.rawWithEnvelope).toBe(coverage.rawTotal);
    expect(coverage.coverage).toBe(1);

    // GitHub-specific: at least 50 rows are tagged source:github, and every
    // such row has a non-null owner shaped `user:github:<login>`.
    const githubEntries = entries.filter(
      (e) => e.kind === 'raw' && e.tags.includes('source:github'),
    );
    expect(githubEntries.length).toBeGreaterThanOrEqual(50);
    for (const e of githubEntries) {
      expect(e.owner).not.toBeNull();
      expect(e.owner).toMatch(/^user:github:/);
      expect(e.artifact_ref).not.toBeNull();
      expect(e.artifact_ref?.startsWith('github://')).toBe(true);
    }
  });
});
