// The queries of the ranker floor check, the stage list each one asks for, and which arm can run which stage.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const MICRO_DIR = join(REPO_ROOT, 'benchmarks', 'micro');

// The pre-registration fixes the corpus, so a changed fixture set stops the run.
export const MICRO_FIXTURE_COUNT = 13;
export const MICRO_QUERY_COUNT = 33;
export const WINDOW_QUERY_COUNT = 5;

export const ARMS = ['A', 'B', 'C'] as const;
export type Arm = (typeof ARMS)[number];
export const ARM_LABEL = { A: 'CLI core', B: 'HTTP SQL BM25', C: 'MCP showRanked' } satisfies Record<Arm, string>;

/** The post-ranking stages one query asks for. Every arm is handed this same list. */
export interface StageList {
  readonly sessionId?: string;
  readonly goalTag?: string;
  readonly salienceThreshold?: number;
  readonly valueAware?: true;
  readonly rerankUtility?: true;
  readonly evcAdaptive?: true;
  readonly filterConflicts?: true;
  readonly reranker?: 'cross-encoder';
  readonly includeSuperseded?: true;
}

export type Stage = keyof StageList;

export const STAGE_LABEL = {
  sessionId: 'goal boost (session stack)',
  goalTag: 'goal boost (named tag)',
  salienceThreshold: 'salience threshold',
  valueAware: 'value-aware',
  rerankUtility: 'utility rerank',
  evcAdaptive: 'EVC',
  filterConflicts: 'conflict filter',
  reranker: 'cross-encoder reranker',
  includeSuperseded: 'include-superseded',
} satisfies Record<Stage, string>;

export const ALL_STAGES =
  // SAFETY: STAGE_LABEL satisfies Record<Stage, string>, so its keys are exactly the stages.
  Object.keys(STAGE_LABEL) as Stage[];

// What `retrieve()` can be asked for under each ranker: `cliCore.rank` takes the whole list, the other two a session id only.
const RUNS = {
  A: new Set<Stage>(ALL_STAGES),
  B: new Set<Stage>(['sessionId']),
  C: new Set<Stage>(['sessionId']),
} satisfies Record<Arm, ReadonlySet<Stage>>;

/** The stages of `stages` this arm cannot run; a query with any counts as a fail for the arm and is never sent to it. */
export function stagesNotRun(arm: Arm, stages: StageList): Stage[] {
  return ALL_STAGES.filter((s) => stages[s] !== undefined && !RUNS[arm].has(s));
}

export interface GoalPush { readonly name: string; readonly sessionId: string }

export interface EvalQuery {
  readonly id: string;
  readonly corpus: 'micro' | 'window';
  readonly fixture: string;
  readonly text: string;
  readonly topK: number;
  readonly mustContainAny: readonly string[];
  readonly mustNotContainAny: readonly string[];
  readonly stages: StageList;
  /** The CLI's token budget, which only the CLI core reads. */
  readonly budget: number;
  readonly cwdSubdir?: string;
  /** Goals pushed in the query's own copy of the store, ahead of the recall. */
  readonly goalPushes: readonly GoalPush[];
}

export type RememberItem = string | { text: string; tags?: string[]; cwd_subdir?: string };

export interface FixtureAction {
  type: string;
  remember_index?: number;
  new_content?: string;
  good?: number;
  bad?: number;
  query?: string;
  times?: number;
  cwd_subdir?: string;
  reason?: string;
  reattempt?: boolean;
}

interface FixtureQuery {
  q: string;
  must_contain_any: string[];
  must_not_contain_any?: string[];
  top_k?: number;
  cli_args?: string[];
  cwd_subdir?: string;
  pre_actions?: { op: string; name?: string; session_id?: string }[];
}

export interface MicroFixture {
  name: string;
  remembers: RememberItem[];
  actions?: FixtureAction[];
  queries: FixtureQuery[];
}

export interface LoadedFixture { readonly fixture: MicroFixture; readonly queries: readonly EvalQuery[] }

// run.py puts this ahead of a fixture's own flags, so a fixture's --budget overrides it.
const RUN_PY_BUDGET = 4000;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface ParsedArgs { readonly stages: StageList; readonly budget: number }

