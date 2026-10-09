// Each verb's flags as data, keyed like the command table: parseArgs needs a flag's kind before the verb's module loads.

// A value on a switch is refused, as `--fix=false` reads as on under Boolean() and `--pin=true` as off under === true.
export type FlagKind = 'switch' | 'value' | 'number' | 'list';

/** One verb's flags by kind: a number is refused unless numeric, and a list collects repeats. */
export interface VerbFlags {
  readonly switches?: readonly string[];
  readonly values?: readonly string[];
  readonly numbers?: readonly string[];
  readonly lists?: readonly string[];
}

// The entry point reads these for every verb, so no verb declares them.
const GLOBAL_FLAGS: VerbFlags = { switches: ['help', 'version'] };

export const VERB_FLAGS = {
  init: { switches: ['global', 'no-hooks', 'no-learn', 'no-schedule'], values: ['scan'], numbers: ['days'] },
  remember: {
    switches: ['error', 'extract', 'force', 'global', 'inferred', 'observed', 'pin', 'verified'],
    values: ['artifact-ref', 'kind', 'layer', 'owner', 'scope'],
    lists: ['tag'],
  },
  recall: {
    switches: ['classic', 'continuity', 'equal-sources', 'evc-adaptive', 'filter-conflicts', 'graph-stream',
      'include-superseded', 'json', 'multihop', 'no-mmr', 'physics', 'rerank-utility', 'value-aware', 'why'],
    values: ['as-of', 'budget', 'goal', 'graph-hops', 'graph-seeds', 'hops', 'layer', 'max-neighbors', 'outcome',
      'reranker', 'salience-threshold', 'scope', 'session-id'],
    numbers: ['limit', 'local-bump', 'min-results', 'mmr-lambda', 'reranker-top-k'],
  },
  drill: { switches: ['json'], values: ['budget', 'depth'], numbers: ['limit'] },
  assemble: { switches: ['json', 'no-summarize-older'], values: ['budget', 'fresh-tail', 'scope', 'session'] },
  supersede: { switches: ['pin'], values: ['layer'], lists: ['tag'] },
  explain: {
    switches: ['classic', 'equal-sources', 'include-superseded', 'json', 'no-mmr', 'physics'],
    values: ['as-of', 'budget', 'scope'],
    numbers: ['limit', 'local-bump', 'mmr-lambda'],
  },
  eval: {
    switches: ['bootstrap', 'equal-sources', 'json', 'no-mmr', 'save-baseline', 'show-cases', 'suite'],
    values: ['baseline', 'compare', 'out'],
    numbers: ['embedding-weight', 'local-bump', 'max-cases', 'min-mrr', 'mmr-lambda'],
  },
  trace: { switches: ['json'], values: ['outcome', 'session', 'source', 'steps', 'task'], lists: ['tag'] },
  refine: { switches: ['all', 'dry-run', 'json'], values: ['model'], numbers: ['limit'] },
  sleep: { switches: ['dry-run', 'no-learn', 'no-share'], values: ['log-file'] },
  'last-sleep': { switches: ['keep'], values: ['path'] },
  'session-end': {
    switches: ['dry-run', 'no-learn', 'no-share', 'turn'],
    values: ['format', 'log-file', 'runtime', 'session-id', 'transcript'],
  },
  '__session-end-worker': {
    switches: ['dry-run', 'no-learn', 'no-share', 'turn'],
    values: ['log-file', 'session-id', 'transcript'],
  },
  'pre-compact': { values: ['format', 'log-file', 'runtime'] },
  'post-compact': { values: ['log-file'] },
  'capture-error': { values: ['format', 'runtime'] },
  'compact-resume': {},
  'codex-run': {},
  '__codex-session-end-worker': { values: ['codex-home', 'history-path', 'log-file', 'start-offset', 'started-at'] },
  dedup: { switches: ['dry-run'], numbers: ['threshold'] },
  dag: { switches: ['stats'] },
  auth: { switches: ['all', 'global', 'json'], values: ['label', 'role', 'tenant'] },
  goal: {
    switches: ['all', 'no-propagate'],
    values: ['level', 'outcome', 'parent', 'policy', 'session-id', 'success', 'tenant-id'],
  },
  slack: { switches: ['force'], values: ['channel', 'since', 'team', 'tenant'] },
  github: { switches: ['force'], values: ['max', 'repo', 'since'] },
  audit: {
    switches: ['apply', 'dry-run', 'fix', 'global', 'json'],
    values: ['older-than', 'op', 'since', 'tenant'],
    numbers: ['limit'],
  },
  'correction-latency': { switches: ['json'] },
  provenance: { switches: ['json', 'strict'] },
  status: {},
  outcome: { switches: ['bad', 'good'], values: ['id'] },
  conflicts: { switches: ['json'], values: ['status'] },
  resolve: { switches: ['forget', 'reject-loser'], values: ['keep', 'reason'] },
  reject: { switches: ['global'], values: ['reason', 'value'] },
  rejections: { switches: ['global', 'json'] },
  unreject: { switches: ['global'] },
  dormant: { switches: ['global', 'json'], numbers: ['limit'] },
  projects: { switches: ['apply', 'global', 'json'] },
  quarantine: { switches: ['all', 'global', 'json'] },
  tokens: { switches: ['global', 'json'], numbers: ['days'] },
  failures: { switches: ['global', 'json'], numbers: ['days'] },
  doctor: { switches: ['json'] },
  'support-bundle': { switches: ['include-logs'], values: ['out'] },
  snapshot: { switches: ['json'], values: ['id', 'next-step', 'session', 'source', 'status', 'summary', 'task'] },
  session: {
    switches: ['json'],
    values: ['content', 'id', 'outcome', 'session', 'source', 'summary', 'task', 'type'],
    numbers: ['limit'],
  },
  handoff: {
    switches: ['json'],
    values: ['card-id', 'id', 'next', 'outcome', 'session', 'summary', 'target-runtime', 'task', 'tests'],
    lists: ['artifact', 'constraint'],
  },
  // Every card subcommand's flags together; card.ts then refuses the ones its subcommand does not read.
  card: {
    switches: ['json'],
    values: ['author', 'body', 'budget', 'contract', 'outcome', 'reason', 'repo', 'run', 'runtime', 'session',
      'status', 'title'],
    lists: ['depends-on'],
  },
  predict: {
    values: ['actual', 'class', 'estimate', 'note', 'state', 'status', 'target', 'unit'],
    numbers: ['limit'],
  },
  current: { switches: ['json'] },
  forget: { switches: ['archive', 'dry-run'], values: ['reason'] },
  inspect: {},
  context: {
    switches: ['auto', 'cross-project', 'pinned-only'],
    values: ['budget', 'format', 'framing', 'include-recent', 'runtime', 'scope'],
    numbers: ['limit'],
  },
  hook: {},
  setup: { switches: ['all', 'dry-run', 'no-learn', 'no-schedule'] },
  'daily-runner': {},
  embed: { switches: ['global', 'reset-physics', 'status'] },
  watch: {},
  learn: { switches: ['git'], values: ['repos'], numbers: ['days'] },
  promote: {},
  sync: { switches: ['cross-project'] },
  share: { switches: ['auto', 'dry-run', 'force'], numbers: ['min-score'] },
  peers: { switches: ['all-tenants'] },
  import: {
    switches: ['agents', 'dry-run', 'global'],
    values: ['chatgpt', 'claude', 'cursor', 'file', 'markdown', 'name', 'scope', 'vault'],
    lists: ['tag'],
  },
  export: { values: ['format'] },
  capture: { switches: ['dry-run', 'global', 'last-session', 'stdin'], values: ['file', 'log-file', 'transcript'] },
  dashboard: { numbers: ['port'] },
  wm: { switches: ['json'], values: ['content', 'importance', 'scope', 'session', 'task'], numbers: ['limit'] },
  mcp: {},
  serve: { values: ['host', 'tls-cert', 'tls-key'], numbers: ['port'] },
  invalidate: { switches: ['churn', 'dry-run'], values: ['id', 'reason'] },
  decide: { values: ['context', 'status', 'supersedes'], numbers: ['limit'] },
  incident: { values: ['context', 'resolution', 'status'], numbers: ['limit'], lists: ['link'] },
  process: { values: ['change', 'description', 'status'], numbers: ['limit'], lists: ['step'] },
  policy: { values: ['change', 'from', 'name', 'status', 'text', 'to'], numbers: ['limit'] },
  skill: { values: ['change', 'instructions', 'status', 'trigger'], numbers: ['limit'] },
  brief: { switches: ['dry-run'], values: ['change', 'repo', 'status', 'summary'], numbers: ['limit'] },
  note: { values: ['change', 'customer', 'status', 'text'], numbers: ['limit'] },
  graph: { switches: ['json', 'open'], values: ['entity', 'format', 'out'] },
} satisfies Record<string, VerbFlags>;

