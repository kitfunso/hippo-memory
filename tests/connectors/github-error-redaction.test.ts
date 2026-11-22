// No 8-character window of a token reaches a GitHub error body excerpt, whatever the reply echoes of it, however the read cap cuts it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorFields, errorMessage, log } from '../../src/base/util/log.js';
import { chainText, failureFor, tokenWindows } from '../_helpers/github-token-leak.js';
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

interface Case {
  readonly token: string;
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
  return { token, body, copies, kinds: new Set(kinds) };
}

const cases: Gen<Case> = (rng) => ({ value: makeCase(rng), smaller: () => [] });

describe('a GitHub error body that echoes the token', () => {
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

  it(`leaves no ${WINDOW}-character window of the token in ${CASES} generated cases`, async () => {
    const seen = {
      overCap: 0,
      cutInCopy: 0,
      cutInChar: 0,
      endsInCopy: 0,
      borderEndsInCopy: 0,
      kinds: new Map<Kind, number>(),
    };
    await forAll(SEED, CASES, cases, async ({ token, body, copies, kinds }) => {
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
});
