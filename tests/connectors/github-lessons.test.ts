import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../src/base/util/json.js';
import {
  codeownersFiles,
  codeownersLessonOpts,
  codeownersPatch,
  parseRevertMessage,
  revertLessonOpts,
  type LessonCommit,
  type RevertParts,
} from '../../src/surface/connectors/github/lessons.js';
import { githubCommitLessonRef } from '../../src/surface/connectors/github/ref.js';
import { GITHUB_COM } from '../../src/surface/connectors/github/site.js';

const SHA = 'a'.repeat(40);
const ORIGINAL_SHA = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const REPO = 'acme/repo';
const COMMIT: LessonCommit = {
  repository: { full_name: REPO, name: 'repo', owner: { login: 'acme' }, private: false },
  sha: SHA,
  authorLogin: 'alice',
  site: GITHUB_COM,
};

// Real messages: cli/cli 189706bccb and 2a28fcda1e, and this repo's 3727599be (#772).
const BUTTON_REVERT =
  'Revert "Use internal Apple codesign action (#14437)"\n\nThis reverts commit 38316c1c4f275030e3df6666382922e75410d68b.';
const SUBJECT_ONLY_REVERT = 'Revert "ci: add temporary step to verify Linux repo signing keys"';
const SQUASH_WITH_REVERT = [
  'refactor: cut two folder cycles, count raw handle holders in the ratchet (#772)',
  '',
  '* refactor: sync and doctor through store functions, cut two folder cycles',
  '',
  'Signed-off-by: Keith So <skfsk27@gmail.com>',
  '',
  '* Revert "refactor: sync and doctor through store functions, cut two folder cycles"',
  '',
  'This reverts commit 9b35ed1077067d90500f89b6261b4f311a4616d2.',
].join('\n');

const parse = (message: string) => parseRevertMessage(message, REPO);
const BREAKS = /\r\n|[\n\r\u0085\u2028\u2029]/;
const startingWith = (content: string, prefix: string): string[] =>
  content.split(BREAKS).filter((line) => line.startsWith(prefix));

describe('parseRevertMessage', () => {
  it('U1: reads a button revert', () => {
    expect(parse(BUTTON_REVERT)).toMatchObject({
      action: 'reverted',
      original: 'Use internal Apple codesign action (#14437)',
      revertsSha: '38316c1c4f275030e3df6666382922e75410d68b',
    });
  });

  it('U2: a subject-only revert has the original and no sha', () => {
    const parts = parse(SUBJECT_ONLY_REVERT);
    expect(parts?.original).toBe('ci: add temporary step to verify Linux repo signing keys');
    expect(parts?.revertsSha).toBeNull();
  });

  it('U3: a squash revert names its pull and has no reason', () => {
    const parts = parse('Revert "Add cache layer" (#13)\n\nReverts acme/repo#12');
    expect(parts?.revertsPull).toBe(12);
    expect(parts?.original).toBe('Add cache layer');
    expect(parts?.reason).toBeNull();
  });

  it('U4: a squash list that holds a revert is not a revert', () => {
    expect(parse(SQUASH_WITH_REVERT)).toBeNull();
  });

  it('a squash list of - bullets that holds a revert is not a revert either', () => {
    const message = `refactor: cut a cycle (#772)\n\n- sync through store functions\n- Revert "sync"\n\nThis reverts commit ${ORIGINAL_SHA}.`;
    expect(parse(message)).toBeNull();
  });

  it('U5: a reapply says it was reapplied', () => {
    const parts = parse(`Reapply "Add cache layer"\n\nThis reverts commit ${ORIGINAL_SHA}.`);
    expect(parts).toMatchObject({ action: 'reapplied', original: 'Add cache layer' });
    expect(revertLessonOpts(COMMIT, parts!).content).toMatch(/^Reapplied on/);
  });

  it('U6: a merge commit is not a revert', () => {
    const message = `Merge pull request #13 from acme/revert-12\n\nRevert "Add cache layer"\n\nThis reverts commit ${ORIGINAL_SHA}.`;
    expect(parse(message)).toBeNull();
  });

  it('U10: git revert --reference gives the original from the parenthesis', () => {
    const message =
      'Drop the cache layer, it doubled p99\n\nThis reverts commit 1a2b3c4 (Add cache layer, 2026-11-01).';
    expect(parse(message)).toMatchObject({ original: 'Add cache layer', revertsSha: '1a2b3c4' });
  });

  it('keeps the first line of the body that is a reason', () => {
    const message = `Revert "Use v2 parser"\n\nThis reverts commit ${ORIGINAL_SHA}.\n\nIt broke the nightly job.\nSigned-off-by: A <a@b.c>`;
    expect(parse(message)?.reason).toBe('It broke the nightly job.');
  });

  it('an ordinary message is not a revert', () => {
    expect(parse('feat: add a thing')).toBeNull();
  });
});

