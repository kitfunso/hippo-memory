// hippo.db's half of the Predictions store group: each method is one call into the queries the CLI and the MCP tools
// run.
import {
  closePredictionAt,
  computePredictionBaserateAt,
  loadAllPredictionsAt,
  loadOpenPredictionsAt,
  loadPredictionByIdAt,
  loadPredictionsByClassAt,
  writePredictionAt,
} from '../predictions.js';
import type { Predictions, Sync } from '../port.js';
import type { OnHandle } from '../open.js';
import { openStore } from './handles.js';

export function sqlitePredictions(on: OnHandle): Sync<Predictions> {
  return {
    savePrediction: (tenantId, input, actor) =>
      on((db, files) => writePredictionAt(db, files, tenantId, input, actor), openStore),
    closePrediction: (tenantId, id, close, actor) => on((db) => closePredictionAt(db, tenantId, id, close, actor)),
    predictionById: (tenantId, id) => on((db) => loadPredictionByIdAt(db, tenantId, id)),
    listPredictions(tenantId, { classTag, closureState, limit, after }) {
      if (closureState === 'open') return on((db) => loadOpenPredictionsAt(db, tenantId, { classTag, limit, after }));
      if (classTag === undefined) return on((db) => loadAllPredictionsAt(db, tenantId, { limit, after }));
      return on((db) => loadPredictionsByClassAt(db, tenantId, classTag, { closureState, limit, after }));
    },
    predictionBaserate: (tenantId, classTag, actor) =>
      on((db) => computePredictionBaserateAt(db, tenantId, classTag, actor)),
  };
}
