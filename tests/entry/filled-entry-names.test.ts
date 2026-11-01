// The entries filled() builds are published, so each must keep the wrapped function's name and
// length, as the function declarations they replaced did.
import { describe, expect, it } from 'vitest';
import * as evalScripts from '../../src/entry/eval-scripts.js';
import * as server from '../../src/server.js';

const ENTRIES = [
  ['authCreate', server.authCreate, 2],
  ['authCreateSelf', server.authCreateSelf, 2],
  ['authRevoke', server.authRevoke, 2],
  ['remember', evalScripts.remember, 2],
  ['retrieve', evalScripts.retrieve, 2],
  ['retrieveRanking', evalScripts.retrieveRanking, 3],
  ['retrieveWithCliCore', evalScripts.retrieveWithCliCore, 3],
] as const;

describe('filled() entries', () => {
  it.each(ENTRIES)('%s keeps its name and length', (name, entry, length) => {
    expect(entry.name).toBe(name);
    expect(entry.length).toBe(length);
  });
});
