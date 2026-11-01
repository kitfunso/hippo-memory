import { describe, expect, it } from 'vitest';
import { extractFromTexts, legacyBoldAlias } from '../../src/surface/capture/extract.js';
import { startsInsideCut } from '../../src/base/memory/memory-quality.js';

const contents = (text: string) => extractFromTexts([text]).map((item) => item.content);
const TAG_RULE = 'Always tag releases from main because CI publishes tags.';

describe('capture reads markdown the way it renders', () => {
  it('treats a backtick run with a backtick after it as inline code', () => {
    expect(contents(`\`\`\`npm test\`\`\` runs the unit suite.\n${TAG_RULE}`)).toEqual([TAG_RULE.slice(0, -1)]);
  });

  it('drops the markers of a bold label, so the rule after it is stored whole', () => {
    expect(contents('- **Volume data.** Never backfill them.')).toEqual(['Never backfill them']);
  });

  it('removes the bold pair of a label itself, so no cut text reaches admission', () => {
    const items = contents('- **Volume data.** Never backfill them.');
    expect(items).toEqual(['Never backfill them']);
    expect(items.some(startsInsideCut)).toBe(false);
  });

  // Each expected list is what base 3.1.0 gives; the aside rule must leave these alone.
  it.each([
    ['(Important: never push to main. Always run tests first.)', ['Always run tests first.)']],
    [
      'See docs [1. Never push to main. Always run tests first. 2] for more.',
      ['Never push to main', 'Always run tests first. 2] for more'],
    ],
    [
      'I was sad :( about it. Never push to main. Fixed it :) Always run tests first.',
      ['Never push to main', 'Fixed it :) Always run tests first'],
    ],
    [':( today. Never push to main. Then pick 1) rebuild.', ['Never push to main']],
    [
      'The debug call is ``console.log(`(cache`)``. Never skip step a) before deploying.',
      ['Never skip step a) before deploying'],
    ],
    [
      'I was sad :( about it. Never push to main. Always run tests first.',
      ['Never push to main', 'Always run tests first'],
    ],
    [
      "The parser expected '('. Never bypass validation for API requests.",
      ['Never bypass validation for API requests'],
    ],
    [
      'Never use (foo as a name. Always run the linter before you push.',
      ['Never use (foo as a name', 'Always run the linter before you push'],
    ],
    // A "(" between quote marks is text, so a later quoted ")" is not an aside close.
    [
      `The parser expected '('. Never use the suffix "test)" for generated filenames.`,
      ['Never use the suffix "test)" for generated filenames'],
    ],
    [
      'The parser expected ‘(’. Never use the suffix “test)” for generated filenames.',
      ['Never use the suffix “test)” for generated filenames'],
    ],
    // No "(" before it, a list-marker ")", an emoticon "(", and a digit before the ")".
    ['Skip that line) Always run tests first.', ['Skip that line) Always run tests first']],
    ['Note (see below. Never skip step a) before deploying.', ['Never skip step a) before deploying']],
    ['I was sad :( about it. Skip that line) Always run tests first.', ['Skip that line) Always run tests first']],
    ['Note (see below. Never pick 1) rebuild the index.', ['Never pick 1) rebuild the index']],
  ])('gives the sentences base 3.1.0 gives for %s', (text, expected) => {
    expect(contents(text)).toEqual(expected);
  });

  it('drops a rule glued to the tail of an aside, which base 3.1.0 also stored as a cut row', () => {
    const text = 'Status (draft. Never push to main. Always run tests first.) is pending.';
    expect(contents(text)).toEqual(['Never push to main']);
  });

  it('drops the one sentence that starts inside an aside the split cut', () => {
    const text = 'Always run the check (see the docs. Then always run it again) before you merge.';
    expect(contents(text)).toEqual(['Always run the check (see the docs']);
  });

  it('judges the sentences of a long unclosed aside in one pass', () => {
    const hostile = `Never skip the check (${'see the docs. '.repeat(40_000)}`;
    expect(contents(hostile)).toEqual([]);
  });

  it('finds the opener a lost closing "**" belonged to, and nothing else', () => {
    expect(legacyBoldAlias('**Never deploy before tests')).toBe('Never deploy before tests');
    expect(legacyBoldAlias('Always run **npm test before deploying')).toBe('Always run npm test before deploying');
    expect(legacyBoldAlias('Never call f(**kwargs) or g(**options) without validation')).toBe(
      'Never call f(**kwargs) or g(options) without validation',
    );
    for (const none of ['Never compute 2**10 by hand', 'Always lint **/*.ts first', '** Never backfill them']) {
      expect(legacyBoldAlias(none), none).toBeNull();
    }
  });

  it('pairs a closer with the nearest opener and keeps code spans whole', () => {
    expect(contents('Never pass **kwargs to **the** store writer.')).toEqual([
      'Never pass **kwargs to the store writer',
    ]);
    expect(contents('Always keep `**kwargs**` in the signature and **never** drop it.')).toEqual([
      'Always keep `**kwargs**` in the signature and never drop it',
    ]);
    expect(contents('Always parse ``a**`b`` and **never** split the span.')).toEqual([
      'Always parse ``a**`b`` and never split the span',
    ]);
  });

  it('pairs nothing when the closer cannot close, so the segmenter leaves a bare opener', () => {
    expect(contents('- **Volume data.**Never backfill them.')).toEqual(['**Never backfill them']);
  });

  it('cleans a spec bullet the way it cleans a prose line', () => {
    const text = ['## Plan', '- **Cache.** Move the cache to Redis so restarts keep', '  **warm** entries'].join('\n');
    expect(
      extractFromTexts([text])
        .filter((item) => item.category === 'spec')
        .map((item) => item.content),
    ).toEqual(['Cache. Move the cache to Redis so restarts keep warm entries']);
  });

  it('ends a spec bullet at a bold label that closes its sentence, as a prose line does', () => {
    const question = ['## Plan', '- **Move the cache to Redis.**', 'should we keep the old cache?'].join('\n');
    expect(extractFromTexts([question]).map((item) => [item.category, item.content])).toEqual([
      ['spec', 'Move the cache to Redis.'],
    ]);
    const rule = ['## Plan', '- **Deploy note.**', 'never push to master on Friday.'].join('\n');
    expect(extractFromTexts([rule]).map((item) => [item.category, item.content])).toEqual([
      ['spec', 'Deploy note.'],
      ['rule', 'never push to master on Friday'],
    ]);
  });

  it('cleans a wrapped spec bullet and prose line once their lines are joined', () => {
    const text = ['## Plan', '- Never change `**foo**', '  bar` in the signature'].join('\n');
    expect(extractFromTexts([text]).map((item) => [item.category, item.content])).toEqual([
      ['spec', 'Never change `**foo** bar` in the signature'],
    ]);
  });

  it('keeps globs, kwargs, exponents and dunder names as written', () => {
    for (const rule of [
      'Always lint **/*.ts and src/** first',
      'Never commit **/*.env files',
      'Never commit **/*.env and **/*.ts files',
      'Always lint **/*.ts and keep cache** files out',
      'Never commit **/*.env or dist** builds',
      'Always ignore cache_** files when deploying',
      'Never use the suffix "test)" for generated filenames',
      'Always allocate 2** (n + 1) bytes for the cache',
      'Always compute (n + 1)** 2 for the buffer size',
      'Never use x[0]** 2 in hot loops',
      'Always lint src/**/*.ts before a push',
      'Never pass **kwargs to the store writer',
      'Never compute 2**10 by hand',
      'Never edit __init__.py',
      'Never import `__init__.py` from tests',
      'Never call f(**kwargs) or g(**options) without validation',
      'Never pass **kwargs and call f(**opts)',
      'Never compute 2**10 and 3**4 by hand',
      'Never compute 2**-1 or 2**(n + 1) by hand',
      'Always use the Hippo**Memory** client for recall',
    ]) {
      expect(contents(`${rule}.`), rule).toEqual([rule]);
    }
  });

  it('reads a bold path as bold when a closer follows it', () => {
    expect(contents('Never edit **/etc/hosts**.')).toEqual(['Never edit /etc/hosts']);
    expect(contents('Always use **/usr/bin/python** (the system interpreter).')).toEqual([
      'Always use /usr/bin/python (the system interpreter)',
    ]);
  });

  it('closes a fence only with a bare run of the same character at least as long', () => {
    const hidden = 'Never push from the VM because it has no tests.';
    for (const text of [
      `\`\`\`\`md\n\`\`\`\n${hidden}\n\`\`\`\`\n${TAG_RULE}`,
      `~~~\n\`\`\`\n${hidden}\n~~~\n${TAG_RULE}`,
      `\`\`\`bash\nnpm test\n\`\`\`js\n${hidden}\n\`\`\`\n${TAG_RULE}`,
      `- \`\`\`\n  ${hidden}\n  \`\`\`\n${TAG_RULE}`,
    ]) {
      expect(contents(text), text).toEqual([TAG_RULE.slice(0, -1)]);
    }
  });

  it('leaves quoted text out', () => {
    expect(contents(`> Never deploy on Fridays because the rota is thin.\n${TAG_RULE}`)).toEqual([
      TAG_RULE.slice(0, -1),
    ]);
  });

  it('never ends a sentence inside inline code or at an abbreviation', () => {
    for (const text of [
      'Never pass `--message "Fix it. Now"` to the release script because it breaks the changelog.',
      'We decided to use a workspace tool, e.g. pnpm, because the repo has six packages.',
      'Prefer Postgres vs. SQLite for the server because writes are concurrent.',
      'Never commit build output, logs, etc. because CI rebuilds them.',
    ]) {
      expect(contents(text), text).toEqual([text.slice(0, -1)]);
    }
  });

  it('ends a sentence at "etc." before a capital', () => {
    expect(contents('We cache logs, builds, etc. Never commit the lockfile by hand.')).toContain(
      'Never commit the lockfile by hand',
    );
  });

  it('joins a lowercase line only to a line that has not ended its sentence', () => {
    expect(
      contents('We decided to use pnpm 9 for installs.\nnpm is still used in CI because the runner image ships it.'),
    ).toEqual(['We decided to use pnpm 9 for installs']);
    expect(contents('The API must retry after HTTP 429\nbecause the provider enforces a quota.')).toEqual([
      'The API must retry after HTTP 429 because the provider enforces a quota',
    ]);
    expect(contents('We should always prefer fast tools, e.g.\nripgrep over grep.')).toEqual([
      'We should always prefer fast tools, e.g. ripgrep over grep',
    ]);
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
    expect(
      extractFromTexts([text])
        .filter((item) => item.category === 'spec')
        .map((item) => item.content),
    ).toEqual([
      'Move the cache to Redis so restarts keep warm entries for the API',
      'Keep the CSV export for finance, who still read it monthly',
    ]);
  });

  it('reads a 4-space line under prose as its continuation and one after a blank line as code', () => {
    const spec = ['## Plan', '- Move the cache to Redis so restarts keep', '    warm entries for the API'].join('\n');
    expect(extractFromTexts([spec]).map((item) => item.content)).toEqual([
      'Move the cache to Redis so restarts keep warm entries for the API',
    ]);
    expect(contents('The API must retry after HTTP 429\n    because the provider enforces a quota.')).toEqual([
      'The API must retry after HTTP 429 because the provider enforces a quota',
    ]);
    expect(contents(`${TAG_RULE}\n\n    Never push from the VM because it has no tests.`)).toEqual([
      TAG_RULE.slice(0, -1),
    ]);
    expect(contents(`## Notes\n    Never push from the VM because it has no tests.\n${TAG_RULE}`)).toEqual([
      TAG_RULE.slice(0, -1),
    ]);
  });
});
