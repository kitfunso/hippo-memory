/**
 * Markdown item splitter for agents that keep memory in one file: bullets and paragraphs are items, headings are context.
 */
import { describe, it, expect } from 'vitest';
import { splitMarkdownItems, slugHeading } from '../src/agent-memories/markdown.js';

const lines = (...parts: string[]): string => parts.join('\n');
const texts = (markdown: string): string[] => splitMarkdownItems(markdown).map((item) => item.text);

describe('splitMarkdownItems: bullets', () => {
  it('keeps indented sub-bullets and wrapped continuation lines inside their item', () => {
    const md = lines(
      '- first item',
      '  - sub one',
      '  - sub two',
      '- second item that wraps',
      'onto the next line',
      '- third',
    );
    expect(texts(md)).toEqual([
      'first item\n  - sub one\n  - sub two',
      'second item that wraps\nonto the next line',
      'third',
    ]);
  });

  it('keeps blank lines between indented lines, and ends the item at a blank line before column 0', () => {
    const md = lines('- item', '  para one', '', '  para two', '', '- next', '', 'plain');
    expect(texts(md)).toEqual(['item\n  para one\n\n  para two', 'next', 'plain']);
  });

  it('trims trailing whitespace on continuation lines and around the item', () => {
    expect(texts('-   padded   \n  more   \n')).toEqual(['padded\n  more']);
  });

  it('accepts *, + and numbered markers', () => {
    const md = lines('* star', '+ plus', '1. one', '2) two', '10. ten');
    expect(texts(md)).toEqual(['star', 'plus', 'one', 'two', 'ten']);
  });

  it('does not treat a marker without a following space as a bullet', () => {
    expect(texts('-dash\n\n3.14 is pi')).toEqual(['-dash', '3.14 is pi']);
  });

  it('drops items that are empty after trim', () => {
    expect(texts('- \n- real\n-  ')).toEqual(['real']);
  });

  it('starts a new item at a top-level bullet even without a blank line', () => {
    expect(texts('- a\n1. b\n- c')).toEqual(['a', 'b', 'c']);
  });
});

describe('splitMarkdownItems: paragraphs', () => {
  it('splits paragraphs on blank lines and joins wrapped lines with a newline', () => {
    const md = lines('first line', 'second line', '', '', 'another paragraph');
    expect(texts(md)).toEqual(['first line\nsecond line', 'another paragraph']);
  });

  it('ends a paragraph at a heading or a top-level bullet', () => {
    const md = lines('intro', '## Head', 'body', '- bullet', 'tail');
    expect(splitMarkdownItems(md).map((i) => [i.heading, i.text])).toEqual([
      ['', 'intro'],
      ['Head', 'body'],
      ['Head', 'bullet\ntail'],
    ]);
  });

  it('keeps an indented bullet-looking line inside the paragraph', () => {
    expect(texts('lead\n  - not top level\nend')).toEqual(['lead\n  - not top level\nend']);
  });
});

describe('splitMarkdownItems: headings', () => {
  it.each([1, 2, 3, 4, 5, 6])('reads a level %i heading as context, never as an item', (level) => {
    const items = splitMarkdownItems(`${'#'.repeat(level)} Section Title\n- entry`);
    expect(items).toEqual([{ heading: 'Section Title', headingSlug: 'section-title', text: 'entry' }]);
  });

  it('strips a trailing run of hashes and spaces', () => {
    const items = splitMarkdownItems('## Closed ##  \n- a\n### Also closed ###\n- b');
    expect(items.map((i) => i.heading)).toEqual(['Closed', 'Also closed']);
  });

  it('keeps a hash that ends a word, as in C#', () => {
    const items = splitMarkdownItems('## C#\n- a\n## F# notes #\n- b');
    expect(items.map((i) => i.heading)).toEqual(['C#', 'F# notes']);
  });

  it('does not treat #tag, seven hashes or a bare # as a heading', () => {
    expect(texts('#tag\n\n####### seven\n\n#')).toEqual(['#tag', '####### seven', '#']);
  });

  it('gives content before any heading an empty heading and the top slug', () => {
    const items = splitMarkdownItems('preamble\n\n- early bullet\n\n## Later\n- late bullet');
    expect(items).toEqual([
      { heading: '', headingSlug: 'top', text: 'preamble' },
      { heading: '', headingSlug: 'top', text: 'early bullet' },
      { heading: 'Later', headingSlug: 'later', text: 'late bullet' },
    ]);
  });

  it('keeps the same bullet text under two headings as two items', () => {
    const items = splitMarkdownItems('## Alpha\n- shared\n## Beta\n- shared');
    expect(items).toEqual([
      { heading: 'Alpha', headingSlug: 'alpha', text: 'shared' },
      { heading: 'Beta', headingSlug: 'beta', text: 'shared' },
    ]);
  });

  it('lets a later heading replace the current one even at a shallower level', () => {
    const items = splitMarkdownItems('### Deep\n- a\n## Shallow\n- b');
    expect(items.map((i) => i.heading)).toEqual(['Deep', 'Shallow']);
  });
});

