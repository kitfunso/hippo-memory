#!/usr/bin/env node
// Z1 prompt-recall replay: docs/plans/2026-09-26-z1-prompt-recall.md, prereg in docs/evals/.
// Prints AGGREGATE NUMBERS ONLY: never transcript, prompt, error or memory text.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { mulberry32 } from './lib/prng.mjs';
import { loadStore, admittedAt, makeResolvers } from './z1-replay/stores.mjs';
import { sig, routine, buildIndices, makeMapBlock, idsFromRecall } from './z1-replay/si0.mjs';
import { selectA1, renderBlock, z1Candidates, computeZ1bBlock, selectZ1Static, selectZ1Recall } from './z1-replay/select.mjs';
import {
  makeAcc, record, setDiff, emptyBucket, fold, renderBucket, emptyZ1Bucket, foldZ1, renderZ1Bucket, pickConfig,
  emptyZ1bBucket, foldZ1b, renderZ1bBucket, pickConfigZ1b,
} from './z1-replay/stats.mjs';

const DIST = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..', 'dist');
const distImport = (f) => import(pathToFileURL(path.join(DIST, f)).href);
const [{ estimateTokens, blockHash }, { shouldSkipUnchanged }] = await Promise.all([distImport('util/token-text.js'), distImport('store/token-ledger.js')]);
const { contentTokens, promptTokens } = await distImport('core/prompt-recall.js');

const REFRESH_TURNS = 10;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { store: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--corpus') out.corpus = argv[++i];
    else if (a === '--global') out.global = argv[++i];
    else if (a === '--store') out.store.push(argv[++i]);
    else if (a === '--home') out.home = argv[++i];
    else if (a === '--mode') out.mode = argv[++i];
    else if (a === '--config') out.config = argv[++i];
    else if (a === '--split') out.split = argv[++i];
    else if (a === '--arm') out.arm = argv[++i];
    else if (a === '--judge-out') out.judgeOut = argv[++i];
    else if (a === '--since') out.since = argv[++i];
  }
  if (!out.arm) out.arm = 'z1';
  return out;
}

// Z1b tool-failure block: same LEADING_CD as src/capture/failure-reading.ts, its cd-stripping is query-only here.
const LEADING_CD = /^\s*(?:(?:cd|pushd)\b[^;&|]*(?:&&|\|\||;)\s*)+/;

// ---------------------------------------------------------------------------
// Judge items (Z1b)
// ---------------------------------------------------------------------------