/** A fixture's `cli_args` as a stage list. A flag with no entry here throws: a stage dropped in silence would score an easier query. */
export function parseCliArgs(args: readonly string[], where: string): ParsedArgs {
  const stages: Mutable<StageList> = {};
  let budget = RUN_PY_BUDGET;
  const valueOf = (i: number): string => {
    const value = args[i + 1];
    if (value === undefined) throw new Error(`${where}: ${args[i]} needs a value`);
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--evc-adaptive': stages.evcAdaptive = true; break;
      case '--filter-conflicts': stages.filterConflicts = true; break;
      case '--include-superseded': stages.includeSuperseded = true; break;
      case '--rerank-utility': stages.rerankUtility = true; break;
      case '--value-aware': stages.valueAware = true; break;
      case '--session-id': stages.sessionId = valueOf(i++); break;
      case '--goal': stages.goalTag = valueOf(i++); break;
      case '--salience-threshold': stages.salienceThreshold = positive(valueOf(i++), where); break;
      case '--budget': budget = positive(valueOf(i++), where); break;
      case '--reranker': {
        const name = valueOf(i++);
        if (name !== 'cross-encoder') throw new Error(`${where}: reranker ${name} is not one the pre-registration names`);
        stages.reranker = name;
        break;
      }
      default: throw new Error(`${where}: flag ${args[i]} has no stage in this harness`);
    }
  }
  return { stages, budget };
}

function positive(raw: string, where: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${where}: ${raw} is not a positive number`);
  return n;
}

/** Every micro fixture in run.py's order (file name), with its queries as stage lists. */
export function loadMicroFixtures(): LoadedFixture[] {
  const dir = join(MICRO_DIR, 'fixtures');
  const loaded = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((file): LoadedFixture => {
    const fixture: MicroFixture = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    return { fixture, queries: fixture.queries.map((q, i) => microQuery(fixture.name, q, i)) };
  });
  const queries = loaded.reduce((n, f) => n + f.queries.length, 0);
  if (loaded.length !== MICRO_FIXTURE_COUNT || queries !== MICRO_QUERY_COUNT) {
    throw new Error(`the micro corpus is ${loaded.length} fixtures and ${queries} queries; the pre-registration fixes ${MICRO_FIXTURE_COUNT} and ${MICRO_QUERY_COUNT}`);
  }
  return loaded;
}

function microQuery(fixture: string, q: FixtureQuery, index: number): EvalQuery {
  const id = `${fixture}#${index + 1}`;
  const { stages, budget } = parseCliArgs(q.cli_args ?? [], id);
  const goalPushes = (q.pre_actions ?? []).map((pa): GoalPush => {
    if (pa.op !== 'goal_push') throw new Error(`${id}: unknown pre_action op ${pa.op}`);
    if (!pa.name || !pa.session_id) throw new Error(`${id}: goal_push needs name and session_id`);
    return { name: pa.name, sessionId: pa.session_id };
  });
  // run.py hands the recall the --session-id flag, else the first pushed goal's session through HIPPO_SESSION_ID.
  const sessionId = stages.sessionId ?? goalPushes[0]?.sessionId;
  return {
    id,
    corpus: 'micro',
    fixture,
    text: q.q,
    topK: q.top_k ?? 5,
    mustContainAny: q.must_contain_any,
    mustNotContainAny: q.must_not_contain_any ?? [],
    stages: sessionId === undefined ? stages : { ...stages, sessionId },
    budget,
    cwdSubdir: q.cwd_subdir,
    goalPushes,
  };
}

export interface Judged { readonly passed: boolean; readonly matched: string | null; readonly leaked: string | null }

/** run.py's pass rule over the top `topK` rows: one wanted string present, no forbidden string present. */
export function judge(q: EvalQuery, texts: readonly string[]): Judged {
  const joined = texts.slice(0, q.topK).join(' || ').toLowerCase();
  const matched = q.mustContainAny.find((s) => joined.includes(s.toLowerCase())) ?? null;
  const leaked = q.mustNotContainAny.find((s) => joined.includes(s.toLowerCase())) ?? null;
  return { passed: matched !== null && leaked === null, matched, leaked };
}
