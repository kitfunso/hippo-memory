// A GitHub Enterprise Server on 127.0.0.1: the App token mint, the repo installation lookup and the three backfill list
// streams, so App auth runs through the real fetcher with no network. Callers fill the reply queues before they run.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { JsonValue } from '../../src/base/util/json.js';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ISSUE_TIME = '2026-11-22T11:00:00Z';

/** What the mint answers. A token or expiresAt makes a JSON body of them; otherwise `body` goes out as sent. */
export interface MintReply {
  readonly status: number;
  readonly token?: string;
  readonly expiresAt?: string;
  readonly body?: string;
  /** A Location header, for a 3xx. */
  readonly location?: string;
}

export interface LookupReply {
  readonly status: number;
  readonly id?: number;
  readonly body?: string;
  readonly location?: string;
}

export interface FakeRequest {
  readonly method: string;
  /** The path with its query string. */
  readonly path: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: string;
}

export interface FakeGitHub {
  /** The server root, which GITHUB_ENTERPRISE_URL takes. */
  readonly url: string;
  readonly requests: FakeRequest[];
  /** Served in order; the last reply repeats. Empty answers 400. */
  readonly mintReplies: MintReply[];
  readonly lookupReplies: LookupReply[];
  close(): Promise<void>;
}

/** A canned answer a commit route gives its first `times` requests, before its real reply. */
export interface FakeRefusal {
  readonly route: 'list' | 'detail';
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly times: number;
}

/** The commit routes: lists are keyed `<path>|<sha>` from the query ('' when absent), detail by sha. */
export interface FakeCommits {
  readonly lists?: Record<string, JsonValue[]>;
  readonly detail?: Record<string, JsonValue>;
  /** A commit's reply in pages: `?page=N` picks one and every page but the last links to the next. */
  readonly detailPages?: Record<string, JsonValue[]>;
  /** Answers 302 to `/elsewhere` on the list route or on the detail route. */
  readonly redirect?: 'list' | 'detail';
  /** A rel="next" link every list reply carries. */
  readonly listNext?: string;
  readonly refuse?: FakeRefusal;
}

export interface FakeGitHubOptions {
  readonly commits?: FakeCommits;
  /** The installation id the default lookup reply names. */
  readonly installationId?: number;
  /** Runs before each reply, so a test can move a clock when a given request arrives. */
  readonly onRequest?: (method: string, path: string) => void;
}

/** The next reply of a queue: the last one stays, so a test lists only the replies that differ. */
function nextReply<T>(queue: T[]): T | undefined {
  return queue.length > 1 ? queue.shift() : queue[0];
}

function item(kind: 'issue' | 'issueComment' | 'prComment', base: string) {
  const user = { login: 'alice', id: 1 };
  if (kind === 'issue') {
    return { number: 1, title: 'a title', body: 'a body', user, updated_at: ISSUE_TIME };
  }
  const link = kind === 'issueComment' ? { issue_url: `${base}/issues/1` } : { pull_request_url: `${base}/pulls/1` };
  return { id: 7, body: 'a comment', user, updated_at: ISSUE_TIME, ...link };
}

interface CommitsReply {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string>;
}

const OK = 200;

type CommitsState = FakeCommits & { root: string; refused: { count: number } };

function detailReply(
  sha: string,
  pathname: string,
  search: URLSearchParams,
  commits: CommitsState,
): CommitsReply | undefined {
  const pages = commits.detailPages?.[sha];
  if (pages === undefined) {
    const detail = commits.detail?.[sha];
    return detail === undefined ? undefined : { status: OK, body: JSON.stringify(detail), headers: {} };
  }
  const page = Number(search.get('page') ?? '1');
  const more = page < pages.length;
  const headers: Record<string, string> = more
    ? { link: `<${commits.root}${pathname}?page=${page + 1}>; rel="next"` }
    : {};
  return { status: OK, body: JSON.stringify(pages[page - 1] ?? {}), headers };
}