describe('splitMarkdownItems: input shape', () => {
  it('returns [] for empty and whitespace-only input', () => {
    expect(splitMarkdownItems('')).toEqual([]);
    expect(splitMarkdownItems('\n  \n\t\n')).toEqual([]);
  });

  it('gives the same items for CRLF and LF input', () => {
    const md = lines('# Title', '', 'para one', 'wrapped', '', '- bullet', '  - sub', '', '## Next', '1. num');
    expect(splitMarkdownItems(md.replace(/\n/g, '\r\n'))).toEqual(splitMarkdownItems(md));
    expect(texts(md)).toEqual(['para one\nwrapped', 'bullet\n  - sub', 'num']);
  });

  it('skips horizontal rules in every spelling', () => {
    const md = lines('before', '', '---', '', '***', '___', '- - -', '* * *', '_ _ _', 'after');
    expect(texts(md)).toEqual(['before', 'after']);
  });

  it('ends a paragraph or bullet at a rule instead of merging across it', () => {
    expect(texts('above\n---\nbelow')).toEqual(['above', 'below']);
    expect(texts('- item\n---\nafter')).toEqual(['item', 'after']);
  });
});

describe('splitMarkdownItems: fenced code', () => {
  it('keeps heading-like and bullet-like lines inside a fence in the bullet that holds it', () => {
    const md = lines(
      '## Real',
      '- has code',
      '  ```',
      '  # not a heading',
      '  - not a bullet',
      '  ```',
      '- after',
    );
    expect(splitMarkdownItems(md)).toEqual([
      { heading: 'Real', headingSlug: 'real', text: 'has code\n  ```\n  # not a heading\n  - not a bullet\n  ```' },
      { heading: 'Real', headingSlug: 'real', text: 'after' },
    ]);
  });

  it('forms its own paragraph when the fence follows a blank line, blank lines inside included', () => {
    const md = lines('## Notes', 'intro', '', '```sh', '# not a heading', '- not a bullet', '', 'still code', '```', '', '- after');
    expect(splitMarkdownItems(md).map((i) => i.text)).toEqual([
      'intro',
      '```sh\n# not a heading\n- not a bullet\n\nstill code\n```',
      'after',
    ]);
    expect(new Set(splitMarkdownItems(md).map((i) => i.heading))).toEqual(new Set(['Notes']));
  });

  it('keeps a fence that touches a paragraph inside that paragraph', () => {
    expect(texts(lines('run this', '~~~', '# comment', '~~~', 'then that'))).toEqual([
      'run this\n~~~\n# comment\n~~~\nthen that',
    ]);
  });

  it('needs a closing fence at least as long as the opener', () => {
    const md = lines('````', '```', '# inside', '````', '- out');
    expect(texts(md)).toEqual(['````\n```\n# inside\n````', 'out']);
  });

  it('lets an unclosed fence run to the end of the file', () => {
    expect(texts(lines('- a', '', '```', '- b', '# c'))).toEqual(['a', '```\n- b\n# c']);
  });

  it('does not open a fence on inline code at the start of a line', () => {
    expect(texts(lines('```inline``` text', '', '- b'))).toEqual(['```inline``` text', 'b']);
  });
});

describe('splitMarkdownItems: Codex-style file', () => {
  const codex = lines(
    'v1',
    '',
    '## User Profile',
    '',
    'Works on a trading desk.',
    '',
    'Prefers short answers.',
    '',
    '## User preferences',
    '- Use metric units',
    '- No emojis',
    '',
    '## General Tips',
    '- Run the tests before a commit',
    '',
    "## What's in Memory",
    '',
    '### scope',
    '',
    '#### 2026-09-01',
    '- topic: kw',
    '  - desc: first note',
    '  - desc: second note',
    '- topic: other',
    '  - desc: third note',
    '',
  );

  it('yields the version line, profile paragraphs, bullets and topic entries with their headings', () => {
    expect(splitMarkdownItems(codex)).toEqual([
      { heading: '', headingSlug: 'top', text: 'v1' },
      { heading: 'User Profile', headingSlug: 'user-profile', text: 'Works on a trading desk.' },
      { heading: 'User Profile', headingSlug: 'user-profile', text: 'Prefers short answers.' },
      { heading: 'User preferences', headingSlug: 'user-preferences', text: 'Use metric units' },
      { heading: 'User preferences', headingSlug: 'user-preferences', text: 'No emojis' },
      { heading: 'General Tips', headingSlug: 'general-tips', text: 'Run the tests before a commit' },
      {
        heading: '2026-09-01',
        headingSlug: '2026-09-01',
        text: 'topic: kw\n  - desc: first note\n  - desc: second note',
      },
      { heading: '2026-09-01', headingSlug: '2026-09-01', text: 'topic: other\n  - desc: third note' },
    ]);
  });

  it('yields the same items from CRLF text', () => {
    expect(splitMarkdownItems(codex.replace(/\n/g, '\r\n'))).toEqual(splitMarkdownItems(codex));
  });
});

describe('slugHeading', () => {
  it('lowercases and folds each run of punctuation or spaces into one dash', () => {
    expect(slugHeading('User Profile')).toBe('user-profile');
    expect(slugHeading("What's in Memory")).toBe('what-s-in-memory');
    expect(slugHeading('Hello,   World!!')).toBe('hello-world');
    expect(slugHeading('Q3 2026 Plan')).toBe('q3-2026-plan');
  });

  it('removes leading and trailing dashes', () => {
    expect(slugHeading('  (Notes)  ')).toBe('notes');
    expect(slugHeading('--x--')).toBe('x');
  });

  it('cuts to 40 characters and drops a dash left at the cut', () => {
    expect(slugHeading('x'.repeat(100))).toBe('x'.repeat(40));
    expect(slugHeading(`${'a'.repeat(39)} bbbb`)).toBe('a'.repeat(39));
    expect(slugHeading(`${'a'.repeat(38)} bbbb`)).toBe(`${'a'.repeat(38)}-b`);
  });

  it("returns 'top' for an empty heading or one with nothing to keep", () => {
    expect(slugHeading('')).toBe('top');
    expect(slugHeading('!!! ???')).toBe('top');
  });
});
