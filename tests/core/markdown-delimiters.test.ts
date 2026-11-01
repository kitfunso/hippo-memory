import { describe, expect, it } from 'vitest';
import { blankCodeSpans, strongMarkers, unclosedRuns } from '../../src/base/memory/markdown-delimiters.js';

describe('blankCodeSpans', () => {
  it.each([
    ['a `b` c', 'a xxx c'],
    ['a ``b`c`` d', 'a xxxxxxx d'],
    ['a ```b``c``` d', 'a xxxxxxxxxx d'],
    ['a `b `` c`', 'a xxxxxxxx'],
  ])('closes a span at the next run of exactly its length: %s', (text, blanked) => {
    expect(blankCodeSpans(text)).toBe(blanked);
  });

  it.each(['a `b c', 'a ``b ` c', 'a \\`b` c'])('reads an opener with no closer as text: %s', (text) => {
    expect(blankCodeSpans(text)).toBe(text);
  });

  it('keeps the length and fills with the character given', () => {
    expect(blankCodeSpans('x `**` y', '`')).toBe('x ```` y');
  });

  // A rescan from every unclosed opener runs past the test timeout at this size.
  it('judges many unclosed runs of different lengths in one pass', () => {
    const hostile = Array.from({ length: 400 }, (_, i) => '`'.repeat(i + 1)).join(' a ');
    expect(blankCodeSpans(hostile)).toBe(hostile);
  });
});

describe('strongMarkers', () => {
  const roles = (text: string) =>
    strongMarkers(text).map(({ open, close, inWord }) =>
      [open ? 'open' : '', close ? 'close' : '', inWord ? 'word' : ''].join(' ').trim(),
    );

  it.each([
    ['**bold** text', ['open', 'close']],
    ['done.** Next', ['close']],
    ['** Next', ['']],
    ['f(**kwargs)', ['open']],
    ['2**10', ['open close word']],
    ['foo**bar**', ['open close word', 'close']],
    ['Volume data.**Next', ['open']],
    ['Never edit **/etc/hosts**.', ['open', 'close']],
    ['Always lint **/*.ts and keep cache** files out', ['close']],
    ['Never commit **/*.env or dist** builds', ['close']],
  ])('gives %s its roles', (text, expected) => {
    expect(roles(text)).toEqual(expected);
  });

  it.each(['src/** first', '**/*.ts', 'src/**/*.ts', 'Never commit **/*.env and **/*.ts files', 'a *** b', 'a \\** b'])(
    'leaves a glob or an escape out: %s',
    (text) => {
      expect(strongMarkers(text)).toEqual([]);
    },
  );
});

describe('unclosedRuns', () => {
  it.each([
    ['a `b` c', []],
    ['a ``b`c`` d', []],
    ['a ```b``c``` d', []],
    ['a `b c', [1]],
    ['a ``b ` c', [2, 1]],
    ['a ``b`c`` d `', [1]],
    ['a \\`b', []],
  ])('lists the runs no later run of equal length closes: %s', (text, open) => {
    expect(unclosedRuns(text)).toEqual(open);
  });

  it('carries the runs the text above leaves open, and a closer ends them', () => {
    expect(unclosedRuns('more text', [1])).toEqual([1]);
    expect(unclosedRuns('end` here', [1])).toEqual([]);
    expect(unclosedRuns('end`` here', [1])).toEqual([1, 2]);
  });

  it('judges many unclosed runs of different lengths in one pass', () => {
    const lengths = Array.from({ length: 400 }, (_, i) => i + 1);
    const hostile = lengths.map((n) => '`'.repeat(n)).join(' a ');
    expect(unclosedRuns(hostile)).toEqual(lengths);
  });
});
