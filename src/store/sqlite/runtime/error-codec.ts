import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../../../base/errors/api-errors.js';
import { RawAppendOnlyError } from '../../../base/errors/raw-append-only.js';
import {
  IncompatibleBinaryError,
  OtherStoreFolderError,
  SqliteBlockedError,
} from '../../../db/index.js';
import { StoreBusyError } from '../../../base/ports/store.js';
import {
  BodyTimeoutError,
  BodyTooLargeError,
  HttpError,
} from '../../../base/errors/http-errors.js';
import { errorMessage, log } from '../../../base/util/log.js';
import { ScopeForbiddenError } from '../../../base/scope/recall-scope.js';
import { RejectedValueError } from '../../../base/errors/api-errors.js';
import { StoreNotPortedError } from '../../../base/util/store-blocked.js';

type FieldValue = string | number | boolean | null | readonly string[];

/** One error as a thread message can carry it. */
export interface WireError {
  readonly classes: readonly string[];
  readonly message: string;
  readonly stack: string | undefined;
  readonly fields: Readonly<Record<string, FieldValue>>;
  readonly cause: WireError | undefined;
}

const CLASSES = [
  Error,
  TypeError,
  RangeError,
  SyntaxError,
  ReferenceError,
  EvalError,
  URIError,
  HttpError,
  BodyTooLargeError,
  BodyTimeoutError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  RejectedValueError,
  ScopeForbiddenError,
  RawAppendOnlyError,
  SqliteBlockedError,
  StoreNotPortedError,
  OtherStoreFolderError,
  StoreBusyError,
  IncompatibleBinaryError,
] as const;

const PROTOTYPES: ReadonlyMap<string, Error> = new Map(
  CLASSES.map((known): [string, Error] => [known.name, known.prototype]),
);

const MAX_CAUSES = 4;

function isFieldValue<V>(value: V): value is V & FieldValue {
  if (Array.isArray(value)) return value.every((item): item is string => typeof item === 'string');
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
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
  return Object.fromEntries(
    Object.entries(err).filter((field): field is [string, FieldValue] => isFieldValue(field[1])),
  );
}

/** Worker side. A thrown value that is not an Error carries its text and no class. */
export function encodeError<E>(err: E, depth = 0): WireError {
  if (!(err instanceof Error)) {
    return {
      classes: [],
      message: errorMessage(err),
      stack: undefined,
      fields: {},
      cause: undefined,
    };
  }
  const cause =
    err.cause === undefined || depth >= MAX_CAUSES ? undefined : encodeError(err.cause, depth + 1);
  return {
    classes: classNames(err),
    message: err.message,
    stack: err.stack,
    fields: ownFields(err),
    cause,
  };
}

/** Server side: an instance of the thrown class, or of its nearest ancestor in the table, with
 * the worker's stack, cause and fields. */
export function decodeError(wire: WireError): Error {
  const thrown = wire.classes[0];
  const known = wire.classes.find((name) => PROTOTYPES.has(name)) ?? 'Error';
  const unlisted = thrown !== undefined && thrown !== known;
  if (unlisted) {
    log.once(
      `store-worker-error:${thrown}`,
      'warn',
      `a store worker threw ${thrown}, which the error codec does not list; it arrives as ${known}`,
    );
  }
  const message = unlisted && known === 'Error' ? `${thrown}: ${wire.message}` : wire.message;
  const rebuilt =
    wire.cause === undefined
      ? new Error(message)
      : new Error(message, { cause: decodeError(wire.cause) });
  Object.setPrototypeOf(rebuilt, PROTOTYPES.get(known) ?? Error.prototype);
  Object.assign(rebuilt, wire.fields);
  if (wire.stack !== undefined) rebuilt.stack = wire.stack;
  return rebuilt;
}
