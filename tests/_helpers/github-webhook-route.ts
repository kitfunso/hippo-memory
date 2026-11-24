// The signed requests and event bodies the GitHub webhook route tests post.
import { createHmac } from 'node:crypto';
import type { DatabaseSyncLike } from '../../src/db/index.js';

export const SECRET = 'github-webhook-secret';

/** Query a single row from the hippo SQLite handle. */
export function queryOne<T>(db: DatabaseSyncLike, sql: string): T {
  // SAFETY: sql is a literal SELECT against known hippo schema columns; the
  // row shape is declared by the generic type argument at each call site and
  // checked immediately by the assertions that follow.
  return db.prepare(sql).get() as T;
}

export function sign(body: string, secret: string = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function postWebhook(port: number, body: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/connectors/github/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

export function defaultHeaders(body: string, eventName: string, deliveryId: string) {
  return {
    'x-hub-signature-256': sign(body),
    'x-github-event': eventName,
    'x-github-delivery': deliveryId,
  };
}

export interface IssueBodyOptions {
  action?: string;
  number?: number;
  installationId?: number | null;
  repoFullName?: string;
}

interface GitHubIssueEventPayload {
  action: string;
  issue: {
    number: number;
    title: string;
    body: string;
    user: { login: string; id: number };
    author_association?: string;
  };
  repository: { full_name: string; private: boolean; owner: { login: string }; name: string };
  sender: { login: string; id: number };
  installation?: { id: number };
}

export function issueBody(opts: IssueBodyOptions = {}): string {
  const obj: GitHubIssueEventPayload = {
    action: opts.action ?? 'opened',
    issue: {
      number: opts.number ?? 42,
      title: 'Bug',
      body: 'broken',
      user: { login: 'alice', id: 1 },
      author_association: 'MEMBER',
    },
    repository: {
      full_name: opts.repoFullName ?? 'acme/repo',
      private: false,
      owner: { login: 'acme' },
      name: 'repo',
    },
    sender: { login: 'alice', id: 1 },
  };
  if (opts.installationId !== null) {
    obj.installation = { id: opts.installationId ?? 99 };
  }
  return JSON.stringify(obj);
}

export function issueCommentBody(action: 'created' | 'edited' | 'deleted' = 'created'): string {
  return JSON.stringify({
    action,
    issue: { number: 42 },
    comment: {
      id: 999,
      body: 'I can repro',
      user: { login: 'bob', id: 2 },
      author_association: 'MEMBER',
    },
    repository: {
      full_name: 'acme/repo',
      private: false,
      owner: { login: 'acme' },
      name: 'repo',
    },
    sender: { login: 'bob', id: 2 },
    installation: { id: 99 },
  });
}

export function pullRequestBody(): string {
  return JSON.stringify({
    action: 'opened',
    pull_request: {
      number: 7,
      title: 'Fix',
      body: 'patches the bug',
      user: { login: 'carol', id: 3 },
      author_association: 'MEMBER',
    },
    repository: {
      full_name: 'acme/repo',
      private: false,
      owner: { login: 'acme' },
      name: 'repo',
    },
    sender: { login: 'carol', id: 3 },
    installation: { id: 99 },
  });
}

export function prReviewCommentBody(action: 'created' | 'deleted' = 'created'): string {
  return JSON.stringify({
    action,
    pull_request: { number: 7 },
    comment: {
      id: 12345,
      body: 'nit',
      user: { login: 'dave', id: 4 },
      author_association: 'MEMBER',
    },
    repository: {
      full_name: 'acme/repo',
      private: false,
      owner: { login: 'acme' },
      name: 'repo',
    },
    sender: { login: 'dave', id: 4 },
    installation: { id: 99 },
  });
}
