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

function isObject(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object';
}

function hasSenderShape(x: unknown): x is GitHubSender {
  if (!isObject(x)) return false;
  return typeof x.login === 'string' && typeof x.id === 'number';
}

export function isGitHubWebhookEnvelope(x: unknown): x is GitHubWebhookEnvelope {
  if (!isObject(x)) return false;
  // Duck-type: an envelope must at least carry an action OR a repository field.
  return typeof x.action === 'string' || isObject(x.repository);
}

export function isGitHubIssueEvent(
  x: unknown,
  evtHeader: string,
): x is GitHubIssueEvent {
  if (evtHeader !== 'issues') return false;
  if (!isObject(x)) return false;
  if (typeof x.action !== 'string') return false;
  const issue = x.issue;
  if (!isObject(issue)) return false;
  if (typeof issue.number !== 'number') return false;
  if (!hasSenderShape(issue.user)) return false;
  return true;
}

export function isGitHubIssueCommentEvent(
  x: unknown,
  evtHeader: string,
): x is GitHubIssueCommentEvent {
  if (evtHeader !== 'issue_comment') return false;
  if (!isObject(x)) return false;
  if (typeof x.action !== 'string') return false;
  const issue = x.issue;
  if (!isObject(issue) || typeof issue.number !== 'number') return false;
  const comment = x.comment;
  if (!isObject(comment)) return false;
  if (typeof comment.id !== 'number') return false;
  if (!hasSenderShape(comment.user)) return false;
  return true;
}

export function isGitHubPullRequestEvent(
  x: unknown,
  evtHeader: string,
): x is GitHubPullRequestEvent {
  if (evtHeader !== 'pull_request') return false;
  if (!isObject(x)) return false;
  if (typeof x.action !== 'string') return false;
  const pr = x.pull_request;
  if (!isObject(pr)) return false;
  if (typeof pr.number !== 'number') return false;
  if (!hasSenderShape(pr.user)) return false;
  return true;
}

export function isGitHubPullRequestReviewCommentEvent(
  x: unknown,
  evtHeader: string,
): x is GitHubPullRequestReviewCommentEvent {
  if (evtHeader !== 'pull_request_review_comment') return false;
  if (!isObject(x)) return false;
  if (typeof x.action !== 'string') return false;
  const pr = x.pull_request;
  if (!isObject(pr) || typeof pr.number !== 'number') return false;
  const comment = x.comment;
  if (!isObject(comment)) return false;
  if (typeof comment.id !== 'number') return false;
  if (!hasSenderShape(comment.user)) return false;
  return true;
}
