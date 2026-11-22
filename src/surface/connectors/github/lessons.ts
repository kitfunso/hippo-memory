/** Lessons a default-branch commit gives: a revert, or a change to a CODEOWNERS file. Each is keyed on
 * its commit sha, so a webhook push and a backfill of one commit write one row. */

import type { RememberOptions } from '../../../api/index.js';
import type { ConnectorEvent } from '../../../base/ports/store.js';
import { isJsonObject, isJsonString, type JsonValue } from '../../../base/util/json.js';
import { rememberWithEventLog, type ConnectorContext, type IngestResult } from '../ingest.js';
import { githubCommitLessonRef, githubRepoKey, isGitHubRepoFullName } from './ref.js';
import { scopeFromRepository } from './scope.js';
import { computeIdempotencyKey } from './signature.js';
import { githubWebOrigin, type GitHubSite } from './site.js';
import type { GitHubPushEvent, GitHubRepository } from './types.js';

export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'] as const;
export const SHA_RE = /^[0-9a-f]{40}$/;

const MERGE_SUBJECT = /^Merge (pull request #|branch |remote-tracking branch )/;
const REVERT_SUBJECT = /^(Revert|Reapply) "(.+)"(?: \(#\d+\))?$/;
const REVERTS_COMMIT = /^This reverts commit ([0-9a-f]{7,40})\b/m;
const REVERTS_REFERENCE = /^This reverts commit [0-9a-f]{7,40} \((.+), (\d{4}-\d{2}-\d{2})\)\.?$/m;
const REVERTS_PULL = /^Reverts ([^\s#]+)#(\d+)\s*$/m;
const NOT_A_REASON = [
  /^This reverts commit /,
  /^changes made to [0-9a-f]{7,40}\.?$/,
  /^Reverts [^\s#]+#\d+\s*$/,
  /^[A-Z][A-Za-z-]*-by: /,
  /^\* /,
];
const MAX_TEXT_CHARS = 200;
const MAX_OWNER_LINES = 40;

export interface RevertParts {
  readonly action: 'reverted' | 'reapplied';
  readonly original: string;
  readonly reason: string | null;
  readonly revertsSha: string | null;
  readonly revertsPull: { readonly repo: string; readonly number: number } | null;
}

function reasonOf(bodyLines: readonly string[]): string | null {
  const line = bodyLines.find(
    (l) => l.trim() !== '' && !NOT_A_REASON.some((re) => re.test(l.trim())),
  );
  return line === undefined ? null : line.trim();
}

function pullOf(body: string): RevertParts['revertsPull'] {
  const m = REVERTS_PULL.exec(body);
  if (m === null || !isGitHubRepoFullName(m[1])) return null;
  return { repo: m[1], number: Number(m[2]) };
}

/** The parts of a revert or reapply commit message; null when the message is neither. */
export function parseRevertMessage(message: string): RevertParts | null {
  const [first, ...rest] = message.split(/\r?\n/);
  const subject = first.trim();
  const body = rest.join('\n');
  if (MERGE_SUBJECT.test(subject)) return null;
  const s = REVERT_SUBJECT.exec(subject);
  const b = REVERTS_COMMIT.exec(body);
  // A squash body lists each branch commit as "* <subject>", so its revert line is not this commit's.
  if (s === null && (b === null || /^\* /m.test(body))) return null;
  const reference = REVERTS_REFERENCE.exec(body);
  return {
    action: s?.[1] === 'Reapply' ? 'reapplied' : 'reverted',
    original: reference?.[1] ?? s?.[2] ?? subject,
    reason: reasonOf(rest),
    revertsSha: b?.[1] ?? null,
    revertsPull: pullOf(body),
  };
}

export interface CodeownersEntry {
  readonly filename: string;
  readonly previousFilename: string | null;
  readonly patch: string | null;
}

/** The files[] entry a commit detail holds for a CODEOWNERS path, by its new or old name. */
export function codeownersPatch(
  files: JsonValue | undefined,
  path: string,
): CodeownersEntry | null {
  if (!Array.isArray(files)) return null;
  for (const f of files) {
    if (!isJsonObject(f)) continue;
    const previous = isJsonString(f.previous_filename) ? f.previous_filename : null;
    if (f.filename !== path && previous !== path) continue;
    return {
      filename: isJsonString(f.filename) ? f.filename : path,
      previousFilename: previous,
      patch: isJsonString(f.patch) ? f.patch : null,
    };
  }
  return null;
}

interface OwnerLineChanges {
  readonly added: string[];
  readonly removed: string[];
}

function codeownersLineChanges(patch: string): OwnerLineChanges {
  const added: string[] = [];
  const removed: string[] = [];
  for (const raw of patch.split(/\r?\n/)) {
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('\\')) continue;
    const line = raw.slice(1).trim();
    if (line === '' || line.startsWith('#')) continue;
    if (raw.startsWith('+')) added.push(line);
    else if (raw.startsWith('-')) removed.push(line);
  }
  return { added, removed };
}

/** The commit a lesson comes from; authorLogin null is an author GitHub did not name. */
export interface LessonCommit {
  readonly repository: GitHubRepository;
  readonly sha: string;
  readonly authorLogin: string | null;
  readonly site: GitHubSite;
}

export type LessonOpts = RememberOptions & { artifactRef: string };

const cap = (text: string): string => text.slice(0, MAX_TEXT_CHARS);

function lessonOpts(
  commit: LessonCommit,
  kind: 'revert' | 'codeowners',
  content: string,
): LessonOpts {
  const { repository, site } = commit;
  const login = `user:github:${commit.authorLogin ?? 'unknown'}`;
  return {
    content,
    kind: 'raw',
    scope: scopeFromRepository(repository, site.host),
    artifactRef: githubCommitLessonRef(repository.full_name, commit.sha, kind, site.host),
    owner: login,
    tags: [
      'source:github',
      `repo:${githubRepoKey(repository.full_name, site.host)}`,
      `event:${kind}`,
      login,
    ],
  };
}

export function revertLessonOpts(commit: LessonCommit, parts: RevertParts): LessonOpts {
  const web = githubWebOrigin(commit.site);
  const full = commit.repository.full_name;
  const again = parts.action === 'reapplied';
  const lines = [
    `${again ? 'Reapplied' : 'Reverted'} on the default branch of ${full}: "${cap(parts.original)}".`,
  ];
  if (parts.reason !== null) lines.push(`Reason given: ${cap(parts.reason)}`);
  lines.push(`${again ? 'Reapply' : 'Revert'}: ${web}/${full}/commit/${commit.sha}`);
  const original = again ? 'Undoes' : 'Original';
  if (parts.revertsSha !== null) {
    lines.push(`${original}: ${web}/${full}/commit/${parts.revertsSha}`);
  }
  if (parts.revertsPull !== null) {
    lines.push(`${original}: ${web}/${parts.revertsPull.repo}/pull/${parts.revertsPull.number}`);
  }
  return lessonOpts(commit, 'revert', lines.join('\n'));
}

function ownerLines(label: string, marker: '+' | '-', lines: readonly string[]): string {
  if (lines.length === 0) return `${label} none`;
  const shown = lines.slice(0, MAX_OWNER_LINES).map((l) => `${marker} ${cap(l)}`);
  const more = lines.length - shown.length;
  if (more > 0) shown.push(`(${more} more lines; see the commit)`);
  return `${label}\n${shown.join('\n')}`;
}

/** What a CODEOWNERS commit changed: its subject and the file's entry, null when GitHub gave none. */
export interface CodeownersChange {
  readonly path: string;
  readonly subject: string;
  readonly entry: CodeownersEntry | null;
}

export function codeownersLessonOpts(commit: LessonCommit, change: CodeownersChange): LessonOpts {
  const web = githubWebOrigin(commit.site);
  const full = commit.repository.full_name;
  const { path, subject, entry } = change;
  const lines = [`CODEOWNERS changed on the default branch of ${full} (${path}): ${cap(subject)}`];
  if (entry?.previousFilename != null) lines.push(`Renamed from ${entry.previousFilename}.`);
  if (entry?.patch == null) {
    lines.push('GitHub sent no diff for this file, so the owner lines are not listed.');
  } else {
    const { added, removed } = codeownersLineChanges(entry.patch);
    lines.push(ownerLines('Owner lines added:', '+', added));
    lines.push(ownerLines('Owner lines removed:', '-', removed));
  }
  lines.push(`Commit: ${web}/${full}/commit/${commit.sha}`);
  return lessonOpts(commit, 'codeowners', lines.join('\n'));
}

function lessonEvent(ref: string, deliveryId: string, eventName: string): ConnectorEvent {
  return {
    connector: 'github',
    idempotencyKey: computeIdempotencyKey(ref, null),
    deliveryId,
    eventName,
  };
}

/** True when a lesson with this ref is already logged. */
export async function lessonSeen(ctx: ConnectorContext, ref: string): Promise<boolean> {
  const seen = await ctx.store.connectorEvents.eventRecord(lessonEvent(ref, '', 'commit'));
  return seen.seen;
}

/** Writes a lesson once per ref, through the same untrusted path as an issue body. */
export async function ingestLesson(
  ctx: ConnectorContext,
  opts: LessonOpts,
  source: { readonly deliveryId: string; readonly eventName: string },
): Promise<IngestResult> {
  const event = lessonEvent(opts.artifactRef, source.deliveryId, source.eventName);
  const seen = await ctx.store.connectorEvents.eventRecord(event);
  if (seen.seen) return { status: 'duplicate', memoryId: seen.memoryId };
  return rememberWithEventLog(ctx, event, opts);
}

interface PushRevert {
  readonly sha: string;
  readonly subject: string;
  readonly parts: RevertParts;
  readonly authorLogin: string | null;
}

const PR_SUFFIX = / \(#\d+\)$/;

function pushReverts(commits: readonly JsonValue[]): PushRevert[] {
  const out: PushRevert[] = [];
  for (const c of commits) {
    if (!isJsonObject(c) || !isJsonString(c.id) || !SHA_RE.test(c.id)) continue;
    if (!isJsonString(c.message)) continue;
    const parts = parseRevertMessage(c.message);
    if (parts === null) continue;
    const username = isJsonObject(c.author) ? c.author.username : undefined;
    out.push({
      sha: c.id,
      subject: c.message.split(/\r?\n/, 1)[0].trim(),
      parts,
      authorLogin: isJsonString(username) ? username : null,
    });
  }
  return out;
}

/** One commit per original and action: each distinct reverted sha once, else the first commit
 * that is not a PR-title merge. A push gives no order, so no rule here reads one. */
function onePerOriginal(reverts: readonly PushRevert[]): PushRevert[] {
  const groups = new Map<string, PushRevert[]>();
  for (const r of reverts) {
    const key = `${r.parts.action}:${r.parts.original}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const kept = new Set<PushRevert>();
  for (const group of groups.values()) {
    const withSha = group.filter((r) => r.parts.revertsSha !== null);
    if (withSha.length === 0) {
      kept.add(group.find((r) => !PR_SUFFIX.test(r.subject)) ?? group[0]);
      continue;
    }
    const shas = new Set<string>();
    for (const r of withSha) {
      if (r.parts.revertsSha !== null && !shas.has(r.parts.revertsSha)) {
        shas.add(r.parts.revertsSha);
        kept.add(r);
      }
    }
  }
  return reverts.filter((r) => kept.has(r));
}

/** Writes a lesson for each revert a push to the default branch carries. */
export async function ingestPushLessons(
  ctx: ConnectorContext,
  evt: GitHubPushEvent,
  source: { readonly site: GitHubSite; readonly deliveryId: string },
): Promise<{ ingested: number; memoryIds: string[] }> {
  const memoryIds: string[] = [];
  if (evt.deleted === true || evt.ref !== `refs/heads/${evt.repository.default_branch}`) {
    return { ingested: 0, memoryIds };
  }
  for (const r of onePerOriginal(pushReverts(evt.commits))) {
    const commit: LessonCommit = {
      repository: evt.repository,
      sha: r.sha,
      authorLogin: r.authorLogin,
      site: source.site,
    };
    const result = await ingestLesson(ctx, revertLessonOpts(commit, r.parts), {
      deliveryId: source.deliveryId,
      eventName: 'push',
    });
    if (result.status === 'ingested' && result.memoryId !== null) memoryIds.push(result.memoryId);
  }
  return { ingested: memoryIds.length, memoryIds };
}
