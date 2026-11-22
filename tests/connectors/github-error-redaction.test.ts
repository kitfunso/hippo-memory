// No 8-character window of a token reaches a GitHub error body excerpt, whatever the reply echoes of it, however the read cap cuts it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function padding(rng: Rng): string {
  const mixed = rng() < 0.5;
  return Array.from({ length: 1 + below(rng, 420) }, () =>
    !mixed || rng() < 0.6
      ? String.fromCodePoint(0x4e00 + below(rng, 0x5200))
      : PUNCTUATION.charAt(below(rng, PUNCTUATION.length)),
  ).join('');
}

interface Case {
  readonly token: string;
  readonly body: string;
  /** The byte range of each whole token copy in the body. */
  readonly copies: ReadonlyArray<readonly [number, number]>;
}

function makeCase(rng: Rng): Case {
  const token = makeToken(rng);
  const segments = Array.from({ length: 1 + below(rng, 6) }, () => (rng() < 0.5 ? token : padding(rng)));
  if (!segments.includes(token)) segments[segments.length - 1] = token;
  const copies: Array<readonly [number, number]> = [];
  let bytes = 0;
  for (const segment of segments) {
    const end = bytes + Buffer.byteLength(segment);
    if (segment === token) copies.push([bytes, end]);
    bytes = end;
  }
  return { token, body: segments.join(''), copies };
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

  async function leakedWindows(body: string, token: string): Promise<string[]> {
    logged.length = 0;
    const err = await failureFor(body, 400, token);
    const text = `${chainText(err)}\n${logged.join('')}`;
    return tokenWindows(token, WINDOW).filter((w) => text.includes(w));
  }

  it(`leaves no ${WINDOW}-character window of the token in ${CASES} generated cases`, async () => {
    const seen = { overCap: 0, cutInCopy: 0, cutInChar: 0, endsInCopy: 0 };
    await forAll(SEED, CASES, cases, async ({ token, body, copies }) => {
      const bytes = Buffer.from(body);
      if (bytes.length > ERROR_READ_CAP_BYTES) {
        seen.overCap += 1;
        const cutsCopy = copies.some(([start, end]) => start < ERROR_READ_CAP_BYTES && ERROR_READ_CAP_BYTES < end);
        if (cutsCopy) seen.cutInCopy += 1;
        if ((bytes[ERROR_READ_CAP_BYTES]! & 0xc0) === 0x80) seen.cutInChar += 1;
      } else if (body.endsWith(token)) {
        seen.endsInCopy += 1;
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
  });

  const rng = mulberry32(511);
  const PAT_ENDING_G = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345678g';
  const APP_ENDING_G = `ghs_${chars(rng, `${ALNUM}._-`, 506)}g`;
  const LONG_TOKEN = `ghs_${chars(rng, `${ALNUM}._-`, 516)}`;
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
  ])('leaves no window of the token for %s', async (_name, body, token) => {
    expect(await leakedWindows(body, token)).toEqual([]);
  });
});