function seededShuffle(arr, seed) {
  const rng = mulberry32(seed);
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// The newest |count| distinct ids A1 put in context, newest first (judge control C).
function buildControlC(a1OrderList, count, byId) {
  const seen = new Set();
  const out = [];
  for (let idx = a1OrderList.length - 1; idx >= 0 && out.length < count; idx--) {
    const id = a1OrderList[idx].id;
    if (seen.has(id)) continue;
    seen.add(id);
    const e = byId.get(id);
    if (e) out.push({ id, content: e.content, created: e.created });
  }
  return out;
}

// Judge items T (Z1b block) and C (control) for one eligible event; command/error not pre-collapsed for T's cap.
function buildJudgeEntries(eventId, cmd, err, tItems, maxItems, a1OrderList, byId, session) {
  const command = cmd.slice(0, 500);
  const error = err.slice(0, 1500);
  const tMems = tItems.slice(0, maxItems).map((it) => it.content.slice(0, 600));
  const cList = buildControlC(a1OrderList, Math.min(tItems.length, maxItems), byId);
  const entries = [{ eventId, arm: 'T', autoNo: false, command, error, memories: tMems, session }];
  if (cList.length === 0) {
    entries.push({ eventId, arm: 'C', autoNo: true, command, error, memories: [], session });
  } else {
    entries.push({ eventId, arm: 'C', autoNo: false, command, error, memories: cList.map((c) => c.content.slice(0, 600)), session });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Per-file replay
// ---------------------------------------------------------------------------

// Mutable per-file replay state: every step below reads and updates it, so it is passed whole.
function newFileState(filePath, mode, ctx, z1Configs, arm, collectJudge) {
  const scored = (t) => ctx.sinceMs == null || t >= ctx.sinceMs;
  const session = createHash('sha256').update(path.basename(filePath)).digest('hex').slice(0, 12);
  const runZ1 = mode === 'grid' || mode === 'final' || mode === 'selftest';
  const isZ1b = runZ1 && arm === 'z1b';
  const a0 = { reset: new Set(), lifetime: new Set() };
  const a1 = { reset: new Set(), lifetime: new Set(), te2: null };
  // One state per config: static block has its own TE2; recall is never skipped, so no TE2 state for it.
  const z1States = runZ1 && !isZ1b ? z1Configs.map(() => ({ reset: new Set(), lifetime: new Set(), teStatic: null })) : null;
  const z1FileAccs = runZ1 && !isZ1b ? z1Configs.map(() => emptyZ1Bucket()) : null;
  // Z1b state per config: A1's ids plus a tool-failure block; teBlock gates the block's own skip rule.
  const z1bStates = isZ1b
    ? z1Configs.map(() => ({ reset: new Set(), lifetime: new Set(), teBlock: null, lastSentItems: { items: [], ts: null }, pendingTokens: 0, intervalHasBlock: false, lastIntervalIdx: null }))
    : null;
  const z1bFileAccs = isZ1b ? z1Configs.map(() => emptyZ1bBucket()) : null;
  // A1's per-prompt injection order, oldest first, reset at compaction: judge control C reads from its tail.
  const a1Order = isZ1b ? [] : null;
  const judgeItems = [];

  const primary = { a0: { reset: makeAcc(), lifetime: makeAcc() }, a1: { reset: makeAcc(), lifetime: makeAcc() } };
  const secondary = { a0: { reset: makeAcc(), lifetime: makeAcc() }, a1: { reset: makeAcc(), lifetime: makeAcc() } };
  const tokensPerPrompt = [];
  const tokensPerPromptScored = [];

  const uses = new Map();
  const firstErr = new Map();
  const firstFail = new Map();
  return {
    ctx, z1Configs, collectJudge, scored, session, runZ1, isZ1b, a0, a1, z1States, z1FileAccs, z1bStates, z1bFileAccs, judgeItems,
    primary, secondary, tokensPerPrompt, tokensPerPromptScored, uses, firstErr, firstFail,
    // Reassigned while the file is read, so they live on the state and not in a local.
    a1Order, nonRoutineFailures: 0, pendingPrompt: null, lastCwd: null,
  };
}

// Returns what A1 sent for this prompt, so the Z1b arm can mirror it.
function sendA1Block(st, sel, isScored) {
  const { a1, tokensPerPrompt, tokensPerPromptScored } = st;
  let a1TokensThisPrompt = 0;
  let a1Sent = false;
  if (sel.items.length === 0) {
    tokensPerPrompt.push(0);
    tokensPerPromptScored.push(isScored);
  } else {
    const text2 = renderBlock(sel.items, sel.totalTokens);
    const hash = blockHash(text2);
    if (shouldSkipUnchanged(a1.te2, hash, REFRESH_TURNS)) {
      tokensPerPrompt.push(0);
      tokensPerPromptScored.push(isScored);
      a1.te2 = { hash, skipsSince: a1.te2.skipsSince + 1 };
    } else {
      a1TokensThisPrompt = estimateTokens(text2);
      tokensPerPrompt.push(a1TokensThisPrompt);
      tokensPerPromptScored.push(isScored);
      for (const it of sel.items) {
        a1.reset.add(it.id);
        a1.lifetime.add(it.id);
      }
      a1.te2 = { hash, skipsSince: 0 };
      a1Sent = true;
    }
  }
  return { a1TokensThisPrompt, a1Sent };
}

function openZ1bIntervals(st, sel, a1Sent, a1TokensThisPrompt, isScored) {
  const { z1Configs, z1bStates, z1bFileAccs, a1Order } = st;
  // Z1b arm = A1's own injections plus the tool-failure block; no prompt-gated recall of its own.
  if (a1Sent) {
    for (const it of sel.items) a1Order.push({ id: it.id });
  }
  z1Configs.forEach((gate, i) => {
    const s = z1bStates[i];
    const acc = z1bFileAccs[i];
    if (a1Sent) for (const it of sel.items) { s.reset.add(it.id); s.lifetime.add(it.id); }
    // Finalize the interval this prompt is closing: its blocks landed after it fired, before this new one.
    // Since gate: the interval is scored iff the prompt that opened it (acc.tokensScored[idx]) was scored.
    if (s.lastIntervalIdx !== null) {
      const intervalScored = acc.tokensScored[s.lastIntervalIdx];
      acc.tokens[s.lastIntervalIdx] += s.pendingTokens;
      if (intervalScored) {
        acc.intervalHasBlock.total++;
        if (s.intervalHasBlock) acc.intervalHasBlock.count++;
      }
    } else {
      acc.tokensUnattributed += s.pendingTokens; // blocks before this file's first hook prompt
    }
    acc.tokens.push(a1TokensThisPrompt);
    acc.tokensScored.push(isScored);
    s.lastIntervalIdx = acc.tokens.length - 1;
    s.pendingTokens = 0;
    s.intervalHasBlock = false;
  });
}

function sendZ1Blocks(st, sel, text, isScored) {
  const { z1Configs, z1States, z1FileAccs } = st;
  const promptTok = promptTokens(text);
  const precomputed = z1Candidates(sel.localAdm, sel.globalAdm, promptTok);
  // Static (pins) block is gate-independent: compute its text/tokens once, gate its TE2 send per config.
  const staticSel = selectZ1Static(sel.rankedPins);
  const staticText = renderBlock(staticSel.items, staticSel.totalTokens);
  const staticHash = staticSel.items.length > 0 ? blockHash(staticText) : null;

  z1Configs.forEach((gate, i) => {
    const state = z1States[i];
    const acc = z1FileAccs[i];
    let staticTokens = 0;
    if (staticSel.items.length > 0) {
      if (!shouldSkipUnchanged(state.teStatic, staticHash, REFRESH_TURNS)) {
        staticTokens = estimateTokens(staticText);
        for (const it of staticSel.items) { state.reset.add(it.id); state.lifetime.add(it.id); }
        state.teStatic = { hash: staticHash, skipsSince: 0 };
      } else {
        state.teStatic = { hash: staticHash, skipsSince: state.teStatic.skipsSince + 1 };
      }
    }

    const recallSel = selectZ1Recall(precomputed, promptTok, gate, sel.pinnedReserve);
    if (isScored) acc.noRecall.total++;
    let recallTokens = 0;
    if (recallSel.items.length > 0) {
      recallTokens = estimateTokens(renderBlock(recallSel.items, recallSel.totalTokens, 'Prompt-Relevant Memory'));
      for (const it of recallSel.items) { state.reset.add(it.id); state.lifetime.add(it.id); }
    } else {
      if (isScored) acc.noRecall.count++;
    }
    acc.tokens.push(staticTokens + recallTokens);
    acc.tokensScored.push(isScored);
  });
}

function fireHookPrompt(st, ts, cwd, text) {
  const { ctx, scored } = st;
  const { resolvers } = ctx;
  const isScored = scored(ts);
  const projectName = resolvers.projectNameFor(cwd);
  const localEntries = resolvers.localEntriesFor(cwd);
  const sel = selectA1(localEntries, ctx.globalEntries, ts, projectName);
  const { a1TokensThisPrompt, a1Sent } = sendA1Block(st, sel, isScored);
  if (st.isZ1b) openZ1bIntervals(st, sel, a1Sent, a1TokensThisPrompt, isScored);
  else if (st.runZ1) sendZ1Blocks(st, sel, text, isScored);
}

function resetAtCompaction(st) {
  const { a0, a1, z1States, z1bStates } = st;
  a0.reset.clear();
  a1.reset.clear();
  a1.te2 = null;
  if (z1States) for (const s of z1States) { s.reset.clear(); s.teStatic = null; }
  if (z1bStates) for (const s of z1bStates) { s.reset.clear(); s.teBlock = null; }
  if (st.a1Order) st.a1Order = [];
}

function replayHookAttachment(st, a) {
  const { a0 } = st;
  const { mapBlock } = st.ctx;
  const t = Array.isArray(a.content) ? a.content.join('\n') : String(a.content ?? '');
  const ids = mapBlock(t);
  ids.forEach((i) => { a0.reset.add(i); a0.lifetime.add(i); });
  if (a.type === 'hook_additional_context' && a.hookEvent === 'UserPromptSubmit' && st.pendingPrompt) {
    fireHookPrompt(st, st.pendingPrompt.ts, st.pendingPrompt.cwd, st.pendingPrompt.text);
    st.pendingPrompt = null;
  }
}

function snapshotArms(st) {
  const { a0, a1, runZ1, isZ1b, z1States, z1bStates } = st;
  return {
    a0: { reset: new Set(a0.reset), lifetime: new Set(a0.lifetime) },
    a1: { reset: new Set(a1.reset), lifetime: new Set(a1.lifetime) },
    z1: runZ1 && !isZ1b ? z1States.map((s) => ({ reset: new Set(s.reset), lifetime: new Set(s.lifetime) })) : null,
    z1b: isZ1b ? z1bStates.map((s) => ({ reset: new Set(s.reset), lifetime: new Set(s.lifetime) })) : null,
  };
}

function recordSecondary(st, snap, err) {
  const { secondary, runZ1, isZ1b, z1FileAccs, z1bFileAccs } = st;
  const { byId } = st.ctx;
  record(secondary.a0.reset, snap.a0.reset, err, byId);
  record(secondary.a0.lifetime, snap.a0.lifetime, err, byId);
  record(secondary.a1.reset, snap.a1.reset, err, byId);
  record(secondary.a1.lifetime, snap.a1.lifetime, err, byId);
  if (runZ1 && !isZ1b) snap.z1.forEach((s, i) => {
    record(z1FileAccs[i].reset.secondary, s.reset, err, byId);
    record(z1FileAccs[i].lifetime.secondary, s.lifetime, err, byId);
  });
  if (isZ1b) snap.z1b.forEach((s, i) => {
    record(z1bFileAccs[i].reset.secondary, s.reset, err, byId);
    record(z1bFileAccs[i].lifetime.secondary, s.lifetime, err, byId);
  });
}

function recordRepeatFailure(st, snap, cmd, err) {
  const { ctx, primary, runZ1, isZ1b, z1Configs, z1bStates, z1FileAccs, z1bFileAccs, a1Order, collectJudge, judgeItems, session } = st;
  const { byId } = ctx;
  record(primary.a0.reset, snap.a0.reset, err, byId);
  record(primary.a0.lifetime, snap.a0.lifetime, err, byId);
  record(primary.a1.reset, snap.a1.reset, err, byId);
  record(primary.a1.lifetime, snap.a1.lifetime, err, byId);
  if (runZ1 && !isZ1b) snap.z1.forEach((s, i) => {
    record(z1FileAccs[i].reset.primary, s.reset, err, byId);
    record(z1FileAccs[i].lifetime.primary, s.lifetime, err, byId);
  });
  if (isZ1b) snap.z1b.forEach((s, i) => {
    record(z1bFileAccs[i].reset.primary, s.reset, err, byId);
    record(z1bFileAccs[i].lifetime.primary, s.lifetime, err, byId);
    const added = [...s.reset].some((id) => !snap.a1.reset.has(id));
    if (added) {
      z1bFileAccs[i].addedEvents++;
      const sent = z1bStates[i].lastSentItems; // most recent block sent before this event's own injection
      const tItems = sent.items.slice(0, z1Configs[i].maxItems);
      for (const it of tItems) {
        const age = sent.ts - Date.parse(it.created); // age against the block's originating failure, not this repeat
        if (age >= 0 && age <= 10 * 60 * 1000) z1bFileAccs[i].recalledCreatedWithin10MinEligible++;
      }
      if (collectJudge) {
        const eventId = ctx.judgeEventCounter.n++;
        judgeItems.push(...buildJudgeEntries(eventId, cmd, err, tItems, z1Configs[i].maxItems, a1Order, byId, session));
      }
    }
  });
}

// Z1b tool-failure block: after the event is recorded, so it counts toward later repeats and fail-then-pass.
// The block's own computation/skip-state stays unconditional; only its accounting is since-gated.
function sendZ1bBlocks(st, o, cmd, err, ts, isScoredFailure) {
  const { ctx, z1Configs, z1bStates, z1bFileAccs, lastCwd } = st;
  const { resolvers } = ctx;
  const cwd = o.cwd || lastCwd;
  const tsMs = ts;
  const { localAdm, globalAdm } = admittedAt(resolvers, ctx.globalEntries, cwd, tsMs);
  const query = cmd.replace(LEADING_CD, '') + '\n' + err;
  const queryTok = contentTokens(query.slice(0, 4000));
  z1Configs.forEach((gate, i) => {
    const s = z1bStates[i];
    const acc = z1bFileAccs[i];
    if (isScoredFailure) acc.failuresSeen++;
    const blk = computeZ1bBlock(localAdm, globalAdm, queryTok, gate);
    if (blk.items.length === 0) return; // nothing clears the gate: no block, no skip-state change
    const idsKey = blk.items.map((it) => it.id).sort().join(',');
    if (shouldSkipUnchanged(s.teBlock, idsKey, REFRESH_TURNS)) {
      s.teBlock = { hash: idsKey, skipsSince: s.teBlock.skipsSince + 1 };
      return;
    }
    const tokens = estimateTokens(renderBlock(blk.items, blk.totalTokens, 'Failure-Relevant Memory'));
    for (const it of blk.items) { s.reset.add(it.id); s.lifetime.add(it.id); }
    s.teBlock = { hash: idsKey, skipsSince: 0 };
    s.lastSentItems = { items: blk.items, ts: tsMs };
    if (isScoredFailure) {
      s.pendingTokens += tokens;
      s.intervalHasBlock = true;
      acc.blocksSent++;
      for (const it of blk.items) {
        const age = tsMs - Date.parse(it.created);
        if (age >= 0 && age <= 10 * 60 * 1000) acc.recalledCreatedWithin10Min++;
      }
    }
  });
}

function replayFailure(st, o, cmd, txt, cs, snap) {
  const { scored, firstErr, firstFail, a1Order } = st;
  const err = txt.replace(/\s+/g, ' ').trim();
  if (routine(cmd, err)) return;
  const ts = Date.parse(o.timestamp);
  const isScoredFailure = scored(ts);
  if (isScoredFailure) st.nonRoutineFailures++;
  const es = sig(('Bash: ' + err).slice(0, 200));
  if (isScoredFailure) recordSecondary(st, snap, err);
  if (firstErr.has(es)) {
    if (isScoredFailure) recordRepeatFailure(st, snap, cmd, err);
  } else {
    firstErr.set(es, true);
  }
  // Snapshot A1's order now: a compaction before the eventual success must not change the judge's control C.
  if (!firstFail.has(cs)) firstFail.set(cs, { err, cmd, snap, ts, a1OrderSnapshot: a1Order ? a1Order.slice() : [] });

  if (st.isZ1b) sendZ1bBlocks(st, o, cmd, err, ts, isScoredFailure);
}

function replayPassAfterFailure(st, o, cs) {
  const { ctx, scored, a0, a1, primary, runZ1, isZ1b, z1Configs, z1States, z1bStates, z1FileAccs, z1bFileAccs } = st;
  const { firstFail, collectJudge, judgeItems, session } = st;
  const { byId } = ctx;
  const ff = firstFail.get(cs);
  const successTs = Date.parse(o.timestamp);
  if (scored(ff.ts) && scored(successTs)) {
    const dReset0 = setDiff(a0.reset, ff.snap.a0.reset);
    const dLife0 = setDiff(a0.lifetime, ff.snap.a0.lifetime);
    const dReset1 = setDiff(a1.reset, ff.snap.a1.reset);
    const dLife1 = setDiff(a1.lifetime, ff.snap.a1.lifetime);
    record(primary.a0.reset, dReset0, ff.err, byId);
    record(primary.a0.lifetime, dLife0, ff.err, byId);
    record(primary.a1.reset, dReset1, ff.err, byId);
    record(primary.a1.lifetime, dLife1, ff.err, byId);
    if (runZ1 && !isZ1b) z1States.forEach((s, i) => {
      const dReset = setDiff(s.reset, ff.snap.z1[i].reset);
      const dLife = setDiff(s.lifetime, ff.snap.z1[i].lifetime);
      record(z1FileAccs[i].reset.primary, dReset, ff.err, byId);
      record(z1FileAccs[i].lifetime.primary, dLife, ff.err, byId);
    });
    if (isZ1b) z1bStates.forEach((s, i) => {
      const dReset = setDiff(s.reset, ff.snap.z1b[i].reset);
      const dLife = setDiff(s.lifetime, ff.snap.z1b[i].lifetime);
      record(z1bFileAccs[i].reset.primary, dReset, ff.err, byId);
      record(z1bFileAccs[i].lifetime.primary, dLife, ff.err, byId);
      const added = [...dReset].some((id) => !dReset1.has(id));
      if (added) {
        z1bFileAccs[i].addedEvents++;
        const sent = s.lastSentItems; // live: no block fires on a success line
        const tItems = sent.items.slice(0, z1Configs[i].maxItems);
        for (const it of tItems) {
          const age = sent.ts - Date.parse(it.created); // age against the originating failure, not this success line
          if (age >= 0 && age <= 10 * 60 * 1000) z1bFileAccs[i].recalledCreatedWithin10MinEligible++;
        }
        if (collectJudge) {
          const eventId = ctx.judgeEventCounter.n++;
          judgeItems.push(...buildJudgeEntries(eventId, ff.cmd, ff.err, tItems, z1Configs[i].maxItems, ff.a1OrderSnapshot, byId, session));
        }
      }
    });
  }
  firstFail.delete(cs);
}

function replayToolBlock(st, o, b) {
  const { a0, uses, firstFail } = st;
  const { byId, mapBlock } = st.ctx;
  if (b.type === 'tool_use' && b.name === 'Bash') uses.set(b.id, String(b.input?.command ?? ''));
  if (b.type === 'tool_result' && uses.has(b.tool_use_id)) {
    const cmd = uses.get(b.tool_use_id);
    const txt = Array.isArray(b.content) ? b.content.map((x) => x.text ?? '').join(' ') : String(b.content ?? '');
    if (/\bhippo (recall|context)\b/.test(cmd)) {
      const ids = new Set([...idsFromRecall(byId, txt), ...mapBlock(txt)]);
      ids.forEach((i) => { a0.reset.add(i); a0.lifetime.add(i); });
      return;
    }
    const cs = sig(cmd);
    const snap = snapshotArms(st);
    if (b.is_error) replayFailure(st, o, cmd, txt, cs, snap);
    else if (firstFail.has(cs)) replayPassAfterFailure(st, o, cs);
  }
}

function closeLastZ1bIntervals(st) {
  const { z1bStates, z1bFileAccs } = st;
  // Include the final interval (blocks after the last hook prompt, to EOF); unattributed only if no prompt ever fired.
  z1bStates.forEach((s, i) => {
    const acc = z1bFileAccs[i];
    if (s.lastIntervalIdx !== null) {
      const intervalScored = acc.tokensScored[s.lastIntervalIdx];
      acc.tokens[s.lastIntervalIdx] += s.pendingTokens;
      if (intervalScored) {
        acc.intervalHasBlock.total++;
        if (s.intervalHasBlock) acc.intervalHasBlock.count++;
      }
    } else {
      acc.tokensUnattributed += s.pendingTokens;
    }
  });
}

function fileResult(st) {
  const { ctx, primary, secondary, tokensPerPrompt, tokensPerPromptScored, z1FileAccs, z1bFileAccs, judgeItems, nonRoutineFailures } = st;
  // --since: drop token entries for unscored prompts/intervals; no-op (arrays untouched) when sinceMs is unset.
  if (ctx.sinceMs != null) {
    const keepScored = (arr, flags) => arr.filter((_, idx) => flags[idx]);
    const filteredTokensPerPrompt = keepScored(tokensPerPrompt, tokensPerPromptScored);
    if (z1FileAccs) for (const acc of z1FileAccs) acc.tokens = keepScored(acc.tokens, acc.tokensScored);
    if (z1bFileAccs) for (const acc of z1bFileAccs) acc.tokens = keepScored(acc.tokens, acc.tokensScored);
    return { primary, secondary, tokensPerPrompt: filteredTokensPerPrompt, z1PerConfig: z1FileAccs, z1bPerConfig: z1bFileAccs, judgeItems, nonRoutineFailures };
  }
  return { primary, secondary, tokensPerPrompt, z1PerConfig: z1FileAccs, z1bPerConfig: z1bFileAccs, judgeItems, nonRoutineFailures };
}

async function processFile(filePath, mode, ctx, z1Configs, arm = 'z1', collectJudge = false) {
  const st = newFileState(filePath, mode, ctx, z1Configs, arm, collectJudge);
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }

    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      resetAtCompaction(st);
      continue;
    }

    const a = o.attachment;
    if (a && (a.type === 'hook_additional_context' || a.type === 'hook_success')) {
      replayHookAttachment(st, a);
      continue;
    }

    const promptText = o.message?.content;
    // String(x) === x holds only for string primitives; array content is a tool result, not a prompt.
    if (o.type === 'user' && !o.isMeta && String(promptText) === promptText) {
      st.pendingPrompt = { ts: Date.parse(o.timestamp), cwd: o.cwd, text: promptText };
    }
    if (o.cwd) st.lastCwd = o.cwd;

    const c = o?.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) replayToolBlock(st, o, b);
  }

  if (st.isZ1b) closeLastZ1bIntervals(st);
  return fileResult(st);
}

