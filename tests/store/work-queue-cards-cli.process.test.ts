// W2a work-queue cards: the card verb round trip through the CLI and the flag parser (tests 10-11).
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { rmSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { runInProcess } from '../_helpers/run-in-process.js';
import { handleCard } from '../../src/surface/cli/card.js';
import { parseArgs } from '../../src/cli.js';
import { COMMANDS } from '../../src/surface/cli/verbs.js';
import { cardDetailOf } from '../_helpers/card-detail.js';
import { runCliAs } from '../_helpers/run-cli-as.js';
import { makeRoot } from '../_helpers/make-root.js';
import { createCard } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';
import { root, useCardsRoot } from '../_helpers/work-queue-cards.js';

useCardsRoot();

describe('CLI round trip: card create -> handoff create --card-id -> card show --json', () => {
  const REPO_ROOT = join(__dirname, '..', '..');
  const CLI_PATH = join(REPO_ROOT, 'dist', 'cli.js');

  beforeAll(() => {
    if (!existsSync(CLI_PATH) || !statSync(CLI_PATH).isFile()) {
      throw new Error(`dist/cli.js not found at ${CLI_PATH}. Run \`npm run build\` first.`);
    }
  });

  function toUtf8(value: string | Buffer | undefined): string {
    if (value === undefined) return '';
    return Buffer.isBuffer(value) ? value.toString('utf8') : value;
  }

  function runCliSpawned(cwd: string, env: Record<string, string>, ...args: string[]) {
    try {
      const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
        cwd,
        env: { ...process.env, ...env },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { out: stdout, status: 0 };
    } catch (e) {
      // SAFETY: execFileSync throws this exact shape (stdout/stderr/status) on a non-zero exit.
      const err = e as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number };
      return { out: toUtf8(err.stdout) + toUtf8(err.stderr), status: err.status ?? 1 };
    }
  }
  // In process: these cases read exit codes and printed bytes; the first CLI case keeps the built CLI pinned in a real child.
  async function runCli(cwd: string, env: Record<string, string>, ...args: string[]) {
    const r = await runCliAs(args, { cwd, env: { ...process.env, ...env } });
    return { out: r.status === 0 ? r.stdout : r.stdout + r.stderr, status: r.status };
  }

  function cardIdFrom(out: string): string {
    const id = out.match(/Created card (\S+)/)?.[1];
    if (!id) throw new Error(`no card id in CLI output: ${out}`);
    return id;
  }

  async function setupCliHome() {
    const home = makeRoot('w2a-cli', { init: false });
    const globalDir = join(home, 'global');
    mkdirSync(globalDir, { recursive: true });
    const env = { HIPPO_HOME: globalDir };
    execSync('git init', { cwd: home, stdio: 'ignore' });
    execSync('git config user.name "Test User"', { cwd: home, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: home, stdio: 'ignore' });
    execSync('git commit --allow-empty -m "init"', { cwd: home, stdio: 'ignore' });
    const init = await runCli(home, env, 'init');
    expect(init.status, init.out).toBe(0);
    return { home, env };
  }

  it('test 10: hippo card show --json contains the handoff created against that card id', async () => {
    const { home, env } = await setupCliHome();
    try {
      const create = runCliSpawned(home, env, 'card', 'create', '--title', 't');
      expect(create.status, create.out).toBe(0);
      const id = create.out.match(/Created card (\S+)/)?.[1];
      expect(id).toBeTruthy();

      const handoff = runCliSpawned(home, env, 'handoff', 'create', '--summary', 's', '--card-id', id!);
      expect(handoff.status, handoff.out).toBe(0);

      const show = runCliSpawned(home, env, 'card', 'show', id!, '--json');
      expect(show.status, show.out).toBe(0);
      const parsed = JSON.parse(show.out);
      expect(parsed.handoff.summary).toBe('s');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('test 12: an unknown --depends-on id exits 1 with the missing-parent message on stderr', async () => {
    const home = makeRoot('w2a-cli', { init: false });
    vi.stubEnv('HIPPO_HOME', join(home, 'global'));
    try {
      initTestStore(join(home, '.hippo'));
      // parseArgs collects --depends-on into an array, so the in-process call passes one.
      const create = await runInProcess(() =>
        handleCard({
          hippoRoot: join(home, '.hippo'),
          tenantId: 'default',
          args: ['create'],
          flags: { title: 'x', 'depends-on': ['nope'] },
        }),
      );
      expect(create.status).toBe(1);
      expect(create.stderr).toContain('unknown parent card id: nope');
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a value-less --title exits 1 and creates no card', async () => {
    const { home, env } = await setupCliHome();
    try {
      const create = await runCli(home, env, 'card', 'create', '--title');
      expect(create.status).toBe(1);
      const list = await runCli(home, env, 'card', 'list');
      expect(list.status, list.out).toBe(0);
      expect(list.out).toContain('No cards found.');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a value-less --depends-on exits 1', async () => {
    const { home, env } = await setupCliHome();
    try {
      const create = await runCli(home, env, 'card', 'create', '--title', 't', '--depends-on');
      expect(create.status).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a value-less --reason on card block exits 1 and leaves the card running', async () => {
    const { home, env } = await setupCliHome();
    try {
      const create = await runCli(home, env, 'card', 'create', '--title', 't');
      const id = create.out.match(/Created card (\S+)/)?.[1];
      expect(id).toBeTruthy();
      const claim = await runCli(home, env, 'card', 'claim', id!, '--runtime', 'r');
      expect(claim.status, claim.out).toBe(0);

      const block = await runCli(home, env, 'card', 'block', id!, '--reason');
      expect(block.status).toBe(1);

      const show = await runCli(home, env, 'card', 'show', id!, '--json');
      expect(show.status, show.out).toBe(0);
      expect(JSON.parse(show.out).card.status).toBe('running');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a value-less --runtime on card claim exits 1', async () => {
    const { home, env } = await setupCliHome();
    try {
      const create = await runCli(home, env, 'card', 'create', '--title', 't');
      const id = create.out.match(/Created card (\S+)/)?.[1];
      expect(id).toBeTruthy();

      const claim = await runCli(home, env, 'card', 'claim', id!, '--runtime');
      expect(claim.status).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('Fix A CLI: card complete --outcome failure prints status shelved and no Promoted line', async () => {
    const { home, env } = await setupCliHome();
    try {
      const create = await runCli(home, env, 'card', 'create', '--title', 't');
      const id = create.out.match(/Created card (\S+)/)?.[1];
      expect(id).toBeTruthy();
      await runCli(home, env, 'card', 'claim', id!, '--runtime', 'r1');
      await runCli(home, env, 'card', 'review', id!);

      const complete = await runCli(home, env, 'card', 'complete', id!, '--outcome', 'failure');
      expect(complete.status, complete.out).toBe(0);
      expect(complete.out).toContain('(status: shelved)');
      expect(complete.out).not.toContain('Promoted to ready');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('card comment on an unknown id exits 1 with the friendly message, not a raw FK error', async () => {
    const { home, env } = await setupCliHome();
    try {
      const comment = await runCli(home, env, 'card', 'comment', 'nope', '--body', 'x');
      expect(comment.status).toBe(1);
      expect(comment.out).toContain('No card found with id nope.');
      expect(comment.out).not.toContain('FOREIGN KEY');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('Fix B CLI: card claim on an unknown id exits 1 with the unknown-id message', async () => {
    const { home, env } = await setupCliHome();
    try {
      const claim = await runCli(home, env, 'card', 'claim', 'card_000000000000', '--runtime', 'r1');
      expect(claim.status).toBe(1);
      expect(claim.out).toContain('unknown card id: card_000000000000');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('Fix C CLI: card create --budget 0 exits 1 and creates no card', async () => {
    const { home, env } = await setupCliHome();
    try {
      const create = await runCli(home, env, 'card', 'create', '--title', 't', '--budget', '0');
      expect(create.status).toBe(1);
      expect(create.out).toContain('Invalid budget: 0 (expected a positive integer)');
      const list = await runCli(home, env, 'card', 'list');
      expect(list.status, list.out).toBe(0);
      expect(list.out).toContain('No cards found.');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('Fix D CLI: an unrecognized flag, a wrong name, or a glued --flag=value with a bad value, exits 1 and creates no card', async () => {
    const { home, env } = await setupCliHome();
    try {
      // --depends-on=nope is a real flag now, so it fails on the parent lookup instead of on parsing.
      const equalsForm = await runCli(home, env, 'card', 'create', '--title', 't', '--depends-on=nope');
      expect(equalsForm.status).toBe(1);
      expect(equalsForm.out).toContain('unknown parent card id: nope');

      const typo = await runCli(home, env, 'card', 'create', '--title', 't', '--depend-on', 'x');
      expect(typo.status).toBe(1);
      expect(typo.out).toContain('Unknown flag --depend-on for hippo card create');

      const protoKey = await runCli(home, env, 'card', 'constructor', '--x');
      expect(protoKey.status).toBe(1);
      expect(protoKey.out).toContain(
        'Usage: hippo card <create|show|list|claim|heartbeat|block|review|complete|reclaim|comment>',
      );

      const list = await runCli(home, env, 'card', 'list');
      expect(list.status, list.out).toBe(0);
      expect(list.out).toContain('No cards found.');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('Fix D CLI: every subcommand still accepts each flag it legitimately reads', async () => {
    const { home, env } = await setupCliHome();
    try {
      const parent = await runCli(home, env, 'card', 'create', '--title', 'parent');
      expect(parent.status, parent.out).toBe(0);
      const parentId = cardIdFrom(parent.out);
      expect(parentId).toBeTruthy();

      const create = await runCli(
        home,
        env,
        'card',
        'create',
        '--title',
        'child',
        '--repo',
        'r',
        '--contract',
        'c',
        '--budget',
        '5',
        '--depends-on',
        parentId,
      );
      expect(create.status, create.out).toBe(0);
      const childId = cardIdFrom(create.out);
      expect(childId).toBeTruthy();

      const list = await runCli(home, env, 'card', 'list', '--status', 'backlog', '--json');
      expect(list.status, list.out).toBe(0);
      const listed = JSON.parse(list.out);
      expect(listed.cards.some((c: { id: string }) => c.id === childId)).toBe(true);

      const claim = await runCli(home, env, 'card', 'claim', parentId, '--runtime', 'r1', '--session', 's1');
      expect(claim.status, claim.out).toBe(0);

      const comment = await runCli(home, env, 'card', 'comment', parentId, '--body', 'note', '--author', 'me');
      expect(comment.status, comment.out).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('test 11: the card verb is wired through the flag parser and the command table', () => {
  it('`card create` with a repeated --depends-on reaches the card verb and records every parent', async () => {
    initTestStore(root);
    const a = createCard(root, 'default', { title: 'A' });
    const b = createCard(root, 'default', { title: 'B' });
    const { args, flags } = parseArgs([
      'node',
      'hippo',
      'card',
      'create',
      '--title',
      'child',
      '--depends-on',
      a.id,
      '--depends-on',
      b.id,
    ]);

    const run = await runInProcess(() => COMMANDS.card.run({ hippoRoot: root, tenantId: 'default', args, flags }));

    expect(run.status, run.stderr).toBe(0);
    const child = /Created card (\S+)/.exec(run.stdout)?.[1] ?? '';
    expect((await cardDetailOf(root, 'default', child))?.deps.parents.sort()).toEqual([a.id, b.id].sort());
  });
});
