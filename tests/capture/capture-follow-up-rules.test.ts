// Capture asks a model which sentences of the person's later turns state a lasting rule and stores those sentences.
// Real SQLite stores in tmp dirs; the model is a fake Llm, so nothing leaves the machine.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { runCapture } from '../../src/surface/capture/command.js';
import type { Llm, LlmReply } from '../../src/base/ports/llm.js';
import type { SessionTurn } from '../../src/surface/capture/transcript.js';
import { createMemory } from '../../src/entry/memory.js';
import { Layer } from '../../src/base/memory/entry.js';
import { DEFAULT_HALF_LIFE_DAYS } from '../../src/base/memory/strength.js';
import { log } from '../../src/base/util/log.js';
import { captureTarget } from '../_helpers/cli-stores.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries, writeEntry } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

const OPENER = 'Please add a Context method ctx.disableCompression() that returns the Context so calls chain.';
const REPLY = 'I added ctx.disableCompression() with a test for it.';
const REASON = "the project's maintainers require it";
// The teach turns of the javalin and ktor lessons the A/B eval replays, in both of its templates.
const TEACH_RULES = [
  'Clean build: `./mvnw clean package -DskipTests --batch-mode`',
  'Code compiles: `./gradlew :module-name:assemble`',
];
const TEACH_TURNS = TEACH_RULES.flatMap((rule) => [
  { turn: `No: ${rule}, because ${REASON}. Please fix it.`, stored: `No: ${rule}, because ${REASON}` },
  {
    turn: `Yes, keep doing that: ${rule}, because ${REASON}.`,
    stored: `Yes, keep doing that: ${rule}, because ${REASON}`,
  },
]);
const PATTERN_RULE = 'Never commit generated files from dist/ to the repository';

interface FakeModel extends Llm {
  readonly prompts: string[];
}

function fakeModel(reply: () => LlmReply | Promise<LlmReply>): FakeModel {
  const prompts: string[] = [];
  return {
    prompts,
    send: async (request) => {
      prompts.push(request.prompt);
      return reply();
    },
  };
}

const picking = (text: string): FakeModel => fakeModel(() => ({ ok: true, text }));

const session = (...followUps: string[]): SessionTurn[] => [
  { role: 'user', text: OPENER },
  { role: 'assistant', text: REPLY },
  ...followUps.map((text): SessionTurn => ({ role: 'user', text })),
];