function commitsReply(pathname: string, search: URLSearchParams, commits: CommitsState): CommitsReply | undefined {
  const m = /^\/api\/v3\/repos\/[^/]+\/[^/]+\/commits(?:\/([^/]+))?$/.exec(pathname);
  if (m === null) return undefined;
  const sha = m[1];
  const route = sha === undefined ? 'list' : 'detail';
  if (commits.redirect === route) {
    return { status: 302, body: '', headers: { location: `${commits.root}/elsewhere` } };
  }
  const { refuse } = commits;
  if (refuse?.route === route && commits.refused.count < refuse.times) {
    commits.refused.count++;
    return { status: refuse.status, body: '{"message":"secret-reply-text"}', headers: refuse.headers ?? {} };
  }
  if (sha !== undefined) return detailReply(sha, pathname, search, commits);
  const key = `${search.get('path') ?? ''}|${search.get('sha') ?? ''}`;
  const headers: Record<string, string> =
    commits.listNext === undefined ? {} : { link: `<${commits.listNext}>; rel="next"` };
  return { status: OK, body: JSON.stringify(commits.lists?.[key] ?? []), headers };
}

function listBody(pathname: string, base: string): string | undefined {
  if (pathname.endsWith('/issues/comments')) return JSON.stringify([item('issueComment', base)]);
  if (pathname.endsWith('/pulls/comments')) return JSON.stringify([item('prComment', base)]);
  if (pathname.endsWith('/issues')) return JSON.stringify([item('issue', base)]);
  return undefined;
}

export async function startFakeGitHub(options: FakeGitHubOptions = {}): Promise<FakeGitHub> {
  const { installationId = 42, onRequest, commits } = options;
  const requests: FakeRequest[] = [];
  const mintReplies: MintReply[] = [];
  const lookupReplies: LookupReply[] = [{ status: 200, id: installationId }];
  const refused = { count: 0 };
  let root = '';
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const method = req.method ?? 'GET';
      const path = req.url ?? '/';
      const { pathname, searchParams } = new URL(path, root);
      requests.push({
        method,
        path,
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      onRequest?.(method, path);
      const send = (status: number, body: string, headers: Record<string, string> = {}): void => {
        res.writeHead(status, headers).end(body);
      };
      if (pathname === '/elsewhere') {
        if (method === 'GET') return send(200, JSON.stringify({ id: 99 }));
        const expires = new Date(Date.now() + ONE_HOUR_MS).toISOString();
        return send(201, JSON.stringify({ token: 'ghs_redirected', expires_at: expires }));
      }
      if (method === 'POST' && /^\/api\/v3\/app\/installations\/[^/]+\/access_tokens$/.test(pathname)) {
        const reply = nextReply(mintReplies);
        if (reply === undefined) return send(400, 'no mint reply queued');
        const json = reply.token !== undefined || reply.expiresAt !== undefined;
        const body = json ? JSON.stringify({ token: reply.token, expires_at: reply.expiresAt }) : (reply.body ?? '');
        return send(reply.status, body, reply.location === undefined ? {} : { location: reply.location });
      }
      if (method === 'GET' && /^\/api\/v3\/repos\/[^/]+\/[^/]+\/installation$/.test(pathname)) {
        const reply = nextReply(lookupReplies);
        if (reply === undefined) return send(400, 'no lookup reply queued');
        const body = reply.id === undefined ? (reply.body ?? '') : JSON.stringify({ id: reply.id });
        return send(reply.status, body, reply.location === undefined ? {} : { location: reply.location });
      }
      const state = commits && { ...commits, root, refused };
      const commit = method === 'GET' && state ? commitsReply(pathname, searchParams, state) : undefined;
      if (commit !== undefined) return send(commit.status, commit.body, commit.headers);
      const list = method === 'GET' ? listBody(pathname, `${root}/api/v3/repos/acme/demo`) : undefined;
      if (list !== undefined) return send(200, list);
      send(404, '{"message":"Not Found"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // SAFETY: a server listening on TCP reports an AddressInfo.
  const { port } = server.address() as AddressInfo;
  root = `http://127.0.0.1:${port}`;
  return {
    url: root,
    requests,
    mintReplies,
    lookupReplies,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
