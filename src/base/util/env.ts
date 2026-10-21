// The one module in src/ that reads process.env; scripts/check-env-reads.mjs fails CI on any other read, and on an
// import of this module outside the roots, the adapters and the eval switches. Accessors read at call time, so a test
// that sets a variable between cases still holds.
import type { ClefSettings, RuntimeSettings } from '../config/config.js';
import { DEFAULT_TENANT_ID } from './tenant.js';

function raw(name: string): string | undefined {
  return process.env[name];
}

type FlagState = 'on' | 'off' | 'unset' | 'unknown';

/** Every on/off variable, with the side an unrecognised spelling takes: the safe one, so a typo never opens a door. */
const FLAGS = {
  HIPPO_ABLATE_DECAY: false,
  HIPPO_ABLATE_RECALL_BOOST: false,
  HIPPO_ABLATE_OUTCOME: false,
  HIPPO_ABLATE_OUTCOME_SLOW: false,
  HIPPO_ABLATE_OUTCOME_FAST: false,
  HIPPO_ABLATE_RECENCY: false,
  HIPPO_AUTODEBIAS: false,
  HIPPO_ANCHORING: false,
  HIPPO_AVAILABILITY: false,
  HIPPO_SKIP_AUTO_INTEGRATIONS: false,
  HIPPO_SKIP_SCHEDULE: false,
  HIPPO_MCP_STDIO: false,
  HIPPO_REQUIRE_SERVER: false,
  HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL: false,
  HIPPO_REQUIRE_AUTH: true,
  HIPPO_ALLOW_KEYLESS_LOCAL: false,
  HIPPO_ALLOW_CLEARTEXT: false,
  SLACK_ALLOW_UNKNOWN_TEAM_FALLBACK: false,
  GITHUB_ALLOW_UNKNOWN_INSTALLATION_FALLBACK: false,
} as const satisfies Record<string, boolean>;

type FlagName = keyof typeof FLAGS;

/** `1`, `true`, `on` and `0`, `false`, `off` (any case, trimmed) are the spellings; unset and empty are unset. */
function flagState(name: string): FlagState {
  const value = raw(name)?.trim().toLowerCase();
  if (!value) return 'unset';
  if (value === '1' || value === 'true' || value === 'on') return 'on';
  if (value === '0' || value === 'false' || value === 'off') return 'off';
  return 'unknown';
}

/** Never throws, since accessors run per request; an unknown spelling takes the flag's safe side. */
function bool(name: FlagName): () => boolean {
  return () => {
    const state = flagState(name);
    return state === 'unknown' ? FLAGS[name] : state === 'on';
  };
}

/** True only for an explicit off spelling, for the settings that are on until switched off. */
function boolOff(name: FlagName): () => boolean {
  return () => flagState(name) === 'off';
}

/** One `NAME="value"` entry per on/off variable set to a spelling no flag accepts; serve refuses to boot on any. */
export function validateFlags(): string[] {
  const bad: string[] = [];
  for (const name of Object.keys(FLAGS)) {
    if (flagState(name) === 'unknown') bad.push(`${name}=${JSON.stringify(raw(name)!.trim().slice(0, 40))}`);
  }
  return bad;
}

// The reader kinds every accessor below is built from; each returns a function so a test's later stubEnv still holds.

/** The value as written, unset when the variable is. */
function text(name: string): () => string | undefined {
  return () => raw(name);
}

/** Trimmed, with an empty or whitespace-only value read as unset. */
function trimmedText(name: string): () => string | undefined {
  return () => raw(name)?.trim() || undefined;
}

/** parseInt, kept only when above zero; the caller supplies its own default. */
function posInt(name: string): () => number | undefined {
  return () => {
    const parsed = Number.parseInt(raw(name) ?? '', 10);
    return parsed > 0 ? parsed : undefined;
  };
}

/** parseInt, kept from zero up, for a setting whose 0 means off. */
function nonNegInt(name: string): () => number | undefined {
  return () => {
    const parsed = Number.parseInt(raw(name) ?? '', 10);
    return parsed >= 0 ? parsed : undefined;
  };
}

/** Number(), kept only for a whole number above zero: parseInt would read "15s" as 15 and "1e3" as 1. */
function strictPosInt(name: string): () => number | undefined {
  return () => {
    const parsed = Number(raw(name));
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  };
}

/**
 * The whole environment, for code that takes it as an injectable map (agent-memory machines, owner checks, support
 * bundles).
 */
