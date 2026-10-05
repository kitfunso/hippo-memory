import { describe, expect, it } from 'vitest';
import { extractFromText } from '../src/capture/extract.js';

const contents = (text: string) => extractFromText(text).map((item) => item.content);
const TAG_RULE = 'Always tag releases from main because CI publishes tags.';

describe('capture reads markdown the way it renders', () => {
  it('treats a backtick run with a backtick after it as inline code', () => {
    expect(contents(`\`\`\`npm test\`\`\` runs the unit suite.\n${TAG_RULE}`)).toEqual([TAG_RULE.slice(0, -1)]);
  });

  it('closes a fence only with a bare run of the same character at least as long', () => {
    const hidden = 'Never push from the VM because it has no tests.';
    for (const text of [
      `\`\`\`\`md\n\`\`\`\n${hidden}\n\`\`\`\`\n${TAG_RULE}`,
      `~~~\n\`\`\`\n${hidden}\n~~~\n${TAG_RULE}`,
      `\`\`\`bash\nnpm test\n\`\`\`js\n${hidden}\n\`\`\`\n${TAG_RULE}`,
      `- \`\`\`\n  ${hidden}\n  \`\`\`\n${TAG_RULE}`,
    ]) expect(contents(text), text).toEqual([TAG_RULE.slice(0, -1)]);
  });

  it('leaves quoted text out', () => {
    expect(contents(`> Never deploy on Fridays because the rota is thin.\n${TAG_RULE}`)).toEqual([TAG_RULE.slice(0, -1)]);
  });

  it('never ends a sentence inside inline code or at an abbreviation', () => {
    for (const text of [
      'Never pass `--message "Fix it. Now"` to the release script because it breaks the changelog.',
      'We decided to use a workspace tool, e.g. pnpm, because the repo has six packages.',
      'Prefer Postgres vs. SQLite for the server because writes are concurrent.',
      'Never commit build output, logs, etc. because CI rebuilds them.',
    ]) expect(contents(text), text).toEqual([text.slice(0, -1)]);
  });

  it('ends a sentence at "etc." before a capital', () => {
    expect(contents('We cache logs, builds, etc. Never commit the lockfile by hand.')).toContain('Never commit the lockfile by hand');
  });

  it('joins a lowercase line only to a line that has not ended its sentence', () => {
    expect(contents('We decided to use pnpm 9 for installs.\nnpm is still used in CI because the runner image ships it.'))
      .toEqual(['We decided to use pnpm 9 for installs']);
    expect(contents('The API must retry after HTTP 429\nbecause the provider enforces a quota.'))
      .toEqual(['The API must retry after HTTP 429 because the provider enforces a quota']);
    expect(contents('We should always prefer fast tools, e.g.\nripgrep over grep.'))
      .toEqual(['We should always prefer fast tools, e.g. ripgrep over grep']);
  });

  it('starts a new statement at a lowercase label', () => {
    expect(contents('Never edit the lockfile by hand\ndecision: we use pnpm 9 for every install')).toEqual([
      'Never edit the lockfile by hand',
      'we use pnpm 9 for every install',
    ]);
  });

  it('reads a spec bullet with its wrapped lines and skips questions', () => {
    const text = [
      '## Plan',
      '- Move the cache to Redis so restarts keep',
      '  warm entries for the API',
      '- Keep the CSV export for',
      'finance, who still read it monthly',
      '- Should we drop the old table?',
    ].join('\n');
    expect(extractFromText(text).filter((item) => item.category === 'spec').map((item) => item.content)).toEqual([
      'Move the cache to Redis so restarts keep warm entries for the API',
      'Keep the CSV export for finance, who still read it monthly',
    ]);
  });

  it('reads a 4-space line under prose as its continuation and one after a blank line as code', () => {
    const spec = ['## Plan', '- Move the cache to Redis so restarts keep', '    warm entries for the API'].join('\n');
    expect(extractFromText(spec).map((item) => item.content)).toEqual(['Move the cache to Redis so restarts keep warm entries for the API']);
    expect(contents('The API must retry after HTTP 429\n    because the provider enforces a quota.'))
      .toEqual(['The API must retry after HTTP 429 because the provider enforces a quota']);
    expect(contents(`${TAG_RULE}\n\n    Never push from the VM because it has no tests.`)).toEqual([TAG_RULE.slice(0, -1)]);
    expect(contents(`## Notes\n    Never push from the VM because it has no tests.\n${TAG_RULE}`)).toEqual([TAG_RULE.slice(0, -1)]);
  });
});
