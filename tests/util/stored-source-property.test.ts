// storedSource over generated sources: made-up tokens of every strict pattern, and a PEM block, at random places in random paths.
import { describe, expect, it } from 'vitest';
import { redactSecretsStrict, storedSource } from '../../src/base/util/secret-detect.js';
import { runtimeJoin } from '../_helpers/secret-shapes.js';

const CASES = 2500;
const SEED = 0x5eed1020;

/** mulberry32: a small seeded generator, so every run draws the same cases. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const UPPER_DIGIT = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

type Draw = () => number;
const pick = <T>(draw: Draw, items: readonly T[]): T => items[Math.floor(draw() * items.length)]!;
const body = (draw: Draw, n: number, chars = ALNUM): string =>
  Array.from({ length: n }, () => pick(draw, [...chars])).join('');

/** One made-up token: its text, and the random bodies no stored source may keep. */
interface Token {
  readonly text: string;
  readonly secrets: readonly string[];
}

const one = (prefix: string, secret: string, suffix = ''): Token => ({
  text: runtimeJoin(prefix, secret, suffix),
  secrets: [secret],
});

const TOKENS: ReadonlyArray<(draw: Draw) => Token> = [
  (d) => one('AKIA', body(d, 16, UPPER_DIGIT)),
  (d) => one('ghp_', body(d, 36)),
  (d) => one('github_pat_', body(d, 30)),
  (d) => one('xoxb-', `${body(d, 20)}7`),
  (d) => one('sk_live_', body(d, 20)),
  (d) => one('AIza', body(d, 35)),
  (d) => {
    const [a, b] = [body(d, 24, BASE32), body(d, 32, BASE32)];
    return { text: runtimeJoin('hk_', a, '.', b), secrets: [a, b] };
  },
  (d) => one('npm_', body(d, 36)),
  (d) => one('hf_', body(d, 34, ALPHA)),
  (d) => one('glpat-', body(d, 24)),
  (d) => one('ya29.', body(d, 24)),
  (d) => {
    const [a, b] = [body(d, 20), body(d, 24)];
    return { text: runtimeJoin('hooks.slack.com/services/', a, '/', b), secrets: [a, b] };
  },
  (d) => one('sk-', `${body(d, 28)}7`),
  (d) => {
    const [a, b] = [body(d, 8), `${body(d, 10)}9`];
    return { text: runtimeJoin('sk_', a, '_', b), secrets: [b] };
  },
  (d) => {
    const [a, b] = [body(d, 9), `${body(d, 9)}7`];
    return { text: runtimeJoin('token=', a, '/', b), secrets: [a, b] };
  },
  (d) => one('https://user:', `${body(d, 10)}5`, '@host'),
  (d) => one('Bearer ', body(d, 24)),
  (d) => {
    const [a, b, c] = [body(d, 10), body(d, 10), body(d, 10)];
    return { text: runtimeJoin('eyJ', a, '.eyJ', b, '.', c), secrets: [a, b, c] };
  },
  (d) => {
    const [a, b] = [body(d, 20), body(d, 20)];
    const pem = runtimeJoin('-----BEGIN RSA ', 'PRIVATE KEY-----\n', a, '/', b, '\n-----END RSA ', 'PRIVATE KEY-----');
    return { text: pem, secrets: [a, b] };
  },
];

const WORDS = [
  'src',
  'docs',
  'notes',
  'MEMORY.md',
  'deploy.md',
  'agent-memory:claude-code:p-0123456789ab',
  'x_y',
  'a b',
];
const JOINERS = ['/', '#', ' '];

/** 1 to 5 words and the tokens, joined by `/`, `#` or a space: a token at the start, the end, beside a separator, or two in one part. */
function source(draw: Draw, tokens: readonly Token[]): string {
  const pieces = Array.from({ length: 1 + Math.floor(draw() * 5) }, () => pick(draw, WORDS));
  for (const token of tokens) pieces.splice(Math.floor(draw() * (pieces.length + 1)), 0, token.text);
  return pieces.reduce((out, piece, i) => (i === 0 ? piece : `${out}${pick(draw, JOINERS)}${piece}`), '');
}

const windows = (secret: string): string[] =>
  Array.from({ length: Math.max(0, secret.length - 7) }, (_, i) => secret.slice(i, i + 8));

describe('storedSource over generated sources', () => {
  it(`holds its rules over ${CASES} cases from seed ${SEED}`, () => {
    const draw = rng(SEED);
    const failures: string[] = [];
    for (let n = 0; n < CASES && failures.length < 5; n++) {
      const makers = Array.from({ length: 1 + Math.floor(draw() * 2) }, () => pick(draw, TOKENS));
      const tokens = makers.map((make) => make(draw));
      const layout = Math.floor(draw() * 2 ** 32);
      const raw = source(rng(layout), tokens);
      const stored = storedSource(raw);
      const leaked = tokens.flatMap((t) => t.secrets.flatMap(windows)).filter((w) => stored.includes(w));
      if (leaked.length > 0) failures.push(`leak ${leaked[0]} in ${JSON.stringify(stored)}`);
      if (storedSource(stored) !== stored) failures.push(`not idempotent: ${JSON.stringify(raw)}`);
      if (redactSecretsStrict(stored) !== stored) failures.push(`strict changes it: ${JSON.stringify(raw)}`);
      // The twin differs from `raw` only in one token's random body, at the same place.
      const other = [...tokens];
      const at = Math.floor(draw() * other.length);
      other[at] = makers[at]!(draw);
      const twin = storedSource(source(rng(layout), other));
      const a = stored.split(/[/#]/);
      const b = twin.split(/[/#]/);
      if (a.length !== b.length || a.filter((part, i) => part !== b[i]).length !== 1) {
        failures.push(`twins not apart at one part: ${JSON.stringify(stored)} vs ${JSON.stringify(twin)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
