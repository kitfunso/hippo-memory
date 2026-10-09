// Generated secrets of every shape the scrub names, placed among ordinary words: none reaches the output, a second pass changes nothing, and ordinary text passes untouched.
import { describe, it, expect } from 'vitest';
import { redactSecretsStrict } from '../src/secret-detect.js';
import { scrubForSharing } from '../src/share-scrub.js';
import { arr, both, forAll, map, oneOf, pick, str, type Gen } from './_helpers/property.js';
import { ASSIGNED_SECRET, ASSIGNED_SECRET_LINES, ORDINARY_CONFIG_LINES } from './_helpers/secret-shapes.js';

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const ALNUM = UPPER + LOWER + DIGITS;
const BASE32 = `${LOWER}234567`;
// Joined at runtime, so no key-shaped prefix or key-block marker sits in source.
const SK = ['s', 'k'].join('');
const DASHES = '-'.repeat(5);
const PEM_KINDS = ['', 'RSA ', 'EC ', 'OPENSSH '];

function pemLine(edge: string, kind: string): string {
  return `${DASHES}${edge} ${kind}PRIVATE KEY${DASHES}`;
}

interface Secret {
  readonly text: string;
  /** The generated part: no stretch of it may reach the output. */
  readonly body: string;
}

/** A body of `min` to `max` characters ending in a letter or digit, as a real token does and as the `\b` that closes most patterns needs. */
function secret(wrap: (body: string) => string, alphabet: string, min: number, max: number, last = [...alphabet].filter((ch) => ALNUM.includes(ch)).join('')): Gen<Secret> {
  return map(both(str(alphabet, min - 1, max - 1), str(last, 1, 1)), ([inner, end]) => ({ text: wrap(inner + end), body: inner + end }));
}

const KINDS: readonly Gen<Secret>[] = [
  secret((b) => `AKIA${b}`, UPPER + DIGITS, 16, 16),
  oneOf(['ghp', 'gho', 'ghu', 'ghs', 'ghr'].map((kind) => secret((b) => `${kind}_${b}`, ALNUM, 36, 36))),
  secret((b) => `github_pat_${b}`, `${ALNUM}_`, 22, 40),
  oneOf([...'baprs'].map((kind) => secret((b) => `xox${kind}-${b}`, `${ALNUM}-`, 10, 30))),
  oneOf([`${SK}_live_`, 'rk_test_'].map((head) => secret((b) => head + b, ALNUM, 16, 30))),
  secret((b) => `AIza${b}`, `${ALNUM}_-`, 35, 35),
  secret((b) => `hk_${b.slice(0, 24)}.${b.slice(24)}`, BASE32, 56, 56),
  secret((b) => `npm_${b}`, ALNUM, 36, 36),
  secret((b) => `hf_${b}`, UPPER + LOWER, 34, 34),
  secret((b) => `glpat-${b}`, `${ALNUM}_-`, 20, 30),
  secret((b) => `ya29.${b}`, `${ALNUM}_-`, 20, 60),
  oneOf(['services', 'workflows', 'triggers'].map((kind) => secret((b) => `https://hooks.slack.com/${kind}/${b}`, `${ALNUM}+/`, 43, 56))),
  oneOf(PEM_KINDS.map((kind) => secret((b) => `${pemLine('BEGIN', kind)}\n${b}\n${pemLine('END', kind)}`, `${ALNUM}+/`, 40, 120))),
  secret((b) => `${SK}-${b}`, `${ALNUM}_-`, 20, 48),
  secret((b) => `${SK}_proj_${b}`, `${ALNUM}_`, 12, 30),
  oneOf(ASSIGNED_SECRET_LINES.map((line) => secret((b) => line.replaceAll(ASSIGNED_SECRET, b), `${ALNUM}_-`, 12, 40, DIGITS))),
  secret((b) => `postgres://app:${b}@db.internal:5432/main`, ALNUM, 8, 24),
  secret((b) => `Authorization: Bearer ${b}`, `${ALNUM}._~+/-`, 16, 60),
  secret((b) => `authorization: basic ${b}`, `${ALNUM}+/`, 12, 40),
  secret((b) => `eyJ${b.slice(0, 12)}.eyJ${b.slice(12, 24)}.${b.slice(24)}`, `${ALNUM}_-`, 36, 60),
];

// Ordinary words, with the near misses a careless pattern would take: key nouns, bare prefixes, package and image names holding an @.
const WORDS = [
  'deploy', 'the', 'cache', 'before', 'release', 'token', 'password', 'secret', 'key', 'bearer', 'basic', 'Authorization', 'bypass', 'compass',
  SK, 'AKIA', 'ghp', 'npm', 'eyJ', 'user', 'logo@2x.png', 'react@18.2.0', 'v1.2.3', '2024-06-01', '42', 'caf\u00e9', '\u6771\u4eac', '\u043f\u0440\u0438\u0432\u0435\u0442',
];

