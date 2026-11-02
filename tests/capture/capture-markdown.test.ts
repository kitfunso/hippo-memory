import { describe, expect, it } from 'vitest';
import { boldTwins, extractFromTexts } from '../../src/surface/capture/extract.js';
import { startsInsideCut } from '../../src/base/memory/memory-quality.js';
import { scanWithinWatchdog } from '../_helpers/scan-watchdog.js';

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

  it.each([
    ['**Never deploy before tests.**', '**Never deploy before tests', 'Never deploy before tests'],
    [
      'Always run **npm test before deploying.**',
      'Always run **npm test before deploying',
      'Always run npm test before deploying',
    ],
    ['- **Volume data.** Never backfill them.', '** Never backfill them', 'Never backfill them'],
    [
      '- **Rule:** Always run tests before committing.',
      '**Rule:** Always run tests before committing',
      'Always run tests before committing',
    ],
    ['**Always run tests. Never push to master.**', '**Always run tests', 'Always run tests'],
    [
      '- **Decision:** We will always use SQLite for offline storage.',
      '**Decision:** We will always use SQLite for offline storage',
      'We will always use SQLite for offline storage',
    ],
  ])('pairs what an old capture stored for %s with what capture stores now', (text, old, clean) => {
    expect(boldTwins([text], (value) => value)).toEqual([{ old, clean }]);
  });

  it('pairs a spec bullet with its spec twin and the prose rule with its prose twin', () => {
    const twins = boldTwins(['## Plan\n- **Rule:** Always run tests before committing.'], (value) => value);
    expect(twins).toEqual(
      expect.arrayContaining([
        { old: '**Rule:** Always run tests before committing.', clean: 'Rule: Always run tests before committing.' },
        { old: '**Rule:** Always run tests before committing', clean: 'Always run tests before committing' },
      ]),
    );
    expect(twins).toHaveLength(2);
  });

  it('pairs by the lines an item came from, so a dropped question pairs with nothing', () => {
    const text = [
      '## Plan',
      '- **Should we deploy on Fridays?**',
      '- **Move the cache to Redis.**',
      'should we keep the old cache?',
    ].join('\n');
    expect(extractFromTexts([text]).map((item) => item.content)).toEqual(['Move the cache to Redis.']);
    expect(boldTwins([text], (value) => value)).toEqual([]);
  });

  it('pairs nothing when both readings give the same text, or no text holds a "**"', () => {
    for (const text of ['Never call f(**kwargs) without validation.', 'Never push to main.']) {
      expect(
        boldTwins([text], (value) => value),
        text,
      ).toEqual([]);
    }
  });

  it('runs the scrubber over the clean side of a twin', () => {
    const [twin] = boldTwins(['Never contact **reviewer**@example.invalid without approval.'], () => '[scrubbed]');
    expect(twin).toEqual({ old: 'Never contact **reviewer**@example.invalid without approval', clean: '[scrubbed]' });
  });

  it('removes the pairs of a line with 50,000 bold words before the watchdog fires', () => {
    // Linear takes tens of milliseconds; a slice per marker takes seconds, well past the deadline.
    const text = `Always ${'**word** '.repeat(50_000)}.`;
    expect(() => scanWithinWatchdog((line) => extractFromTexts([line]), text, 2_000)).not.toThrow();
    expect(() => scanWithinWatchdog((line) => boldTwins([line], (value) => value), text, 2_000)).not.toThrow();
  }, 20_000);

  // The first two lists are what base 3.1.0 gives; base cut the capital-letter lines at the bold label.
  it.each([
    [
      'Never change `**Warning.**\ncontinued text\nend` in the help text.',
      [['rule', 'Never change `**Warning.** continued text end` in the help text']],
    ],
    [
      '## Plan\n- Never change `**Warning.**\ncontinued text\nend` in the help text.',
      [
        ['spec', 'Never change `**Warning.** continued text end` in the help text.'],
        ['rule', 'Never change `**Warning.** continued text end` in the help text'],
      ],
    ],
    [
      'Never change `**Warning.**\nContinued text\nend` in the help text.',
      [['rule', 'Never change `**Warning.** Continued text end` in the help text']],
    ],
    [
      '## Plan\n- Never change `**Warning.**\nContinued text\nend` in the help text.',
      [
        ['spec', 'Never change `**Warning.** Continued text end` in the help text.'],
        ['rule', 'Never change `**Warning.** Continued text end` in the help text'],
      ],
    ],
    [
      'Never open `a\nbc` here.\nAlways run the tests.',
      [
        ['rule', 'Never open `a bc` here'],
        ['rule', 'Always run the tests'],
      ],
    ],
  ])('keeps the next line attached while a code span is open: %j', (text, expected) => {
    expect(extractFromTexts([text]).map((item) => [item.category, item.content])).toEqual(expected);
  });

  // Each list is what base 3.1.0 gives: a backtick run with no closer is plain text, so it joins nothing.
  it.each([
    [
      'Never use a lone ` in names\nAlways run lint before push',
      [
        ['rule', 'Never use a lone ` in names'],
        ['rule', 'Always run lint before push'],
      ],
    ],
    [
      "Don't use ` in a branch name\nNever push to main",
      [
        ['preference', "Don't use ` in a branch name"],
        ['rule', 'Never push to main'],
      ],
    ],
    [
      '1. Never use ` in names\nAlways run lint before push',
      [
        ['rule', 'Never use ` in names'],
        ['rule', 'Always run lint before push'],
      ],
    ],
    [' Use ``` for fences \nNever push to main', [['rule', 'Never push to main']]],
    ['Use `C:\\dir\\`\nNever push to main', [['rule', 'Never push to main']]],
    [
      'Press the ` key to open the console\nNever push to main\nAlways run tests first.',
      [
        ['rule', 'Never push to main'],
        ['rule', 'Always run tests first'],
      ],
    ],
    [
      'Don`t push to main on Friday\nNever push to main\nAlways run tests first.',
      [
        ['rule', 'Never push to main'],
        ['rule', 'Always run tests first'],
      ],
    ],
    [
      '- Press the ` key to open the console\n- Never push to main\n- Always run tests first.',
      [
        ['rule', 'Never push to main'],
        ['rule', 'Always run tests first'],
      ],
    ],
    [
      '- Don`t push to main on Friday\n- Never push to main\n- Always run tests first.',
      [
        ['rule', 'Never push to main'],
        ['rule', 'Always run tests first'],
      ],
    ],
    [
      'We decided to name the flag with a `\nNever push to main on Friday.',
      [
        ['decision', 'We decided to name the flag with a `'],
        ['rule', 'Never push to main on Friday'],
      ],
    ],
    [
      '## Plan\n- Never use ` in names\nplain line one\nplain line two',
      [['spec', 'Never use ` in names plain line one plain line two']],
    ],
    [
      '## Plan\n- Never use ` in names\n  plain line one\n  plain line two',
      [['spec', 'Never use ` in names plain line one plain line two']],
    ],
    [
      '## Plan\n- Press the ` key to open the console\n- Never push to main\n- Always run tests first.',
      [
        ['spec', 'Press the ` key to open the console'],
        ['spec', 'Never push to main'],
        ['spec', 'Always run tests first.'],
        ['rule', 'Always run tests first'],
      ],
    ],
    [
      '## Plan\n- Don`t push to main on Friday\n- Never push to main\n- Always run tests first.',
      [
        ['spec', 'Don`t push to main on Friday'],
        ['spec', 'Never push to main'],
        ['spec', 'Always run tests first.'],
        ['rule', 'Always run tests first'],
      ],
    ],
    [
      'Don`t push to main on Friday\nAlways run tests first\nWe can`t skip the linter.',
      [
        ['rule', 'Always run tests first'],
        ['preference', 'We can`t skip the linter'],
      ],
    ],
    [
      'Don`t push to main on Friday\nAlways run tests first.\nWe can`t skip the linter.',
      [
        ['rule', 'Always run tests first'],
        ['preference', 'We can`t skip the linter'],
      ],
    ],
  ])('joins a line break only inside a matched code span: %j', (text, expected) => {
    expect(extractFromTexts([text]).map((item) => [item.category, item.content])).toEqual(expected);
  });

  it('keeps a stray backtick from joining the 2000 lines below it', () => {
    const log = Array.from({ length: 2000 }, (_, i) => `Line ${i + 1} of the build log.`).join('\n');
    const items = extractFromTexts([`Never use a lone \` in names\n${log}\nAlways run lint before push`]);
    expect(items.map((item) => item.content)).toEqual(['Never use a lone ` in names', 'Always run lint before push']);
  });

  it('reads 20,000 lines below a stray backtick before the watchdog fires', () => {
    // The lines join into one block, so the time is the line scan; a rescan per line takes far longer.
    const text = `Never use a lone \`\n${'line of the build log\n'.repeat(20_000)}`;
    expect(() => scanWithinWatchdog((value) => extractFromTexts([value]), text, 2_000)).not.toThrow();
    expect(() => scanWithinWatchdog((value) => boldTwins([`**${value}`], (v) => v), text, 2_000)).not.toThrow();
  }, 20_000);

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
