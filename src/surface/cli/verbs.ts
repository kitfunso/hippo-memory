// Every CLI verb, one row each: dispatch, flags, help and the help listing's order all read this table.

import { MEMORY_VERBS } from './verbs/memory.js';
import { HEALTH_VERBS } from './verbs/health.js';
import { SESSION_VERBS } from './verbs/sessions.js';
import { OBJECT_VERBS } from './verbs/objects.js';
import { OPTIONAL_GROUPS, type OptionalGroup } from '../../base/ports/store.js';
import { StoreNotPortedError } from '../../base/util/store-blocked.js';
import type { VerbRow } from './verb-row.js';

export const COMMANDS = { ...MEMORY_VERBS, ...HEALTH_VERBS, ...SESSION_VERBS, ...OBJECT_VERBS };

/** A store as the CLI knows it before opening it: its kind and the optional groups it sets. */
export interface ServedGroups {
  readonly kind: string;
  readonly groups: readonly OptionalGroup[];
}

/** The store the CLI opens: hippo.db, which sets every optional group. */
export const CLI_STORE: ServedGroups = { kind: 'sqlite', groups: OPTIONAL_GROUPS };

/** Throws the StoreNotPortedError an unported path throws when `store` lacks a group the verb needs; main asks before
 * the verb opens anything. */
export function assertVerbPorted(row: VerbRow, store: ServedGroups): void {
  const missing = row.needs?.find((group) => !store.groups.includes(group));
  if (missing !== undefined) throw new StoreNotPortedError(store.kind, missing);
}
