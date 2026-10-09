// The one module in src/ that reads process.env; scripts/check-env-reads.mjs fails CI on any other read.
// Accessors read at call time, so a test that sets a variable between cases, or a HIPPO_HOME switch mid-process, still holds.

function raw(name: string): string | undefined {
  return process.env[name];
}

function isOne(name: string): boolean {
  return raw(name) === '1';
}

function isOneOrTrue(name: string): boolean {
  const value = raw(name);
  return value === '1' || value === 'true';
}

/** parseInt, kept only when above zero; the caller supplies its own default. */
function positiveInt(name: string): number | undefined {
  const parsed = Number.parseInt(raw(name) ?? '', 10);
  return parsed > 0 ? parsed : undefined;
}

/** Trimmed, with an empty or whitespace-only value read as unset. */
function trimmed(name: string): string | undefined {
  return raw(name)?.trim() || undefined;
}

/** The whole environment, for code that takes it as an injectable map (agent-memory machines, owner checks, support bundles). */
export function processEnv(): NodeJS.ProcessEnv {
  return process.env;
}

/** A variable whose name comes from configuration, such as an embedding provider's key variable. */
export function envByName(name: string): string | undefined {
  return raw(name);
}

// Eval-only lifecycle switches; ablation.ts caches them per process.
export function envAblateDecay(): boolean { return isOneOrTrue('HIPPO_ABLATE_DECAY'); }
export function envAblateRecallBoost(): boolean { return isOneOrTrue('HIPPO_ABLATE_RECALL_BOOST'); }
export function envAblateOutcome(): boolean { return isOneOrTrue('HIPPO_ABLATE_OUTCOME'); }
export function envAblateOutcomeSlow(): boolean { return isOneOrTrue('HIPPO_ABLATE_OUTCOME_SLOW'); }
export function envAblateOutcomeFast(): boolean { return isOneOrTrue('HIPPO_ABLATE_OUTCOME_FAST'); }
export function envAblateRecency(): boolean { return isOneOrTrue('HIPPO_ABLATE_RECENCY'); }

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

export function envLossAversionRatio(): string | undefined { return raw('HIPPO_LOSS_AVERSION_RATIO'); }
export function envSummaryDeboost(): string | undefined { return raw('HIPPO_SUMMARY_DEBOOST'); }
export function envAutodebiasOff(): boolean { return raw('HIPPO_AUTODEBIAS') === 'off'; }
export function envAnchoringOff(): boolean { return raw('HIPPO_ANCHORING') === 'off'; }
export function envAvailabilityOff(): boolean { return raw('HIPPO_AVAILABILITY') === 'off'; }
export function envDagRebuildCap(): number | undefined { return positiveInt('HIPPO_DAG_REBUILD_CAP'); }

// Paths. HIPPO_HOME and XDG_DATA_HOME come back trimmed, possibly empty.
export function envHippoHome(): string | undefined { return raw('HIPPO_HOME')?.trim(); }
export function envXdgDataHome(): string | undefined { return raw('XDG_DATA_HOME')?.trim(); }
export function envHomeDir(): string | undefined { return raw('HOME') || raw('USERPROFILE'); }
export function envPath(): string | undefined { return raw('PATH'); }
export function envModelCache(): string | undefined { return trimmed('HIPPO_MODEL_CACHE'); }

// Session, scope and tenant.
export function envHippoSessionId(): string | undefined { return trimmed('HIPPO_SESSION_ID'); }
export function envClaudeCodeSessionId(): string | undefined { return trimmed('CLAUDE_CODE_SESSION_ID'); }
export function envScope(): string | undefined { return raw('HIPPO_SCOPE'); }
export function envGstackSkill(): string | undefined { return raw('GSTACK_SKILL'); }
export function envOpenclawSkill(): string | undefined { return raw('OPENCLAW_SKILL'); }

/** HIPPO_TENANT trimmed; empty or whitespace-only falls through to 'default'. */
export function envTenant(): string {
  return raw('HIPPO_TENANT')?.trim() || 'default';
}

// Install and CLI switches.
export function envSkipAutoIntegrations(): boolean { return isOne('HIPPO_SKIP_AUTO_INTEGRATIONS'); }
export function envSkipPostinstall(): boolean { return isOne('HIPPO_SKIP_POSTINSTALL'); }
export function envMcpStdio(): boolean { return isOne('HIPPO_MCP_STDIO'); }
/** `1` or `true`, so `0` and `false` turn it off; `true` stays on for anyone who set it that way. */
export function envRequireServer(): boolean { return isOneOrTrue('HIPPO_REQUIRE_SERVER'); }
export function envRequireSessionScopedFreshTail(): boolean { return isOne('HIPPO_REQUIRE_SESSION_SCOPED_FRESH_TAIL'); }
export function envStdinWaitMs(): number | undefined { return positiveInt('HIPPO_STDIN_WAIT_MS'); }
export function envLogLevel(): string { return raw('HIPPO_LOG')?.trim().toLowerCase() ?? ''; }
/** `HIPPO_LOG_FORMAT=json` writes each log line as one JSON object; anything else keeps the text line. */
export function envLogJson(): boolean { return raw('HIPPO_LOG_FORMAT')?.trim().toLowerCase() === 'json'; }