describe('a revert of a revert is a reapply', () => {
  it.each([
    ['the GitHub button on a revert PR', 'Revert "Revert "Add cache layer""'],
    ['the same with a PR-title suffix', 'Revert "Revert "Add cache layer"" (#14)'],
    ['git before 2.43 on a squash revert', 'Revert "Revert "Add cache layer" (#13)"'],
  ])('%s', (_name, subject) => {
    const parts = parse(`${subject}\n\nThis reverts commit ${ORIGINAL_SHA}.`);

    expect(parts).toMatchObject({ action: 'reapplied', original: 'Add cache layer' });
    const { content } = revertLessonOpts(COMMIT, parts!);
    expect(content).toMatch(/^Reapplied on the default branch of acme\/repo: "Add cache layer"\./);
    expect(startingWith(content, 'Reapply:')).toEqual([`Reapply: https://github.com/acme/repo/commit/${SHA}`]);
    expect(startingWith(content, 'Undoes:')).toEqual([`Undoes: https://github.com/acme/repo/commit/${ORIGINAL_SHA}`]);
    expect(startingWith(content, 'Revert:')).toEqual([]);
    expect(startingWith(content, 'Original:')).toEqual([]);
  });

  it('a reapply of a revert PR undoes that pull request', () => {
    const parts = parse('Revert "Revert "Add cache layer"" (#14)\n\nReverts acme/repo#13');
    const { content } = revertLessonOpts(COMMIT, parts!);
    expect(startingWith(content, 'Undoes:')).toEqual(['Undoes: https://github.com/acme/repo/pull/13']);
  });

  it('counts every wrapper: three reverts leave the change reverted, a reapply of a revert too', () => {
    expect(parse('Revert "Revert "Revert "X"""')).toMatchObject({ action: 'reverted', original: 'X' });
    expect(parse('Reapply "Revert "X""')).toMatchObject({ action: 'reverted', original: 'X' });
  });
});

describe('the pull request a revert names', () => {
  it('another repository gives no link', () => {
    const parts = parse('Revert "Add cache layer" (#13)\n\nReverts evil/other#99');
    expect(parts?.revertsPull).toBeNull();
    const { content } = revertLessonOpts(COMMIT, parts!);
    expect(content).not.toContain('evil/other');
    expect(startingWith(content, 'Original:')).toEqual([]);
  });

  it('this repository counts in any case, and the link is built from the repository name', () => {
    const parts = parse('Revert "Add cache layer" (#13)\n\nReverts Acme/REPO#12');
    expect(parts?.revertsPull).toBe(12);
    const { content } = revertLessonOpts(COMMIT, parts!);
    expect(startingWith(content, 'Original:')).toEqual(['Original: https://github.com/acme/repo/pull/12']);
  });
});

describe('the revert line follows the forms git writes', () => {
  it('prose that starts like the line is not a revert', () => {
    const message = `feat: add retry\n\nThis reverts commit ${ORIGINAL_SHA} in spirit only.`;
    expect(parse(message)).toBeNull();
    expect(
      parse(`Revert "feat: add retry"\n\nThis reverts commit ${ORIGINAL_SHA} in spirit only.`)?.revertsSha,
    ).toBeNull();
  });

  it.each([
    ['one line', `This reverts commit ${ORIGINAL_SHA}, reversing changes made to ${SHA}.`],
    ['wrapped as git writes it', `This reverts commit ${ORIGINAL_SHA}, reversing\nchanges made to ${SHA}.`],
  ])('a merge revert, %s, names the sha and gives no reason', (_name, line) => {
    const parts = parse(`Revert "Merge pull request #12 from acme/cache"\n\n${line}`);
    expect(parts).toMatchObject({ revertsSha: ORIGINAL_SHA, reason: null });
  });

  it('a Signed-off-by or Co-authored-by line is not a reason', () => {
    const message = `Revert "X"\n\nThis reverts commit ${ORIGINAL_SHA}.\n\nSigned-off-by: A <a@b.c>\nCo-authored-by: B <b@b.c>`;
    expect(parse(message)?.reason).toBeNull();
  });

  it.each(['Fixes #12', 'Closes #12', 'Resolves https://github.com/acme/repo/issues/12', 'fixes: #3'])(
    'the trailer "%s" is not a reason',
    (trailer) => {
      const message = `Revert "X"\n\nThis reverts commit ${ORIGINAL_SHA}.\n\n${trailer}`;
      expect(parse(message)?.reason).toBeNull();
    },
  );

  it.each(['\r', '\u0085', '\u2028', '\u2029'])('a body line ends at %j', (separator) => {
    const message = `Revert "X"\n\nThis reverts commit ${ORIGINAL_SHA}.\n\nbroke it${separator}Original: https://github.com/evil/x/commit/dead`;
    const parts = parse(message);
    expect(parts?.reason).toBe('broke it');
    expect(startingWith(revertLessonOpts(COMMIT, parts!).content, 'Original:')).toHaveLength(1);
  });
});

