import { describe, expect, it } from 'vitest';
import {
  END_CHECK_LEAD,
  END_CHECK_MAX_RULES,
  applies,
  bashWritePaths,
  commandKey,
  corrects,
  done,
  endCheckText,
  globMatch,
  isBashWrite,
  mentionsCommand,
  openRules,
  stopContext,
  type DetectedRule,
  type EndCheckScan,
} from '../../src/api/end-check.js';
import {
  brokeAfterDone,
  flaggedRules,
  type Correction,
  type ScanPrompt,
  type ValidityScan,
} from '../../src/api/validity.js';
import { MAX_FLAGS, type Detector } from '../../src/base/memory/detect-tags.js';

function scan(over: Partial<EndCheckScan> = {}): EndCheckScan {
  return { editsSincePrompt: [], editedSincePrompt: true, commands: [], earlierChecks: '', ...over };
}

function detector(applyGlobs: string[], ...commands: string[][]): Detector {
  return { applies: applyGlobs, commands };
}

function rule(id: string, created: string, applyGlobs: string[] = []): DetectedRule {
  return { id, content: `Rule ${id}: run the check.`, created, detector: detector(applyGlobs, ['pytest']), flags: 0 };
}

const ran = (command: string, landed: string): boolean => done(detector([], [command]), scan({ commands: [landed] }));

describe('commandKey', () => {
  it('folds case, quotes and runs of spaces', () => {
    expect(commandKey('./gradlew spotlessApply')).toBe(commandKey('./gradlew spotlessapply'));
    expect(commandKey(`pytest -m "not notebooks"`)).toBe('pytest -m not notebooks');
    expect(commandKey("  git   commit -m 'a  b'  ")).toBe('git commit -m a b');
  });
});

describe('a landed command counts as a detector command', () => {
  it.each([
    ['./gradlew spotlessApply', './gradlew spotlessapply'],
    ['./gradlew spotlessapply', './Gradlew SpotlessApply --info'],
    ['pytest', 'pytest'],
    ['pytest', 'cd x && pytest -q'],
    ['pytest', 'cd x; pytest'],
    ['pytest', 'make build || true\npytest -q'],
    ['pytest', 'FOO=1 pytest tests/'],
    ['pytest -m not notebooks', 'python -m pytest -m "not notebooks"'],
    ['pytest -m "not notebooks"', 'python3 -m pytest -m not notebooks'],
    ['coverage report', 'uv run coverage report'],
    ['uv run pytest', 'uv run pytest -q'],
    ['uv run pytest', 'sudo uv run pytest'],
    ['npm test', 'cd web && sudo npm test'],
    ['dotnet test --framework net8.0', 'dotnet test tests/CoreTests/ --framework net8.0'],
    ['dotnet build -c Release', 'dotnet build src/Markdig/Markdig.csproj -c Release'],
    ['mvn -pl sniffy-module-tls -am clean test', 'mvn -q -pl sniffy-module-tls -am clean test'],
    ['pnpm build --filter', 'pnpm build --filter=@heroui/styles 2>&1 | tail -15'],
    ['npx jest --config', 'npx jest --config=tests/unit/jest.config.mjs'],
    ['pnpm typecheck', 'cd w; (pnpm lint && pnpm typecheck) 2>&1 | tail -25'],
    ['pnpm lint', '{ pnpm lint; }'],
  ])('%s is run by %s', (command, landed) => {
    expect(ran(command, landed)).toBe(true);
  });

  it.each([
    ['flake8', 'pip install flake8'],
    ['pytest', 'cat pytest.ini'],
    ['pytest', 'echo pytest'],
    ['pytest', 'pytestx'],
    ['ruff check', 'ruff format'],
    ['pytest', 'grep -r pytest .'],
    ['ruff check', 'ruff format check.py'],
    ['dotnet test -c Release', 'dotnet test src/X.Tests/X.Tests.csproj'],
    ['mvn clean test', 'mvn test clean'],
    ['npm test', 'npm install && echo test'],
    ['npx jest --config', 'npx jest --configs=x'],
    ['uv run pytest', 'pytest -q'],
    ['uv run pytest', '.venv/Scripts/python.exe -m pytest -q'],
    ['uv run coverage report', 'coverage report -m'],
    ['pytest', ''],
    ['', 'pytest'],
  ])('%s is not run by %s', (command, landed) => {
    expect(ran(command, landed)).toBe(false);
  });

  it('needs every group to have a run, and any one command in a group', () => {
    const rule3 = detector([], ['pytest'], ['ruff check', 'flake8']);
    const doneWith = (...commands: string[]): boolean => done(rule3, scan({ commands }));
    expect(doneWith()).toBe(false);
    expect(doneWith('pytest -q')).toBe(false);
    expect(doneWith('ruff check .', 'flake8 src')).toBe(false);
    expect(doneWith('pytest -q', 'flake8 src')).toBe(true);
    expect(doneWith('ruff check .', 'pytest -q')).toBe(true);
  });
});

