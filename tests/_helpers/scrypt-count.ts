// Counts scrypt derivations, sync and pooled, in this process. A test file opts in with
// vi.mock('node:crypto', async (orig) => (await import('../_helpers/scrypt-count.js')).countingCrypto(await orig()));
type Crypto = typeof import('node:crypto');

let runs = 0;

function counting<F extends (...args: never[]) => unknown>(fn: F): F {
  // SAFETY: the wrapper passes every argument and `this` through unchanged, so it has fn's own overloads.
  return function (this: unknown, ...args: unknown[]) {
    runs += 1;
    return Reflect.apply(fn, this, args);
  } as unknown as F;
}

export function countingCrypto(real: Crypto): Crypto {
  return { ...real, scrypt: counting(real.scrypt), scryptSync: counting(real.scryptSync) };
}

/** Derivations since the process started, minted keys' hashes included. */
export const scryptRuns = (): number => runs;
