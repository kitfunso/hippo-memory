// A store worker's thrown error crosses to the server as plain data: for generated errors of every listed class the server still gets the class, the message, the fields and the cause chain.
import { describe, it, expect } from 'vitest';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../src/api-errors.js';
import { IncompatibleBinaryError, StoreBusyError } from '../src/db.js';
import { BodyTimeoutError, BodyTooLargeError, HttpError } from '../src/http-util.js';
import { ScopeForbiddenError } from '../src/recall-scope.js';
import { RejectedValueError } from '../src/rejection.js';
import { decodeError, encodeError } from '../src/store/sqlite/error-codec.js';
import { OtherStoreFolderError, SqliteBlockedError, StoreNotPortedError } from '../src/util/sqlite-blocked.js';
import { arr, both, forAll, int, map, pick, str, type Gen } from './_helpers/property.js';

// One way to throw each class the codec lists; HttpError twice, with and without its optional field.
const MAKERS: readonly ((text: string) => Error)[] = [
  (m) => new Error(m), (m) => new TypeError(m), (m) => new RangeError(m), (m) => new SyntaxError(m),
  (m) => new ReferenceError(m), (m) => new EvalError(m), (m) => new URIError(m),
  (m) => new HttpError(400, m), (m) => new HttpError(429, m, 7), (m) => new BodyTooLargeError(m), (m) => new BodyTimeoutError(m),
  (m) => new BadRequestError(m), (m) => new ForbiddenError(m), (m) => new NotFoundError(m), (m) => new ConflictError(m),
  (m) => new RejectedValueError({ digest: m, tenantId: 't1', entryId: 'mem_1', reason: null, rejectedAt: '2026-01-01T00:00:00.000Z' }),
  (m) => new ScopeForbiddenError(m),
  (m) => new SqliteBlockedError('other', m), (m) => new StoreNotPortedError('other', m), (m) => new OtherStoreFolderError('other', m),
  (m) => new StoreBusyError(m), (m) => new IncompatibleBinaryError(m),
];

// The codec keeps this many causes under an error and cuts the rest.
const KEPT_CAUSES = 4;

/** An error to build afresh on every check: which maker, and the text it is given. */
type Recipe = readonly [maker: number, text: string];

interface Case {
  readonly top: Recipe;
  /** Extra fields holding plain data, which must cross. */
  readonly carried: readonly (readonly [string, string | number | boolean | null])[];
  /** Extra fields holding something a thread message cannot carry as a field, which must be left behind. */
  readonly dropped: readonly (readonly [string, object | bigint])[];
  readonly causes: readonly Recipe[];
}

const RECIPE: Gen<Recipe> = both(int(0, MAKERS.length - 1), str('abc XYZ 019 .:/-_"é東\n', 0, 24));
const CARRIED = both(pick(['retries', 'hint', 'detail', 'flag']), pick(['x', '', 0, 42, -1.5, Number.NaN, true, false, null]));
const DROPPED = both(pick(['handle', 'rows']), pick([{ a: 1 }, [1, 2], 10n, new Date(0)]));

const CASE: Gen<Case> = map(
  both(both(RECIPE, arr(RECIPE, 0, 6)), both(arr(CARRIED, 0, 3), arr(DROPPED, 0, 2))),
  ([[top, causes], [carried, dropped]]) => ({ top, causes, carried, dropped }),
);

function thrownFrom({ top, causes, carried, dropped }: Case): Error {
  const make = ([maker, text]: Recipe): Error => MAKERS[maker]!(text);
  const error = make(top);
  Object.assign(error, Object.fromEntries(carried), Object.fromEntries(dropped));
  causes.reduce((parent, recipe) => Object.assign(parent, { cause: make(recipe) }).cause, error);
  return error;
}

/** The error and each cause under it, outermost first. */
function chain(error: Error): Error[] {
  const next = error.cause;
  return next instanceof Error ? [error, ...chain(next)] : [error];
}

/** The own fields of `error` that hold plain data: everything but its cause and the fields named in `dropped`. */
function plainFields(error: Error, dropped: readonly string[]): object {
  return Object.fromEntries(Object.entries(error).filter(([name]) => name !== 'cause' && !dropped.includes(name)));
}

describe('error codec properties', () => {
  it('decode(encode(e)) keeps the class, message, plain fields and cause chain of every listed class', () => {
    forAll(0xc0dec, 300, CASE, (drawn) => {
      const error = thrownFrom(drawn);
      // structuredClone is what a thread message does to the encoded error.
      const arrived = chain(decodeError(structuredClone(encodeError(error))));
      const sent = chain(error).slice(0, KEPT_CAUSES + 1);
      expect(arrived.length).toBe(Math.min(drawn.causes.length, KEPT_CAUSES) + 1);
      arrived.forEach((got, depth) => {
        const thrown = sent[depth]!;
        expect(Object.getPrototypeOf(got)).toBe(Object.getPrototypeOf(thrown));
        expect(got.message).toBe(thrown.message);
        expect({ ...got }).toEqual(plainFields(thrown, drawn.dropped.map(([name]) => name)));
      });
    });
  });
});