// ---------------------------------------------------------------------------
// Corpus walking + split
// ---------------------------------------------------------------------------

function walkCorpus(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(p);
    }
  }
  return out;
}

function splitOf(file) {
  const h = createHash('sha256').update(path.basename(file)).digest('hex');
  return parseInt(h.slice(0, 2), 16) % 2 === 0 ? 'tune' : 'heldout';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Judge export: shuffled, unlabelled main file plus a separate itemId -> {eventId, arm} key file.
function writeJudgeExport(filePath, rawItems) {
  const shuffled = seededShuffle(rawItems, 20260926);
  const items = shuffled.map((it, idx) => ({ itemId: idx, autoNo: it.autoNo, command: it.command, error: it.error, memories: it.memories }));
  const key = shuffled.map((it, idx) => ({ itemId: idx, eventId: it.eventId, arm: it.arm, autoNo: it.autoNo, session: it.session }));
  fs.writeFileSync(filePath, JSON.stringify({ seed: 20260926, items }, null, 2));
  fs.writeFileSync(`${filePath}.key.json`, JSON.stringify(key, null, 2));
}

function loadStores(args) {
  const globalEntries = loadStore(args.global);
  const storeMap = new Map();
  const namedEntries = [];
  for (const spec of args.store) {
    const eq = spec.indexOf('=');
    const root = path.resolve(spec.slice(0, eq));
    const dir = spec.slice(eq + 1);
    const entries = loadStore(dir);
    storeMap.set(root.toLowerCase(), entries);
    namedEntries.push(...entries);
  }
  return { globalEntries, storeMap, namedEntries };
}

function configsForMode(args, arm) {
  let z1Configs = null;
  if (args.mode === 'grid') {
    if (args.split !== 'tune') {
      console.error('grid mode requires --split tune');
      process.exit(1);
    }
    const jaccardT = [0.04, 0.06, 0.08, 0.1, 0.12];
    const cosineT = [0.1, 0.15, 0.2, 0.25, 0.3];
    z1Configs = [];
    for (const metric of ['jaccard', 'cosine']) {
      for (const threshold of metric === 'jaccard' ? jaccardT : cosineT) {
        for (const minShared of [2, 3]) {
          for (const maxItems of [3, 5]) {
            z1Configs.push({ metric, threshold, minShared, maxItems });
          }
        }
      }
    }
  } else if (args.mode === 'final') {
    z1Configs = [JSON.parse(args.config)];
  } else if (args.mode === 'selftest') {
    // Hidden wiring check: fixed config, first 3 tune files, counts only, never a scored run.
    z1Configs = arm === 'z1b'
      ? [{ metric: 'jaccard', threshold: 0.08, minShared: 2, maxItems: 3 }]
      : [{ metric: 'cosine', threshold: 0.2, minShared: 2, maxItems: 3 }];
  }
  return z1Configs;
}

function wantedFiles(args) {
  const files = walkCorpus(args.corpus);
  let wanted;
  if (args.mode === 'selftest') {
    wanted = files.filter((f) => splitOf(f) === 'tune').slice(0, 3);
  } else {
    wanted =
      args.split === 'tune' ? files.filter((f) => splitOf(f) === 'tune')
      : args.split === 'heldout' ? files.filter((f) => splitOf(f) === 'heldout')
      : files;
  }
  return wanted;
}

async function replayCorpus(wanted, args, ctx, z1Configs, arm) {
  const { sinceMs } = ctx;
  const buckets = { tune: emptyBucket(), heldout: emptyBucket(), all: emptyBucket() };
  const z1Buckets = z1Configs && arm !== 'z1b' ? z1Configs.map(() => ({ tune: emptyZ1Bucket(), heldout: emptyZ1Bucket(), all: emptyZ1Bucket() })) : null;
  const z1bBuckets = z1Configs && arm === 'z1b' ? z1Configs.map(() => ({ tune: emptyZ1bBucket(), heldout: emptyZ1bBucket(), all: emptyZ1bBucket() })) : null;
  const nonRoutineFailures = { tune: 0, heldout: 0, all: 0 };
  const judgeItems = [];
  const collectJudgeMode = args.mode === 'final' && arm === 'z1b' && !!args.judgeOut;
  const startedAt = Date.now();
  for (const f of wanted) {
    const label = splitOf(f);
    const collectJudge = collectJudgeMode && (sinceMs != null || label === 'heldout');
    const result = await processFile(f, args.mode, ctx, z1Configs, arm, collectJudge);
    fold(buckets[label], result);
    fold(buckets.all, result);
    nonRoutineFailures[label] += result.nonRoutineFailures;
    nonRoutineFailures.all += result.nonRoutineFailures;
    if (z1Buckets) {
      result.z1PerConfig.forEach((r, i) => {
        foldZ1(z1Buckets[i][label], r);
        foldZ1(z1Buckets[i].all, r);
      });
    }
    if (z1bBuckets) {
      result.z1bPerConfig.forEach((r, i) => {
        foldZ1b(z1bBuckets[i][label], r);
        foldZ1b(z1bBuckets[i].all, r);
      });
    }
    if (result.judgeItems.length) judgeItems.push(...result.judgeItems);
  }
  const runtimeMs = Date.now() - startedAt;
  return { buckets, z1Buckets, z1bBuckets, nonRoutineFailures, judgeItems, runtimeMs };
}

function printReport(args, arm, z1Configs, wanted, run, autoCapturedTotal) {
  const { buckets, z1Buckets, z1bBuckets, nonRoutineFailures, judgeItems, runtimeMs } = run;
  if (args.mode === 'a0') {
    console.log(JSON.stringify({
      mode: 'a0',
      filesProcessed: wanted.length,
      runtimeMs,
      tune: renderBucket(buckets.tune),
      heldout: renderBucket(buckets.heldout),
      all: renderBucket(buckets.all),
    }, null, 2));
  } else if (args.mode === 'grid' && arm === 'z1b') {
    const a1Tune = renderBucket(buckets.tune).A1;
    const rows = z1Configs.map((cfg, i) => ({ config: cfg, tune: renderZ1bBucket(z1bBuckets[i].tune) }));
    const pick = pickConfigZ1b(rows, a1Tune.tokens.median, a1Tune.tokens.mean);
    console.log(JSON.stringify({ mode: 'grid', arm: 'z1b', filesProcessed: wanted.length, runtimeMs, A1: a1Tune, rows, pick }, null, 2));
  } else if (args.mode === 'grid') {
    const a1Tune = renderBucket(buckets.tune).A1;
    const rows = z1Configs.map((cfg, i) => ({ config: cfg, tune: renderZ1Bucket(z1Buckets[i].tune) }));
    const pick = pickConfig(rows, a1Tune.tokens.median);
    console.log(JSON.stringify({ mode: 'grid', filesProcessed: wanted.length, runtimeMs, A1: a1Tune, rows, pick }, null, 2));
  } else if (args.mode === 'final' && arm === 'z1b') {
    const out = {
      mode: 'final', arm: 'z1b', filesProcessed: wanted.length, runtimeMs, config: z1Configs[0],
      since: args.since ?? null,
      datasetAudit: { autoCapturedTotal },
    };
    for (const split of ['tune', 'heldout', 'all']) {
      out[split] = {
        A1: renderBucket(buckets[split]).A1,
        Z1b: renderZ1bBucket(z1bBuckets[0][split]),
        nonRoutineFailures: nonRoutineFailures[split],
      };
    }
    console.log(JSON.stringify(out, null, 2));
    if (args.judgeOut) writeJudgeExport(args.judgeOut, judgeItems);
  } else if (args.mode === 'final') {
    const out = { mode: 'final', filesProcessed: wanted.length, runtimeMs, config: z1Configs[0] };
    for (const split of ['tune', 'heldout', 'all']) {
      out[split] = { A1: renderBucket(buckets[split]).A1, Z1: renderZ1Bucket(z1Buckets[0][split]) };
    }
    console.log(JSON.stringify(out, null, 2));
  } else if (args.mode === 'selftest' && arm === 'z1b') {
    const z1bAll = renderZ1bBucket(z1bBuckets[0].all);
    console.log(JSON.stringify({
      mode: 'selftest',
      arm: 'z1b',
      filesProcessed: wanted.length,
      hookPrompts: buckets.all.tokens.length,
      z1bEventsWithContext: z1bAll.reset.primary.withContext,
      addedEvents: z1bAll.addedEvents,
      z1bTokenMedian: z1bAll.tokens.median,
      failuresSeen: z1bAll.failuresSeen,
      blocksSent: z1bAll.blocksSent,
    }, null, 2));
  } else if (args.mode === 'selftest') {
    const z1All = renderZ1Bucket(z1Buckets[0].all);
    console.log(JSON.stringify({
      mode: 'selftest',
      filesProcessed: wanted.length,
      hookPrompts: buckets.all.tokens.length,
      z1EventsWithContext: z1All.reset.primary.withContext,
      z1TokenMedian: z1All.tokens.median,
    }, null, 2));
  } else {
    console.error(`unknown --mode ${args.mode}`);
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const home = path.resolve(args.home);
  const { globalEntries, storeMap, namedEntries } = loadStores(args);
  const { byId, byContent } = buildIndices([...globalEntries, ...namedEntries]);
  const mapBlock = makeMapBlock(byId, byContent);
  const resolvers = makeResolvers(home, storeMap);
  const arm = args.arm === 'z1b' ? 'z1b' : 'z1';
  const judgeEventCounter = { n: 0 };
  const sinceMs = args.since ? Date.parse(args.since) : null;
  if (Number.isNaN(sinceMs)) {
    console.error(`invalid --since ${args.since}`);
    process.exit(1);
  }
  const ctx = { byId, mapBlock, resolvers, globalEntries, judgeEventCounter, sinceMs };
  const autoCapturedTotal = [...globalEntries, ...namedEntries].filter((e) => e.tags.includes('auto-captured')).length;

  const z1Configs = configsForMode(args, arm);
  const wanted = wantedFiles(args);
  const run = await replayCorpus(wanted, args, ctx, z1Configs, arm);
  printReport(args, arm, z1Configs, wanted, run, autoCapturedTotal);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
