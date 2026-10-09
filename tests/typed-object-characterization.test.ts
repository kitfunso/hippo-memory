// Pins the typed-object behaviour no other test owns, so one shared lifecycle core cannot change it unseen.
// Remove this file in the change that lands that core.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createApiKey } from '../src/store/auth.js';
import { runCli } from '../src/cli.js';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { insertEntity } from '../src/store/graph-writes.js';
import type { SourceObjectType } from '../src/store/graph-rows.js';
import type { JsonValue } from '../src/util/json.js';
import { serve, type ServerHandle } from '../src/server.js';
import { deleteEntry } from '../src/store/delete-and-batch.js';
import { initStore } from '../src/store/open.js';
import { makeRoot } from './_helpers/make-root.js';
import { runInProcess } from './_helpers/run-in-process.js';

type Body = { [key: string]: JsonValue };

interface Reply {
  readonly status: number;
  readonly text: string;
}

interface AuditRow {
  readonly op: string;
  readonly actor: string;
  readonly target_id: string;
  readonly metadata_json: string;
}

interface EntityOwner {
  readonly source_object_id: number;
}

const refused = (status: number, error: string): Reply => ({ status, text: JSON.stringify({ error }) });
const idsIn = (reply: Reply): string => [...reply.text.matchAll(/\{"id":(\d+),/g)].map((m) => m[1]).join(',');
const fieldIn = (reply: Reply, key: string): string | undefined => new RegExp(`"${key}":"([^"]+)"`).exec(reply.text)?.[1];

/** One live server on a fresh store, called with a real key so the audit actor is the key and never the default. */
class ObjectApi {
  private constructor(
    private readonly handle: ServerHandle,
    readonly root: string,
    private readonly keyId: string,
    private readonly token: string,
  ) {}

  static async start(): Promise<ObjectApi> {
    const root = makeRoot('typed-object');
    const db = openHippoDb(root);
    let key: ReturnType<typeof createApiKey>;
    try {
      key = createApiKey(db, { tenantId: 'default', role: 'admin' });
    } finally {
      closeHippoDb(db);
    }
    // The limiter reads its rate once at boot; zero switches it off so a case table is never throttled.
    vi.stubEnv('HIPPO_V1_RPS', '0');
    const handle = await serve({ hippoRoot: root, port: 0 });
    vi.unstubAllEnvs();
    return new ObjectApi(handle, root, key.keyId, key.plaintext);
  }

  async stop(): Promise<void> {
    await this.handle.stop();
    rmSync(this.root, { recursive: true, force: true });
  }

  async send(method: string, path: string, body?: Body, keyed = true): Promise<Reply> {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (keyed) headers.set('authorization', `Bearer ${this.token}`);
    const res = await fetch(`${this.handle.url}${path}`, { method, headers, body: body && JSON.stringify(body) });
    return { status: res.status, text: await res.text() };
  }

  /** Every audit row in write order, with the key id and the memory ids swapped for fixed marks. */
  auditLines(): string[] {
    const db = openHippoDb(this.root);
    try {
      // SAFETY: the SELECT names exactly the four audit_log columns AuditRow declares.
      const rows = db.prepare(`SELECT op, actor, target_id, metadata_json FROM audit_log ORDER BY id`).all() as AuditRow[];
      return rows.map((r) => {
        const actor = r.actor === `api_key:${this.keyId}` ? 'key' : r.actor;
        return `${r.op} ${actor} ${r.target_id} ${r.metadata_json}`.replace(/\b[a-z]{3}_[0-9a-f]{12}\b/g, '<mem>');
      });
    } finally {
      closeHippoDb(db);
    }
  }

  /** The object ids that still own a graph entity, for one object type. */
  graphOwners(type: SourceObjectType): number[] {
    const db = openHippoDb(this.root);
    try {
      // SAFETY: the SELECT names exactly the one entities column EntityOwner declares.
      const rows = db.prepare(`SELECT source_object_id FROM entities WHERE source_object_type = ? ORDER BY id`).all(type) as EntityOwner[];
      return rows.map((r) => r.source_object_id);
    } finally {
      closeHippoDb(db);
    }
  }
}

interface TypeRow {
  readonly type: string;
  readonly path: string;
  /** A valid create body whose name-like field carries two spaces on each side. */
  readonly create: Body;
  /** That field as the create reply returns it. */
  readonly stored: string;
  /** The step after create: a supersede makes row 2, a resolve keeps row 1. */
  readonly next: 'supersede' | 'resolve';
  readonly nextBody: Body;
  readonly nextAgain: string;
  readonly nextMissing: string;
  readonly closeAgain: string;
  /** Audit rows of create, the next step and close, as `op actor target metadata`. */
  readonly audit: readonly string[];
}

const TYPES: readonly TypeRow[] = [
  {
    type: 'decision', path: '/v1/decisions', next: 'supersede',
    create: { text: '  Use Postgres  ', context: 'cheaper to run' },
    stored: '"decisionText":"  Use Postgres  "',
    nextBody: { text: 'Use SQLite' },
    nextAgain: "saveDecision: decision 1 is not active (status='superseded'); only active decisions can be superseded.",
    nextMissing: 'saveDecision: decision 9999 to supersede not found for tenant default',
    closeAgain: "closeDecision: decision 2 is not active (status='closed'); only active decisions can be closed.",
    audit: [
      'decision_create key 1 {"decision_id":1,"has_context":true}',
      'remember key <mem> {"kind":"distilled","scope":null}',
      'decision_supersede key 1 {"decision_id":1,"superseded_by":2}',
      'decision_create key 2 {"decision_id":2,"has_context":false}',
      'remember key <mem> {"kind":"distilled","scope":null}',
      'decision_close key 2 {"decision_id":2}',
    ],
  },
  {
    type: 'incident', path: '/v1/incidents', next: 'resolve',
    create: { text: '  Checkout returned 500s  ' },
    stored: '"incidentText":"  Checkout returned 500s  "',
    nextBody: { resolutionText: 'rolled back' },
    nextAgain: "resolveIncident: incident 1 is not open (status='resolved'); only open incidents can be resolved.",
    nextMissing: 'resolveIncident: incident 9999 not found for tenant default',
    closeAgain: "closeIncident: incident 1 is already closed (status='closed'); only open or resolved incidents can be closed.",
    audit: [
      'incident_open key 1 {"incident_id":1,"has_context":false,"linked_memory_count":0}',
      'remember key <mem> {"kind":"distilled","scope":null}',
      'incident_resolve key 1 {"incident_id":1}',
      'incident_close key 1 {"incident_id":1}',
    ],
  },
  {
    type: 'process', path: '/v1/processes', next: 'supersede',
    create: { processName: '  Release  ', steps: ['run the tests'] },
    stored: '"processName":"  Release  "',
    nextBody: { steps: ['sign the build'] },
    nextAgain: "saveProcess: process 1 is not active (status='superseded'); only active processes can be superseded.",
    nextMissing: 'process 9999 not found',
    closeAgain: "closeProcess: process 2 is not active (status='closed'); only active processes can be closed.",
    audit: [
      'process_create key 1 {"process_id":1,"version":1,"step_count":1,"has_description":false}',
      'remember key <mem> {"kind":"distilled","scope":null}',
      'process_supersede key 1 {"process_id":1,"superseded_by":2,"new_version":2}',
      'process_create key 2 {"process_id":2,"version":2,"step_count":1,"has_description":false}',
      'remember key <mem> {"kind":"distilled","scope":null}',
      'process_close key 2 {"process_id":2}',
    ],
  },
  {
    type: 'policy', path: '/v1/policies', next: 'supersede',
    create: { policyName: '  Retention  ', policyText: 'Delete logs after 90 days' },
    stored: '"policyName":"  Retention  "',
    nextBody: { policyText: 'Delete logs after 30 days' },
    nextAgain: "savePolicy: policy 1 is not active (status='superseded'); only active policies can be superseded.",
    nextMissing: 'policy 9999 not found',
    closeAgain: "closePolicy: policy 2 is not active (status='closed'); only active policies can be closed.",
    audit: [
      'policy_create key 1 {"policy_id":1,"version":1,"open_ended":true}',
      'remember key <mem> {"kind":"distilled","scope":null}',
      'policy_supersede key 1 {"policy_id":1,"superseded_by":2,"new_version":2}',
      'policy_create key 2 {"policy_id":2,"version":2,"open_ended":true}',
      'remember key <mem> {"kind":"distilled","scope":null}',
      'policy_close key 2 {"policy_id":2}',
    ],
  },
  {
    type: 'skill', path: '/v1/skills', next: 'supersede',
    create: { skillName: '  Review  ', instructions: 'Check the down path' },
    stored: '"skillName":"Review"',
    nextBody: { instructions: 'Check both paths' },
    nextAgain: "saveSkill: skill 1 is not active (status='superseded'); only active skills can be superseded.",
    nextMissing: 'skill 9999 not found',
    closeAgain: "closeSkill: skill 2 is not active (status='closed'); only active skills can be closed.",
    audit: [
      'skill_create key 1 {"skill_id":1,"version":1,"has_trigger":false}',
      'remember key <mem> {"kind":"distilled","scope":null}',
      'skill_supersede key 1 {"skill_id":1,"superseded_by":2,"new_version":2}',
      'skill_create key 2 {"skill_id":2,"version":2,"has_trigger":false}',
      'remember key <mem> {"kind":"distilled","scope":null}',
      'skill_close key 2 {"skill_id":2}',
    ],
  },
  {
    type: 'customer note', path: '/v1/customer-notes', next: 'supersede',
    create: { customer: '  Acme Ltd  ', note: 'Prefers email' },
    stored: '"customer":"Acme Ltd"',
    nextBody: { note: 'Prefers a call' },
    nextAgain: "saveCustomerNote: note 1 is not active (status='superseded'); only active notes can be superseded.",
    nextMissing: 'customer note 9999 not found',
    closeAgain: "closeCustomerNote: note 2 is not active (status='closed'); only active notes can be closed.",
    audit: [
      'customer_note_create key 1 {"note_id":1,"customer":"Acme Ltd","version":1}',
      'remember key <mem> {"kind":"distilled","scope":null}',
      'customer_note_supersede key 1 {"note_id":1,"superseded_by":2,"new_version":2}',
      'customer_note_create key 2 {"note_id":2,"customer":"Acme Ltd","version":2}',
      'remember key <mem> {"kind":"distilled","scope":null}',
      'customer_note_close key 2 {"note_id":2}',
    ],
  },
  {
    type: 'project brief', path: '/v1/project-briefs', next: 'supersede',
    create: { repo: '  acme/web  ', summary: 'Storefront app' },
    stored: '"repo":"acme/web"',
    nextBody: { summary: 'Storefront and admin app' },
    nextAgain: "saveProjectBrief: brief 1 is not active (status='superseded'); only active briefs can be superseded.",
    nextMissing: 'project brief 9999 not found',
    closeAgain: "closeProjectBrief: brief 2 is not active (status='closed'); only active briefs can be closed.",
    audit: [
      'project_brief_create key 1 {"brief_id":1,"repo":"acme/web","version":1,"refreshed":false}',
      'remember key <mem> {"kind":"distilled","scope":null}',
      'project_brief_supersede key 1 {"brief_id":1,"superseded_by":2,"new_version":2,"refreshed":false}',
      'project_brief_create key 2 {"brief_id":2,"repo":"acme/web","version":2,"refreshed":false}',
      'remember key <mem> {"kind":"distilled","scope":null}',
      'project_brief_close key 2 {"brief_id":2}',
    ],
  },
];

describe('typed objects over HTTP, one fresh store per case', () => {
  it.each(TYPES)('$type: the stored name, each refusal text and the audit rows', async (row) => {
    const api = await ObjectApi.start();
    try {
      const made = await api.send('POST', row.path, row.create);
      expect(made.status).toBe(201);
      expect(made.text).toContain(row.stored);
      await api.send('POST', `${row.path}/1/${row.next}`, row.nextBody);
      expect(await api.send('POST', `${row.path}/1/${row.next}`, row.nextBody)).toEqual(refused(409, row.nextAgain));
      expect(await api.send('POST', `${row.path}/9999/${row.next}`, row.nextBody)).toEqual(refused(404, row.nextMissing));
      const last = row.next === 'supersede' ? 2 : 1;
      await api.send('POST', `${row.path}/${last}/close`);
      expect(await api.send('POST', `${row.path}/${last}/close`)).toEqual(refused(409, row.closeAgain));
      expect(api.auditLines()).toEqual(row.audit);
    } finally {
      await api.stop();
    }
  });

  const MIRRORLESS: readonly (readonly [SourceObjectType, string, Body])[] = [
    ['policy', '/v1/policies', { policyName: 'Retention', policyText: 'Delete logs after 90 days' }],
    ['customer', '/v1/customer-notes', { customer: 'Acme Ltd', note: 'Prefers email' }],
    ['project', '/v1/project-briefs', { repo: 'acme/web', summary: 'Storefront app' }],
  ];

  it.each(MIRRORLESS)('closing a %s object whose mirror memory is gone drops its graph rows and no other', async (source, path, create) => {
    const api = await ObjectApi.start();
    try {
      const first = await api.send('POST', path, create);
      await api.send('POST', path, create);
      deleteEntry(api.root, fieldIn(first, 'memoryId') ?? '');
      for (const id of [1, 2]) insertEntity(api.root, 'default', { entityType: source, name: `object ${id}`, sourceObject: { type: source, id } });
      expect(api.graphOwners(source)).toEqual([1, 2]);
      expect((await api.send('POST', `${path}/1/close`)).status).toBe(200);
      expect(api.graphOwners(source)).toEqual([2]);
    } finally {
      await api.stop();
    }
  });
});

describe('typed objects over HTTP, one shared store', () => {
  let api: ObjectApi;
  beforeAll(async () => {
    api = await ObjectApi.start();
  });
  afterAll(async () => {
    await api.stop();
  });

  const LIMIT = 'limit must be a positive integer <= 1000';
  const CURSOR = 'cursor is malformed; pass next_cursor from the previous page unchanged';
  const KEYLESS: readonly (readonly [string, number, string])[] = [
    ...TYPES.flatMap((row): (readonly [string, number, string])[] => [
      [`${row.path}?limit=0`, 400, LIMIT],
      [`${row.path}?cursor=junk`, 400, CURSOR],
      [`${row.path}?status=bogus`, 401, 'auth required'],
    ]),
    ['/v1/policies/asof', 400, 'date is required (ISO-8601 valid-time)'],
    ['/v1/policies/asof?date=soon', 401, 'auth required'],
  ];

  it.each(KEYLESS)('with auth required and no key, GET %s answers %i', async (path, status, error) => {
    vi.stubEnv('HIPPO_REQUIRE_AUTH', '1');
    try {
      expect(await api.send('GET', path, undefined, false)).toEqual(refused(status, error));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  const FILTERS: readonly (readonly [string, string, Body, Body, string])[] = [
    ['/v1/customer-notes', 'customer', { customer: 'Acme Ltd', note: 'Prefers email' }, { customer: 'Globex', note: 'Pays monthly' }, 'globex'],
    ['/v1/project-briefs', 'repo', { repo: 'acme/web', summary: 'Storefront app' }, { repo: 'acme/api', summary: 'Orders service' }, 'ACME/API'],
  ];

  it.each(FILTERS)('%s: an empty %s filter lists every row and another case matches none', async (path, key, one, two, otherCase) => {
    await api.send('POST', path, one);
    await api.send('POST', path, two);
    expect(idsIn(await api.send('GET', `${path}?${key}=`))).toBe('2,1');
    const none = await api.send('GET', `${path}?${key}=${otherCase}`);
    expect([none.status, idsIn(none)]).toEqual([200, '']);
  });

  it.each(['/v1/decisions', '/v1/incidents'])('%s takes a text of spaces only when a context comes with it', async (path) => {
    expect((await api.send('POST', path, { text: '   ' })).status).toBe(400);
    const made = await api.send('POST', path, { text: '   ', context: 'cheaper to run' });
    expect(made.status).toBe(201);
    expect(made.text).toContain('Text":"   "');
  });

  it('a policy made with no validFrom starts at the instant it was created', async () => {
    const made = await api.send('POST', '/v1/policies', { policyName: 'Access', policyText: 'Two reviewers' });
    expect(fieldIn(made, 'validFrom')).toBe(fieldIn(made, 'createdAt'));
    expect(fieldIn(made, 'createdAt')).toBeDefined();
  });
});

interface NounRow {
  readonly noun: string;
  /** Arguments that write row 1. */
  readonly seed: readonly string[];
  /** The verb that prints one row by id. */
  readonly read: string;
  readonly refuses: (raw: string) => string;
  /** What an id with a tail or a fraction gets. */
  readonly loose: (raw: string) => string;
  /** Flags of a valid supersede and what a second supersede of row 1 prints; absent where the noun has no such verb. */
  readonly revise?: readonly string[];
  readonly reviseAgain?: string;
}

const strict = (label: string) => (raw: string): string => `exit 1: Invalid ${label} id: "${raw}" (expected a positive integer).`;
const again = (fn: string, label: string, plural: string): string =>
  `${fn}: ${label} 1 is not active (status='superseded'); only active ${plural} can be superseded.`;

const NOUNS: readonly NounRow[] = [
  {
    noun: 'predict', seed: ['predict', 'Ships by Friday', '--class', 'release'], read: 'show',
    refuses: (raw) => `exit 1: Invalid prediction id: "${raw}"`, loose: () => 'exit 0: Prediction #1',
  },
  {
    noun: 'decide', seed: ['decide', 'Use Postgres for billing'], read: 'get',
    refuses: (raw) => `exit 1: Invalid decision id: "${raw}"`, loose: () => 'exit 0: Decision #1',
  },
  { noun: 'incident', seed: ['incident', 'open', 'Checkout returned 500s'], read: 'get', refuses: strict('incident'), loose: strict('incident') },
  {
    noun: 'process', seed: ['process', 'new', 'Release', '--step', 'run the tests'], read: 'get', refuses: strict('process'), loose: strict('process'),
    revise: ['--step', 'sign the build'], reviseAgain: `exit 1: Error: ${again('saveProcess', 'process', 'processes')}`,
  },
  {
    noun: 'policy', seed: ['policy', 'new', 'Retention', '--text', 'Delete logs after 90 days'], read: 'get', refuses: strict('policy'), loose: strict('policy'),
    revise: ['--text', 'Delete logs after 30 days'], reviseAgain: `exit 1: ${again('savePolicy', 'policy', 'policies')}`,
  },
  {
    noun: 'skill', seed: ['skill', 'new', 'Review', '--instructions', 'Check the down path'], read: 'get', refuses: strict('skill'), loose: strict('skill'),
    revise: ['--instructions', 'Check both paths'], reviseAgain: `exit 1: ${again('saveSkill', 'skill', 'skills')}`,
  },
  {
    noun: 'brief', seed: ['brief', 'new', 'acme/web', '--summary', 'Storefront app'], read: 'get', refuses: strict('brief'), loose: strict('brief'),
    revise: ['--summary', 'Storefront and admin app'], reviseAgain: `exit 1: ${again('saveProjectBrief', 'brief', 'briefs')}`,
  },
  {
    noun: 'note', seed: ['note', 'new', 'Acme Ltd', '--text', 'Prefers email'], read: 'get', refuses: strict('note'), loose: strict('note'),
    revise: ['--text', 'Prefers a call'], reviseAgain: `exit 1: ${again('saveCustomerNote', 'note', 'notes')}`,
  },
];

describe('typed-object CLI verbs', () => {
  const savedCwd = process.cwd();
  let root: string;

  /** Exit code and the first line printed: stderr on a refusal, stdout otherwise. */
  async function hippo(...args: string[]): Promise<string> {
    const res = await runInProcess(() => runCli(['node', 'hippo', ...args]));
    return `exit ${res.status}: ${(res.stderr || res.stdout).split('\n')[0]}`;
  }

  beforeAll(async () => {
    root = makeRoot('typed-object-cli');
    // The CLI looks for the store in `.hippo` under the working directory.
    initStore(join(root, '.hippo'));
    vi.stubEnv('HIPPO_SKIP_AUTO_INTEGRATIONS', '1');
    // An empty tenant falls through to `default`, whatever the shell running the suite has set.
    vi.stubEnv('HIPPO_TENANT', '');
    process.chdir(root);
    for (const row of NOUNS) expect(await hippo(...row.seed)).toMatch(/^exit 0: /);
  });
  afterAll(() => {
    process.chdir(savedCwd);
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it.each(NOUNS)('hippo $noun $read: how each id form is read', async (row) => {
    for (const raw of ['0', '-1']) expect(await hippo(row.noun, row.read, raw)).toBe(row.refuses(raw));
    // Documents current behaviour: predict and decide read these as 1 and act on row 1; every other noun refuses them.
    for (const raw of ['1.5', '1abc']) expect(await hippo(row.noun, row.read, raw)).toBe(row.loose(raw));
  });

  it.each(NOUNS.filter((row) => row.noun !== 'predict'))('hippo $noun list refuses --limit=0', async (row) => {
    expect(await hippo(row.noun, 'list', '--limit=0')).toBe('exit 1: Invalid --limit: "0". Must be a positive integer.');
  });

  it.each(NOUNS.filter((row) => row.revise))('hippo $noun supersede: what a second supersede of one row prints', async (row) => {
    const args = [row.noun, 'supersede', '1', ...(row.revise ?? [])];
    expect(await hippo(...args)).toMatch(/^exit 0: /);
    expect(await hippo(...args)).toBe(row.reviseAgain);
  });
});
