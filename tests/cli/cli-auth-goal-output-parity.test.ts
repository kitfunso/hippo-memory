// The published stdout, stderr and exit codes of `hippo auth revoke|grant|ungrant` and `hippo goal`, in process on a
// real store, and the key, grant, audit, goal and policy rows each run leaves.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { handleAuth } from '../../src/cli/auth.js';
import { handleGoal } from '../../src/cli/goals.js';
import * as api from '../../src/api/index.js';
import { verifyApiKeyCached } from '../../src/store/sqlite/auth.js';
import { sqliteStore } from '../../src/store/index.js';
import { openHippoDb, closeHippoDb } from '../../src/db/index.js';
import { makeRoot } from '../_helpers/make-root.js';
import { runInProcess } from '../_helpers/run-in-process.js';
import { apiCtx } from '../_helpers/api-ctx.js';

type Flags = Record<string, string | boolean | string[]>;

/** The goal_stack columns the goal case reads back. */
interface GoalRow {
  id: string;
  tenant_id: string;
  goal_name: string;
  level: number;
  parent_goal_id: string | null;
  status: string;
  success_condition: string | null;
  has_policy: number;
  completed: number;
  outcome_score: number | null;
}

let root = '';

beforeEach(() => {
  root = makeRoot('cli-auth-goal-parity');
  vi.stubEnv('HIPPO_HOME', `${root}-global`);
  vi.stubEnv('HIPPO_TENANT', '');
  vi.stubEnv('HIPPO_SESSION_ID', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** Replaces each distinct id matching `pattern` with its first-seen order, and every ISO timestamp with <ts>. */
function masker(pattern: RegExp, label: string): (text: string) => string {
  const ids = new Map<string, string>();
  return (text) =>
    text
      .replace(pattern, (id) => {
        if (!ids.has(id)) ids.set(id, `${label}#${ids.size + 1}`);
        return ids.get(id)!;
      })
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g, '<ts>');
}

function rows(sql: string, ...params: string[]): unknown[] {
  const db = openHippoDb(root);
  try {
    return db.prepare(sql).all(...params);
  } finally {
    closeHippoDb(db);
  }
}

describe('hippo auth revoke, grant and ungrant (in process)', () => {
  it('prints each command output and exit code, and leaves these rows', async () => {
    const mint = async (tenantId: string): Promise<api.AuthCreateResult> =>
      await api.authCreate(apiCtx(root, tenantId, api.adminActor('cli')), { label: tenantId, role: 'member' });
    const home = await mint('default');
    const acme = await mint('acme');
    const spare = await mint('acme');
    const mask = masker(/hk_[a-z2-7]{24}/g, 'key');
    mask(home.keyId);
    mask(acme.keyId);
    mask(spare.keyId);

    // Prove both secrets first, so the revoke and the grant below must show on keys this process already trusts.
    expect((await verifyApiKeyCached(acme.plaintext, sqliteStore(root)))?.scopes).toEqual([]);
    expect((await verifyApiKeyCached(spare.plaintext, sqliteStore(root)))?.scopes).toEqual([]);

    const transcript: string[] = [];
    const step = async (label: string, args: string[], flags: Flags = {}): Promise<void> => {
      const r = await runInProcess(() => handleAuth({ hippoRoot: root, tenantId: 'default', args, flags }));
      transcript.push(`$ auth ${label} -> ${r.status}\n--- stdout\n${mask(r.stdout)}--- stderr\n${mask(r.stderr)}`);
    };

    await step('revoke (no id)', ['revoke']);
    await step('revoke (unknown)', ['revoke', 'hk_aaaaaaaaaaaaaaaaaaaaaaaa']);
    await step('grant (no scope)', ['grant', spare.keyId]);
    await step('grant (unknown)', ['grant', 'hk_aaaaaaaaaaaaaaaaaaaaaaaa', 'unknown:legacy']);
    await step('grant (open scope)', ['grant', spare.keyId, 'team:eng']);
    await step('grant', ['grant', spare.keyId, 'unknown:legacy']);
    expect((await verifyApiKeyCached(spare.plaintext, sqliteStore(root)))?.scopes).toEqual(['unknown:legacy']);
    await step('grant --json (again)', ['grant', spare.keyId, 'unknown:legacy'], { json: true });
    await step('ungrant', ['ungrant', spare.keyId, 'unknown:legacy']);
    await step('ungrant --json (none held)', ['ungrant', spare.keyId, 'unknown:legacy'], { json: true });
    await step('revoke (other tenant)', ['revoke', acme.keyId]);
    expect(await verifyApiKeyCached(acme.plaintext, sqliteStore(root))).toBeNull();
    await step('revoke --json (again)', ['revoke', acme.keyId], { json: true });
    await step('grant (revoked)', ['grant', acme.keyId, 'unknown:legacy']);
    await step('revoke (own tenant)', ['revoke', home.keyId], { json: true });

    expect(transcript.join('\n')).toMatchSnapshot();
    expect(rows(`SELECT key_id, tenant_id, revoked_at IS NOT NULL AS revoked FROM api_keys ORDER BY id`)).toEqual([
      { key_id: home.keyId, tenant_id: 'default', revoked: 1 },
      { key_id: acme.keyId, tenant_id: 'acme', revoked: 1 },
      { key_id: spare.keyId, tenant_id: 'acme', revoked: 0 },
    ]);
    expect(rows(`SELECT key_id, scope FROM api_key_scope_grants`)).toEqual([]);
    const audit = rows(
      `SELECT tenant_id, actor, op, target_id, metadata_json FROM audit_log WHERE op LIKE 'auth_%' AND op != 'auth_create' ORDER BY id`,
    );
    // Each grant and ungrant is audited under the key's tenant, a repeat of one too.
    const scoped = (op: string) => ({
      tenant_id: 'acme',
      actor: 'cli',
      op,
      target_id: spare.keyId,
      metadata_json: '{"scope":"unknown:legacy"}',
    });
    expect(audit).toEqual([
      scoped('auth_grant'),
      scoped('auth_grant'),
      scoped('auth_ungrant'),
      scoped('auth_ungrant'),
      { tenant_id: 'acme', actor: 'cli', op: 'auth_revoke', target_id: acme.keyId, metadata_json: '{}' },
      { tenant_id: 'default', actor: 'cli', op: 'auth_revoke', target_id: home.keyId, metadata_json: '{}' },
    ]);
  });
});

describe('hippo goal (in process)', () => {
  it('prints each command output and exit code, and leaves these rows', async () => {
    const mask = masker(/\b(?:g|rp)_[0-9a-f]{16}\b/g, 'id');
    const transcript: string[] = [];
    const step = async (label: string, args: string[], flags: Flags = {}): Promise<string> => {
      const r = await runInProcess(() => handleGoal({ hippoRoot: root, tenantId: 'default', args, flags }));
      transcript.push(`$ goal ${label} -> ${r.status}\n--- stdout\n${mask(r.stdout)}--- stderr\n${mask(r.stderr)}`);
      return r.stdout.trim();
    };
    const s = { 'session-id': 's1' };

    await step('(no sub)', []);
    await step('bogus', ['bogus']);
    await step('push (no name)', ['push'], s);
    await step('push (no session)', ['push', 'ship']);
    await step('push (valueless policy)', ['push', 'ship'], { ...s, policy: true });
    await step('push (bad policy)', ['push', 'ship'], { ...s, policy: 'fastest' });
    await step('push (valueless success)', ['push', 'ship'], { ...s, success: true });
    await step('push (bad level)', ['push', 'ship'], { ...s, level: '3' });
    await step('push (valueless parent)', ['push', 'ship'], { ...s, parent: true });
    const top = await step('push', ['push', 'ship', 'the', 'release'], {
      ...s,
      policy: 'error-prioritized',
      success: 'CI green',
      level: '0',
    });
    const child = await step('push (control chars, parent)', ['push', 'fix\x1b[31m', 'ci'], {
      ...s,
      parent: top,
      level: '1',
    });
    const other = await step('push (other tenant)', ['push', 'acme goal'], { ...s, 'tenant-id': 'acme' });
    vi.stubEnv('HIPPO_SESSION_ID', 's1');
    const third = await step('push (session from env)', ['push', 'write docs']);
    await step('list (empty session)', ['list'], { 'session-id': 's2' });
    await step('list', ['list'], s);
    await step('complete (no id)', ['complete']);
    await step('complete (valueless outcome)', ['complete', child], { outcome: true });
    await step('complete (bad outcome)', ['complete', child], { outcome: '2' });
    await step('complete', ['complete', child], { outcome: '0.9' });
    await step('complete (again)', ['complete', child], { outcome: '0.1' });
    await step('suspend (no id)', ['suspend']);
    await step('suspend', ['suspend', third]);
    await step('list (suspended hidden)', ['list'], s);
    await step('list --all', ['list'], { ...s, all: true });
    await step('resume (no id)', ['resume']);
    await step('resume', ['resume', third]);
    await step('complete --no-propagate', ['complete', top], { outcome: '0.5', 'no-propagate': true });
    await step('list --all (after)', ['list'], { ...s, all: true });
    await step('list --tenant-id acme', ['list'], { ...s, 'tenant-id': 'acme' });

    expect(transcript.join('\n')).toMatchSnapshot();
    const goals = rows(
      `SELECT id, tenant_id, goal_name, level, parent_goal_id, status, success_condition,
              retrieval_policy_id IS NOT NULL AS has_policy, completed_at IS NOT NULL AS completed, outcome_score
       FROM goal_stack ORDER BY rowid`,
    );
    const goal = (id: string, name: string, more: Partial<GoalRow> = {}): GoalRow => ({
      id,
      tenant_id: 'default',
      goal_name: name,
      level: 0,
      parent_goal_id: null,
      status: 'active',
      success_condition: null,
      has_policy: 0,
      completed: 0,
      outcome_score: null,
      ...more,
    });
    // The repeat complete keeps the first outcome; the control character is stored as `?`.
    expect(goals).toEqual([
      goal(top, 'ship the release', {
        status: 'completed',
        success_condition: 'CI green',
        has_policy: 1,
        completed: 1,
        outcome_score: 0.5,
      }),
      goal(child, 'fix?[31m ci', {
        level: 1,
        parent_goal_id: top,
        status: 'completed',
        completed: 1,
        outcome_score: 0.9,
      }),
      goal(other, 'acme goal', { tenant_id: 'acme' }),
      goal(third, 'write docs'),
    ]);
    expect(rows(`SELECT goal_id, policy_type FROM retrieval_policy`)).toEqual([
      { goal_id: top, policy_type: 'error-prioritized' },
    ]);
    expect(rows(`SELECT DISTINCT session_id FROM goal_stack`)).toEqual([{ session_id: 's1' }]);
  });
});
