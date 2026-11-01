import { describe, expect, it } from 'vitest';
import { blankCodeSpans, strongMarkers } from '../../src/base/memory/markdown-delimiters.js';

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
