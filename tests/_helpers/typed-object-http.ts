// One live server and a line-per-reply client, so an HTTP characterization test reads as a list of requests.
import { rmSync } from 'node:fs';
import { vi } from 'vitest';
import { createApiKey } from '../../src/auth.js';
import { closeHippoDb, openHippoDb } from '../../src/db.js';
import type { JsonValue } from '../../src/json.js';
import { serve, type ServerHandle } from '../../src/server.js';
import { makeRoot } from './make-root.js';
import { maskVolatile } from './typed-object-specs.js';

export type Body = { [key: string]: JsonValue };

/** Who sends the request: a key of either tenant, or no Authorization header at all. */
export type Caller = 'default' | 'tenant-b' | 'nobody';

export interface Reply {
  readonly status: number;
  /** The body as sent, for a test that has to read an id or a cursor out of it. */
  readonly text: string;
  /** Status and body with the clock, the memory ids and the cursor swapped for fixed marks. */
  readonly line: string;
}

export interface RouteSpec {
  readonly type: string;
  readonly path: string;
  readonly create: Body;
  /** A valid supersede body, or null for the one type with no supersede route. */
  readonly revise: Body | null;
  /** The status a new row starts in. */
  readonly firstStatus: string;
}

export const OBJECT_ROUTES: readonly RouteSpec[] = [
  {
    type: 'decision', path: '/v1/decisions', firstStatus: 'active',
    create: { text: 'Use Postgres for billing', context: 'cheaper to run' },
    revise: { text: 'Use SQLite for billing', context: 'one file to back up' },
  },
  {
    type: 'incident', path: '/v1/incidents', firstStatus: 'open',
    create: { text: 'Checkout returned 500s', context: 'after the deploy' },
    revise: null,
  },
  {
    type: 'process', path: '/v1/processes', firstStatus: 'active',
    create: { processName: 'Release', steps: ['run the tests', 'tag the build'], description: 'weekly cut' },
    revise: { steps: ['run the tests', 'sign and tag the build'], changeSummary: 'sign the build' },
  },
  {
    type: 'skill', path: '/v1/skills', firstStatus: 'active',
    create: { skillName: 'Review a migration', instructions: 'Check the down path', trigger: 'a schema change' },
    revise: { instructions: 'Check both paths', changeSummary: 'both ways' },
  },
  {
    type: 'customer note', path: '/v1/customer-notes', firstStatus: 'active',
    create: { customer: 'Acme Ltd', note: 'Prefers email' },
    revise: { note: 'Prefers a call', changeSummary: 'asked on the phone' },
  },
  {
    // Fixed dates keep the row free of the clock, since validFrom defaults to now.
    type: 'policy', path: '/v1/policies', firstStatus: 'active',
    create: { policyName: 'Retention', policyText: 'Delete logs after 90 days', validFrom: '2026-01-01' },
    revise: { policyText: 'Delete logs after 30 days', validFrom: '2026-06-01', changeSummary: 'shorter' },
  },
  {
    type: 'project brief', path: '/v1/project-briefs', firstStatus: 'active',
    create: { repo: 'acme/web', summary: 'Storefront app' },
    revise: { summary: 'Storefront and admin app', changeSummary: 'admin added' },
  },
];

export function routeOf(type: string): RouteSpec {
  const spec = OBJECT_ROUTES.find((s) => s.type === type);
  if (!spec) throw new Error(`no route spec named ${type}`);
  return spec;
}

export class ObjectApi {
  private constructor(
    private readonly handle: ServerHandle,
    private readonly root: string,
    private readonly tokens: ReadonlyMap<string, string>,
  ) {}

  static async start(label: string): Promise<ObjectApi> {
    const root = makeRoot(label);
    const tokens = new Map<string, string>();
    const db = openHippoDb(root);
    try {
      for (const tenantId of ['default', 'tenant-b']) {
        tokens.set(tenantId, createApiKey(db, { tenantId, label, role: 'admin' }).plaintext);
      }
    } finally {
      closeHippoDb(db);
    }
    // The limiter reads its rate once at boot; zero switches it off so a long case table is never throttled.
    vi.stubEnv('HIPPO_V1_RPS', '0');
    const handle = await serve({ hippoRoot: root, port: 0 });
    vi.unstubAllEnvs();
    return new ObjectApi(handle, root, tokens);
  }

  async stop(): Promise<void> {
    await this.handle.stop();
    rmSync(this.root, { recursive: true, force: true });
  }

  send(method: string, path: string, body?: Body, caller: Caller = 'default'): Promise<Reply> {
    return this.sendRaw(method, path, body === undefined ? undefined : JSON.stringify(body), caller);
  }

  /** Sends the body text untouched, so a test can post what no JSON encoder would produce. */
  async sendRaw(method: string, path: string, raw: string | undefined, caller: Caller = 'default'): Promise<Reply> {
    const headers = new Headers({ 'content-type': 'application/json' });
    const token = this.tokens.get(caller);
    if (token !== undefined) headers.set('authorization', `Bearer ${token}`);
    const res = await fetch(`${this.handle.url}${path}`, { method, headers, body: raw });
    const text = await res.text();
    const masked = maskVolatile(text).replace(/"next_cursor":"[^"]+"/g, '"next_cursor":"<cursor>"');
    return { status: res.status, text, line: `${res.status} ${masked}` };
  }
}
