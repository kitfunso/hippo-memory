// An override's rule options replace the ones before it, so each folder's list is built here from
// the shared entries below; a message changes in one place.
import { defineConfig } from 'oxlint';

interface Restricted {
  readonly object?: string;
  readonly property: string;
  readonly message: string;
}
interface ImportPattern {
  readonly regex: string;
  readonly importNames?: string[];
  readonly message: string;
}
type Some<T> = [T, ...T[]];

const restrict = (...entries: Some<Restricted>): ['error', ...Some<Restricted>] => ['error', ...entries];
const importPatterns = (...patterns: ImportPattern[]): ['error', { patterns: ImportPattern[] }] => [
  'error',
  { patterns },
];

const STORE_ON = { property: 'sqliteStoreOn', message: 'Take the store from a composition root.' };
const ENV = {
  object: 'process',
  property: 'env',
  message: 'Read the environment through src/base/util/env.ts.',
};
const PROCESS = {
  object: 'globalThis',
  property: 'process',
  message: 'Name the process global, so the env rule sees it.',
};
const PREPARE = {
  property: 'prepare',
  message: 'SQL runs in src/db and src/store; reach the database through the port.',
};
const RECORD_AS_NAMES = ['bumpRecallStats', 'noteRecall', 'lastShown'];
const RECORD_AS = RECORD_AS_NAMES.map((property) => ({
  property,
  message: 'Pass recordAs to retrieve(); src/api/recall/finish.ts records it.',
}));

// Matches the identifier `ctx` only; a store reached as `r.ctx.store` or `cli.store()` is not seen.
const CTX_STORE = {
  object: 'ctx',
  property: 'store',
  message: 'Pass the context to a src/api function; only a composition root reads its store.',
};

const SRC: Some<Restricted> = [STORE_ON, ENV, PROCESS, PREPARE];
const SURFACE_ROOT: Some<Restricted> = [...SRC, ...RECORD_AS];
const SURFACE: Some<Restricted> = [...SURFACE_ROOT, CTX_STORE];
const CLI_ONLY: Some<Restricted> = [
  {
    property: 'finishRecall',
    message: 'The CLI recalls through retrieveWithCliCore(), which writes every recall row.',
  },
  {
    property: 'writeEntry',
    message: 'A CLI verb changes rows through a src/api function that takes the Context.',
  },
];
const CLI_ROOT: Some<Restricted> = [...SURFACE_ROOT, ...CLI_ONLY];
const CLI: Some<Restricted> = [...SURFACE, ...CLI_ONLY];
const CLI_NAMES: Some<string> = [
  'sqliteStoreOn',
  ...RECORD_AS_NAMES,
  'rankRecall',
  'resolveTenantId',
  'finishRecall',
  'writeEntry',
];

const OPEN_HIPPO_DB = {
  regex: '(^|/)(open|index)[.]js$',
  importNames: ['openHippoDb', 'openHippoDbReadOnly'],
  message:
    "A hippo.db open in src goes through its store's DbGrant (src/db/grant.ts); openHippoDb is the unscoped connection for scripts and tests.",
};
const CONNECT = {
  regex: '(^|/)connect[.]js$',
  importNames: ['connectWithFacts'],
  message: "A hippo.db connection in src goes through its store's DbGrant (src/db/grant.ts).",
};
const SESSION_OPEN = {
  regex: '(^|/)request-stores[.]js$',
  importNames: ['SESSION_OPEN'],
  message: "A session's hippo.db handle is opened through its store's DbGrant (src/db/grant.ts).",
};
const DATABASE_SYNC = {
  regex: '(^|/)sqlite[.]js$',
  importNames: ['DatabaseSync'],
  message:
    "A SQLite connection in src is made in src/db/connect.ts, open.ts or grant.ts; reach hippo.db through its store's DbGrant.",
};

