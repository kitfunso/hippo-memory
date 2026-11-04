// `hippo session-rules` through the real CLI: the SessionStart reply that carries only the rules the person taught, and
// the cases where it must print nothing. Real stores in tmp dirs, each test with its own HIPPO_HOME and project folder.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeHippoDb, openHippoDb } from '../src/db/index.js';
import { USER_RULE_TAG } from '../src/api/user-rule.js';
import type { MemoryEntry } from '../src/core/memory.js';
import { resolveProjectIdentity } from '../src/core/project-identity.js';
import { initStore } from '../src/store/open.js';
import { writeEntry } from '../src/store/entry-writes.js';
import { createMemory } from './_helpers/default-half-life-memory.js';
import { hippoRun } from './_helpers/spawn-hippo.js';

const FIRST_MS = Date.UTC(2026, 0, 1);
const HEADING = '## Rules from the user';
// The project name for the folder `work`, which the admission rules match a row's origin against.
const PROJECT = 'work';

let dir: string;
let cwd: string;
let local: string;
let globalRoot: string;

function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, HIPPO_HOME: globalRoot, HOME: dir, USERPROFILE: dir };
  delete e.CLAUDE_CODE_SESSION_ID;
  delete e.HIPPO_SESSION_ID;
  return e;
}

/** The row capture writes for a rule the person stated; a higher `n` is newer. */
function ruleRow(content: string, n: number, over: Partial<MemoryEntry> = {}): MemoryEntry {
  const row = createMemory(content, {
    source: 'capture',
    confidence: 'observed',
    pinned: true,
    tags: ['rule', 'captured', USER_RULE_TAG],
  });
  return { ...row, origin_project: PROJECT, created: new Date(FIRST_MS + n * 60_000).toISOString(), ...over };
}

function startPayload(sessionId: string): string {
  return JSON.stringify({ session_id: sessionId, hook_event_name: 'SessionStart', source: 'startup' });
}

async function sessionRules(sessionId = 's1', at = cwd): Promise<{ status: number; stdout: string }> {
  const { status, stdout, stderr } = hippoRun(['session-rules'], {
    cwd: at,
    env: env(),
    input: startPayload(sessionId),
  });
  expect(stderr).toBe('');
  return { status: status ?? -1, stdout };
}

function reply(text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } });
}

function setRate(rateBp: number): void {
  fs.writeFileSync(path.join(local, 'config.json'), JSON.stringify({ pilot: { holdoutRateBp: rateBp } }));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-session-rules-'));
  cwd = path.join(dir, 'work');
  fs.mkdirSync(cwd);
  local = path.join(cwd, '.hippo');
  globalRoot = path.join(dir, 'global');
  initStore(globalRoot);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('hippo session-rules in a project with its own store', () => {
  beforeEach(() => {
    initStore(local);
  });

  it('prints the SessionStart reply with the rules oldest first and their text as stored', async () => {
    writeEntry(local, ruleRow('Yes, keep doing that: Run the linter before every commit.', 1));
    writeEntry(local, ruleRow('No: Clean build: `./mvnw clean package -DskipTests`, because CI does.', 0));
    writeEntry(local, ruleRow('Never edit CHANGELOG.md by hand.', 2));
    writeEntry(local, {
      ...createMemory('Deploys go through the staging queue.', { pinned: true }),
      origin_project: PROJECT,
    });

    const { status, stdout } = await sessionRules();

    expect(status).toBe(0);
    expect(stdout).toBe(
      reply(
        [
          HEADING,
          '- No: Clean build: `./mvnw clean package -DskipTests`, because CI does.',
          '- Yes, keep doing that: Run the linter before every commit.',
          '- Never edit CHANGELOG.md by hand.',
        ].join('\n'),
      ),
    );
  });

  it('books the block under the session_start surface', async () => {
    writeEntry(local, ruleRow('No: Never edit CHANGELOG.md by hand.', 0));
    await sessionRules('s-ledger');

    const db = openHippoDb(local);
    try {
      const rows = db
        .prepare(`SELECT session_id, surface, event, items, tokens FROM token_ledger WHERE surface = 'session_start'`)
        .all();
      expect(rows).toEqual([
        { session_id: 's-ledger', surface: 'session_start', event: 'inject', items: 1, tokens: expect.any(Number) },
      ]);
    } finally {
      closeHippoDb(db);
    }
  });

  it('prints nothing when the project holds no user rule', async () => {
    writeEntry(local, {
      ...createMemory('Deploys go through the staging queue.', { pinned: true }),
      origin_project: PROJECT,
    });

    expect(await sessionRules()).toEqual({ status: 0, stdout: '' });
  });

  it('prints nothing in a pilot holdout session, and prints in the same project outside it', async () => {
    writeEntry(local, ruleRow('Never edit CHANGELOG.md by hand.', 0));

    setRate(0);
    expect((await sessionRules('s-in')).stdout).toBe(reply(`${HEADING}\n- Never edit CHANGELOG.md by hand.`));

    setRate(10_000);
    expect(await sessionRules('s-held')).toEqual({ status: 0, stdout: '' });
  });
});

describe('hippo session-rules in a project folder with no .hippo', () => {
  beforeEach(() => {
    execSync('git init -q', { cwd, stdio: 'ignore' });
  });

  it('reads the global store alone, and only the rules stamped with this project', async () => {
    const here = resolveProjectIdentity(cwd).name;
    writeEntry(globalRoot, ruleRow('No: Never edit CHANGELOG.md by hand.', 0, { origin_project: here }));
    writeEntry(globalRoot, ruleRow('Always squash merges.', 1, { origin_project: `${here}-other` }));

    const { status, stdout } = await sessionRules();

    expect(status).toBe(0);
    expect(stdout).toBe(reply(`${HEADING}\n- No: Never edit CHANGELOG.md by hand.`));
    expect(fs.existsSync(local)).toBe(false);
  });

  it('prints nothing and creates no store when no store exists at all', async () => {
    fs.rmSync(globalRoot, { recursive: true, force: true });

    expect(await sessionRules()).toEqual({ status: 0, stdout: '' });
    expect([fs.existsSync(local), fs.existsSync(globalRoot)]).toEqual([false, false]);
  });
});
