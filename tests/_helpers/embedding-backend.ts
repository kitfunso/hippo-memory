// Shared rule for tests that need the local embedding backend: skip honestly, or fail where CI says it must be there.
export const REQUIRE_EMBEDDINGS_VAR = 'HIPPO_REQUIRE_EMBEDDINGS';

/** Call first in a test body with the probe result; skips when the backend is missing, throws when it is required. */
export function skipWithoutEmbeddings(
  ctx: { skip: () => void },
  available: boolean,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (available) return;
  if (env[REQUIRE_EMBEDDINGS_VAR] === '1') {
    throw new Error(`${REQUIRE_EMBEDDINGS_VAR}=1 but the local embedding backend is missing or not functional`);
  }
  ctx.skip();
}