export function processEnv(): NodeJS.ProcessEnv {
  return process.env;
}

/**
 * Every variable env.ts reads that holds a secret, an endpoint or a path outside the isolated homes, plus the
 * provider keys read by configured name; vitest.config.ts blanks each so a developer's shell never reaches a test.
 * scripts/check-test-env.mjs fails a secret-looking read that is missing here.
 */
export const ENV_SCRUBBED_IN_TESTS = Object.freeze([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'VOYAGE_API_KEY',
  'COHERE_API_KEY',
  'TYPESAFE_API_KEY',
  'HIPPO_API_KEY',
  'HIPPO_LLM_RERANKER_URL',
  'HIPPO_LLM_RERANKER_KEY',
  'HIPPO_CLEF_ENDPOINT',
  'HIPPO_CLEF_ENDPOINT_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_SIGNING_SECRET_PREVIOUS',
  'SLACK_SIGNING_SECRET_PREVIOUS_UNTIL',
  'GITHUB_TOKEN',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_WEBHOOK_SECRET_PREVIOUS',
  'GITHUB_WEBHOOK_SECRET_PREVIOUS_UNTIL',
  'HIPPO_MODEL_CACHE',
  'HIPPO_TLS_CERT',
  'HIPPO_TLS_KEY',
  'XDG_DATA_HOME',
]);

/** A variable whose name comes from configuration, such as an embedding provider's key variable. */
export function envByName(name: string): string | undefined {
  return raw(name);
}

// Eval-only lifecycle switches; ablation.ts reads them at call time.
export const envAblateDecay = bool('HIPPO_ABLATE_DECAY');
export const envAblateRecallBoost = bool('HIPPO_ABLATE_RECALL_BOOST');
export const envAblateOutcome = bool('HIPPO_ABLATE_OUTCOME');
export const envAblateOutcomeSlow = bool('HIPPO_ABLATE_OUTCOME_SLOW');
export const envAblateOutcomeFast = bool('HIPPO_ABLATE_OUTCOME_FAST');
export const envAblateRecency = bool('HIPPO_ABLATE_RECENCY');

/** HIPPO_EVAL_RECENCY_DAYS when it is a positive number, else null. */
export function envEvalRecencyDays(): number | null {
  const days = Number(raw('HIPPO_EVAL_RECENCY_DAYS'));
  return Number.isFinite(days) && days > 0 ? days : null;
}

