// Z0 lesson sources (stage 2 plan D4): rules are source lines under one transform, reasons are fixed, templates come from the published list.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REASONS, TEMPLATES, checkLessonSource, fillTemplate, ruleFromSource, verifySourceLine } from '../scripts/token-eval/lesson-sources.mjs';
import { cleanup, tmp } from './fixtures/z0-harness.js';

const LINE = '- Use **pytest** fixtures from `conftest.py`, never `unittest.TestCase`.';
const RULE = 'Use pytest fixtures from `conftest.py`, never `unittest.TestCase`';
const sourced = (over = {}) => ({ id: 'm1', rule: RULE, reason: REASONS.maintainer, source: { repo: 'o/r', commit: 'abc', file: 'AGENTS.md', line: 3, text: LINE }, ...over });
const templated = (over = {}) => ({
  id: 't1', rule: 'Log through `log.info`, never `console.log`', reason: TEMPLATES.logger.reason, template: { id: 'logger', slots: { logger: 'log.info', console: 'console.log' } }, ...over,
});

describe('ruleFromSource', () => {
  it('drops the list marker, bold and one trailing period, and keeps wording, case and code spans', () => {
    expect(ruleFromSource(LINE)).toBe(RULE);
    expect(ruleFromSource('2) Keep `__init__.py` files empty.')).toBe('Keep `__init__.py` files empty');
    expect(ruleFromSource('* Commit titles follow\n  Conventional Commits.')).toBe('Commit titles follow Conventional Commits');
    expect(ruleFromSource('Version 1.2 stays...')).toBe('Version 1.2 stays..');
  });
});

describe('checkLessonSource', () => {
  it('accepts a maintainer rule that is its source line under the transform, with the fixed reason', () => {
    expect(() => checkLessonSource(sourced(), 'maintainer')).not.toThrow();
    expect(() => checkLessonSource(sourced({ supersedes: 'm0', reason: REASONS.maintainerReversal }), 'maintainer')).not.toThrow();
  });

  it.each([
    ['a reworded rule', sourced({ rule: 'Use pytest fixtures, never unittest.TestCase' }), 'maintainer', /source line under the transform/],
    ['a free reason', sourced({ reason: 'fixtures are faster' }), 'maintainer', /reason must be/],
    ['the root reason on a reversal', sourced({ supersedes: 'm0' }), 'maintainer', /maintainers changed this rule/],
    ['a source with no commit', sourced({ source: { ...sourced().source, commit: '' } }), 'maintainer', /source needs commit/],
    ['a sourced root in a template family', sourced(), 'template', /belongs to a maintainer family/],
    ['a template root in a maintainer family', templated(), 'maintainer', /belongs to a template family/],
    ['an unfilled slot', templated({ template: { id: 'logger', slots: { logger: 'log.info' } } }), 'template', /slot console is missing/],
    ['a prototype key as template', templated({ template: { id: 'constructor', slots: {} } }), 'template', /unknown template constructor/],
    ['a template rule changed by hand', templated({ rule: 'Always log through `log.info`, never `console.log`' }), 'template', /template filled/],
    ['neither source nor template', { id: 'x', rule: 'r', reason: 'q' }, 'maintainer', /needs a source or a template/],
  ])('refuses %s', (_, lesson, lessonSource, error) => {
    expect(() => checkLessonSource(lesson, lessonSource)).toThrow(error);
  });

  it('accepts a template lesson and its template reversal, also as the reversal of a maintainer family', () => {
    expect(() => checkLessonSource(templated(), 'template')).not.toThrow();
    const slots = { logger: 'log.info', newLogger: 'pino' };
    const rev = templated({ supersedes: 't0', rule: fillTemplate(TEMPLATES.logger.reversal, slots), reason: TEMPLATES.logger.reversalReason, template: { id: 'logger', slots } });
    expect(() => checkLessonSource(rev, 'maintainer')).not.toThrow();
  });
});

describe('verifySourceLine', () => {
  afterEach(cleanup);

  it('matches the recorded text against the file at the commit, and refuses any other text', () => {
    const repo = tmp('lesson-src-');
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo, encoding: 'utf8' }).trim();
    git('init', '-q');
    writeFileSync(join(repo, 'AGENTS.md'), `# Rules\r\n\r\n${LINE}\r\n* Commit titles follow\r\n  Conventional Commits.\r\n`);
    git('add', '.');
    git('commit', '-q', '-m', 'rules');
    const commit = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'AGENTS.md'), '# Rules moved\n');
    const source = { repo: 'o/r', commit, file: 'AGENTS.md', line: 3, text: LINE };
    expect(() => verifySourceLine(source, repo)).not.toThrow();
    expect(() => verifySourceLine({ ...source, line: 4, endLine: 5, text: '* Commit titles follow\n  Conventional Commits.' }, repo)).not.toThrow();
    expect(() => verifySourceLine({ ...source, text: RULE }, repo)).toThrow(/does not hold the recorded text/);
    expect(() => verifySourceLine({ ...source, line: 2 }, repo)).toThrow(/does not hold/);
  });
});

describe('the published list', () => {
  it('holds every template text and fixed reason the code uses, word for word', () => {
    const doc = readFileSync(join(__dirname, '..', 'docs', 'evals', 'z0-lesson-sources.md'), 'utf8');
    const texts = [...Object.values(REASONS), ...Object.values(TEMPLATES).flatMap((t) => Object.values(t))];
    expect(texts.filter((t) => !doc.includes(t))).toEqual([]);
    expect(Object.keys(TEMPLATES).filter((id) => !doc.includes(`| ${id} |`))).toEqual([]);
  });
});
