import type { JsonValue } from '../../base/util/json.js';
import { errorFields, log } from '../../base/util/log.js';
import { ALL_TENANTS } from '../../base/util/tenant.js';
import type { NearestIdsAsk, VectorCandidateSpec } from '../../base/ports/store/vectors.js';
import { detectServer } from '../server/server-detect.js';
import { callerKey } from '../server/local-key.js';
import { nearestIds } from './client.js';

const NEAREST_TIMEOUT_MS = 1000;

/** The ask a CLI store on `hippoRoot` makes of its server: undefined with no server, and after
 * one warn line when the server does not answer in time or refuses. */
export function serverNearestAsk(hippoRoot: string): NearestIdsAsk {
  return async (queryVector, spec) => {
    const wire = wireSpec(spec);
    if (wire === undefined) return undefined;
    try {
      const info = await detectServer(hippoRoot);
      if (info === null) return undefined;
      return await nearestIds(
        info.url,
        callerKey(hippoRoot),
        { vector: queryVector, spec: wire },
        NEAREST_TIMEOUT_MS,
      );
    } catch (err) {
      log.warn(
        'the hippo server did not answer the nearest-vector read, so this process scans its own store',
        {
          hippoRoot,
          ...errorFields(err),
        },
      );
      return undefined;
    }
  };
}

// ALL_TENANTS is a symbol, which no request can carry, so that read stays local.
function wireSpec(spec: VectorCandidateSpec): JsonValue | undefined {
  if (spec.tenantId === ALL_TENANTS) return undefined;
  const { tenantId, includeSuperseded, limit, scope, origin } = spec;
  return {
    tenantId,
    includeSuperseded,
    ...(limit !== undefined && { limit }),
    ...(scope !== undefined && { scope: { ...scope } }),
    ...(origin !== undefined && { origin: [origin].flat() }),
  };
}
