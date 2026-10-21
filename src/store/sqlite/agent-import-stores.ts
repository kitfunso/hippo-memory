// The agent-memories import's stores on hippo.db: each scores by the caller's rules, its container writes wait the
// caller's lock wait, and a dry run's stand-in lives in a scratch folder deleted at close.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LossAversion } from '../../base/memory/memory.js';
import { outsideRequestStores } from '../../db/index.js';
import { isStoreBusy, type StoreWith } from '../port.js';
import type { AgentImport } from '../port/agent-import.js';
import { sqliteAgentImport } from './agent-import.js';
import { handlesOf, initStore } from './handles.js';
import { served } from './served.js';
import { inPortTerms } from './port-errors.js';
import { sqliteStore } from './store.js';

export type SqliteImportStore = StoreWith<'agentImport' | 'projectTags'>;

export interface SqliteImportStores {
  open(root: string, opts: { readonly busyWaitMs?: number }): SqliteImportStore;
  create(root: string): Promise<void>;
  standIn(): SqliteImportStore;
  isBusy<E>(err: E): boolean;
}

/** The opener a CLI verb hands the sync; `rules` are the invoking root's, which every store it opens scores by. */
export function sqliteImportStores(rules: LossAversion): SqliteImportStores {
  return {
    open: (root, { busyWaitMs }) => ({
      ...sqliteStore(root, rules),
      agentImport: served<AgentImport>(sqliteAgentImport(handlesOf(root, rules).on, busyWaitMs)),
    }),
    create: async (root) => inPortTerms(() => initStore(root)),
    standIn: () => standIn(rules),
    isBusy: isStoreBusy,
  };
}

function standIn(rules: LossAversion): SqliteImportStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hippo-agent-memories-'));
  // Its folder is deleted at close, so a request scope must not keep one of its handles open past that.
  outsideRequestStores(() => initStore(root));
  const store = unscoped(sqliteStore(root, rules));
  return {
    ...store,
    close: async () => {
      await store.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** `obj` with each method, its groups' too, opening its handles outside any request scope. */
function unscoped<T extends object>(obj: T): T {
  const out: Partial<T> = {};
  // SAFETY: Object.keys lists the object's own keys, which are keys of T.
  for (const key of Object.keys(obj) as (keyof T)[]) {
    const value = obj[key];
    // SAFETY: a wrapped method takes and answers what the method does, and a wrapped group has the group's keys.
    out[key] = (
      value instanceof Function
        ? (...args: never[]) => outsideRequestStores(() => value.apply(obj, args))
        : isPlainObject(value)
          ? unscoped(value)
          : value
    ) as T[keyof T];
  }
  // SAFETY: every own key of obj was copied or wrapped above.
  return out as T;
}

function isPlainObject<V>(value: V): value is V & object {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
