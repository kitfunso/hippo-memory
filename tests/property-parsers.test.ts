// Generated ids, cursors and argv through the CLI and server parsers: what was written comes back, and a bad input ends in the parser's own refusal and nothing else.
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { parseArgs } from '../src/cli.js';
import { VERB_FLAGS, flagKind, type VerbFlags } from '../src/cli/flags.js';
import { parsePositiveId, type CliFlags } from '../src/cli/shared.js';
import { HttpError } from '../src/util/http-util.js';
import type { KeysetPosition } from '../src/util/keyset.js';
import { pageOf, parseCursor } from '../src/server/cursor.js';
import { arr, both, forAll, int, just, map, oneOf, pick, str, type Gen } from './_helpers/property.js';

type ExitCode = string | number | null | undefined;

class Exit extends Error {
  constructor(readonly code: ExitCode) {
    super(`process.exit(${code})`);
  }
}

/** The id the parser returned, or the code it ended the process with: its refusal is an exit, with no error type of its own. */
function idOrExit(raw: string) {
  try {
    return { id: parsePositiveId(raw, 'brief') };
  } catch (thrown) {
    if (thrown instanceof Exit) return { exit: thrown.code };
    throw thrown;
  }
}

describe('typed-object id parser properties', () => {
  beforeEach(() => {
    vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Exit(code); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('an id written with padding and leading zeros comes back as that id', () => {
    const pad = str(' \t\n', 0, 2);
    const written = both(both(oneOf([int(1, 9999), int(1, Number.MAX_SAFE_INTEGER)]), int(0, 3)), both(pad, pad));
    forAll(0x1d01, 400, written, ([[id, zeros], [before, after]]) => {
      expect(idOrExit(`${before}${'0'.repeat(zeros)}${id}${after}`)).toEqual({ id });
    });
  });

  it('a string that is not whole positive digits is refused with exit 1, and never read as a number', () => {
    forAll(0x1d02, 500, str('0123456789 +-.eExX_,a\t', 0, 8), (raw) => {
      const trimmed = raw.trim();
      const positiveDigits = /^0*[1-9][0-9]*$/.test(trimmed);
      expect(idOrExit(raw)).toEqual(positiveDigits ? { id: Number(trimmed) } : { exit: 1 });
    });
  });

  // Digits past 2^53 would come back as the nearest number a double holds, which is not the id that was typed.
  it('an id too long to be held exactly is refused', () => {
    const digits = map(both(str('123456789', 1, 1), str('0123456789', 16, 24)), ([lead, rest]) => lead + rest);
    forAll(0x1d03, 200, digits, (raw) => {
      expect(idOrExit(raw)).toEqual({ exit: 1 });
    });
  });
});

type Part = 'string' | 'integer';

const PARTS: readonly Part[] = ['string', 'integer'];
const KEY_TEXT = str('az09 "\\/:-_.,é東\u{1F600}\n', 1, 40);
const KEY_NUMBER = oneOf([int(-50, 50), int(-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)]);
const PART_VALUE: Gen<string | number> = oneOf<string | number>([KEY_TEXT, KEY_NUMBER]);

function partOf(value: string | number): Part {
  return String(value) === value ? 'string' : 'integer';
}

function fits(value: string | number, part: Part): boolean {
  return part === 'string' ? partOf(value) === 'string' && value !== '' : Number.isInteger(value);
}

/** The cursor the server mints for `pos`: the next-page cursor of a page that ends on it. */
function minted(pos: KeysetPosition): string {
  return pageOf([pos, pos], 1, (row) => row).nextCursor ?? '';
}

/** The position the parser returned, or the status of the HttpError it refused with; any other throw escapes. */
function positionOrStatus(raw: string, key: Part, id: Part) {
  try {
    return { pos: parseCursor(raw, key, id) };
  } catch (thrown) {
    if (thrown instanceof HttpError) return { status: thrown.status };
    throw thrown;
  }
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
// JSON a cursor could decode to: right pairs, wrong lengths, wrong part types, fractions, nesting and broken text.
const JSON_TEXT = ['[1,2]', '["a",1]', '["a","b"]', '[1.5,2]', '[1,2.5]', '["",1]', '["a",""]', '[1]', '[1,2,3]', '[]', '{"key":1,"id":2}', 'null', '7', '"a"', '[null,1]', '[true,"a"]', '[[1],2]', '[1e400,1]', '[1,"a"', ''];
const HOSTILE_CURSOR: Gen<string> = oneOf([
  map(pick(JSON_TEXT), (text) => Buffer.from(text).toString('base64url')),
  str(B64URL, 0, 40),
  str(`${B64URL}+/= %.é`, 0, 12),
  str(B64URL, 1020, 1030),
]);

describe('keyset cursor properties', () => {
  it('a minted cursor parses back to its position, and only under the part types it was minted with', () => {
    forAll(0xc0750, 400, both(PART_VALUE, PART_VALUE), ([key, id]) => {
      const cursor = minted({ key, id });
      for (const keyPart of PARTS) {
        for (const idPart of PARTS) {
          const mine = keyPart === partOf(key) && idPart === partOf(id);
          expect(positionOrStatus(cursor, keyPart, idPart)).toEqual(mine ? { pos: { key, id } } : { status: 400 });
        }
      }
    });
  });

  it('any other string is refused with a 400, or yields parts of the types asked for', () => {
    forAll(0xc0751, 400, both(HOSTILE_CURSOR, both(pick(PARTS), pick(PARTS))), ([raw, [keyPart, idPart]]) => {
      const { pos, status } = positionOrStatus(raw, keyPart, idPart);
      if (pos === undefined) expect(status).toBe(400);
      else expect([fits(pos.key, keyPart), fits(pos.id, idPart)]).toEqual([true, true]);
    });
  });
});

/** One flag or positional as typed, with what it must leave in the parse. */
interface Item {
  readonly tokens: readonly string[];
  readonly positional?: string;
  readonly set?: readonly [string, string | boolean];
  readonly push?: readonly [string, string];
}

// parseArgs reads a number flag like a value flag: the entry point refuses a bad number later.
type Family = 'switch' | 'list' | 'plain';
type Form = 'bare' | 'separated' | 'glued';

/** One flag as drawn, before its verb says which name it is: `index` picks among the verb's names of the family, its own ones when `own`. */
interface FlagDraw {
  readonly family: Family;
  readonly own: boolean;
  readonly index: number;
  readonly form: Form;
  readonly value: string;
}

const VERBS: ReadonlyMap<string, VerbFlags> = new Map(Object.entries(VERB_FLAGS));
const declaredBy = (verb: VerbFlags): string[] => [verb.switches, verb.values, verb.numbers, verb.lists].flatMap((names) => names ?? []);
// A flag no verb declares parses as a value flag, and `help` belongs to the entry point.
const NAMES = [...new Set([...[...VERBS.values()].flatMap(declaredBy), 'help', 'zz-unlisted'])];

function familyOn(verb: VerbFlags | undefined, name: string): Family {
  const kind = flagKind(verb, name);
  return kind === 'switch' || kind === 'list' ? kind : 'plain';
}

// A verb that reads one of its flags unlike the other verbs with that name: a parse that ignored the verb would get it wrong.
const OWN_KIND_VERBS = [...VERBS].filter(([, verb]) => declaredBy(verb).some((name) => familyOn(verb, name) !== familyOn(undefined, name))).map(([name]) => name);
// A command the table lacks parses each flag by the kind its declaring verbs agree on.
const UNLISTED_COMMANDS = ['', 'no-such-verb'];
const COMMAND = oneOf([pick([...VERBS.keys(), ...UNLISTED_COMMANDS]), pick([...OWN_KIND_VERBS, ...UNLISTED_COMMANDS])]);

/** The flag names of `family` on `command`: the ones the verb declares when `own` and it has any, else every name any verb declares. */
function namesOn(command: string, family: Family, own: boolean): string[] {
  const verb = VERBS.get(command);
  const inFamily = (names: readonly string[]) => names.filter((name) => familyOn(verb, name) === family);
  const declared = inFamily(own && verb ? declaredBy(verb) : []);
  return declared.length > 0 ? declared : inFamily(NAMES);
}

function itemOf({ family, form, value }: FlagDraw, key: string): Item {
  if (form === 'bare') return { tokens: [`--${key}`], set: [key, true] };
  const tokens = form === 'glued' ? [`--${key}=${value}`] : [`--${key}`, value];
  if (family === 'list') return value === '' ? { tokens } : { tokens, push: [key, value] };
  return { tokens, set: [key, family === 'plain' && value === '' ? true : value] };
}

function drawn(family: Family, form: Form, value: Gen<string>): Gen<FlagDraw> {
  return map(both(both(pick([true, false]), int(0, 999)), value), ([[own, index], text]) => ({ family, own, index, form, value: text }));
}

// A positional is never the literal a switch would take as its value, and neither it nor a separated value opens with two dashes.
const WORD = pick(['list', 'show', 'x', 'a=b', '-5', '-x', '42', 'two words', 'café', '']);
const VALUE = pick(['v', 'a=b', '-5', '0', 'true', 'false', 'two words', 'café']);
// A glued value may be empty: a value flag then counts as set with no value, and a list takes nothing.
const GLUED = pick(['v', 'a=b', '-5', 'true', 'false', '--x', '=', 'two words', '']);

// Only a switch stands bare mid-argv: any other flag would take the next token as its value.
const DRAW: Gen<Item | FlagDraw> = oneOf<Item | FlagDraw>([
  map(WORD, (word) => ({ tokens: [word], positional: word })),
  just({ tokens: ['-h'], set: ['help', true] }),
  drawn('switch', 'bare', just('')),
  drawn('switch', 'separated', pick(['true', 'false'])),
  drawn('switch', 'glued', pick(['true', 'false', 'yes', ''])),
  drawn('plain', 'separated', VALUE),
  drawn('plain', 'glued', GLUED),
  drawn('list', 'separated', VALUE),
  drawn('list', 'glued', GLUED),
]);

// After a bare `--` every token is a positional, whatever it looks like.
const TAIL: Gen<string[] | null> = oneOf<string[] | null>([just(null), arr(pick(['--pin', '-h', '--', 'x', '--tag=a', '']), 0, 4)]);
// A value flag with nothing after it, or with a flag after it, is set with no value.
const BARE_LAST: Gen<FlagDraw[]> = oneOf<FlagDraw[]>([just([]), map(drawn('plain', 'bare', just('')), (draw) => [draw])]);

function parseOf(items: readonly Item[]) {
  const args: string[] = [];
  const flags: CliFlags = {};
  for (const { positional, set, push } of items) {
    if (positional !== undefined) args.push(positional);
    if (set) flags[set[0]] = set[1];
    if (push) {
      const sofar = flags[push[0]];
      flags[push[0]] = [...(Array.isArray(sofar) ? sofar : []), push[1]];
    }
  }
  return { args, flags };
}

describe('parseArgs properties', () => {
  it("argv built from a verb's flags gives back the same command, flags and positionals", () => {
    const argv = both(both(COMMAND, arr(DRAW, 0, 8)), both(BARE_LAST, TAIL));
    forAll(0xa49, 500, argv, ([[command, body], [last, tail]]) => {
      const items = [...body, ...last].map((draw) => {
        if (!('family' in draw)) return draw;
        const names = namesOn(command, draw.family, draw.own);
        return itemOf(draw, names[draw.index % names.length]);
      });
      const { args, flags } = parseOf(items);
      const typed = [...items.flatMap((item) => item.tokens), ...(tail === null ? [] : ['--', ...tail])];
      expect(parseArgs(['node', 'hippo', command, ...typed])).toEqual({ command, args: [...args, ...(tail ?? [])], flags });
    });
  });
});
