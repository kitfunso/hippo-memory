// No 8-character window of a token reaches an error, a log line or a returned page, whichever reply field echoes it (body, Link next path, query or host, redirect target) and however the read cap cuts it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorFields, errorMessage, log } from '../../src/base/util/log.js';
import { chainText, failureFor, outcomeFor, outcomeText, tokenWindows } from '../_helpers/github-token-leak.js';
import { forAll, mulberry32, type Gen, type Rng } from '../_helpers/property.js';

const SEED = 20261122;
const CASES = 2500;
const WINDOW = 8;
// errorExcerpt reads at most its 256-character excerpt at 4 bytes a character.
const ERROR_READ_CAP_BYTES = 256 * 4;
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const PREFIXES = ['ghp_', 'ghs_', 'github_pat_'];
// No letter, digit, '.', '_' or '-', so a window found in an error came from the token.
const PUNCTUATION = ' \n:;,!?()[]{}"\'';

const below = (rng: Rng, n: number): number => Math.floor(rng() * n);

function chars(rng: Rng, alphabet: string, count: number): string {
  return Array.from({ length: count }, () => alphabet.charAt(below(rng, alphabet.length))).join('');
}

function alphabetOf(prefix: string): string {
  return prefix === 'ghs_' ? `${ALNUM}._-` : ALNUM;
}

function makeToken(rng: Rng): string {
  const prefix = PREFIXES[below(rng, PREFIXES.length)]!;
  const length = 36 + below(rng, 485);
  const token = prefix + chars(rng, alphabetOf(prefix), length - prefix.length);
  const kind = rng();
  if (kind < 1 / 3) return token.slice(0, -1) + token.charAt(0);
  if (kind < 1 / 2) {
    const border = 2 + below(rng, 5);
    return token.slice(0, length - border) + token.slice(0, border);
  }
  return token;
}

type Kind = 'whole' | 'cut' | 'cutThenWhole' | 'asciiPadding' | 'otherPadding';
const KINDS: readonly Kind[] = ['whole', 'cut', 'cutThenWhole', 'asciiPadding', 'otherPadding'];

// A random run of 8 or more characters from anywhere in the token, as a server that cuts or masks an echo sends it.
function cutOf(rng: Rng, token: string): string {
  const start = below(rng, token.length - WINDOW + 1);
  const room = token.length - start;
  const size = rng() < 0.4 ? Math.min(room, WINDOW + below(rng, 5)) : WINDOW + below(rng, room - WINDOW + 1);
  return token.slice(start, start + size);
}

function otherPadding(rng: Rng): string {
  const mixed = rng() < 0.5;
  return Array.from({ length: 1 + below(rng, 420) }, () =>
    !mixed || rng() < 0.6
      ? String.fromCodePoint(0x4e00 + below(rng, 0x5200))
      : PUNCTUATION.charAt(below(rng, PUNCTUATION.length)),
  ).join('');
}

function segmentText(rng: Rng, kind: Kind, token: string): string {
  switch (kind) {
    case 'whole':
      return token;
    case 'cut':
      return cutOf(rng, token);
    case 'cutThenWhole':
      return token.slice(0, token.length - (1 + below(rng, 12))) + token;
    case 'asciiPadding':
      return chars(rng, `${ALNUM} `, 1 + below(rng, 420));
    case 'otherPadding':
      return otherPadding(rng);
  }
}

function pickKind(rng: Rng): Kind {
  const roll = rng();
  if (roll < 0.25) return 'whole';
  if (roll < 0.45) return 'cut';
  if (roll < 0.55) return 'cutThenWhole';
  return roll < 0.75 ? 'asciiPadding' : 'otherPadding';
}

type FieldKind = 'linkPath' | 'linkQuery' | 'linkHost' | 'location';
const FIELD_KINDS: readonly FieldKind[] = ['linkPath', 'linkQuery', 'linkHost', 'location'];
const ORIGIN = 'https://api.github.com';
const LIST_URL = `${ORIGIN}/repos/acme/app/issues`;
const FIELD_SHARE = 0.4;

// A host label keeps the token characters and nothing a host cannot hold.
const hostSafe = (text: string): string => text.replace(/[^A-Za-z0-9_.-]/g, 'x');

/** Echo segments for a reply field the client reads; at least one holds a whole copy of the token. */
function fieldSegments(rng: Rng, token: string): string[] {
  const kinds = Array.from({ length: 1 + below(rng, 4) }, () => pickKind(rng));
  if (kinds.every((k) => k.endsWith('Padding'))) kinds[kinds.length - 1] = 'whole';
  return kinds.map((kind) => segmentText(rng, kind, token));
}

// The URL each reply field carries, built so that it still parses; segments are percent-encoded where a URL needs it.
const FIELD_URLS = {
  linkPath: (s) => `${ORIGIN}/repos/acme/app/issues/${s.map(encodeURIComponent).join('/')}?page=2`,
  linkQuery: (s) => `${LIST_URL}?${s.map((t, i) => `q${i}=${encodeURIComponent(t)}`).join('&')}`,
  linkHost: (s) => `https://${s.map(hostSafe).join('.')}.example.test/x`,
  location: (s) => `https://${s.map(hostSafe).join('.')}.example.test/x`,
} satisfies Record<FieldKind, (segments: string[]) => string>;

