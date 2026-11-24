import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { isDetectTag } from '../../src/base/memory/detect-tags.js';
import type { Llm, LlmReply, LlmUsage } from '../../src/base/ports/llm.js';
import { log } from '../../src/base/util/log.js';
import { runCapture } from '../../src/surface/capture/command.js';
import { detectorUsageLine, ruleDetectors } from '../../src/surface/capture/detector.js';
import type { SessionTurn } from '../../src/surface/capture/transcript.js';
import { captureTarget } from '../_helpers/cli-stores.js';
import { makeRoot } from '../_helpers/make-root.js';
import { loadAllEntries } from '../_helpers/root-forms.js';
import { initTestStore } from '../_helpers/store-template.js';

const OPENER = 'Please add a Context method ctx.disableCompression() that returns the Context so calls chain.';
const REPLY = 'I added ctx.disableCompression() with a test for it.';
const FORMAT_RULE = 'Always run `black .` and `flake8` on the Python files you edit';
const LINT_RULE = 'Always run `make lint` when you change the build files';
const PROHIBITION = 'Never commit generated files from dist/ to the repository';
const MODEL_ONLY_RULE = 'That file is generated, so changes belong in the template it comes from';
const DETECTOR_REPLY = '[{"i": 0, "applies": ["**/*.py"], "commands": [["black ."], ["flake8", "ruff check"]]}]';
const FORMAT_TAGS = ['detect:applies:**/*.py', 'detect:cmd:["black ."]', 'detect:cmd:["flake8","ruff check"]'];
const FROZEN_PROMPT = [
  'Each rule below was given by a person to a coding agent.',
  'If following a rule means running a command, give the commands a later session must run to follow it.',
  'Return only JSON: [{"i": <rule number>, "applies": [<file globs>], "commands": [[<alternates>], ...]}] ' +
    'for rules that a command shows; leave other rules out.',
  'applies lists globs of edited files that make the rule relevant, like "**/*.py"; ' +
    'use [] when any code change makes it relevant.',
  'Each inner list of commands is one command the agent must run; its items are other common ways ' +
    'to run that same command, like ["npm test", "npm run test"].',
  'Give the shortest stable part of each command, with no quotes and no file arguments.',
  'Leave out rules that a command cannot show: style, naming, prohibitions, doc or changelog edits, ' +
    'and rules with a condition you cannot see in file paths.',
  '',
  '',
].join('\n');

const promptFor = (...rules: string[]): string =>
  FROZEN_PROMPT + rules.map((rule, i) => `<r i="${i}">${rule}</r>\n`).join('');

interface FakeModel extends Llm {
  readonly followUpPrompts: string[];
  readonly detectorPrompts: string[];
}

type Say = () => LlmReply;

const said =
  (text: string, usage?: LlmUsage): Say =>
  () => ({ ok: true, text, usage });

function fakeModel(followUp: Say, detector: Say): FakeModel {
  const followUpPrompts: string[] = [];
  const detectorPrompts: string[] = [];
  return {
    followUpPrompts,
    detectorPrompts,
    send: async ({ prompt }) => {
      if (prompt.startsWith(FROZEN_PROMPT)) {
        detectorPrompts.push(prompt);
        return detector();
      }
      followUpPrompts.push(prompt);
      return followUp();
    },
  };
}

const detecting = (reply: string): FakeModel => fakeModel(said('[]'), said(reply));

const session = (...followUps: string[]): SessionTurn[] => [
  { role: 'user', text: OPENER },
  { role: 'assistant', text: REPLY },
  ...followUps.map((text): SessionTurn => ({ role: 'user', text })),
];

const silentLog = () => undefined;
const fakeLlm = (reply: string): Llm => ({ send: async () => ({ ok: true, text: reply }) });

