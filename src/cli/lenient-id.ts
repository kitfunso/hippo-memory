// The id parser the predict and decide verbs share.

import { printError } from './output.js';
import { CliExit } from './exit.js';

// Lenient on purpose (parseInt reads "1abc" as 1) until the next major version; the other object verbs use the strict parser.
export function parseObjectId(idRaw: string, noun: string): number {
  const id = parseInt(String(idRaw), 10);
  if (!Number.isFinite(id) || id <= 0) {
    printError(`Invalid ${noun} id: "${idRaw}"`);
    throw new CliExit(1);
  }
  return id;
}
