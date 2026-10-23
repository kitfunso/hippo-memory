// The SQL twins of the dashboard's live-row rules, which its reads and its sorted memory lists both filter by.
import { QUARANTINE_SCOPE_PREFIX } from './quarantine.js';

// SQL twins of isQuarantineScope and of the two halves of isLiveMemory, for columns under prefix `t`; substr compares
// bytes, as startsWith does, where LIKE would fold case.
export const quarantinedIn = (t: string): string =>
  `(${t}scope IS NOT NULL AND substr(${t}scope, 1, ${QUARANTINE_SCOPE_PREFIX.length}) = '${QUARANTINE_SCOPE_PREFIX}')`;
export const supersededIn = (t: string): string => `(${t}superseded_by IS NOT NULL AND ${t}superseded_by <> '')`;
export const kindIn = (t: string): string => `COALESCE(${t}kind, 'distilled')`;
const liveIn = (t: string): string =>
  `NOT ${supersededIn(t)} AND ${kindIn(t)} IN ('raw', 'distilled') AND NOT ${quarantinedIn(t)}`;
export const LIVE = liveIn('');

// Named parameters bound from one object: Node 22's node:sqlite skips every named slot, ?NNN too, on a positional bind.
export const IN_PROJECT = `tenant_id = :tenant AND origin_project IS :origin AND ${LIVE}`;

// The open conflicts of the tenant bound as :tenant whose members are both live.
export const OPEN_PAIRS =
  `open_pairs AS (SELECT mc.id AS id, mc.memory_a_id AS a, mc.memory_b_id AS b, ma.origin_project AS pa, ` +
  `mb.origin_project AS pb FROM memory_conflicts mc JOIN memories ma ON ma.id = mc.memory_a_id JOIN memories mb ` +
  `ON mb.id = mc.memory_b_id WHERE mc.status = 'open' AND ma.tenant_id = :tenant AND mb.tenant_id = :tenant ` +
  `AND ${liveIn('ma.')} AND ${liveIn('mb.')})`;
