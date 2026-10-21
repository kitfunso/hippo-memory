// The in-memory LessonWrites group: git learn's word and tag reads and its batch writes.
import { RejectedValueError } from '../../base/errors/api-errors.js';
import { ownScopeTouches, passesScopeFilterForRecall } from '../../base/scope/recall-scope.js';
import type { LessonWrites } from '../port/lesson-writes.js';
import type { HeldText } from '../port/types.js';
import { bumpCounter } from './rows.js';
import { put, refusalEvent, stage } from './staged.js';
import type { MemoryTables } from './tables.js';

// The CLI's actor, which hippo.db's batch write names when its caller gives none.
const CLI_ACTOR = 'cli';

/** As hippo.db's instr: a case-sensitive substring of the content, among rows the caller may touch. */
function textsHoldingIn(t: MemoryTables, tenantId: string, words: readonly string[], ownScope: string | null) {
  const wanted = [...new Set(words)];
  const held = [...t.entries.values()].filter(
    (e) =>
      e.tenantId === tenantId &&
      ownScopeTouches(ownScope, e.scope ?? null) &&
      wanted.some((word) => e.content.includes(word)),
  );
  return held.map((e): HeldText => ({ content: e.content, source: e.source, originProject: e.originProject ?? null }));
}

/** Team-visible rows tagged exactly `tag`; with `origins`, those projects' rows and user-global ones. */
function contentsWithTagIn(t: MemoryTables, tenantId: string, tag: string, origins?: readonly string[]): string[] {
  const inOrigins = (origin: string | null): boolean =>
    origins === undefined || (origin !== null && (origin === '' || origins.includes(origin)));
  const tagged = [...t.entries.values()].filter(
    (e) =>
      e.tenantId === tenantId &&
      e.tags.includes(tag) &&
      inOrigins(e.originProject ?? null) &&
      passesScopeFilterForRecall(e.scope ?? null, undefined),
  );
  return tagged.map((e) => e.content);
}

/** One staged write; a refused value leaves its refusal row in order and the rest of the batch goes on. */
function writeSkippingIn(
  t: MemoryTables,
  entries: Parameters<LessonWrites['writeSkippingRejected']>[0],
  actor: string,
) {
  return stage(t, actor, (tx) =>
    entries.flatMap((entry) => {
      try {
        put(t, tx, entry, actor);
        return [entry.id];
      } catch (err) {
        if (!(err instanceof RejectedValueError)) throw err;
        tx.audit.push(refusalEvent(err, actor));
        return [];
      }
    }),
  );
}

export function memoryLessonWrites(t: MemoryTables): LessonWrites {
  return {
    textsHoldingWords: async (tenantId, words, ownScope) => textsHoldingIn(t, tenantId, words, ownScope),
    contentsWithTag: async (tenantId, tag, origins) => contentsWithTagIn(t, tenantId, tag, origins),
    writeSkippingRejected: async (entries, actor) => writeSkippingIn(t, entries, actor),
    async writeTogether(entries) {
      if (entries.length === 0) return;
      stage(t, CLI_ACTOR, (tx) => {
        for (const entry of entries) put(t, tx, entry, CLI_ACTOR);
      });
    },
    bumpRemembered: async (count) => bumpCounter(t, 'total_remembered', count),
  };
}