describe('globMatch', () => {
  it('matches **/*.py on a lower-case forward-slash absolute path, at any depth', () => {
    expect(globMatch('**/*.py', '/home/keith/proj/src/app.py')).toBe(true);
    expect(globMatch('**/*.py', '/app.py')).toBe(true);
    expect(globMatch('**/*.py', 'c:/users/keith/proj/app.py')).toBe(true);
  });

  it('does not match another extension or a file under a folder named like the glob', () => {
    expect(globMatch('**/*.py', '/home/keith/proj/app.pyc')).toBe(false);
    expect(globMatch('**/*.py', '/home/keith/proj/app.py/readme.md')).toBe(false);
    expect(globMatch('**/*.py', '/home/keith/proj/app.txt')).toBe(false);
  });

  it('keeps a folder part whole and lets ** span none or many folders', () => {
    expect(globMatch('src/**/*.ts', '/proj/src/a.ts')).toBe(true);
    expect(globMatch('src/**/*.ts', '/proj/src/x/y/a.ts')).toBe(true);
    expect(globMatch('src/**/*.ts', '/proj/lib/a.ts')).toBe(false);
    expect(globMatch('src/**/*.ts', '/proj/mysrc/a.ts')).toBe(false);
  });

  it('folds the glob to lower case, lets ? take one character and takes + and . literally', () => {
    expect(globMatch('SRC/**/*.TS', '/proj/src/a.ts')).toBe(true);
    expect(globMatch('a?.py', '/p/ab.py')).toBe(true);
    expect(globMatch('a?.py', '/p/abc.py')).toBe(false);
    expect(globMatch('a+b.py', '/p/a+b.py')).toBe(true);
    expect(globMatch('a+b.py', '/p/aab.py')).toBe(false);
  });
});

describe('applies', () => {
  const pyRule = detector(['**/*.py'], ['pytest']);
  const anyEdit = detector([], ['pytest']);

  it('is false with no edit since the prompt, whatever the edits list holds', () => {
    const noEdit = scan({ editedSincePrompt: false, editsSincePrompt: ['/p/a.py'] });
    expect(applies(pyRule, noEdit)).toBe(false);
    expect(applies(anyEdit, noEdit)).toBe(false);
  });

  it('is true for a rule with no glob after any edit, a Bash write included', () => {
    expect(applies(anyEdit, scan({ editsSincePrompt: [] }))).toBe(true);
    expect(applies(anyEdit, scan({ editsSincePrompt: ['/p/a.txt'] }))).toBe(true);
  });

  it('needs an edited path that a glob matches for a rule with globs', () => {
    expect(applies(pyRule, scan({ editsSincePrompt: ['/p/a.txt', '/p/b.py'] }))).toBe(true);
    expect(applies(pyRule, scan({ editsSincePrompt: ['/p/a.txt'] }))).toBe(false);
    expect(applies(pyRule, scan({ editsSincePrompt: [] }))).toBe(false);
  });
});