// Server.
export function envPort(): string | undefined { return raw('HIPPO_PORT'); }
/** How long a client waits for a running server's /health before writing to the store directly; server-detect.ts holds the default. */
export function envHealthProbeMs(): number | undefined { return positiveInt('HIPPO_HEALTH_PROBE_MS'); }
export function envRequireAuth(): boolean { return isOne('HIPPO_REQUIRE_AUTH'); }
export function envV1Rps(): string | undefined { return raw('HIPPO_V1_RPS'); }
/** How long a request body may take to arrive; http-util.ts holds the default. */
export function envBodyTimeoutMs(): number | undefined { return positiveInt('HIPPO_BODY_TIMEOUT_MS'); }
/** How long POST /v1/sleep lets its consolidation run; server/sleep-offload.ts holds the default. */
export function envSleepTimeoutMs(): number | undefined { return positiveInt('HIPPO_SLEEP_TIMEOUT_MS'); }
export function envApiKey(): string | undefined { return raw('HIPPO_API_KEY'); }
export function envClientIpHeader(): string | undefined { return raw('HIPPO_CLIENT_IP_HEADER')?.trim().toLowerCase(); }
export function envTrustedProxies(): string | undefined { return raw('HIPPO_TRUSTED_PROXIES'); }
export function envMcpSseMaxStreams(): number | undefined { return positiveInt('MCP_SSE_MAX_STREAMS'); }
export function envMcpSseHeartbeatMs(): number | undefined { return positiveInt('MCP_SSE_HEARTBEAT_MS'); }
export function envMcpSseMaxAgeSec(): number | undefined { return positiveInt('MCP_SSE_MAX_AGE_SEC'); }

// LLM and reranker credentials and knobs.
export function envAnthropicApiKey(): string | undefined { return raw('ANTHROPIC_API_KEY'); }
export function envLlmTimeoutMs(): number | undefined { return positiveInt('HIPPO_LLM_TIMEOUT_MS'); }
export function envTypesafeApiKey(): string | undefined { return trimmed('TYPESAFE_API_KEY'); }
export function envJevTimeoutMs(): number | undefined { return positiveInt('HIPPO_JEV_TIMEOUT_MS'); }
export function envJevModel(): string | undefined { return raw('HIPPO_JEV_MODEL'); }
export function envLlmRerankerUrl(): string | undefined { return raw('HIPPO_LLM_RERANKER_URL'); }
export function envLlmRerankerKey(): string | undefined { return raw('HIPPO_LLM_RERANKER_KEY'); }
export function envLlmRerankerModel(): string | undefined { return raw('HIPPO_LLM_RERANKER_MODEL'); }
export function envLlmRerankerTimeoutMs(): number | undefined { return positiveInt('HIPPO_LLM_RERANKER_TIMEOUT_MS'); }
export function envClefEndpoint(): string | undefined { return raw('HIPPO_CLEF_ENDPOINT')?.trim(); }
export function envClefEndpointToken(): string | undefined { return raw('HIPPO_CLEF_ENDPOINT_TOKEN')?.trim() || undefined; }
export function envClefTimeoutMs(): string | undefined { return raw('HIPPO_CLEF_TIMEOUT_MS'); }
export function envCloudflareAccountId(): string { return raw('CLOUDFLARE_ACCOUNT_ID')?.trim() ?? ''; }
export function envCloudflareApiToken(): string { return raw('CLOUDFLARE_API_TOKEN')?.trim() ?? ''; }

// Connectors.
export function envSlackBotToken(): string | undefined { return raw('SLACK_BOT_TOKEN'); }
export function envSlackTeamId(): string | undefined { return raw('SLACK_TEAM_ID'); }
export function envSlackSigningSecret(): string | undefined { return raw('SLACK_SIGNING_SECRET'); }
export function envSlackSigningSecretPrevious(): string | undefined { return raw('SLACK_SIGNING_SECRET_PREVIOUS'); }
export function envSlackAllowUnknownTeamFallback(): boolean { return isOne('SLACK_ALLOW_UNKNOWN_TEAM_FALLBACK'); }
export function envGithubToken(): string | undefined { return raw('GITHUB_TOKEN'); }
export function envGithubWebhookSecret(): string | undefined { return raw('GITHUB_WEBHOOK_SECRET'); }
export function envGithubWebhookSecretPrevious(): string | undefined { return raw('GITHUB_WEBHOOK_SECRET_PREVIOUS'); }
export function envGithubAllowUnknownInstallationFallback(): boolean { return isOne('GITHUB_ALLOW_UNKNOWN_INSTALLATION_FALLBACK'); }
