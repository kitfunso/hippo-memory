/**
 * GitHub webhook event shapes used by the ingestion connector.
 * Spec: https://docs.github.com/en/webhooks/webhook-events-and-payloads
 *
 * V1 cares about four event types: issues, issue_comment, pull_request,
 * pull_request_review_comment. Each guard is gated on the X-GitHub-Event
 * header value so a malicious or misrouted payload cannot satisfy a guard
 * for the wrong event type.
 */

/**
 * Codex P1 #7: `private` MUST be optional, not required. The Slack-style
 * fail-safe in scope.ts requires an envelope with `private: undefined` to
 * map to private; a strict boolean type would reject the payload before
 * scope can fail closed.
 */
export interface GitHubRepository {
  full_name: string;
  private?: boolean;
  owner: { login: string };
  name: string;
  id?: number;
}

export interface GitHubSender {
  login: string;
  id: number;
}

export interface GitHubInstallation {
  id: number;
}

export interface GitHubWebhookEnvelope {
  action?: string;
  repository?: GitHubRepository;
  sender?: GitHubSender;
  installation?: GitHubInstallation;
}

export interface GitHubIssueEvent extends GitHubWebhookEnvelope {
  action: 'opened' | 'edited' | 'closed' | 'reopened' | 'deleted';
  issue: {
    number: number;
    title: string;
    body: string | null;
    user: GitHubSender;
    updated_at?: string;
  };
}

export interface GitHubIssueCommentEvent extends GitHubWebhookEnvelope {
  action: 'created' | 'edited' | 'deleted';
  issue: { number: number };
  comment: {
    id: number;
    body: string | null;
    user: GitHubSender;
    updated_at?: string;
  };
}

export interface GitHubPullRequestEvent extends GitHubWebhookEnvelope {
  action:
    | 'opened'
    | 'edited'
    | 'closed'
    | 'reopened'
    | 'synchronize'
    | 'ready_for_review';
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    user: GitHubSender;
    updated_at?: string;
  };
}

export interface GitHubPullRequestReviewCommentEvent extends GitHubWebhookEnvelope {
  action: 'created' | 'edited' | 'deleted';
  pull_request: { number: number };
  comment: {
    id: number;
    body: string | null;
    user: GitHubSender;
    updated_at?: string;
  };
}

/**
 * The full value space `JSON.parse` can produce. Boundary-guard functions in
 * this file accept `JsonValue` (never `unknown`) so a value's origin as
 * unparsed external JSON stays visible in its type, then narrow it via the
 * `isJson*` predicates below.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function isJsonObject(x: JsonValue): x is Record<string, JsonValue> {
  return x !== null && typeof x === 'object';
}

function isJsonString(x: JsonValue): x is string {
  return typeof x === 'string';
}

function isJsonNumber(x: JsonValue): x is number {
  return typeof x === 'number';
}

function isGitHubSender(x: JsonValue): x is JsonValue & GitHubSender {
  if (!isJsonObject(x)) return false;
  return isJsonString(x.login) && isJsonNumber(x.id);
}

export function isGitHubWebhookEnvelope(x: JsonValue): x is JsonValue & GitHubWebhookEnvelope {
  if (!isJsonObject(x)) return false;
  // Duck-type: an envelope must at least carry an action OR a repository field.
  return isJsonString(x.action) || isJsonObject(x.repository);
}

export function isGitHubIssueEvent(
  x: JsonValue,
  evtHeader: string,
): x is JsonValue & GitHubIssueEvent {
  if (evtHeader !== 'issues') return false;
  if (!isJsonObject(x)) return false;
  if (!isJsonString(x.action)) return false;
  const issue = x.issue;
  if (!isJsonObject(issue)) return false;
  if (!isJsonNumber(issue.number)) return false;
  if (!isGitHubSender(issue.user)) return false;
  return true;
}

export function isGitHubIssueCommentEvent(
  x: JsonValue,
  evtHeader: string,
): x is JsonValue & GitHubIssueCommentEvent {
  if (evtHeader !== 'issue_comment') return false;
  if (!isJsonObject(x)) return false;
  if (!isJsonString(x.action)) return false;
  const issue = x.issue;
  if (!isJsonObject(issue) || !isJsonNumber(issue.number)) return false;
  const comment = x.comment;
  if (!isJsonObject(comment)) return false;
  if (!isJsonNumber(comment.id)) return false;
  if (!isGitHubSender(comment.user)) return false;
  return true;
}

export function isGitHubPullRequestEvent(
  x: JsonValue,
  evtHeader: string,
): x is JsonValue & GitHubPullRequestEvent {
  if (evtHeader !== 'pull_request') return false;
  if (!isJsonObject(x)) return false;
  if (!isJsonString(x.action)) return false;
  const pr = x.pull_request;
  if (!isJsonObject(pr)) return false;
  if (!isJsonNumber(pr.number)) return false;
  if (!isGitHubSender(pr.user)) return false;
  return true;
}

export function isGitHubPullRequestReviewCommentEvent(
  x: JsonValue,
  evtHeader: string,
): x is JsonValue & GitHubPullRequestReviewCommentEvent {
  if (evtHeader !== 'pull_request_review_comment') return false;
  if (!isJsonObject(x)) return false;
  if (!isJsonString(x.action)) return false;
  const pr = x.pull_request;
  if (!isJsonObject(pr) || !isJsonNumber(pr.number)) return false;
  const comment = x.comment;
  if (!isJsonObject(comment)) return false;
  if (!isJsonNumber(comment.id)) return false;
  if (!isGitHubSender(comment.user)) return false;
  return true;
}