/** HIPPO_FAKE_NOW as epoch millis, or null unless it is byte-identical to Date.toISOString output. */
export function envFakeNowMs(): number | null {
  const value = raw('HIPPO_FAKE_NOW');
  if (value === undefined || value === '') return null;
  // Round-trip, not a regex: Date.parse accepts junk and locale dates, and a regex admits rolled-over days like 02-31.
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

/** HIPPO_LOSS_AVERSION_RATIO as a number, NaN for junk; strength scoring applies the floor and the 1.0 fallback. */
export function envLossAversionRatio(): number | undefined {
  const value = raw('HIPPO_LOSS_AVERSION_RATIO');
  return value === undefined ? undefined : Number(value);
}
function envSummaryDeboost(): string | undefined {
  return raw('HIPPO_SUMMARY_DEBOOST');
}
const envAutodebiasOff = boolOff('HIPPO_AUTODEBIAS');
const envAnchoringOff = boolOff('HIPPO_ANCHORING');
const envAvailabilityOff = boolOff('HIPPO_AVAILABILITY');
const envDagRebuildCap = posInt('HIPPO_DAG_REBUILD_CAP');

/** The settings a root hands down in HippoConfig.runtime; an unset number or scope stays undefined. */
export function envRuntimeSettings(): RuntimeSettings {
  const deboost = envSummaryDeboost();
  return {
    anchoringHint: !envAnchoringOff(),
    availabilityHint: !envAvailabilityOff(),
    autodebias: !envAutodebiasOff(),
    requireSessionScopedFreshTail: envRequireSessionScopedFreshTail(),
    summaryDeboost: deboost === undefined ? undefined : Number.parseFloat(deboost),
    queryEmbedTimeoutMs: envQueryEmbedTimeoutMs(),
    dagRebuildCap: envDagRebuildCap(),
    activeScope: envActiveScope() ?? undefined,
    lossAversionRatio: envLossAversionRatio(),
    clef: envClefSettings(),
  };
}

export function envClefSettings(): ClefSettings {
  return {
    endpoint: envClefEndpoint(),
    endpointToken: envClefEndpointToken(),
    timeoutMs: envClefTimeoutMs(),
    cloudflareAccountId: envCloudflareAccountId(),
    cloudflareApiToken: envCloudflareApiToken(),
  };
}

// Paths. HIPPO_HOME and XDG_DATA_HOME come back trimmed, possibly empty.
export function envHippoHome(): string | undefined {
  return raw('HIPPO_HOME')?.trim();
}
export function envXdgDataHome(): string | undefined {
  return raw('XDG_DATA_HOME')?.trim();
}
export function envHomeDir(): string | undefined {
  return raw('HOME') || raw('USERPROFILE');
}
export const envPath = text('PATH');
/** The extensions win32 tries on a bare command name, in order. */
export const envPathExt = text('PATHEXT');
export const envModelCache = trimmedText('HIPPO_MODEL_CACHE');

// Session, scope and tenant.
export const envHippoSessionId = trimmedText('HIPPO_SESSION_ID');
export const envClaudeCodeSessionId = trimmedText('CLAUDE_CODE_SESSION_ID');
const hippoScope = trimmedText('HIPPO_SCOPE');
const gstackSkill = trimmedText('GSTACK_SKILL');
const openclawSkill = trimmedText('OPENCLAW_SKILL');
/** The operational scope, trimmed: HIPPO_SCOPE, else GSTACK_SKILL, else OPENCLAW_SKILL; null when none is set. */
export function envActiveScope(): string | null {
  return hippoScope() ?? gstackSkill() ?? openclawSkill() ?? null;
}

/** HIPPO_TENANT trimmed; empty or whitespace-only falls through to the default tenant. */
export function envTenant(): string {
  return raw('HIPPO_TENANT')?.trim() || DEFAULT_TENANT_ID;
}

// Install and CLI switches.
export const envSkipAutoIntegrations = bool('HIPPO_SKIP_AUTO_INTEGRATIONS');
export const envSkipSchedule = bool('HIPPO_SKIP_SCHEDULE');
export const envMcpStdio = bool('HIPPO_MCP_STDIO');
export const envRequireServer = bool('HIPPO_REQUIRE_SERVER');
const envRequireSessionScopedFreshTail = bool('HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL');
export const envStdinWaitMs = posInt('HIPPO_STDIN_WAIT_MS');
export function envLogLevel(): string {
  return raw('HIPPO_LOG')?.trim().toLowerCase() ?? '';
}
/** `HIPPO_LOG_FORMAT=json` writes each log line as one JSON object; anything else keeps the text line. */
export function envLogJson(): boolean {
  return raw('HIPPO_LOG_FORMAT')?.trim().toLowerCase() === 'json';
}

// Server.
export const envPort = text('HIPPO_PORT');
/**
 * How long a client waits for a running server's /health before writing to the store directly; server-detect.ts holds
 * the default.
 */
export const envHealthProbeMs = posInt('HIPPO_HEALTH_PROBE_MS');
export const envRequireAuth = bool('HIPPO_REQUIRE_AUTH');
/** `1` lets a request made on this machine in with no key; HIPPO_REQUIRE_AUTH=1 wins over it. */
export const envAllowKeylessLocal = bool('HIPPO_ALLOW_KEYLESS_LOCAL');
/** `1` lets a non-loopback bind start without TLS, for TLS that ends at a proxy in front. */
export const envAllowCleartext = bool('HIPPO_ALLOW_CLEARTEXT');
export const envV1Rps = text('HIPPO_V1_RPS');
/** Requests per second each authenticated caller may make; `0` turns the per-caller limit off. */
export const envCallerRps = trimmedText('HIPPO_CALLER_RPS');
/** How long a request body may take to arrive; http-util.ts holds the default. */
export const envBodyTimeoutMs = posInt('HIPPO_BODY_TIMEOUT_MS');
/** How long POST /v1/sleep lets its consolidation run; surface/server/sleep-offload.ts holds the default. */
export const envSleepTimeoutMs = posInt('HIPPO_SLEEP_TIMEOUT_MS');
/** How long a /v1 or /mcp request may run before the server answers 504, and a stdio MCP request before its timeout
 * error; 0 for no deadline; base/util/request-scope.ts holds the default. */
export const envRequestDeadlineMs = nonNegInt('HIPPO_REQUEST_DEADLINE_MS');
/**
 * How many store calls may wait for one worker thread before the next is refused; store/sqlite/executor.ts holds the
 * default.
 */
export const envStoreQueueMax = posInt('HIPPO_STORE_QUEUE_MAX');
/** How long the daily runner lets one child `hippo` step run; surface/cli/setup.ts holds the default. */
export const envDailyStepTimeoutMs = posInt('HIPPO_DAILY_STEP_TIMEOUT_MS');
export const envApiKey = text('HIPPO_API_KEY');
export function envClientIpHeader(): string | undefined {
  return raw('HIPPO_CLIENT_IP_HEADER')?.trim().toLowerCase();
}
/** The peers whose HIPPO_CLIENT_IP_HEADER is believed: IPs or CIDRs. */
export const envTrustedProxies = text('HIPPO_TRUSTED_PROXIES');
/** Paths to the PEM certificate and key `hippo serve` answers HTTPS with; the --tls-cert and --tls-key flags win. */
export const envTlsCert = trimmedText('HIPPO_TLS_CERT');
export const envTlsKey = trimmedText('HIPPO_TLS_KEY');
export const envMcpSseMaxStreams = posInt('MCP_SSE_MAX_STREAMS');
export const envMcpSseHeartbeatMs = posInt('MCP_SSE_HEARTBEAT_MS');
export const envMcpSseMaxAgeSec = posInt('MCP_SSE_MAX_AGE_SEC');

// LLM and reranker credentials and knobs.
export const envAnthropicApiKey = text('ANTHROPIC_API_KEY');
export const envLlmTimeoutMs = posInt('HIPPO_LLM_TIMEOUT_MS');
export const envTypesafeApiKey = trimmedText('TYPESAFE_API_KEY');
export const envJevTimeoutMs = posInt('HIPPO_JEV_TIMEOUT_MS');
export const envJevModel = text('HIPPO_JEV_MODEL');
/**
 * How long a recall waits for an API provider to embed its query before ranking on BM25 alone;
 * domain/search/vector.ts holds the default.
 */
const envQueryEmbedTimeoutMs = posInt('HIPPO_QUERY_EMBED_TIMEOUT_MS');
export const envLlmRerankerUrl = trimmedText('HIPPO_LLM_RERANKER_URL');
export const envLlmRerankerKey = text('HIPPO_LLM_RERANKER_KEY');
export const envLlmRerankerModel = text('HIPPO_LLM_RERANKER_MODEL');
export const envLlmRerankerTimeoutMs = posInt('HIPPO_LLM_RERANKER_TIMEOUT_MS');
const envClefEndpoint = trimmedText('HIPPO_CLEF_ENDPOINT');
const envClefEndpointToken = trimmedText('HIPPO_CLEF_ENDPOINT_TOKEN');
const envClefTimeoutMs = strictPosInt('HIPPO_CLEF_TIMEOUT_MS');
const cloudflareAccountId = trimmedText('CLOUDFLARE_ACCOUNT_ID');
const cloudflareApiToken = trimmedText('CLOUDFLARE_API_TOKEN');
export function envCloudflareAccountId(): string {
  return cloudflareAccountId() ?? '';
}
export function envCloudflareApiToken(): string {
  return cloudflareApiToken() ?? '';
}

// Connectors.
export const envSlackBotToken = text('SLACK_BOT_TOKEN');
export const envSlackTeamId = text('SLACK_TEAM_ID');
export const envSlackSigningSecret = text('SLACK_SIGNING_SECRET');
export const envSlackSigningSecretPrevious = text('SLACK_SIGNING_SECRET_PREVIOUS');
export const envSlackSigningSecretPreviousUntil = text('SLACK_SIGNING_SECRET_PREVIOUS_UNTIL');
export const envSlackAllowUnknownTeamFallback = bool('SLACK_ALLOW_UNKNOWN_TEAM_FALLBACK');
export const envGitHubToken = text('GITHUB_TOKEN');
export const envGitHubWebhookSecret = text('GITHUB_WEBHOOK_SECRET');
export const envGitHubWebhookSecretPrevious = text('GITHUB_WEBHOOK_SECRET_PREVIOUS');
export const envGitHubWebhookSecretPreviousUntil = text('GITHUB_WEBHOOK_SECRET_PREVIOUS_UNTIL');
export const envGitHubAllowUnknownInstallationFallback = bool('GITHUB_ALLOW_UNKNOWN_INSTALLATION_FALLBACK');