// fetch follows a 3xx and reports the target as `res.url`, so a Location echo reaches the client there.
function replyFor(kind: FieldKind, target: string): () => Response {
  return () => {
    if (kind !== 'location') {
      return new Response('[]', {
        status: 200,
        headers: { link: `<${target}>; rel="next"` },
      });
    }
    const res = new Response('[]', { status: 200 });
    Object.defineProperty(res, 'url', { value: target });
    return res;
  };
}

interface Case {
  readonly token: string;
  /** The URL for each reply field that echoes the token in this case. */
  readonly fieldUrls: Partial<Record<FieldKind, string>>;
  readonly body: string;
  /** The byte range of each whole token copy in the body. */
  readonly copies: ReadonlyArray<readonly [number, number]>;
  readonly kinds: ReadonlySet<Kind>;
}

function makeCase(rng: Rng): Case {
  const token = makeToken(rng);
  const kinds = Array.from({ length: 1 + below(rng, 6) }, () => pickKind(rng));
  if (kinds.every((k) => k.endsWith('Padding'))) kinds[kinds.length - 1] = 'whole';
  const copies: Array<readonly [number, number]> = [];
  let bytes = 0;
  const body = kinds
    .map((kind) => {
      const text = segmentText(rng, kind, token);
      const end = bytes + Buffer.byteLength(text);
      if (kind === 'whole' || kind === 'cutThenWhole') copies.push([end - Buffer.byteLength(token), end]);
      bytes = end;
      return text;
    })
    .join('');
  const fieldUrls: Partial<Record<FieldKind, string>> = {};
  for (const kind of FIELD_KINDS) {
    if (rng() < FIELD_SHARE) fieldUrls[kind] = FIELD_URLS[kind](fieldSegments(rng, token));
  }
  return { token, fieldUrls, body, copies, kinds: new Set(kinds) };
}

const cases: Gen<Case> = (rng) => ({ value: makeCase(rng), smaller: () => [] });