const SCRUBS: readonly { name: string; scrub: (text: string) => string }[] = [
  { name: 'redactSecretsStrict', scrub: redactSecretsStrict },
  { name: 'scrubForSharing', scrub: scrubForSharing },
];

const WINDOW = 8;

function leaked(out: string, s: Secret): boolean {
  return out.includes(s.body.slice(0, WINDOW)) || out.includes(s.body.slice(-WINDOW));
}

const WORD_RUN = arr(pick(WORDS), 0, 5);

/** One to three secrets, each after a run of words and before a space or a line break. */
const LEAKY_TEXT: Gen<{ text: string; secrets: Secret[] }> = map(
  both(arr(both(WORD_RUN, both(oneOf(KINDS), pick([' ', '\n']))), 1, 3), WORD_RUN),
  ([placed, tail]) => ({
    text: [...placed.map(([words, [s, gap]]) => [...words, s.text].join(' ') + gap), tail.join(' ')].join(''),
    secrets: placed.map(([, [s]]) => s),
  }),
);

// Markers the scrubs write, and openings of secret shapes with nothing after them.
const LOOSE_PIECES = [
  '[REDACTED]', '[email]', '[home]', 'password=', 'token: ', 'Bearer ', 'authorization: basic ', 'https://', 'bob@example.com', '@', ':', '=',
  pemLine('BEGIN', ''), pemLine('END', ''), 'eyJ', 'AKIA', `${SK}-`, 'hooks.slack.com/services/',
];
const HOME_PATHS = ['/home/kit', '/root', '/Users/alice', 'C:\\Users\\kit', '/mnt/c/Users/kit', '/var/home/kit'];

// Two secrets of one kind on a line, as in a pasted list of keys: a scrub that stops at the first leaves the second for the next pass.
const TWINS = oneOf(KINDS.map((kind) => map(both(kind, kind), ([a, b]) => `${a.text} ${b.text}`)));

/** Words, whole secrets, ordinary config lines and loose pieces of secret shapes, glued with or without a gap. */
const SOUP: Gen<string> = map(
  arr(both(oneOf([pick(WORDS), map(oneOf(KINDS), (s) => s.text), TWINS, pick(ORDINARY_CONFIG_LINES), pick(LOOSE_PIECES)]), pick(['', ' ', '\n', '/'])), 0, 10),
  (parts) => parts.map(([text, gap]) => text + gap).join(''),
);

describe('secret scrubbing properties', () => {
  it('no generated secret of any shape reaches the output of either scrub', () => {
    forAll(0x5ec1, 400, LEAKY_TEXT, ({ text, secrets }) => {
      for (const { name, scrub } of SCRUBS) {
        const out = scrub(text);
        expect(secrets.filter((s) => leaked(out, s)).map((s) => s.text), `${name} left a secret in: ${out}`).toEqual([]);
      }
    });
  });

  it('redactSecretsStrict changes nothing on a second pass', () => {
    forAll(0x1de0, 400, SOUP, (text) => {
      const once = redactSecretsStrict(text);
      expect(redactSecretsStrict(once)).toBe(once);
    });
  });

  // Fails today: a home path under another home path is half masked on the first pass, and its tail is masked on the second.
  it.fails('scrubForSharing changes nothing on a second pass over home paths, nested or not', () => {
    const paths = map(both(WORD_RUN, arr(pick(HOME_PATHS), 1, 3)), ([words, nested]) => [...words, nested.join('')].join(' '));
    forAll(0x1de1, 200, paths, (text) => {
      const once = scrubForSharing(text);
      expect(scrubForSharing(once)).toBe(once);
    });
  });

  it('sentences of ordinary words and ordinary config lines come back unchanged', () => {
    // A sentence ends in a full stop, so a word never runs on into the config line under it.
    const sentence = map(arr(pick(WORDS), 1, 8), (words) => `${words.join(' ')}.`);
    const benign = map(arr(oneOf([sentence, sentence, pick(ORDINARY_CONFIG_LINES)]), 1, 8), (lines) => lines.join('\n'));
    forAll(0xbe9, 400, benign, (text) => {
      expect(redactSecretsStrict(text)).toBe(text);
    });
  });

  it('text made of ordinary words comes back unchanged from the share scrub', () => {
    forAll(0xbea, 400, map(arr(pick(WORDS), 1, 12), (parts) => parts.join(' ')), (text) => {
      expect(scrubForSharing(text)).toBe(text);
    });
  });

  // Fails today: the key pattern ends on a word boundary, which a closing hyphen before a space or the end of the text does not give.
  it.fails('a Google API key ending in a hyphen is scrubbed', () => {
    const key = map(str(`${ALNUM}_-`, 34, 34), (inner) => ({ text: `AIza${inner}-`, body: `${inner}-` }));
    forAll(0x600, 200, map(both(WORD_RUN, key), ([words, s]) => ({ text: [...words, s.text, 'end'].join(' '), s })), ({ text, s }) => {
      expect(leaked(redactSecretsStrict(text), s)).toBe(false);
    });
  });
});
