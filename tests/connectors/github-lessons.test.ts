import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../../src/base/util/json.js';
import {
  codeownersLessonOpts,
  codeownersPatch,
  parseRevertMessage,
  revertLessonOpts,
  type LessonCommit,
} from '../../src/surface/connectors/github/lessons.js';
import { GITHUB_COM } from '../../src/surface/connectors/github/site.js';

const SHA = 'a'.repeat(40);
const ORIGINAL_SHA = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
const COMMIT: LessonCommit = {
  repository: { full_name: 'acme/repo', name: 'repo', owner: { login: 'acme' }, private: false },
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

describe('parseRevertMessage', () => {
  it('U1: reads a button revert', () => {
    expect(parseRevertMessage(BUTTON_REVERT)).toMatchObject({
      action: 'reverted',
      original: 'Use internal Apple codesign action (#14437)',
      revertsSha: '38316c1c4f275030e3df6666382922e75410d68b',
    });
  });

  it('U2: a subject-only revert has the original and no sha', () => {
    const parts = parseRevertMessage(SUBJECT_ONLY_REVERT);
    expect(parts?.original).toBe('ci: add temporary step to verify Linux repo signing keys');
    expect(parts?.revertsSha).toBeNull();
  });

  it('U3: a squash revert names its pull and has no reason', () => {
    const parts = parseRevertMessage('Revert "Add cache layer" (#13)\n\nReverts acme/repo#12');
    expect(parts?.revertsPull).toEqual({ repo: 'acme/repo', number: 12 });
    expect(parts?.original).toBe('Add cache layer');
    expect(parts?.reason).toBeNull();
  });

  it('U4: a squash list that holds a revert is not a revert', () => {
    expect(parseRevertMessage(SQUASH_WITH_REVERT)).toBeNull();
  });

  it('U5: a reapply says it was reapplied', () => {
    const parts = parseRevertMessage(`Reapply "Add cache layer"\n\nThis reverts commit ${ORIGINAL_SHA}.`);
    expect(parts).toMatchObject({ action: 'reapplied', original: 'Add cache layer' });
    expect(revertLessonOpts(COMMIT, parts!).content).toMatch(/^Reapplied on/);
  });

  it('U6: a merge commit is not a revert', () => {
    const message = `Merge pull request #13 from acme/revert-12\n\nRevert "Add cache layer"\n\nThis reverts commit ${ORIGINAL_SHA}.`;
    expect(parseRevertMessage(message)).toBeNull();
  });

  it('U10: git revert --reference gives the original from the parenthesis', () => {
    const message =
      'Drop the cache layer, it doubled p99\n\nThis reverts commit 1a2b3c4 (Add cache layer, 2026-11-01).';
    expect(parseRevertMessage(message)).toMatchObject({ original: 'Add cache layer', revertsSha: '1a2b3c4' });
  });

  it('keeps the first line of the body that is a reason', () => {
    const message = `Revert "Use v2 parser"\n\nThis reverts commit ${ORIGINAL_SHA}.\n\nIt broke the nightly job.\nSigned-off-by: A <a@b.c>`;
    expect(parseRevertMessage(message)?.reason).toBe('It broke the nightly job.');
  });

  it('an ordinary message is not a revert', () => {
    expect(parseRevertMessage('feat: add a thing')).toBeNull();
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
  const change = (patch: string | null, previousFilename: string | null = null) => ({
    path: '.github/CODEOWNERS',
    subject: 'Move the API to its team',
    entry: { filename: '.github/CODEOWNERS', previousFilename, patch },
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
      path: '.github/CODEOWNERS',
      subject: 'Move it',
      entry,
    });
    expect(content).toContain('Renamed from .github/CODEOWNERS.');
  });

  it('a patch that is not text gives a null patch', () => {
    expect(codeownersPatch([{ filename: 'CODEOWNERS', patch: 5 }], 'CODEOWNERS')?.patch).toBeNull();
  });
});
