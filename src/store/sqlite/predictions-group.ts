// hippo.db's half of the Predictions store group: each method is one call into the queries the CLI and the MCP tools run.
import {
  closePrediction, computePredictionBaserate, loadAllPredictions, loadOpenPredictions, loadPredictionById, loadPredictionsByClass, writePrediction,
} from '../predictions.js';
import type { Predictions, Sync } from '../port.js';

export function sqlitePredictions(hippoRoot: string): Sync<Predictions> {
  return {
    savePrediction: (tenantId, input, actor) => writePrediction(hippoRoot, tenantId, input, actor),
    closePrediction: (tenantId, id, close, actor) => closePrediction(hippoRoot, tenantId, id, close, actor),
    predictionById: (tenantId, id) => loadPredictionById(hippoRoot, tenantId, id),
    listPredictions(tenantId, { classTag, closureState, limit, after }) {
      if (closureState === 'open') return loadOpenPredictions(hippoRoot, tenantId, { classTag, limit, after });
      if (classTag === undefined) return loadAllPredictions(hippoRoot, tenantId, { limit, after });
      return loadPredictionsByClass(hippoRoot, tenantId, classTag, { closureState, limit, after });
    },
    predictionBaserate: (tenantId, classTag, actor) => computePredictionBaserate(hippoRoot, tenantId, classTag, actor),
  };
}

/** The group as a served store answers it: each call runs at once and resolves through a Promise, so a throw rejects as another store's would. */
export function servedPredictions(sync: Sync<Predictions>): Predictions {
  return {
    savePrediction: async (tenantId, input, actor) => sync.savePrediction(tenantId, input, actor),
    closePrediction: async (tenantId, id, close, actor) => sync.closePrediction(tenantId, id, close, actor),
    predictionById: async (tenantId, id) => sync.predictionById(tenantId, id),
    listPredictions: async (tenantId, query) => sync.listPredictions(tenantId, query),
    predictionBaserate: async (tenantId, classTag, actor) => sync.predictionBaserate(tenantId, classTag, actor),
  };
}
