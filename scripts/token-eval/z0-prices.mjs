/** Z0 price rows (round 4 prereg item 7): a record is priced at its tool's row under round 3, and at its arm's model row under round 4.
 * A price file holds `claude-code` and `codex` rows (round 3), or a `models` block, or top-level rows whose `model` field names the model. */

import { addUsage, priceUsage } from '../../dist/eval/eval-stats.js';
import { ARM_TABLE, DESIGNS, OPUS_MODEL, SONNET_MODEL } from './arms.mjs';
import { cellKey, isString, locationOf } from './z0-records.mjs';

export const PRICE_FIELDS = ['inputPerMTok', 'cacheWritePerMTok', 'cacheReadPerMTok', 'outputPerMTok'];
const HALF_TOLERANCE = 1e-9;

const own = (object, key) => Object.hasOwn(object, key);
const isObject = (v) => v !== undefined && v !== null && v.constructor === Object;
const isPrices = (p) => p !== undefined && p !== null && PRICE_FIELDS.every((f) => Number.isFinite(p[f]) && p[f] >= 0);
const priced = (usage, row) => (row === null ? Number.NaN : priceUsage(usage, row));

/** The rows of a by-model file keyed by model id: the `models` block, else each top-level row that names its model. Two rows naming one model stop the read. */
function modelRows(prices, file) {
  const where = file ?? 'the price file';
  if (prices.models !== undefined) {
    if (!isObject(prices.models)) throw new Error(`${where}: "models" must be an object with one price row per model id`);
    for (const [id, p] of Object.entries(prices.models)) if (!isPrices(p)) throw new Error(`${where}: models.${id} needs ${PRICE_FIELDS.join(', ')}`);
    return new Map(Object.entries(prices.models));
  }
  const [rows, keys] = [new Map(), new Map()];
  for (const [key, p] of Object.entries(prices)) {
    // A top-level string, such as asOf, is no row.
    if (!isObject(p)) continue;
    if (!isPrices(p)) throw new Error(`${where}: "${key}" needs ${PRICE_FIELDS.join(', ')}`);
    if (!isString(p.model)) continue;
    if (rows.has(p.model)) throw new Error(`${where}: rows "${keys.get(p.model)}" and "${key}" both name model ${p.model}; a model has one price row`);
    rows.set(p.model, p);
    keys.set(p.model, key);
  }
  return rows;
}

/** The one way to find a model's price row, for the read and the check alike: null when the file has none. */
const modelRow = (prices, model, file) => modelRows(prices, file).get(model) ?? null;

/** The price row of one record, or null when a round 3 file has no row for its tool; round 4 stops on a record it cannot price.
 * @param {any} prices
 * @param {any} record
 * @param {{design?: any, rowModel?: string, file?: string}} [options] `rowModel` prices every record at that model's row */
export function priceRow(prices, record, { design = DESIGNS.r3, rowModel = undefined, file = undefined } = {}) {
  if (design.prices === 'tool') return own(prices, record.tool) ? prices[record.tool] : null;
  const where = locationOf(record) ?? cellKey(record);
  if (!own(ARM_TABLE, record.arm)) throw new Error(`${where}: arm ${record.arm} is not an arm of the arm table`);
  const arm = ARM_TABLE[record.arm];
  if (record.tool !== arm.tool) throw new Error(`${where}: tool ${record.tool} but arm ${record.arm} runs ${arm.tool}; a design that prices by model holds Claude Code arms only`);
  const model = rowModel ?? arm.model;
  const row = modelRow(prices, model, file);
  if (row === null) throw new Error(`no price row for model ${model} (arm ${record.arm}) in ${file ?? 'the price file'}; add its row from the price page and record it in an amendment (prereg item 7)`);
  return row;
}

/** A record's whole usage priced at its row; NaN when a round 3 file has no row for its tool, so a report prints n/a. */
export const costOf = (record, prices, opts = {}) => priced(addUsage(record.usage.firstSession, record.usage.extra), priceRow(prices, record, opts));

/** One part of a record's usage (`usage.firstSession` or `usage.extra`) priced at the record's own row. */
export const partCost = (usage, record, prices, opts = {}) => priced(usage, priceRow(prices, record, opts));

/** Stops, naming the file, when the price file cannot price the design: a missing tool row, a model with no row, or a Sonnet 5.5 rate that is not half the Opus 5.5 rate. */
export function checkPrices(prices, file, design = DESIGNS.r3) {
  if (design.prices === 'tool') {
    if (!isObject(prices) || !isPrices(prices['claude-code']) || !(prices.codex === undefined || isPrices(prices.codex))) {
      throw new Error(`${file}: needs "claude-code" (and optionally "codex") with ${PRICE_FIELDS.join(', ')}`);
    }
    return;
  }
  for (const model of new Set([...design.arms.map((a) => ARM_TABLE[a].model), OPUS_MODEL])) {
    if (modelRow(prices, model, file) === null) throw new Error(`${file}: no price row for model ${model}; add its row from the price page and record it in an amendment (prereg item 7)`);
  }
  const [opus, sonnet] = [modelRow(prices, OPUS_MODEL, file), modelRow(prices, SONNET_MODEL, file)];
  if (sonnet === null) return;
  for (const column of PRICE_FIELDS) {
    if (Math.abs(sonnet[column] - opus[column] / 2) > HALF_TOLERANCE) {
      throw new Error(`${file}: ${column} is ${sonnet[column]} for ${SONNET_MODEL} and ${opus[column]} for ${OPUS_MODEL}, not half; the freeze stops; an amendment sets k (prereg item 7)`);
    }
  }
}