describe('ruleDetectors', () => {
  const ask = (rules: string[], reply: string) => ruleDetectors(rules, fakeLlm(reply), silentLog);

  it('sends the frozen prompt and then one <r> line per rule', async () => {
    const prompts: string[] = [];
    const llm: Llm = {
      send: async ({ prompt }) => {
        prompts.push(prompt);
        return { ok: true, text: '[]' };
      },
    };
    await ruleDetectors([FORMAT_RULE, 'Keep\nthe   spacing'], llm, silentLog);
    expect(prompts).toEqual([promptFor(FORMAT_RULE, 'Keep the spacing')]);
  });

  it('reads one detector per rule from the reply and leaves the rest null', async () => {
    const { detectors } = await ask(
      [FORMAT_RULE, 'Name every table in snake case', 'Run `npm test` for each change'],
      '[{"i": 2, "applies": [], "commands": [["npm test", "npm run test"]]}, ' +
        '{"i": 0, "applies": ["**/*.py"], "commands": [["black ."], ["flake8", "ruff check"]]}]',
    );
    expect(detectors).toEqual([
      { applies: ['**/*.py'], commands: [['black .'], ['flake8', 'ruff check']] },
      null,
      { applies: [], commands: [['npm test', 'npm run test']] },
    ]);
  });

  it('drops malformed items, empty strings and detectors with no command, and keeps the good one', async () => {
    const { detectors } = await ask(
      [FORMAT_RULE, 'Run `make lint` for each change', 'Run `make docs` for each change', 'Run `make bench`'],
      JSON.stringify([
        'text',
        { i: '0', applies: [], commands: [['black .']] },
        { i: 0, applies: 'any', commands: [['black .']] },
        { i: 0, applies: [], commands: [['black .', 7]] },
        { i: 1, applies: ['', '  '], commands: [[], [''], [' make lint ', '']] },
        { i: 2, applies: [], commands: [[''], []] },
        { i: 3, applies: [] },
        { i: 9, applies: [], commands: [['make']] },
      ]),
    );
    expect(detectors).toEqual([null, { applies: [], commands: [['make lint']] }, null, null]);
  });

  it('keeps the first detector of a rule the reply repeats', async () => {
    const { detectors } = await ask(
      [FORMAT_RULE],
      '[{"i": 0, "applies": [], "commands": [["black ."]]}, {"i": 0, "applies": [], "commands": [["ruff"]]}]',
    );
    expect(detectors).toEqual([{ applies: [], commands: [['black .']] }]);
  });

  it('caps globs at 5, command groups at 4 and alternates at 4, and drops a string over 120 characters', async () => {
    const long = 'x'.repeat(121);
    const edge = 'y'.repeat(120);
    const { detectors } = await ask(
      [FORMAT_RULE],
      JSON.stringify([
        {
          i: 0,
          applies: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
          commands: [['c1', 'c1b', 'c1c', 'c1d', 'c1e', 'c1f'], ['c2', long], ['c3', edge], ['c4'], ['c5'], ['c6']],
        },
      ]),
    );
    expect(detectors).toEqual([
      {
        applies: ['a', 'b', 'c', 'd', 'e'],
        commands: [['c1', 'c1b', 'c1c', 'c1d'], ['c2'], ['c3', edge], ['c4']],
      },
    ]);
  });

  it('scrubs every string it keeps', async () => {
    const { detectors } = await ask(
      [FORMAT_RULE],
      '[{"i": 0, "applies": ["notes/ops@example.com/**"], "commands": [["mail ops@example.com"]]}]',
    );
    expect(detectors).toEqual([{ applies: ['notes/[email]/**'], commands: [['mail [email]']] }]);
  });

  it.each([
    ['starts with never', 'Never push to main'],
    ['starts with do not', 'Do not skip the hooks'],
    ['starts with a curly don’t', 'Don’t amend a pushed commit'],
    ['starts with avoid', 'Avoid mocks in the store tests'],
    ['starts with a no: lead and never', 'No: Never use `print()` in the store'],
  ])('gives a rule that %s no detector, whatever the reply says', async (_name, rule) => {
    const { detectors } = await ask(
      [rule, FORMAT_RULE],
      '[{"i": 0, "applies": [], "commands": [["npm test"]]}, {"i": 1, "applies": [], "commands": [["black ."]]}]',
    );
    expect(detectors).toEqual([null, { applies: [], commands: [['black .']] }]);
  });

  it.each([
    ['a before', 'Run `npm test` before you push'],
    ['a not', 'Run the tests with `npm test`, not the bare `vitest`'],
    ['a contraction', "Run `npm test`, it isn't optional"],
  ])('keeps the detector of a command rule that holds %s', async (_name, rule) => {
    const { detectors } = await ask([rule], '[{"i": 0, "applies": [], "commands": [["npm test"]]}]');
    expect(detectors).toEqual([{ applies: [], commands: [['npm test']] }]);
  });

  it('asks nothing of a model when there are no rules', async () => {
    const send = vi.fn();
    expect(await ruleDetectors([], { send }, silentLog)).toEqual({ detectors: [], usage: undefined });
    expect(send).not.toHaveBeenCalled();
  });

  it('reports the billed tokens with the detectors', async () => {
    const usage = { inputTokens: 812, outputTokens: 37 };
    const llm: Llm = { send: async () => ({ ok: true, text: DETECTOR_REPLY, usage }) };
    expect((await ruleDetectors([FORMAT_RULE], llm, silentLog)).usage).toEqual(usage);
  });

  it.each([
    ['no JSON list', 'Rule 0 needs black.'],
    ['a list that does not parse', '[{"i": 0, "applies": []'],
    ['a JSON object, not a list', '{"i": 0}'],
  ])('logs one line and gives no detector for a reply of %s', async (_name, reply) => {
    const lines: string[] = [];
    const { detectors } = await ruleDetectors([FORMAT_RULE], fakeLlm(reply), (line) => lines.push(line));
    expect(detectors).toEqual([null]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^rule detectors skipped: /);
  });

  it.each([
    ['a failed call', (): LlmReply => ({ ok: false, failure: { kind: 'http', status: 529, detail: 'overloaded' } })],
    [
      'a call that throws',
      (): LlmReply => {
        throw new DOMException('This operation was aborted', 'AbortError');
      },
    ],
  ])('logs one line and gives no detector for %s', async (_name, reply) => {
    const lines: string[] = [];
    const llm: Llm = { send: async () => reply() };
    const { detectors } = await ruleDetectors([FORMAT_RULE, LINT_RULE], llm, (line) => lines.push(line));
    expect(detectors).toEqual([null, null]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^rule detectors skipped: /);
  });

  it('prints the usage line with the request model, or the endpoint model when one is named', () => {
    const usage = { inputTokens: 812, outputTokens: 37 };
    expect(detectorUsageLine(usage)).toBe('rule detectors: model=claude-sonnet-5-5 input_tokens=812 output_tokens=37');
    expect(detectorUsageLine(usage, 'gpt-x')).toBe('rule detectors: model=gpt-x input_tokens=812 output_tokens=37');
  });
});

