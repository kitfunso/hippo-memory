/** `hippo github backfill --lessons` and the replay of a parked push, through the CLI and a fake
 * GHES on loopback. */

import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonValue } from '../../src/base/util/json.js';
import { parkInDlq } from '../../src/surface/connectors/dlq.js';
import { githubDlq } from '../../src/surface/connectors/github/dlq.js';
import { sqliteStore } from '../../src/store/sqlite/store.js';
import { SECRET } from '../_helpers/github-webhook.js';
import { startFakeGitHub, type FakeCommits, type FakeGitHub } from '../_helpers/fake-github-server.js';
import { makeStore } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { runCliAs } from '../_helpers/run-cli-as.js';

const REPO = 'acme/demo';
const SINCE = '2026-11-01T00:00:00.000Z';
const R = '1'.repeat(40);
const S = 'a'.repeat(40);
const REVERT_MESSAGE = `Revert "Add cache layer"\n\nThis reverts commit ${S}.`;
const REVERT_ITEM: JsonValue = {
  sha: R,
  commit: { message: REVERT_MESSAGE },
  parents: [{ sha: 'c'.repeat(40) }],
  author: { login: 'alice', id: 1 },
};

describe('hippo github backfill --lessons', () => {
  let base: string;
  let root: string;
  let fake: FakeGitHub | undefined;

  beforeEach(() => {
    ({ base, root } = makeStore('gh-lessons-cli'));
  });
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  async function backfill(commits: FakeCommits | undefined, ...flags: string[]) {
    fake = await startFakeGitHub(commits === undefined ? {} : { commits });
    return runCliAs(['github', 'backfill', '--repo', REPO, '--since', SINCE, ...flags], {
      cwd: base,
      env: { ...process.env, HIPPO_HOME: root, GITHUB_ENTERPRISE_URL: fake.url, GITHUB_TOKEN: 'ghp_tok' },
    });
  }
  const commitRequests = () => fake?.requests.filter((r) => r.path.includes('/commits')) ?? [];

  it('i. with the flag, prints the lesson counts beside the three streams', async () => {
    const r = await backfill({ lists: { '|': [REVERT_ITEM] } }, '--lessons');

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ lessons: { reverts: 1, codeowners: 0 } });
    expect(loadAllEntries(root, 'default').filter((e) => e.tags.includes('event:revert'))).toHaveLength(1);
  });

  it('i. without the flag, prints no lessons key and asks for no commits', async () => {
    const r = await backfill({ lists: { '|': [REVERT_ITEM] } });

    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).not.toHaveProperty('lessons');
    expect(commitRequests()).toEqual([]);
  });

  it('S10. a lesson pass that fails prints the streams with lessons null, then exits 3', async () => {
    const r = await backfill(undefined, '--lessons');

    expect(r.status).toBe(3);
    expect(JSON.parse(r.stdout)).toMatchObject({ lessons: null, ingested: { issues: 1 } });
    expect(r.stderr).toContain('the token needs Contents read on this repository');
  });
});

describe('hippo github dlq replay of a push', () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    ({ base, root } = makeStore('gh-lessons-replay'));
  });

  it('i. a parked push gives one lesson and a second replay gives none', async () => {
    const body = JSON.stringify({
      ref: 'refs/heads/main',
      repository: {
        full_name: 'acme/repo',
        private: false,
        owner: { login: 'acme' },
        name: 'repo',
        default_branch: 'main',
      },
      commits: [{ id: R, message: REVERT_MESSAGE, author: { username: 'alice' } }],
      installation: { id: 99 },
    });
    const id = await parkInDlq(githubDlq, sqliteStore(root), {
      tenantId: 'default',
      rawPayload: body,
      error: 'unroutable: installation_id=99 repo=acme/repo',
      bucket: 'unroutable',
      eventName: 'push',
      deliveryId: 'delivery-push',
      signature: `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
      installationId: '99',
      repoFullName: 'acme/repo',
    });
    const replay = () =>
      runCliAs(['github', 'dlq', 'replay', String(id)], {
        cwd: base,
        env: { ...process.env, HIPPO_HOME: root, GITHUB_WEBHOOK_SECRET: SECRET, GITHUB_WEBHOOK_SECRET_PREVIOUS: '' },
      });
    const lessons = () => loadAllEntries(root, 'default').filter((e) => e.tags.includes('event:revert'));

    const first = await replay();
    expect(first.status).toBe(0);
    expect(lessons()).toHaveLength(1);
    expect(first.stdout).toContain(`memory_id=${lessons()[0].id}`);

    expect((await replay()).status).toBe(0);
    expect(lessons()).toHaveLength(1);
  });
});