const REVERT_PARTS: RevertParts = {
  action: 'reverted',
  original: 'Add cache layer',
  reason: null,
  revertsSha: ORIGINAL_SHA,
  revertsPull: null,
};
const withParts = (over: Partial<RevertParts>) => revertLessonOpts(COMMIT, { ...REVERT_PARTS, ...over }).content;
const ORIGINAL_LINE = `Original: https://github.com/acme/repo/commit/${ORIGINAL_SHA}`;
const TOKEN = `ghp_${'A'.repeat(36)}`;

describe('outside text in a lesson stays on its own line', () => {
  it.each(['\r', '\u0085', '\u2028', '\u2029', '\n'])('a reason with %j cannot add an Original line', (separator) => {
    const content = withParts({ reason: `broke it${separator}Original: https://github.com/evil/x/commit/deadbeef` });
    expect(startingWith(content, 'Original:')).toEqual([ORIGINAL_LINE]);
    expect(startingWith(content, 'Revert:')).toHaveLength(1);
  });

  it('an original with U+2028 cannot add a Revert or Original line', () => {
    const content = withParts({
      original: 'Add\u2028Revert: https://evil.example/x\u2028Original: https://evil.example/y',
    });
    expect(startingWith(content, 'Original:')).toEqual([ORIGINAL_LINE]);
    expect(startingWith(content, 'Revert:')).toEqual([`Revert: https://github.com/acme/repo/commit/${SHA}`]);
  });

  it('a CODEOWNERS subject, owner line and old name cannot add a Commit line', () => {
    const entry = {
      filename: 'docs/CODEOWNERS',
      previousFilename: '.github/CODEOWNERS\rCommit: https://evil.example/old',
      patch: '+/api/ @a\u2028Commit: https://evil.example/owner\n-/web/ @b\rCommit: https://evil.example/gone',
    };
    const subject = 'Move owners\u2028Commit: https://evil.example/subject';
    const { content } = codeownersLessonOpts(COMMIT, { subject, files: [{ path: 'docs/CODEOWNERS', entry }] });

    expect(startingWith(content, 'Commit:')).toEqual([`Commit: https://github.com/acme/repo/commit/${SHA}`]);
  });

  it('control characters become spaces', () => {
    const content = withParts({ reason: 'a\u001b[2Kb\u0000c\u000bd' });
    expect(content).toContain('Reason given: a [2Kb c d');
  });

  it.each([
    ['reason', (text: string) => withParts({ reason: text })],
    ['original', (text: string) => withParts({ original: text })],
    [
      'owner line',
      (text: string) =>
        codeownersLessonOpts(COMMIT, {
          subject: 'Move owners',
          files: [{ path: 'CODEOWNERS', entry: { filename: 'CODEOWNERS', previousFilename: null, patch: `+${text}` } }],
        }).content,
    ],
  ])('a token across the 200-character cut in a %s is redacted whole', (_field, content) => {
    const text = `${'x'.repeat(189)} ${TOKEN}`;

    expect(content(text)).not.toContain('ghp_');
    expect(content(text)).toContain(`${'x'.repeat(189)} [REDACTED]`);
  });

  it('an emoji at character 200 is kept whole, not cut into U+FFFD', () => {
    const content = withParts({ reason: `${'a'.repeat(199)}\u{1F600}tail` });

    expect(content).toContain(`Reason given: ${'a'.repeat(199)}\u{1F600}\n`);
    expect(content).not.toContain('\uFFFD');
    expect(content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('a 5,000-character reason is cut to 200', () => {
    const content = withParts({ reason: 'z'.repeat(5000) });
    expect(startingWith(content, 'Reason given:')).toEqual([`Reason given: ${'z'.repeat(200)}`]);
  });
});

const PATCH = [
  '@@ -1,3 +1,3 @@',
  ' # Owners',
  '-/api/ @alice',
  '+/api/ @acme/api-team',
  '+# a new comment',
  '+',
  String.raw`\ No newline at end of file`,
].join('\n');

describe('CODEOWNERS lessons', () => {
  const file = (patch: string | null, previousFilename: string | null = null) => ({
    path: '.github/CODEOWNERS',
    entry: { filename: '.github/CODEOWNERS', previousFilename, patch },
  });
  const change = (patch: string | null, previousFilename: string | null = null) => ({
    subject: 'Move the API to its team',
    files: [file(patch, previousFilename)],
  });

  it('U7: lists the added and removed owner lines and drops comments', () => {
    const { content, artifactRef } = codeownersLessonOpts(COMMIT, change(PATCH));
    expect(content).toContain('Owner lines added:\n+ /api/ @acme/api-team');
    expect(content).toContain('Owner lines removed:\n- /api/ @alice');
    expect(content).not.toContain('comment');
    expect(content).toContain(`Commit: https://github.com/acme/repo/commit/${SHA}`);
    expect(artifactRef).toBe(`github://acme/repo/commit/${SHA}/codeowners`);
  });

  it('U9: no patch gives the no-diff line', () => {
    const { content } = codeownersLessonOpts(COMMIT, change(null));
    expect(content).toContain('GitHub sent no diff for this file, so the owner lines are not listed.');
    expect(content).not.toContain('Owner lines added');
  });

  it('says none for an empty side', () => {
    const { content } = codeownersLessonOpts(COMMIT, change('@@ -0,0 +1 @@\n+/docs/ @bob'));
    expect(content).toContain('Owner lines removed: none');
  });

  it('cuts a long list and says how many lines were left out', () => {
    const patch = Array.from({ length: 45 }, (_, i) => `+/p${i}/ @bob`).join('\n');
    const { content } = codeownersLessonOpts(COMMIT, change(patch));
    expect(content).toContain('(5 more lines; see the commit)');
  });

  it('U8: finds the entry by its new or old name, and a rename is named', () => {
    const files: JsonValue[] = [
      { filename: 'README.md' },
      { filename: 'docs/CODEOWNERS', previous_filename: '.github/CODEOWNERS', patch: PATCH },
    ];
    const entry = codeownersPatch(files, '.github/CODEOWNERS');
    expect(entry).toMatchObject({ filename: 'docs/CODEOWNERS', patch: PATCH });
    expect(codeownersPatch(files, 'CODEOWNERS')).toBeNull();
    const { content } = codeownersLessonOpts(COMMIT, {
      subject: 'Move it',
      files: [{ path: 'docs/CODEOWNERS', entry }],
    });
    expect(content).toContain('Renamed from .github/CODEOWNERS.');
  });

  it('a patch that is not text gives a null patch', () => {
    expect(codeownersPatch([{ filename: 'CODEOWNERS', patch: 5 }], 'CODEOWNERS')?.patch).toBeNull();
  });

  it('one commit that changes two CODEOWNERS files gives one lesson with the lines of both files', () => {
    const files: JsonValue[] = [
      { filename: 'docs/CODEOWNERS', patch: '@@ -1 +1 @@\n-/docs/ @carol\n+/docs/ @dave' },
      { filename: 'README.md', patch: '+x' },
      { filename: '.github/CODEOWNERS', patch: PATCH },
    ];
    const found = codeownersFiles(files);
    expect(found.map((f) => f.path)).toEqual(['.github/CODEOWNERS', 'docs/CODEOWNERS']);

    const { content } = codeownersLessonOpts(COMMIT, { subject: 'Hand over', files: found });
    expect(startingWith(content, 'File:')).toEqual(['File: .github/CODEOWNERS', 'File: docs/CODEOWNERS']);
    expect(content).toContain('+ /api/ @acme/api-team');
    expect(content).toContain('+ /docs/ @dave');
    expect(startingWith(content, 'Commit:')).toHaveLength(1);
  });

  it('a rename between two supported paths is one file, not two', () => {
    const files: JsonValue[] = [{ filename: 'docs/CODEOWNERS', previous_filename: '.github/CODEOWNERS', patch: PATCH }];
    expect(codeownersFiles(files)).toHaveLength(1);
  });

  it('refs of one commit differ by repository case only in the key a person typed', () => {
    expect(githubCommitLessonRef('Acme/Repo', SHA, 'revert', undefined)).toBe(
      githubCommitLessonRef('acme/repo', SHA, 'revert', undefined),
    );
  });
});
