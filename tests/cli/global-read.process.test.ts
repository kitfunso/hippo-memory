import { describe, it, expect } from 'vitest';
import { Store, type ParsedRow } from '../_helpers/cli-verb-store.js';
import { hippoRunAsync } from '../_helpers/spawn-hippo.js';

const SPAWN_MS = 60_000;
const GLOBAL_ROWS = ['the staging deploy needs a vpn tunnel first', 'the staging deploy needs a signed tag first'];
const LOCAL_ROW = 'the production deploy needs a written ticket first';
const ALPHA_ROW = 'the alpha vault rotation runbook lives in the wiki';
const PROMPT = JSON.stringify({ session_id: 's', prompt: 'what does the deploy need first' });
const HOOK_FORMAT = ['--pinned-only', '--format', 'additional-context'];

async function hippo(store: Store, args: readonly string[], opts: { tenant?: string; input?: string } = {}) {
  const env = opts.tenant === undefined ? store.env : { ...store.env, HIPPO_TENANT: opts.tenant };
  const ran = await hippoRunAsync(args, { cwd: store.cwd, env, input: opts.input, timeout: SPAWN_MS });
  expect(ran.status, ran.stderr).toBe(0);
  return ran.stdout.replace(/\r\n/g, '\n');
}

const recallContents = async (store: Store, args: readonly string[], tenant?: string): Promise<string[]> => {
  const out = await hippo(store, ['recall', 'deploy', '--json', ...args], { tenant });
  const parsed: { results: Array<{ content: string }> } = JSON.parse(out);
  return parsed.results.map((row) => row.content).sort();
};

const idsOf = (rows: readonly ParsedRow[]): string[] => rows.map((row) => String(row['id']));

describe('--global on recall, context and outcome (built CLI, project folder with its own store)', () => {
  async function seeded(): Promise<Store> {
    const store = new Store({ global: true });
    for (const text of GLOBAL_ROWS) await hippo(store, ['remember', text, '--global']);
    await hippo(store, ['remember', LOCAL_ROW]);
    return store;
  }

  it('recall reads the global store only, and without the switch it reads both', async () => {
    const store = await seeded();
    expect(await recallContents(store, [])).toEqual([...GLOBAL_ROWS, LOCAL_ROW].sort());
    expect(await recallContents(store, ['--global'])).toEqual([...GLOBAL_ROWS].sort());
  });

  it('context holds the global rows and not the local one, in the hook form and in markdown', async () => {
    const store = await seeded();
    for (const form of [HOOK_FORMAT, []]) {
      const both = await hippo(store, ['context', ...form], { input: PROMPT });
      const globalOnly = await hippo(store, ['context', '--global', ...form], { input: PROMPT });
      expect(both).toContain(LOCAL_ROW);
      expect(globalOnly).toContain(GLOBAL_ROWS[0]);
      expect(globalOnly).not.toContain(LOCAL_ROW);
    }
  });

  it('outcome with two --id flags marks both global rows in one call, and without the switch marks none', async () => {
    const store = await seeded();
    const [a, b] = idsOf(store.rows('global'));
    const [local] = idsOf(store.rows('local'));
    expect(await hippo(store, ['outcome', '--good', '--id', a!, '--id', b!])).toBe(
      'Applied positive outcome to 0 memories\n',
    );
    expect(await hippo(store, ['outcome', '--global', '--good', '--id', a!, '--id', b!])).toBe(
      'Applied positive outcome to 2 memories\n',
    );
    expect(await hippo(store, ['outcome', '--global', '--bad', '--id', local!])).toBe(
      'Applied negative outcome to 0 memories\n',
    );
    expect(store.rows('global').map((row) => row['outcome_positive'])).toEqual([1, 1]);
    expect(store.rows('local').map((row) => row['outcome_positive'])).toEqual([0]);
  });

  it('outcome with an empty --id= or trailing --id= exits 1 and marks nothing, even after a recall', async () => {
    const store = await seeded();
    const [globalId] = idsOf(store.rows('global'));
    await hippo(store, ['recall', 'deploy', '--global']);
    const before = store.rows('global').map((row) => row['outcome_positive']);
    for (const extra of [['--id='], ['--id', globalId!, '--id='], ['--id', globalId!, '--id']]) {
      const ran = await hippoRunAsync(['outcome', '--global', '--good', ...extra], {
        cwd: store.cwd,
        env: store.env,
        timeout: SPAWN_MS,
      });
      expect(ran.status).toBe(1);
      expect(ran.stderr).toContain('--id requires a value');
      expect(store.rows('global').map((row) => row['outcome_positive'])).toEqual(before);
    }
  });
});

describe('--global with no global store', () => {
  it('recall exits 1 and names the global store and the command that makes it', async () => {
    const store = new Store();
    const ran = await hippoRunAsync(['recall', 'deploy', '--global'], {
      cwd: store.cwd,
      env: store.env,
      timeout: SPAWN_MS,
    });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain(`No global hippo store at ${store.home}. Run \`hippo init --global\` first.`);
  });
});

describe('--global holds to the tenant of the caller', () => {
  it('shows alpha its own row on all three verbs and shows beta nothing of it', async () => {
    const store = new Store({ global: true });
    await hippo(store, ['remember', ALPHA_ROW, '--global'], { tenant: 'alpha' });
    const [id] = idsOf(store.rows('global'));
    const vault = ['recall', 'vault', '--global', '--json'];
    const asContext = (tenant: string) => hippo(store, ['context', '--global'], { tenant, input: PROMPT });
    const asRecall = async (tenant: string): Promise<unknown[]> => {
      const parsed: { results: unknown[] } = JSON.parse(await hippo(store, vault, { tenant }));
      return parsed.results;
    };

    expect(await asRecall('alpha')).toHaveLength(1);
    expect(await asContext('alpha')).toContain(ALPHA_ROW);
    expect(await hippo(store, ['outcome', '--global', '--good', '--id', id!], { tenant: 'alpha' })).toBe(
      'Applied positive outcome to 1 memory\n',
    );

    expect(await asRecall('beta')).toHaveLength(0);
    expect(await asContext('beta')).not.toContain(ALPHA_ROW);
    expect(await hippo(store, ['outcome', '--global', '--good', '--id', id!], { tenant: 'beta' })).toBe(
      'Applied positive outcome to 0 memories\n',
    );
    expect(store.rows('global').map((row) => row['outcome_positive'])).toEqual([1]);
  });
});