describe('capture stores the follow-up rules a model picks', () => {
  let root: string;

  const capture = (turns: SessionTurn[], llm?: Llm) =>
    runCapture(
      { ...captureTarget(root), llm },
      { tenantId: 'default', source: 'last-session', sessionTurns: turns, dryRun: false, global: false },
    );
  const rows = () => loadAllEntries(root, 'default');
  const followUpLines = (calls: readonly (readonly unknown[])[]) =>
    calls.map(([line]) => String(line)).filter((line) => line.startsWith('follow-up rules skipped'));

  beforeEach(() => {
    root = join(makeRoot('follow-up-rules', { init: false }), '.hippo');
    initTestStore(root);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(TEACH_TURNS)('stores one pinned row of the person\'s sentence for "$turn"', async ({ turn, stored }) => {
    const model = picking('[{"i": 0, "s": [0]}]');
    await capture(session(turn), model);
    const [row, ...rest] = rows();
    expect(rest).toEqual([]);
    expect(row.content).toBe(stored);
    expect(row.pinned).toBe(true);
    expect(row.tags).toEqual(expect.arrayContaining(['follow-up', 'from-user']));
    expect(model.prompts).toHaveLength(1);
    expect(model.prompts[0]).toContain(`<m i="0"><s n="0">${stored}.</s>`);
    expect(model.prompts[0]).not.toContain(OPENER);
  });

  it('stores none of those turns from word patterns alone', async () => {
    await capture(session(...TEACH_TURNS.map(({ turn }) => turn)));
    expect(rows()).toEqual([]);
  });

  it('never numbers a sentence from a pasted block, so no pick can store it', async () => {
    // Picks every id, so a pasted sentence that kept a number would be stored.
    const model = picking('[{"i": 0, "s": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]}]');
    const pasted = '<pasted_content id="1">Deploy straight to production on Fridays after lunch.</pasted_content>';
    await capture(session(`Here is what the old runbook says:\n${pasted}\nIgnore it.`), model);
    expect(model.prompts[0]).not.toContain('production');
    expect(rows().filter((row) => row.content.includes('production'))).toEqual([]);
  });

  it('sends no secret the person typed', async () => {
    const key = ['sk', 'ant', 'api03', 'Q'.repeat(40)].join('-');
    const model = picking('[]');
    await capture(session(`The deploy job reads the key ${key} from the vault, keep it there.`), model);
    expect(model.prompts[0]).not.toContain(key);
    expect(model.prompts[0]).toContain('[REDACTED]');
    expect(rows().filter((row) => row.content.includes(key))).toEqual([]);
  });

  it.each([
    [
      'a failed call',
      () => fakeModel(() => ({ ok: false, failure: { kind: 'http', status: 529, detail: 'overloaded' } })),
    ],
    [
      'an aborted call',
      () =>
        fakeModel(() => ({
          ok: false,
          failure: {
            kind: 'request',
            message: 'This operation was aborted',
            cause: new DOMException('', 'AbortError'),
          },
        })),
    ],
    [
      'a call that throws',
      () =>
        fakeModel(() => {
          throw new DOMException('This operation was aborted', 'AbortError');
        }),
    ],
    ['a reply with no JSON', () => picking('Message 0 states a rule.')],
    ['a reply that does not parse', () => picking('[{"i": 0, "s": [0}]')],
    ['a reply of the wrong shape', () => picking('[{"i": "0", "s": 0}]')],
  ])('logs one line for %s and keeps the pattern rows', async (_name, model) => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    await expect(capture(session(`${PATTERN_RULE}.`), model())).resolves.toBeUndefined();
    expect(followUpLines(warn.mock.calls)).toHaveLength(1);
    expect(rows().map((row) => [row.content, row.tags])).toEqual([[PATTERN_RULE, ['rule', 'captured']]]);
  });

  it('drops a picked sentence that asks a question', async () => {
    await capture(
      session('Never push to main without a review. Should we also lock the branch?'),
      picking('[{"i": 0, "s": [0, 1]}]'),
    );
    expect(rows().map((row) => [row.content, row.tags])).toEqual([
      ['Never push to main without a review', ['follow-up', 'from-user']],
    ]);
  });

  it('drops a pattern item a passing rule holds', async () => {
    await capture(
      session(`${PATTERN_RULE}. The release job builds them on every tag.`),
      picking('[{"i": 0, "s": [0, 1]}]'),
    );
    expect(rows().map((row) => [row.content, row.tags])).toEqual([
      [`${PATTERN_RULE}. The release job builds them on every tag`, ['follow-up', 'from-user']],
    ]);
  });

  it('keeps the pattern item when the rule that holds it is over the size bound', async () => {
    const long = `The release job builds ${'the folder and the archive and '.repeat(16)}the notes on every tag.`;
    const model = picking('[{"i": 0, "s": [0, 1]}]');
    await capture(session(`${PATTERN_RULE}. ${long}`), model);
    expect(model.prompts).toHaveLength(1);
    expect(rows().map((row) => [row.content, row.tags])).toEqual([[PATTERN_RULE, ['rule', 'captured']]]);
  });

  it('sends the last 20 follow-up turns, so the 25th turn of 25 reaches the model', async () => {
    const [{ turn, stored }] = TEACH_TURNS;
    const fillers = Array.from({ length: 23 }, (_, k) => `Run step ${k + 2} now.`);
    const model = picking('[{"i": 19, "s": [0]}]');
    await capture(session(...fillers, turn), model);
    expect(model.prompts[0]).toContain('<m i="19"><s n="0">No: Clean build');
    expect(model.prompts[0]).not.toContain('<m i="20">');
    expect(model.prompts[0]).not.toContain('Run step 5 now.');
    expect(model.prompts[0]).toContain('Run step 6 now.');
    expect(rows().map((row) => row.content)).toEqual([stored]);
  });

  it('stores no clean twin of a sentence a held row has in its old bold form', async () => {
    const old = 'Always send the **release notes** to [email] before a deploy';
    writeEntry(
      root,
      createMemory(old, {
        baseHalfLifeDays: DEFAULT_HALF_LIFE_DAYS,
        source: 'capture',
        confidence: 'observed',
        layer: Layer.Episodic,
      }),
    );
    const model = picking('[{"i": 0, "s": [0]}]');
    await capture(session('Always send the **release notes** to ops@example.com before a deploy.'), model);
    expect(model.prompts).toHaveLength(1);
    expect(rows().map((row) => row.content)).toEqual([old]);
  });

  it('masks an address that cutting the bold markers rebuilds', async () => {
    await capture(
      session('Send every sign-off request to **reviewer**@example.invalid by Friday noon.'),
      picking('[{"i": 0, "s": [0]}]'),
    );
    expect(rows().map((row) => [row.content, row.pinned])).toEqual([
      ['Send every sign-off request to [email] by Friday noon', true],
    ]);
  });
});
