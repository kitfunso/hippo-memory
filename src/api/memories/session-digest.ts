// The session digest's write: which sessions earn one, the text the echo filters leave, and one row
// per session.
import type { HippoConfig } from '../../base/config/config.js';
import { RejectedValueError } from '../../base/errors/api-errors.js';
import { createMemory, Layer, type MemoryEntry } from '../../base/memory/entry.js';
import { SESSION_DIGEST_TAG, sessionDigestId } from '../../base/session/session-digest-row.js';
import { SNAPSHOT_AMBIENT_MAX_AGE_MS } from '../../base/session/session-snapshot.js';
import { buildSessionDigest } from '../../domain/learn/session-digest.js';
import type { StoreWith } from '../../base/ports/store.js';
import { READ_PAGE_ROWS } from '../../base/util/pages.js';
import type { Context } from '../types.js';

/** The repo store's reads and the digest's write. */
export type DigestStore = Pick<StoreWith<'sessions'>, 'entriesWhere' | 'hippoDb' | 'entryWrites'>;

/** Where a digest writes: the repo's own store, its tenant and config, and the actor its audit
 * names. */
export type DigestContext = Pick<Context, 'tenantId' | 'actor'> & {
  readonly store: DigestStore;
  readonly config: Pick<HippoConfig, 'defaultHalfLifeDays'>;
};

/** The repo's paths as the disk has them; the surface reads them, so the api names no file
 * system. */
export interface DigestRepo {
  /** The repo folder with links followed, or null when it sits on a network path. */
  root(): string | null;
  /** `p` relative to `root` with forward slashes, '' for the root itself, null outside it or
   * when it cannot resolve. */
  relative(p: string, root: string): string | null;
  /** The files the session's edits changed inside `root`, repo-relative, each once. */
  changedFiles(root: string): string[];
}

/** One ended session as the digest reads it. */
export interface SessionDigestRequest {
  /** Session id, or the transcript's basename when the host gives none. */
  readonly key: string;
  readonly prompts: readonly string[];
  readonly finalText: string;
  /** The first working folder the transcript names: where the session ran. */
  readonly cwd: string | null;
  readonly editCount: number;
  readonly repo: DigestRepo;
  /** The instant the digest is stamped with. */
  readonly now: Date;
}

export interface DigestOutcome {
  written: boolean;
  reason: string;
  sentences: number;
  files: number;
}

function skipped(reason: string): DigestOutcome {
  return { written: false, reason, sentences: 0, files: 0 };
}

/** What hippo could have injected into the session: the newest live digests (prompt recall
 * reaches older ones too, but the echo filter only needs the recent ones a session most likely
 * saw) and the ambient handoff, never this session's own. */
async function injectedTexts(ctx: DigestContext, key: string): Promise<string[]> {
  const filter = {
    tenantId: ctx.tenantId,
    source: SESSION_DIGEST_TAG,
    tag: SESSION_DIGEST_TAG,
    live: true,
  } as const;
  const { entries } = await ctx.store.entriesWhere(filter, {
    limit: READ_PAGE_ROWS,
    newest: true,
  });
  const digests = entries
    .filter((e) => !e.extractedFrom && e.sourceSessionId !== key)
    .map((e) => e.content);
  const handoff = await ctx.store.hippoDb.sessions.read(
    ctx.tenantId,
    'handoff',
    {
      sessionId: null,
      unfinishedOnly: true,
      maxAgeMs: SNAPSHOT_AMBIENT_MAX_AGE_MS,
      scopeFilter: 'default-deny',
      excludeSessionId: key,
    },
    null,
  );
  if (!handoff) return digests;
  return [
    ...digests,
    [handoff.taskId, handoff.summary, handoff.nextAction].filter(Boolean).join('\n'),
  ];
}

/** The reason a session earns no digest, in the order the checks run, else the repo root it ran
 * in. */
function skipReason(req: SessionDigestRequest): { reason: string } | { root: string } {
  if (req.prompts.length === 0) return { reason: 'no human prompt' };
  if (!req.finalText.trim() && req.editCount === 0) {
    return { reason: 'no final message and no edits' };
  }
  if (!req.cwd) return { reason: 'the transcript names no working directory' };
  const root = req.repo.root();
  if (root === null) return { reason: 'the repo is on a network path' };
  if (req.repo.relative(req.cwd, root) === null) {
    return { reason: 'the session ran outside this repo' };
  }
  return { root };
}

/** Writes the session's digest row, keyed on the session so a second run updates it; a rejected
 * value skips. */
export async function writeSessionDigest(
  ctx: DigestContext,
  req: SessionDigestRequest,
): Promise<DigestOutcome> {
  const gate = skipReason(req);
  if ('reason' in gate) return skipped(gate.reason);
  const { root } = gate;
  const draft = buildSessionDigest({
    finalText: req.finalText,
    echoTexts: [...req.prompts, ...(await injectedTexts(ctx, req.key))],
    files: req.repo.changedFiles(root),
    relativePath: (p) => req.repo.relative(p, root),
  });
  if (!draft) return skipped('nothing left after the filters');
  const entry: MemoryEntry = {
    ...createMemory(
      draft.content,
      {
        layer: Layer.Episodic,
        tags: [SESSION_DIGEST_TAG],
        source: SESSION_DIGEST_TAG,
        confidence: 'observed',
        sourceSessionId: req.key,
        tenantId: ctx.tenantId,
        baseHalfLifeDays: ctx.config.defaultHalfLifeDays,
      },
      req.now,
    ),
    id: sessionDigestId(ctx.tenantId, req.key),
  };
  try {
    await ctx.store.entryWrites.writeEntry({ entry, actor: ctx.actor.subject });
  } catch (err) {
    if (err instanceof RejectedValueError) return skipped('it matches a rejected value');
    throw err;
  }
  return { written: true, reason: '', sentences: draft.sentences, files: draft.files };
}
