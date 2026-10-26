// Variables vitest.config.ts blanks for every test so a developer's shell never reaches one: each secret, endpoint or path
// src/base/util/env.ts reads outside the isolated homes, plus the provider keys read by configured name.
// scripts/check-test-env.mjs fails a secret-looking read in env.ts that is missing here.
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
