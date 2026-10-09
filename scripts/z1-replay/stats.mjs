// Score and token accumulators for the Z1 replay: per-arm buckets, their folds and summaries, and the prereg pick rules.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DIST = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', '..', 'dist');
const distImport = (f) => import(pathToFileURL(path.join(DIST, f)).href);
const { textOverlap } = await distImport('util/tokenize.js');

// ---------------------------------------------------------------------------
// Stats accumulation
// ---------------------------------------------------------------------------

export function makeAcc() {
  return { total: 0, withContext: 0, atLeast02: 0, sumAll: 0, scores: [], contextSizes: [] };
}

export function record(acc, candSet, errText, byId) {
  acc.total++;
  acc.contextSizes.push(candSet.size);
  if (candSet.size === 0) return;
  let mx = 0;
  for (const id of candSet) {
    const e = byId.get(id);
    if (!e) continue;
    const ov = textOverlap(e.content, errText);
    if (ov > mx) mx = ov;
  }
  acc.withContext++;
  acc.scores.push(mx);
  acc.sumAll += mx;
  if (mx >= 0.2) acc.atLeast02++;
}

function quantile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

function summarize(acc) {
  const scores = [...acc.scores].sort((a, b) => a - b);
  const ctx = [...acc.contextSizes].sort((a, b) => a - b);
  return {
    total: acc.total,
    withContext: acc.withContext,
    median: quantile(scores, 0.5),
    p90: quantile(scores, 0.9),
    max: scores.length ? scores[scores.length - 1] : null,
    atLeast0_2: acc.atLeast02,
    meanAllSignalEvents: acc.total ? acc.sumAll / acc.total : 0,
    medianContextSize: quantile(ctx, 0.5),
  };
}

function summarizeTokens(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return {
    hookPrompts: arr.length,
    median: quantile(s, 0.5),
    mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0,
    p90: quantile(s, 0.9),
  };
}

export function setDiff(a, b) {
  const out = new Set();
  for (const x of a) if (!b.has(x)) out.add(x);
  return out;
}

export function emptyBucket() {
  return {
    a0: { reset: { primary: makeAcc(), secondary: makeAcc() }, lifetime: { primary: makeAcc(), secondary: makeAcc() } },
    a1: { reset: { primary: makeAcc(), secondary: makeAcc() }, lifetime: { primary: makeAcc(), secondary: makeAcc() } },
    tokens: [],
    files: 0,
  };
}

export function fold(bucket, result) {
  for (const arm of ['a0', 'a1']) {
    for (const variant of ['reset', 'lifetime']) {
      foldAcc(bucket[arm][variant].primary, result.primary[arm][variant]);
      foldAcc(bucket[arm][variant].secondary, result.secondary[arm][variant]);
    }
  }
  bucket.tokens.push(...result.tokensPerPrompt);
  bucket.files++;
}

function foldAcc(into, from) {
  into.total += from.total;
  into.withContext += from.withContext;
  into.atLeast02 += from.atLeast02;
  into.sumAll += from.sumAll;
  into.scores.push(...from.scores);
  into.contextSizes.push(...from.contextSizes);
}

export function renderBucket(bucket) {
  return {
    files: bucket.files,
    A0: {
      reset: { primary: summarize(bucket.a0.reset.primary), secondary: summarize(bucket.a0.reset.secondary) },
      lifetime: { primary: summarize(bucket.a0.lifetime.primary), secondary: summarize(bucket.a0.lifetime.secondary) },
    },
    A1: {
      reset: { primary: summarize(bucket.a1.reset.primary), secondary: summarize(bucket.a1.reset.secondary) },
      lifetime: { primary: summarize(bucket.a1.lifetime.primary), secondary: summarize(bucket.a1.lifetime.secondary) },
      tokens: summarizeTokens(bucket.tokens),
    },
  };
}

// One Z1 arm, one config: same shape as a0/a1's per-arm stats plus its own tokens and no-recall share.
export function emptyZ1Bucket() {
  return {
    reset: { primary: makeAcc(), secondary: makeAcc() },
    lifetime: { primary: makeAcc(), secondary: makeAcc() },
    tokens: [],
    tokensScored: [], // per-file only: parallel scored flags; fold ignores them
    noRecall: { count: 0, total: 0 },
  };
}

export function foldZ1(bucket, result) {
  foldAcc(bucket.reset.primary, result.reset.primary);
  foldAcc(bucket.reset.secondary, result.reset.secondary);
  foldAcc(bucket.lifetime.primary, result.lifetime.primary);
  foldAcc(bucket.lifetime.secondary, result.lifetime.secondary);
  bucket.tokens.push(...result.tokens);
  bucket.noRecall.count += result.noRecall.count;
  bucket.noRecall.total += result.noRecall.total;
}

