import { describe, it, expect } from 'vitest';
import { dumpFrontmatter, parseFrontmatter } from '../src/yaml.js';

type Frontmatter = Parameters<typeof dumpFrontmatter>[0];

function roundTrip(data: Frontmatter, body = 'body text\n'): ReturnType<typeof parseFrontmatter> {
  return parseFrontmatter(`${dumpFrontmatter(data)}\n${body}`);
}

describe('dumpFrontmatter then parseFrontmatter', () => {
  it('keeps a list item that contains a comma as one item', () => {
    const tags = ['plain', 'a, b', 'trailing,'];
    expect(roundTrip({ tags }).data['tags']).toEqual(tags);
  });

  it('keeps double quotes and backslashes inside list items and scalars', () => {
    const tags = ['say "hi"', 'C:\\temp\\x', 'quote, then "comma, inside"', '\\"'];
    const note = 'he said "a, b" \\ done';
    const { data } = roundTrip({ tags, note });
    expect(data['tags']).toEqual(tags);
    expect(data['note']).toBe(note);
  });

  it('keeps colons, hashes and brackets in values', () => {
    const data: Frontmatter = {
      created: '2026-10-04T12:34:56.000Z',
      url: 'http://example.test:8080/a#frag',
      odd: '[not, a list]',
      tags: ['k:v', '#hash', '[x]', '{y}'],
    };
    expect(roundTrip(data).data).toEqual(data);
  });

  it('keeps line breaks inside a value on one frontmatter line', () => {
    const data: Frontmatter = { note: 'line one\nline two\r\nline three', tags: ['multi\nline'], after: 'still parsed' };
    const dumped = dumpFrontmatter(data);
    expect(dumped.split('\n')).toHaveLength(5);
    expect(roundTrip(data).data).toEqual(data);
  });

  it('keeps strings that look like other scalar types as strings', () => {
    const data: Frontmatter = { a: 'true', b: 'false', c: 'null', d: '42', e: '-1.5', tags: ['7', 'null'] };
    expect(roundTrip(data).data).toEqual(data);
  });

  it('keeps empty and whitespace-edged strings', () => {
    const data: Frontmatter = { empty: '', padded: '  x  ', tags: ['', ' y'] };
    expect(roundTrip(data).data).toEqual(data);
  });

  it('round-trips an empty list, numbers, booleans and null', () => {
    const data: Frontmatter = { tags: [], count: 3, ratio: 0.25, neg: -2, pinned: true, starred: false, scope: null };
    expect(roundTrip(data).data).toEqual(data);
  });

  it('keeps the body after the closing fence', () => {
    expect(roundTrip({ id: 'mem_1' }, 'first line\n---\nnot frontmatter\n').content).toBe('first line\n---\nnot frontmatter\n');
  });
});

describe('parseFrontmatter on hand-written input', () => {
  it('reads a CRLF file the same as an LF file', () => {
    const lf = '---\nid: mem_1\ntags: [a, "b, c"]\nlist:\n  - x\n  - "y, z"\nnote: "q: \\"r\\""\n---\nbody\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    const fromLf = parseFrontmatter(lf);
    const fromCrlf = parseFrontmatter(crlf);
    expect(fromCrlf.data).toEqual(fromLf.data);
    expect(fromLf.data).toEqual({ id: 'mem_1', tags: ['a', 'b, c'], list: ['x', 'y, z'], note: 'q: "r"' });
    expect(fromCrlf.content.replace(/\r\n/g, '\n')).toBe('body\n');
  });

  it('reads an indented block list and unquotes its items', () => {
    const raw = '---\ntags:\n  - plain\n  - "with, comma"\n    - deeper\nnext: 1\n---\n';
    expect(parseFrontmatter(raw).data).toEqual({ tags: ['plain', 'with, comma', 'deeper'], next: 1 });
  });

  it('reads an empty inline list and a key with no value', () => {
    expect(parseFrontmatter('---\ntags: []\nblank:\n---\n').data).toEqual({ tags: [], blank: '' });
  });

  it('keeps an unknown escape sequence as written', () => {
    expect(parseFrontmatter('---\npath: "C:\\x\\y"\n---\n').data['path']).toBe('C:\\x\\y');
  });

  it('treats a file with no closing fence as all body and no data', () => {
    const raw = '---\nid: mem_1\ntags: [a]\nbody without a closing fence\n';
    expect(parseFrontmatter(raw)).toEqual({ data: {}, content: raw });
  });

  it('treats a file with no opening fence as all body and no data', () => {
    const raw = 'id: mem_1\n---\n';
    expect(parseFrontmatter(raw)).toEqual({ data: {}, content: raw });
  });
});
