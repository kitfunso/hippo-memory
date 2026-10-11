// A thrown error crosses the worker boundary as plain data and arrives as an instance
// of its class: the server's mappers test `instanceof`, `errcode` and fields.
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../core/api-errors.js';
import { RawAppendOnlyError } from '../../core/raw-append-only.js';
import { IncompatibleBinaryError } from '../../db/index.js';
import { StoreBusyError } from '../port.js';
import { BodyTimeoutError, BodyTooLargeError, HttpError } from '../../util/http-util.js';
import { errorMessage, log } from '../../util/log.js';
import { ScopeForbiddenError } from '../../core/recall-scope.js';
import { RejectedValueError } from '../../core/api-errors.js';
import { OtherStoreFolderError, SqliteBlockedError, StoreNotPortedError } from '../../util/sqlite-blocked.js';

type FieldValue = string | number | boolean | null;

/** One error as a thread message can carry it. */
export interface WireError {
  /** Constructor names from the thrown class up to Error: several classes set no `name`, so a name alone cannot pick the class. */
  readonly classes: readonly string[];
  readonly message: string;
  readonly stack: string | undefined;
  /** Own enumerable fields with a primitive value: `status`, `errcode`, `storeKind`, a `name` its constructor set. */
  readonly fields: Readonly<Record<string, FieldValue>>;
  readonly cause: WireError | undefined;
}

// Every class the server maps by, at or below the store layer. Abstract ApiError is absent: only its four subclasses are thrown.
const CLASSES = [
  Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError,
  HttpError, BodyTooLargeError, BodyTimeoutError,
  BadRequestError, ForbiddenError, NotFoundError, ConflictError, RejectedValueError, ScopeForbiddenError, RawAppendOnlyError,
  SqliteBlockedError, StoreNotPortedError, OtherStoreFolderError,
  StoreBusyError, IncompatibleBinaryError,
] as const;

const PROTOTYPES: ReadonlyMap<string, Error> = new Map(CLASSES.map((known): [string, Error] => [known.name, known.prototype]));

// A chain of causes deeper than this is cut, so a cycle cannot recurse for ever.
const MAX_CAUSES = 4;

function isFieldValue<V>(value: V): value is V & FieldValue {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function classNames(err: Error): string[] {
  const names: string[] = [];
  let proto: object | null = Object.getPrototypeOf(err);
  while (proto !== null && proto !== Object.prototype) {
    names.push(proto.constructor.name);
    proto = Object.getPrototypeOf(proto);
  }
  return names;
}

function ownFields(err: Error) {
  return Object.fromEntries(Object.entries(err).filter((field): field is [string, FieldValue] => isFieldValue(field[1])));
}

/** Worker side. A thrown value that is not an Error carries its text and no class. */
export function encodeError<E>(err: E, depth = 0): WireError {
  if (!(err instanceof Error)) return { classes: [], message: errorMessage(err), stack: undefined, fields: {}, cause: undefined };
  const cause = err.cause === undefined || depth >= MAX_CAUSES ? undefined : encodeError(err.cause, depth + 1);
  return { classes: classNames(err), message: err.message, stack: err.stack, fields: ownFields(err), cause };
}

/** Server side: an instance of the thrown class, or of its nearest ancestor in the table, with the worker's stack, cause and fields. */
export function decodeError(wire: WireError): Error {
  const thrown = wire.classes[0];
  const known = wire.classes.find((name) => PROTOTYPES.has(name)) ?? 'Error';
  const unlisted = thrown !== undefined && thrown !== known;
  if (unlisted) log.once(`store-worker-error:${thrown}`, 'warn', `a store worker threw ${thrown}, which the error codec does not list; it arrives as ${known}`);
  // A listed ancestor still maps to its status, so its text stays as thrown; under plain Error the class survives only in the message.
  const message = unlisted && known === 'Error' ? `${thrown}: ${wire.message}` : wire.message;
  const rebuilt = wire.cause === undefined ? new Error(message) : new Error(message, { cause: decodeError(wire.cause) });
  // The constructor is not run again: its arguments did not cross, and the fields below are what it set.
  Object.setPrototypeOf(rebuilt, PROTOTYPES.get(known) ?? Error.prototype);
  Object.assign(rebuilt, wire.fields);
  if (wire.stack !== undefined) rebuilt.stack = wire.stack;
  return rebuilt;
}