describe('a GitHub reply that echoes the token', () => {
  const logged: string[] = [];

  beforeEach(() => {
    vi.stubEnv('HIPPO_LOG', 'debug');
    logged.length = 0;
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      logged.push(String(chunk));
      return true;
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // The error as inspected, its log lines and the warn line the CLI writes for it.
  async function leakedWindows(body: string, token: string): Promise<string[]> {
    logged.length = 0;
    const err = await failureFor(body, 400, token);
    log.warn(`github backfill failed: ${errorMessage(err)}`, errorFields(err));
    const text = `${chainText(err)}\n${logged.join('')}`;
    return tokenWindows(token, WINDOW).filter((w) => text.includes(w));
  }

  // What a failed or returned page shows: the error as inspected, the log lines, the CLI's warn line, the page itself.
  async function leakedFromField(kind: FieldKind, target: string, token: string): Promise<string[]> {
    logged.length = 0;
    const outcome = await outcomeFor(replyFor(kind, target), LIST_URL, token);
    if (outcome.err !== undefined) {
      log.warn(`github backfill failed: ${errorMessage(outcome.err)}`, errorFields(outcome.err));
    }
    const text = `${outcomeText(outcome)}
${logged.join('')}`;
    return tokenWindows(token, WINDOW).filter((w) => text.includes(w));
  }

  it(`leaves no ${WINDOW}-character window of the token in ${CASES} generated cases`, async () => {
    const seen = {
      fields: new Map<FieldKind | 'body', number>(),
      overCap: 0,
      cutInCopy: 0,
      cutInChar: 0,
      endsInCopy: 0,
      borderEndsInCopy: 0,
      kinds: new Map<Kind, number>(),
    };
    await forAll(SEED, CASES, cases, async ({ token, fieldUrls, body, copies, kinds }) => {
      seen.fields.set('body', (seen.fields.get('body') ?? 0) + 1);
      for (const kind of FIELD_KINDS) {
        const target = fieldUrls[kind];
        if (target === undefined) continue;
        seen.fields.set(kind, (seen.fields.get(kind) ?? 0) + 1);
        const leakedField = await leakedFromField(kind, target, token);
        if (leakedField.length > 0) {
          throw new Error(`${kind} echo of a ${token.length}-character token leaked ${leakedField[0]}
target: ${target}`);
        }
      }
      const bytes = Buffer.from(body);
      for (const kind of kinds) seen.kinds.set(kind, (seen.kinds.get(kind) ?? 0) + 1);
      const readEnd = Math.min(bytes.length, ERROR_READ_CAP_BYTES);
      if (bytes.length > ERROR_READ_CAP_BYTES) {
        seen.overCap += 1;
        const cutsCopy = copies.some(([start, end]) => start < ERROR_READ_CAP_BYTES && ERROR_READ_CAP_BYTES < end);
        if (cutsCopy) seen.cutInCopy += 1;
        if ((bytes[ERROR_READ_CAP_BYTES]! & 0xc0) === 0x80) seen.cutInChar += 1;
      }
      if (copies.some(([, end]) => end === readEnd)) {
        seen.endsInCopy += 1;
        if (token.charAt(token.length - 1) === token.charAt(0)) seen.borderEndsInCopy += 1;
      }
      const leaked = await leakedWindows(body, token);
      if (leaked.length > 0) {
        throw new Error(
          `token length ${token.length}: ${leaked.length} windows reached the error, first ${leaked[0]}\nbody: ${JSON.stringify(body)}`,
        );
      }
    });

    // The generator must keep reaching the cuts that leaked before, or this test proves nothing.
    expect(seen.overCap).toBeGreaterThan(CASES / 3);
    expect(seen.cutInCopy).toBeGreaterThan(CASES / 20);
    expect(seen.cutInChar).toBeGreaterThan(CASES / 20);
    expect(seen.endsInCopy).toBeGreaterThan(CASES / 20);
    // A token whose last character equals its first, copied whole at the end of the read text: the class a trim-first order broke.
    expect(seen.borderEndsInCopy).toBeGreaterThanOrEqual(50);
    for (const kind of KINDS) expect(seen.kinds.get(kind) ?? 0, `cases with ${kind}`).toBeGreaterThanOrEqual(100);
    // Every reply field the client reads must carry an echo in many cases, or one of them is untested.
    for (const field of ['body', ...FIELD_KINDS] as const) {
      expect(seen.fields.get(field) ?? 0, `cases with an echo in ${field}`).toBeGreaterThanOrEqual(100);
    }
  });

  const rng = mulberry32(511);
  const PAT_ENDING_G = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345678g';
  const APP_ENDING_G = `ghs_${chars(rng, `${ALNUM}._-`, 506)}g`;
  const LONG_TOKEN = `ghs_${chars(rng, `${ALNUM}._-`, 516)}`;
  const APP_511 = `ghs_${chars(rng, `${ALNUM}._-`, 507)}`;
  const PAT = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab';

  it.each([
    ['a 40-character PAT ending in g after Bearer', `Bearer ${PAT_ENDING_G}`, PAT_ENDING_G],
    ['a 40-character PAT ending in g echoed twice in a row', `${PAT_ENDING_G}${PAT_ENDING_G}`, PAT_ENDING_G],
    ['a 40-character PAT ending in g after you sent Bearer', `you sent Bearer ${PAT_ENDING_G}`, PAT_ENDING_G],
    ['a 511-character token ending in g echoed once at the end', `you sent ${APP_ENDING_G}`, APP_ENDING_G],
    ['a 511-character token ending in g echoed twice inside the cap', `${APP_ENDING_G}${APP_ENDING_G}`, APP_ENDING_G],
    [
      '169 CJK characters then one whole 40-character PAT ending in g',
      `${'中'.repeat(169)}${PAT_ENDING_G}`,
      PAT_ENDING_G,
    ],
    ['30 copies of a PAT after 20 filler characters', `${'x'.repeat(20)}${`${PAT} `.repeat(30)}`, PAT],
    ['a 520-character token echoed twice', `${LONG_TOKEN}${LONG_TOKEN}`, LONG_TOKEN],
    ['169 CJK characters then one echo of a 520-character token', `${'中'.repeat(169)}${LONG_TOKEN}`, LONG_TOKEN],
    ['the first 20 characters of a PAT, then dots', `token ${PAT.slice(0, 20)}... is invalid`, PAT],
    ['the last 16 characters of a PAT', `invalid token ...${PAT.slice(-16)}`, PAT],
    ['a 64-character cut from the middle of a 511-character token', `bad ${APP_511.slice(200, 264)} here`, APP_511],
    [
      'a PAT ending in g minus its last character, then the PAT',
      `${PAT_ENDING_G.slice(0, -1)}${PAT_ENDING_G}`,
      PAT_ENDING_G,
    ],
    ['a whole PAT that the read cap cuts after 20 characters', `${'x'.repeat(ERROR_READ_CAP_BYTES - 20)}${PAT}`, PAT],
    ['an exactly 8-character cut from the middle of a PAT', `see ${PAT.slice(10, 18)} here`, PAT],
  ])('leaves no window of the token for %s', async (_name, body, token) => {
    expect(await leakedWindows(body, token)).toEqual([]);
  });

  it('scrubs the origin a redirect ends at, a site that prints it without a scrub of its own', async () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789ab';
    const outcome = await outcomeFor(replyFor('location', `https://${token}.example.test/x`), LIST_URL, token);

    expect(outcome.err?.message).toBe(`GitHub request to ${LIST_URL} was redirected to https://[token].example.test`);
    expect(await leakedFromField('location', `https://${token}.example.test/x`, token)).toEqual([]);
  });
});