describe('openRules', () => {
  it('skips a rule whose content an earlier check already listed', () => {
    const listed = rule('a', '2026-11-01');
    const fresh = rule('b', '2026-11-02');
    const earlierChecks = `${END_CHECK_LEAD}\n1. ${listed.content}`;
    expect(openRules([listed, fresh], scan({ earlierChecks }), 5)).toEqual([fresh]);
  });

  it('skips a rule that does not apply and a rule that is done', () => {
    const notApplying = rule('a', '2026-11-01', ['**/*.rs']);
    const finished = rule('b', '2026-11-02');
    const open = rule('c', '2026-11-03', ['**/*.py']);
    const state = scan({ editsSincePrompt: ['/p/a.py'], commands: ['cd p && pytest -q'] });
    expect(openRules([notApplying, finished], state, 5)).toEqual([]);
    expect(openRules([notApplying, open], scan({ editsSincePrompt: ['/p/a.py'] }), 5)).toEqual([open]);
  });

  it('ranks rules by glob hits first and by newest created second', () => {
    const oldAny = rule('old-any', '2026-11-03');
    const newAny = rule('new-any', '2026-11-05');
    const py = rule('py', '2026-11-01', ['**/*.py']);
    const ts = rule('ts', '2026-11-02', ['**/*.ts']);
    const state = scan({ editsSincePrompt: ['/p/a.py', '/p/b.py', '/p/x.ts'] });
    const order = openRules([oldAny, ts, newAny, py], state, 10).map((r) => r.id);
    expect(order).toEqual(['py', 'ts', 'new-any', 'old-any']);
  });

  it('lists at most max rules, the best ranked', () => {
    const rules = ['a', 'b', 'c', 'd'].map((id, i) => rule(id, `2026-11-0${i + 1}`));
    expect(openRules(rules, scan(), 2).map((r) => r.id)).toEqual(['d', 'c']);
    expect(openRules(rules, scan(), END_CHECK_MAX_RULES)).toHaveLength(END_CHECK_MAX_RULES);
  });
});

describe('isBashWrite', () => {
  it.each([
    'cat > f.txt <<EOF',
    'echo hi >> notes.md',
    'sed -i s/a/b/ f',
    'cd x && sed -i "s/a/b/" f.py',
    'tee out.log',
    'git apply fix.patch',
    'rm -rf build',
  ])('counts %s as a write', (command) => {
    expect(isBashWrite(command)).toBe(true);
  });

  it.each([
    'ls 2>/dev/null',
    'cmd > /dev/null',
    'cmd >/dev/null 2>&1',
    'cmd 2>&1',
    'python - <<EOF',
    'sed s/a/b/ f',
    'npm run build',
  ])('does not count %s as a write', (command) => {
    expect(isBashWrite(command)).toBe(false);
  });
});

describe('bashWritePaths', () => {
  it.each([
    [
      `cd w && sed -i '78s/max(self.domain/min(self.domain/' emukit/core/discrete_parameter.py`,
      ['emukit/core/discrete_parameter.py'],
    ],
    ['cat > notes.md <<EOF', ['notes.md']],
    ['echo hi >>out/log.txt', ['out/log.txt']],
    ['pytest 2>&1 | tee run.log', ['run.log']],
    ['mv src/global.json src/global.json.bak', ['src/global.json', 'src/global.json.bak']],
    [`sed -i 's/version = 1.2/version = 1.3/' setup.cfg && pytest tests/test_x.py`, ['setup.cfg']],
  ])('finds the written files of %s', (command, paths) => {
    expect(bashWritePaths(command)).toEqual(paths);
  });

  it.each(['rm -rf build', 'cat setup.py', 'pytest tests/test_x.py > /dev/null', 'python - <<EOF'])(
    'finds no written file in %s',
    (command) => {
      expect(bashWritePaths(command)).toEqual([]);
    },
  );
});

describe('the stop context', () => {
  it('numbers the open rules under the lead and wraps the text for the Stop hook', () => {
    const text = endCheckText([rule('a', '2026-11-01'), rule('b', '2026-11-02')]);
    expect(text).toBe(
      [
        END_CHECK_LEAD,
        'Do each one that applies to your change.',
        '',
        '1. Rule a: run the check.',
        '2. Rule b: run the check.',
      ].join('\n'),
    );
    expect(JSON.parse(stopContext(text))).toEqual({
      hookSpecificOutput: { hookEventName: 'Stop', additionalContext: text },
    });
  });
});

const MARKER = detector(['**/*.py'], ['pytest -m not notebooks']);
const MARKER_RULE: DetectedRule = {
  id: 'marker',
  content: 'Run tests with pytest -m "not notebooks"',
  created: '2026-11-01T00:00:00.000Z',
  detector: MARKER,
  flags: 0,
};
const Q118 = 'Every pytest call takes -m "not notebooks", single tests too';
const LINT_RULE: DetectedRule = {
  ...MARKER_RULE,
  id: 'lint',
  content: 'Run npm run lint before you finish',
  detector: detector([], ['npm run lint']),
};
const PROMPT: ScanPrompt = { seq: 9, at: Date.parse('2026-11-24T20:00:09.000Z'), text: 'typed' };
const said = (content: string, own: Detector | null = null): Correction => ({ content, prompt: PROMPT, detector: own });
const ranBefore = (...commands: string[]): ValidityScan => ({ prompts: [PROMPT], before: () => scan({ commands }) });