describe('capture writes the detector of each rule it stores', () => {
  let root: string;

  const capture = (turns: SessionTurn[], llm?: Llm, extra: { dryRun?: boolean; llmModel?: string } = {}) =>
    runCapture(
      { ...captureTarget(root), llm, llmModel: extra.llmModel },
      {
        tenantId: 'default',
        source: 'last-session',
        sessionTurns: turns,
        dryRun: extra.dryRun ?? false,
        global: false,
      },
    );
  const rows = () => loadAllEntries(root, 'default');
  const detectTags = () => rows().map((row) => row.tags.filter(isDetectTag));
  const skippedLines = (calls: readonly (readonly unknown[])[]) =>
    calls.map(([line]) => String(line)).filter((line) => line.startsWith('rule detectors skipped'));

  beforeEach(() => {
    root = join(makeRoot('rule-detectors', { init: false }), '.hippo');
    initTestStore(root);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tags a model-route rule with the detector in the reply, in one call', async () => {
    const model = fakeModel(said('[{"i": 0, "s": [0]}]'), said(DETECTOR_REPLY));
    await capture(session(`${MODEL_ONLY_RULE}.`), model);
    const [row, ...rest] = rows();
    expect(rest).toEqual([]);
    expect(row.content).toBe(MODEL_ONLY_RULE);
    expect(row.tags).toEqual(expect.arrayContaining(['follow-up', 'from-user']));
    expect(row.tags.filter(isDetectTag)).toEqual(FORMAT_TAGS);
    expect(model.detectorPrompts).toEqual([promptFor(MODEL_ONLY_RULE)]);
  });

  it('tags a pattern-route rule too, though the model picked none', async () => {
    const model = detecting(DETECTOR_REPLY);
    await capture(session(`${FORMAT_RULE}.`), model);
    const [row, ...rest] = rows();
    expect(rest).toEqual([]);
    expect(row.content).toBe(FORMAT_RULE);
    expect(row.tags).toEqual(expect.arrayContaining(['rule', 'captured', 'from-user']));
    expect(row.tags).not.toContain('follow-up');
    expect(row.tags.filter(isDetectTag)).toEqual(FORMAT_TAGS);
    expect(model.detectorPrompts).toHaveLength(1);
  });

  it('numbers the rules about to be written in one call and tags each with its own detector', async () => {
    const model = detecting(
      '[{"i": 1, "applies": [], "commands": [["make lint"]]}, {"i": 0, "applies": ["**/*.py"], "commands": [["black ."]]}]',
    );
    await capture(session(`${FORMAT_RULE}.`, `${LINT_RULE}.`), model);
    expect(model.detectorPrompts).toHaveLength(1);
    expect(model.detectorPrompts[0]).toContain(`<r i="0">${FORMAT_RULE}</r>\n<r i="1">${LINT_RULE}</r>\n`);
    const byContent = new Map(rows().map((row) => [row.content, row.tags.filter(isDetectTag)]));
    expect(byContent.get(FORMAT_RULE)).toEqual(['detect:applies:**/*.py', 'detect:cmd:["black ."]']);
    expect(byContent.get(LINT_RULE)).toEqual(['detect:cmd:["make lint"]']);
  });

  it('gives a rule with no detector in the reply no detect: tags', async () => {
    await capture(session(`${FORMAT_RULE}.`), detecting('[]'));
    expect(rows().map((row) => [row.content, row.pinned])).toEqual([[FORMAT_RULE, true]]);
    expect(detectTags()).toEqual([[]]);
  });

  it('gives a prohibition no detector, though the reply names one', async () => {
    await capture(session(`${PROHIBITION}.`), detecting(DETECTOR_REPLY));
    expect(rows().map((row) => row.content)).toEqual([PROHIBITION]);
    expect(detectTags()).toEqual([[]]);
  });

  it.each([
    ['a malformed reply', 'Rule 0 needs black.'],
    ['a list that does not parse', '[{"i": 0, "applies": []'],
  ])('keeps the rule with no detect: tags and logs one line for %s', async (_name, reply) => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    await capture(session(`${FORMAT_RULE}.`), detecting(reply));
    expect(rows().map((row) => row.content)).toEqual([FORMAT_RULE]);
    expect(detectTags()).toEqual([[]]);
    expect(skippedLines(warn.mock.calls)).toHaveLength(1);
  });

  it.each([
    [
      'a failed call',
      () => fakeModel(said('[]'), () => ({ ok: false, failure: { kind: 'http', status: 529, detail: 'overloaded' } })),
    ],
    [
      'a call that throws',
      () =>
        fakeModel(said('[]'), () => {
          throw new DOMException('This operation was aborted', 'AbortError');
        }),
    ],
  ])('keeps the rule with no detect: tags and logs one line for %s', async (_name, model) => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    await expect(capture(session(`${FORMAT_RULE}.`), model())).resolves.toBeUndefined();
    expect(rows().map((row) => [row.content, row.pinned])).toEqual([[FORMAT_RULE, true]]);
    expect(detectTags()).toEqual([[]]);
    expect(skippedLines(warn.mock.calls)).toHaveLength(1);
  });

  it('asks nothing for a rule that is already stored, and leaves its row as it was', async () => {
    await capture(session(`${FORMAT_RULE}.`));
    const stored = rows();
    const model = detecting(DETECTOR_REPLY);
    await capture(session(`${FORMAT_RULE}.`), model);
    expect(model.detectorPrompts).toEqual([]);
    expect(rows()).toEqual(stored);
  });

  it('sends only the rules not yet stored', async () => {
    await capture(session(`${FORMAT_RULE}.`));
    const model = detecting('[{"i": 0, "applies": [], "commands": [["make lint"]]}]');
    await capture(session(`${FORMAT_RULE}.`, `${LINT_RULE}.`), model);
    expect(model.detectorPrompts).toEqual([promptFor(LINT_RULE)]);
  });

  it('asks nothing when capture stores no rule', async () => {
    const model = detecting(DETECTOR_REPLY);
    await capture(session('Run the tests with `pnpm test:unit`, not the bare `pnpm test`.'), model);
    expect(model.detectorPrompts).toEqual([]);
  });

  it('asks nothing in a dry run, which stores nothing', async () => {
    const model = detecting(DETECTOR_REPLY);
    await capture(session(`${FORMAT_RULE}.`), model, { dryRun: true });
    expect(model.detectorPrompts).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it('stores the rule with no detect: tags when the target has no model', async () => {
    await capture(session(`${FORMAT_RULE}.`));
    expect(rows().map((row) => row.content)).toEqual([FORMAT_RULE]);
    expect(detectTags()).toEqual([[]]);
  });

  it('prints the billed tokens of the detector call after the follow-up line, so a harness can price both', async () => {
    const lines = vi.spyOn(console, 'log').mockImplementation(() => {});
    const model = fakeModel(
      said('[]', { inputTokens: 100, outputTokens: 5 }),
      said(DETECTOR_REPLY, { inputTokens: 812, outputTokens: 37 }),
    );
    await capture(session(`${FORMAT_RULE}.`), model);
    const printed = lines.mock.calls.map(([line]) => String(line));
    const followUp = printed.indexOf('follow-up rules: model=claude-sonnet-5-5 input_tokens=100 output_tokens=5');
    const detector = printed.indexOf('rule detectors: model=claude-sonnet-5-5 input_tokens=812 output_tokens=37');
    expect(followUp).toBeGreaterThanOrEqual(0);
    expect(detector).toBeGreaterThan(followUp);
  });

  it('names the endpoint model in the usage line when the target has one', async () => {
    const lines = vi.spyOn(console, 'log').mockImplementation(() => {});
    const model = fakeModel(said('[]'), said(DETECTOR_REPLY, { inputTokens: 9, outputTokens: 3 }));
    await capture(session(`${FORMAT_RULE}.`), model, { llmModel: 'gpt-x' });
    expect(lines.mock.calls.map(([line]) => String(line))).toContain(
      'rule detectors: model=gpt-x input_tokens=9 output_tokens=3',
    );
  });
});