export default defineConfig({
  ignorePatterns: [
    '.agent/**',
    '.agents/**',
    '.claude/**',
    '.codex/**',
    '.context/**',
    '.continue/**',
    '.cursor/**',
    '.gemini/**',
    '.hippo/**',
    '.opencode/**',
    '.pi/**',
    '.roo/**',
    '.windsurf/**',
    'dist/**',
    'docs/brand/**',
    'dist-bench/**',
    'dist-ui/**',
    'ui/dist/**',
    'tools/oxlint/anti-slop/**',
  ],
  jsPlugins: [
    { name: 'anti-slop', specifier: './tools/oxlint/anti-slop/index.ts' },
    { name: 'boundaries', specifier: './tools/oxlint/boundaries/index.mjs' },
  ],
  plugins: ['typescript', 'unicorn', 'oxc', 'import'],
  rules: {
    'anti-slop/no-chained-type-assertions': 'error',
    'anti-slop/no-conditional-empty-object-spread': 'error',
    'anti-slop/no-known-value-widening': 'error',
    'anti-slop/no-module-mocking': 'error',
    'anti-slop/no-object-parameters': 'error',
    'anti-slop/no-reflect-apply': 'error',
    'anti-slop/no-reflect-get': 'error',
    'anti-slop/no-runtime-typeof': ['error', { allowInTypeGuards: true }],
    'anti-slop/no-shape-in-symbol-names': 'error',
    'anti-slop/no-unknown-parameters': 'error',
    'anti-slop/no-unknown-returns': 'error',
    'anti-slop/no-unknown-type-aliases': 'error',
    'anti-slop/no-unsafe-dictionary-type': 'error',
    'anti-slop/no-widen-then-assert': 'error',
    'anti-slop/require-safety-comment-for-type-assertion': 'error',
    curly: ['error', 'multi-line'],
    'no-useless-concat': 'error',
    'unicorn/prefer-node-protocol': 'error',
  },
  overrides: [
    {
      files: ['src/**/*.ts'],
      rules: {
        'import/no-cycle': ['error', { ignoreTypes: true }],
        'anti-slop/require-safety-comment-for-type-assertion': ['error', { allowStatementReads: true }],
        'max-params': ['error', { max: 5 }],
        'boundaries/max-signature-params': 'error',
        'max-lines-per-function': ['error', { max: 50 }],
        'max-lines': ['error', { max: 800 }],
        'id-denylist': ['error', 'sqliteStoreOn'],
        'no-restricted-properties': restrict(...SRC),
        'unicorn/no-process-exit': 'error',
        'boundaries/no-hand-transaction': 'error',
        'boundaries/no-twin-function': 'error',
      },
    },
    {
      files: ['src/db/**/*.ts', 'src/store/**/*.ts'],
      rules: {
        'no-restricted-properties': restrict(STORE_ON, ENV, PROCESS),
        'no-restricted-imports': importPatterns(OPEN_HIPPO_DB, CONNECT, SESSION_OPEN, DATABASE_SYNC),
      },
    },
    {
      files: ['src/db/open.ts', 'src/db/index.ts', 'src/db/grant.ts'],
      rules: { 'no-restricted-imports': 'off' },
    },
    {
      files: ['src/db/request-stores.ts'],
      rules: { 'no-restricted-imports': importPatterns(OPEN_HIPPO_DB, SESSION_OPEN, DATABASE_SYNC) },
    },
    {
      files: ['src/store/sqlite/runtime/worker-jobs.ts'],
      rules: { 'no-restricted-imports': importPatterns(OPEN_HIPPO_DB, CONNECT, DATABASE_SYNC) },
    },
    {
      files: ['src/db/connect.ts'],
      rules: { 'no-restricted-imports': importPatterns(OPEN_HIPPO_DB, SESSION_OPEN) },
    },
    {
      files: ['src/db/continuity-tables.ts'],
      rules: { 'no-restricted-imports': importPatterns(OPEN_HIPPO_DB, CONNECT, SESSION_OPEN) },
    },
    {
      files: ['src/store/sqlite/**/*.ts'],
      rules: { 'id-denylist': 'off', 'no-restricted-properties': restrict(ENV, PROCESS) },
    },
    {
      files: ['src/base/util/env.ts'],
      rules: { 'no-restricted-properties': restrict(STORE_ON, PREPARE) },
    },
    {
      files: ['src/host/**/*.ts'],
      rules: {
        'no-restricted-imports': importPatterns({
          regex: 'config-file[.]js$',
          importNames: ['loadConfig'],
          message: 'Only the surface reads config.json; host code takes a ConfigReader.',
        }),
      },
    },
    {
      files: ['src/api/**/*.ts', 'src/domain/**/*.ts'],
      rules: { 'boundaries/no-adapter-name': 'error' },
    },
    {
      files: ['src/api/**/*.ts'],
      rules: {
        'id-denylist': ['error', 'sqliteStoreOn', 'hippoRoot'],
        'no-restricted-properties': restrict(
          STORE_ON,
          { property: 'hippoRoot', message: 'The api reads what the folder gave from a port method.' },
          ENV,
          PROCESS,
          PREPARE,
        ),
        'boundaries/no-store-branch': 'error',
      },
    },
    {
      files: ['src/domain/**/*.ts'],
      rules: {
        'id-denylist': ['error', 'sqliteStoreOn'],
        'no-restricted-properties': restrict(...SRC, {
          object: 'globalThis',
          property: 'fetch',
          message: 'Domain code reaches the network through a port.',
        }),
        'no-restricted-globals': [
          'error',
          { name: 'fetch', message: 'Domain code reaches the network through a port.' },
        ],
        'no-restricted-imports': importPatterns(
          {
            regex:
              '(^|/)(http-retry|embedding-provider|embeddings/provider|local-embedder|transformers)([.][cm]?[jt]s)?$',
            message: 'Domain code reaches a model or the network through a port that src/infra implements.',
          },
          {
            regex: '^[.]',
            importNames: ['fetchWithRetry', 'resolveEmbeddingProvider', 'importTransformers'],
            message: 'Domain code reaches a model or the network through a port that src/infra implements.',
          },
        ),
      },
    },
    {
      files: ['src/surface/**/*.ts', 'src/cli.ts'],
      rules: {
        'id-denylist': ['error', 'sqliteStoreOn', ...RECORD_AS_NAMES],
        'no-restricted-properties': restrict(...SURFACE),
        'boundaries/no-recall-ledger-label': 'error',
      },
    },
    {
      files: ['src/surface/cli/**/*.ts', 'src/cli.ts'],
      rules: {
        'id-denylist': ['error', ...CLI_NAMES],
        'no-restricted-properties': restrict(...CLI),
        'no-restricted-imports': importPatterns(
          {
            regex: 'api/recall/(pipeline|rank-search|rank-stages)[.]js$',
            importNames: ['rankRecall', 'loadRecallPool', 'searchPool', 'rankStages'],
            message: 'The CLI ranks a recall through retrieveWithCliCore() in src/api/recall/request.ts.',
          },
          {
            regex: '(server/boot|entry/testing)[.]js$',
            importNames: ['resolveTenantId'],
            message: 'The CLI resolves its tenant once, at dispatch, and hands it down.',
          },
        ),
        'boundaries/no-hand-flag-read': 'error',
        'boundaries/no-hand-fail': 'error',
      },
    },
    {
      files: ['src/surface/cli/recall*.ts', 'src/surface/cli/explain.ts'],
      rules: {
        'id-denylist': ['error', ...CLI_NAMES, 'recordTokens'],
        'no-restricted-properties': restrict(...CLI, {
          property: 'recordTokens',
          message: "retrieveWithCliCore() books the recall's token row.",
        }),
      },
    },
    {
      files: ['src/surface/cli/exit.ts'],
      rules: { 'boundaries/no-hand-fail': 'off' },
    },
    {
      files: ['src/surface/server/boot.ts', 'src/surface/mcp/request.ts'],
      rules: { 'no-restricted-properties': restrict(...SURFACE_ROOT) },
    },
    {
      files: ['src/surface/cli/api-context.ts'],
      rules: { 'no-restricted-properties': restrict(...CLI_ROOT) },
    },
    {
      files: ['src/surface/open-store.ts'],
      rules: {
        'id-denylist': 'off',
        'no-restricted-properties': restrict(ENV, PROCESS, PREPARE, ...RECORD_AS),
      },
    },
    {
      files: ['src/db/busy.ts', 'src/host/file-lock.ts'],
      rules: { 'boundaries/no-hand-transaction': 'off' },
    },
    {
      files: [
        'src/base/util/crash-handlers.ts',
        'src/surface/server/sleep-child.ts',
        'src/surface/cli/hooks/codex-run.ts',
      ],
      rules: { 'unicorn/no-process-exit': 'off' },
    },
    {
      files: ['scripts/**'],
      rules: {
        'max-lines-per-function': ['error', { max: 80 }],
        'max-lines': ['error', { max: 800 }],
      },
    },
    {
      files: ['tests/**/*.test.ts'],
      rules: { 'max-lines': ['error', { max: 800 }] },
    },
    {
      files: ['tests/**/*.ts'],
      rules: {
        'anti-slop/require-safety-comment-for-type-assertion': ['error', { allowStatementReads: true }],
      },
    },
    {
      files: ['tests/**'],
      rules: { 'boundaries/no-env-write': 'error' },
    },
    {
      files: ['tests/**/_helpers/**'],
      rules: { 'boundaries/no-env-write': 'off' },
    },
    { files: ['deploy/**/*.mjs'], rules: { 'anti-slop/no-runtime-typeof': 'off' } },
    {
      files: [
        'scripts/z1-replay.mjs',
        'scripts/e1-lifecycle/**',
        'scripts/z6-supersession/**',
        'scripts/token-eval/**',
        'benchmarks/**',
      ],
      rules: { curly: 'off' },
    },
    {
      files: [
        'scripts/z1-replay.mjs',
        'scripts/z1c-eval.mjs',
        'scripts/z0-capture-eval.mjs',
        'scripts/e1-lifecycle/generate.mjs',
        'tests/eval/token-eval-z0-homes.test.ts',
      ],
      rules: { 'max-lines': 'off', 'max-lines-per-function': 'off' },
    },
  ],
});