describe('mentionsCommand', () => {
  it.each([
    [Q118, 'pytest -m not notebooks'],
    ['Every pytest call takes -m \u201cnot notebooks\u201d.', 'pytest -m "not notebooks"'],
    ['Please always run `npm test`.', 'npm test'],
    ['Run ruff check . before you push.', 'ruff check .'],
  ])('finds the command words of %s in order', (text, command) => {
    expect(mentionsCommand(text, command)).toBe(true);
  });

  it.each([
    ['npm run build must pass before you hand back.', 'npm run lint'],
    ['Every call takes -m "not notebooks".', 'pytest -m not notebooks'],
    ['Keep notebooks out: not -m, pytest.', 'pytest -m not notebooks'],
    ['Use pytest.', ''],
  ])('finds no command words in %s', (text, command) => {
    expect(mentionsCommand(text, command)).toBe(false);
  });
});

describe('corrects', () => {
  it('matches the rule text, the rule command in the prose, or an own command that runs it', () => {
    expect(corrects(said(MARKER_RULE.content), MARKER_RULE)).toBe(true);
    expect(corrects(said(Q118), MARKER_RULE)).toBe(true);
    expect(
      corrects(said('Single tests need the marker too.', detector([], ['pytest -m not notebooks'])), MARKER_RULE),
    ).toBe(true);
  });

  it('does not take an npm run build correction for an npm run lint rule', () => {
    const build = said('npm run build must pass before you hand back', detector([], ['npm run build']));
    expect(corrects(build, LINT_RULE)).toBe(false);
  });
});

describe('brokeAfterDone', () => {
  it.each([
    [MARKER, ['pytest -m "not notebooks"', 'cd w && pytest tests/test_io.py'], true],
    [MARKER, ['pytest -m "not notebooks"', 'pytest -m "not notebooks" tests/test_io.py'], false],
    [MARKER, ['pytest tests/test_io.py', 'pytest -m "not notebooks"'], false],
    [MARKER, ['pytest -m "not notebooks"', 'ruff check .'], false],
    [detector([], ['uv run pytest']), ['uv run pytest -q', 'pytest -q'], true],
  ])('%o after %o is %s', (rule, commands, broken) => {
    expect(brokeAfterDone(rule, scan({ commands }))).toBe(broken);
  });
});

describe('flaggedRules', () => {
  const q118 = ranBefore('pytest -m "not notebooks"', 'pytest tests/test_io.py');

  it('flags a rule that ran, then broke, then was corrected, and never a rule newer than the prompt', () => {
    const fresh: DetectedRule = { ...MARKER_RULE, id: 'fresh', content: Q118, created: '2026-11-25T00:00:00.000Z' };
    expect(flaggedRules([MARKER_RULE, fresh], [said(Q118)], q118)).toEqual(['marker']);
  });

  it('flags nothing for an approval with no break, or a rule not done before the prompt', () => {
    const approval = 'Good, keep running pytest -m "not notebooks" for every run.';
    expect(flaggedRules([MARKER_RULE], [said(approval)], ranBefore('pytest -m "not notebooks"'))).toEqual([]);
    expect(flaggedRules([MARKER_RULE], [said(Q118)], ranBefore('pytest tests/test_io.py'))).toEqual([]);
  });

  it('flags an npm run lint rule only for a correction that names it', () => {
    const lintThenBuild = ranBefore('npm run lint', 'npm run build');
    const build = said('npm run build must pass before you hand back', detector([], ['npm run build']));
    expect(flaggedRules([LINT_RULE], [build], lintThenBuild)).toEqual([]);
    expect(flaggedRules([LINT_RULE], [said('Run npm run lint again after the build.')], lintThenBuild)).toEqual([
      'lint',
    ]);
  });

  it(`stops adding flags at ${MAX_FLAGS}`, () => {
    expect(flaggedRules([{ ...MARKER_RULE, flags: MAX_FLAGS - 1 }], [said(Q118)], q118)).toEqual(['marker']);
    expect(flaggedRules([{ ...MARKER_RULE, flags: MAX_FLAGS }], [said(Q118)], q118)).toEqual([]);
  });
});
