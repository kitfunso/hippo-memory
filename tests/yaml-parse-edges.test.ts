import { describe, it, expect } from 'vitest';
import { dumpFrontmatter, parseFrontmatter } from '../src/util/yaml.js';

const parse = (lines: string[]): ReturnType<typeof parseFrontmatter>['data'] => parseFrontmatter(`---\n${lines.join('\n')}\n---\nbody`).data;

describe('parseFrontmatter scalars', () => {
  it('reads negative and decimal numbers as numbers and a quoted number as a string', () => {
    expect(parse(['a: -3', 'b: 2.5', 'c: "7"'])).toEqual({ a: -3, b: 2.5, c: '7' });
  });

  it('reads a bare word as a string and null, true and false as their values', () => {
    expect(parse(['a: hello', 'b: null', 'c: true', 'd: false'])).toEqual({ a: 'hello', b: null, c: true, d: false });
  });

  it('keeps only the text after the first colon as the value', () => {
    expect(parse(['url: http://x.test:80/p'])).toEqual({ url: 'http://x.test:80/p' });
  });

  it('skips a line with no colon and a line with an empty key, and lets a repeated key keep its last value', () => {
    expect(parse(['no colon here', ': orphan', 'k: 1', 'k: 2'])).toEqual({ k: 2 });
  });
});

describe('parseFrontmatter lists', () => {
  it('keeps a comma inside a quoted inline item', () => {
    expect(parse(['tags: ["a, b", c]'])).toEqual({ tags: ['a, b', 'c'] });
  });

  it('stops a block list at the first line that is not an item', () => {
    expect(parse(['tags:', '  - one', '  - two', 'next: 1'])).toEqual({ tags: ['one', 'two'], next: 1 });
  });
});

describe('dumpFrontmatter', () => {
  it('writes the fences and one line per key, in insertion order', () => {
    expect(dumpFrontmatter({ b: 1, a: ['x', 'y z'], c: null })).toBe('---\nb: 1\na: [x, y z]\nc: null\n---');
  });

  it('quotes an empty list item', () => {
    expect(dumpFrontmatter({ a: [''] })).toBe('---\na: [""]\n---');
  });
});
