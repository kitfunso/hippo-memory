// hippo.db's EmbeddingIndex: sessions by id, each holding the lock and the rebuild it took,
// so a session stays on the thread that opened it. The model checks take the opener, since an
// unreadable index there reads as none.
import { randomUUID } from 'node:crypto';
import { closeHippoDb } from '../../db/index.js';
import { listEveryTenantEntryIds } from './entry-reads.js';
import type {
  EmbeddingIndex,
  IndexStep,
  IndexStepAnswers,
  IndexStepKind,
} from '../../base/ports/store/vectors.js';
import {
  type VectorRebuild,
  beginVectorRebuild,
  embeddingModelRequiresReindex,
  particleStats,
  pendingVectorIds,
  pruneOrphanVectors,
  resetStoredParticles,
  saveStoredEmbeddingModel,
  seedStoredParticle,
  storedVectorSummary,
  vectorCoverage,
} from './vector-index.js';
import type { Handles } from './open.js';
import { openStore } from './handles.js';
import { answered } from './bound.js';
import { dropVectorStaging, upsertVectors } from '../../db/vector-store.js';
import type { FileLock } from '../../host/file-lock.js';
import { embedLockKey, tryEmbedLock } from './embed-lock.js';

// The staged vectors live in a TEMP table, which only the handle that made it sees, so the rebuild
// keeps one open; a worker's handle outlives it, so the table is dropped too.
function beginRebuild(open: Handles['open']): VectorRebuild {
  const db = open();
  try {
    return beginVectorRebuild(db, () => {
      try {
        dropVectorStaging(db);
      } finally {
        closeHippoDb(db);
      }
    });
  } catch (err) {
    closeHippoDb(db);
    throw err;
  }
}

/** What a session took: the lock, and a rebuild begun and not yet committed. */
interface Session {
  lock: FileLock | null;
  rebuild: VectorRebuild | null;
}

type Steps = {
  readonly [K in IndexStepKind]: (session: Session, step: IndexStep<K>) => IndexStepAnswers[K];
};

function rebuildOf(session: Session): VectorRebuild {
  if (session.rebuild === null) throw new Error('no vector rebuild is open on this session');
  return session.rebuild;
}

function closeSession(session: Session): void {
  try {
    session.rebuild?.close();
  } finally {
    session.lock?.release();
  }
}

function rebuildSteps(
  open: Handles['open'],
  hippoRoot: string,
): Pick<Steps, 'lock' | 'begin' | 'stage' | 'commit' | 'close'> {
  return {
    lock: (session) => {
      session.lock ??= tryEmbedLock(hippoRoot);
      return session.lock !== null;
    },
    begin: (session) => {
      if (session.rebuild !== null) {
        throw new Error('a vector rebuild is already open on this session');
      }
      session.rebuild = beginRebuild(open);
    },
    stage: (session, { rows }) => rebuildOf(session).stage(rows),
    commit: (session, { model }) => {
      const rebuild = rebuildOf(session);
      session.rebuild = null;
      try {
        rebuild.commit(model);
      } finally {
        rebuild.close();
      }
    },
    close: closeSession,
  };
}

// A particle's start strength is scored, so seed and reset score by the store's loss-aversion
// rules.
function indexSteps({ on, open, files }: Handles): Steps {
  return {
    ...rebuildSteps(open, files.hippoRoot),
    reindex: (_, { providerId }) => embeddingModelRequiresReindex(on, providerId),
    saveModel: (_, { providerId }) => saveStoredEmbeddingModel(on, providerId),
    ids: (_, { page }) => on((db) => listEveryTenantEntryIds(db, page), openStore),
    pending: (_, { page }) => on((db) => pendingVectorIds(db, page)),
    save: (_, { rows, model }) => on((db) => upsertVectors(db, rows, model)),
    prune: () => on(pruneOrphanVectors),
    seed: (_, { entry, vector }) => on((db) => seedStoredParticle(db, files, entry, vector)),
    reset: () => on((db) => resetStoredParticles(db, files)),
    summary: () => on(storedVectorSummary),
    coverage: () => on(vectorCoverage, openStore),
    particles: (_, { fullUpTo }) => on((db) => particleStats(db, fullUpTo)),
  };
}

export function sqliteEmbeddingIndex(handles: Handles): EmbeddingIndex {
  const sessions = new Map<string, Session>();
  const steps = indexSteps(handles);
  const opened = (id: string): Session => {
    const session = sessions.get(id);
    if (session === undefined) throw new Error(`no open index session '${id}'`);
    return session;
  };
  return {
    open: () =>
      answered(() => {
        const id = randomUUID();
        sessions.set(id, { lock: null, rebuild: null });
        return { id, key: embedLockKey(handles.files.hippoRoot) };
      }),
    step: (id, step) =>
      answered(() => {
        const session = opened(id);
        if (step.kind === 'close') sessions.delete(id);
        return steps[step.kind](session, step);
      }),
  };
}