const FIELD_KINDS = [['switches', 'switch'], ['values', 'value'], ['numbers', 'number'], ['lists', 'list']] as const;

const DECLARED: ReadonlyMap<VerbFlags, ReadonlyMap<string, FlagKind>> = new Map(
  [GLOBAL_FLAGS, ...Object.values<VerbFlags>(VERB_FLAGS)].map((verb) => [
    verb,
    new Map(FIELD_KINDS.flatMap(([field, kind]) => (verb[field] ?? []).map((name): [string, FlagKind] => [name, kind]))),
  ]),
);

// A flag typed on a verb that does not declare it still has to parse: it takes the kind its
// declaring verbs agree on, and where they differ it is a plain value.
const SHARED_KIND: ReadonlyMap<string, FlagKind> = (() => {
  const shared = new Map<string, FlagKind>();
  for (const kinds of DECLARED.values()) {
    for (const [name, kind] of kinds) shared.set(name, (shared.get(name) ?? kind) === kind ? kind : 'value');
  }
  return shared;
})();

/** How parseArgs reads `--name` on the verb with these flags; `undefined` is a command the table lacks. */
export function flagKind(verb: VerbFlags | undefined, name: string): FlagKind {
  return (verb ? DECLARED.get(verb)?.get(name) : undefined) ?? SHARED_KIND.get(name) ?? 'value';
}

/** Whether any verb, or the entry point, reads `--name`. */
export function isKnownFlag(name: string): boolean {
  return SHARED_KIND.has(name);
}

/** The typed flags this verb does not read, in the order typed. */
export function undeclaredFlags(verb: VerbFlags, typed: readonly string[]): string[] {
  const declared = DECLARED.get(verb);
  const global = DECLARED.get(GLOBAL_FLAGS);
  return typed.filter((name) => !declared?.has(name) && !global?.has(name));
}