export function renderZ1Bucket(bucket) {
  return {
    reset: { primary: summarize(bucket.reset.primary), secondary: summarize(bucket.reset.secondary) },
    lifetime: { primary: summarize(bucket.lifetime.primary), secondary: summarize(bucket.lifetime.secondary) },
    tokens: summarizeTokens(bucket.tokens),
    noRecallShare: bucket.noRecall.total ? bucket.noRecall.count / bucket.noRecall.total : null,
  };
}

// Prereg pick rule, tune split only: eligible on token budget and a sample floor, then max signal.
export function pickConfig(rows, a1TokenMedian) {
  const eligible = rows.filter((r) => {
    const tm = r.tune.tokens.median;
    return tm !== null && a1TokenMedian !== null && tm <= a1TokenMedian && r.tune.reset.primary.withContext >= 10;
  });
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => {
    const byMedian = (b.tune.reset.primary.median ?? -Infinity) - (a.tune.reset.primary.median ?? -Infinity);
    if (byMedian !== 0) return byMedian;
    const byMeanTokens = a.tune.tokens.mean - b.tune.tokens.mean;
    if (byMeanTokens !== 0) return byMeanTokens;
    return b.config.threshold - a.config.threshold;
  });
  return eligible[0].config;
}

// One Z1b arm, one config: Z1's fields plus addedEvents, the block-created-recently audit, tokensUnattributed.
export function emptyZ1bBucket() {
  return {
    reset: { primary: makeAcc(), secondary: makeAcc() },
    lifetime: { primary: makeAcc(), secondary: makeAcc() },
    tokens: [],
    tokensScored: [], // per-file only: parallel scored flags; fold ignores them
    intervalHasBlock: { count: 0, total: 0 },
    tokensUnattributed: 0,
    addedEvents: 0,
    blocksSent: 0,
    failuresSeen: 0,
    recalledCreatedWithin10Min: 0,
    recalledCreatedWithin10MinEligible: 0,
  };
}

export function foldZ1b(bucket, result) {
  foldAcc(bucket.reset.primary, result.reset.primary);
  foldAcc(bucket.reset.secondary, result.reset.secondary);
  foldAcc(bucket.lifetime.primary, result.lifetime.primary);
  foldAcc(bucket.lifetime.secondary, result.lifetime.secondary);
  bucket.tokens.push(...result.tokens);
  bucket.intervalHasBlock.count += result.intervalHasBlock.count;
  bucket.intervalHasBlock.total += result.intervalHasBlock.total;
  bucket.tokensUnattributed += result.tokensUnattributed;
  bucket.addedEvents += result.addedEvents;
  bucket.blocksSent += result.blocksSent;
  bucket.failuresSeen += result.failuresSeen;
  bucket.recalledCreatedWithin10Min += result.recalledCreatedWithin10Min;
  bucket.recalledCreatedWithin10MinEligible += result.recalledCreatedWithin10MinEligible;
}

export function renderZ1bBucket(bucket) {
  return {
    reset: { primary: summarize(bucket.reset.primary), secondary: summarize(bucket.reset.secondary) },
    lifetime: { primary: summarize(bucket.lifetime.primary), secondary: summarize(bucket.lifetime.secondary) },
    tokens: summarizeTokens(bucket.tokens),
    tokensUnattributed: bucket.tokensUnattributed,
    intervalShare: bucket.intervalHasBlock.total ? bucket.intervalHasBlock.count / bucket.intervalHasBlock.total : null,
    addedEvents: bucket.addedEvents,
    blocksSent: bucket.blocksSent,
    failuresSeen: bucket.failuresSeen,
    recalledCreatedWithin10Min: bucket.recalledCreatedWithin10Min,
    recalledCreatedWithin10MinEligible: bucket.recalledCreatedWithin10MinEligible,
  };
}

// Z1b pick rule (prereg "Split and tuning"): token budget, mean cap, and an addedEvents floor, then max signal.
export function pickConfigZ1b(rows, a1TokenMedian, a1TokenMean) {
  const eligible = rows.filter((r) => {
    const tm = r.tune.tokens.median;
    const mn = r.tune.tokens.mean;
    return (
      tm !== null && a1TokenMedian !== null && tm <= a1TokenMedian &&
      a1TokenMean !== null && mn <= 1.1 * a1TokenMean &&
      r.tune.addedEvents >= 10
    );
  });
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => {
    const byMedian = (b.tune.reset.primary.median ?? -Infinity) - (a.tune.reset.primary.median ?? -Infinity);
    if (byMedian !== 0) return byMedian;
    const byMeanTokens = a.tune.tokens.mean - b.tune.tokens.mean;
    if (byMeanTokens !== 0) return byMeanTokens;
    return b.config.threshold - a.config.threshold;
  });
  return eligible[0].config;
}
