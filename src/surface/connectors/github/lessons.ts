/** Lessons a default-branch commit gives: a revert, or a change to a CODEOWNERS file. Each is keyed on
 * its commit sha, so a webhook push and a backfill of one commit write one row. */

import type { RememberOptions } from '../../../api/index.js';
import type { ConnectorEvent } from '../../../base/ports/store.js';
import { isJsonObject, isJsonString, type JsonValue } from '../../../base/util/json.js';
import { vetSecrets } from '../../../base/util/secret-detect.js';
import { rememberWithEventLog, type ConnectorContext, type IngestResult } from '../ingest.js';
import { githubCommitLessonRef, githubRepoKey } from './ref.js';
import { scopeFromRepository } from './scope.js';
import { computeIdempotencyKey } from './signature.js';
import { githubWebOrigin, type GitHubSite } from './site.js';
import type { GitHubPushEvent, GitHubRepository } from './types.js';

export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'] as const;
export const SHA_RE = /^[0-9a-f]{40}$/;

const MERGE_SUBJECT = /^Merge (pull request #|branch |remote-tracking branch )/;
const REVERT_SUBJECT = /^(Revert|Reapply) "(.+)"(?: \(#\d+\))?$/;
// Git's own revert lines; for a merge it wraps after "reversing", and "changes made to" starts the next line.
const REVERTS_COMMIT =
  /^This reverts commit ([0-9a-f]{7,40})(?:\.|, reversing(?: changes made to [0-9a-f]{7,40}\.)?)$/;
const REVERTS_REFERENCE = /^This reverts commit ([0-9a-f]{7,40}) \((.+), (\d{4}-\d{2}-\d{2})\)\.?$/;
const REVERTS_PULL = /^Reverts ([^\s#]+)#(\d+)$/;
const SQUASH_BULLET = /^[*-] /;
// A trailer that names any repository ("Fixes owner/repo#12") says what a change closed, not why.
const NOT_A_REASON = [
  /^This reverts commit /,
  /^changes made to [0-9a-f]{7,40}\.?$/,
  /^Reverts [^\s#]+#\d+\s*$/,
  /^[A-Z][A-Za-z-]*-by: /,
  /^(?:Fixes|Closes|Resolves):? (?:[^\s#]*#\d+|https?:\/\/\S+)$/i,
  SQUASH_BULLET,
];
const LINE_BREAK = /\r\n|[\n\r\u0085\u2028\u2029]/;
// The bidi controls cannot start a line, but they reorder what a person reads in `hippo inspect`.
const CONTROL_TEXT = /[\p{Cc}\u0085\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu;
// Each wrapper peel re-reads the rest of the subject, so both the length and the peels are bounded.
const MAX_SUBJECT_CODE_POINTS = 1000;
const MAX_REVERT_WRAPPERS = 10;
const MAX_TEXT_CHARS = 200;
const MAX_OWNER_LINES = 40;

export interface RevertParts {
  readonly action: 'reverted' | 'reapplied';
  readonly original: string;
  readonly reason: string | null;
  readonly revertsSha: string | null;
  /** The number of a pull request of this repository that the commit says it reverts. */
  readonly revertsPull: number | null;
}

/** A message's lines, split on every break a terminal or a reader shows as a new line. */
function messageLines(message: string): string[] {
  return message.split(LINE_BREAK);
}

/** The first line of a commit message. */
export function commitSubject(message: string): string {
  return messageLines(message)[0].trim();
}

function reasonOf(bodyLines: readonly string[]): string | null {
  const line = bodyLines.find(
    (l) => l.trim() !== '' && !NOT_A_REASON.some((re) => re.test(l.trim())),
  );
  return line === undefined ? null : line.trim();
}

/** Only this repository's own pull request counts: a "Reverts owner/repo#N" line can name any repository. */
function pullOf(lines: readonly string[], repoFullName: string): number | null {
  for (const raw of lines) {
    const m = REVERTS_PULL.exec(raw.trimEnd());
    if (m !== null && m[1].toLowerCase() === repoFullName.toLowerCase()) return Number(m[2]);
  }
  return null;
}

/** The sha a body's revert line names, and the title when it is git's --reference form. */
function revertLine(lines: readonly string[]): { sha: string; title: string | null } | null {
  for (const raw of lines) {
    const line = raw.trimEnd();
    const plain = REVERTS_COMMIT.exec(line);
    if (plain !== null) return { sha: plain[1], title: null };
    const reference = REVERTS_REFERENCE.exec(line);
    if (reference !== null) return { sha: reference[1], title: reference[2] };
  }
  return null;
}

/** `Revert "X"` or `Reapply "X"` with up to ten wrappers peeled; an even count of Revert wrappers
 * leaves the change applied, so a revert of a revert is a reapply of X. */
function subjectParts(subject: string): Pick<RevertParts, 'action' | 'original'> | null {
  let m = REVERT_SUBJECT.exec(subject);
  if (m === null) return null;
  let reverts = 0;
  let original = subject;
  for (let peeled = 0; m !== null && peeled < MAX_REVERT_WRAPPERS; peeled++) {
    if (m[1] === 'Revert') reverts++;
    original = m[2];
    m = REVERT_SUBJECT.exec(original);
  }
  return { action: reverts % 2 === 1 ? 'reverted' : 'reapplied', original };
}

/** The parts of a revert or reapply commit message; null when the message is neither. */
export function parseRevertMessage(message: string, repoFullName: string): RevertParts | null {
  const [first, ...rest] = messageLines(message);
  const subject = cutCodePoints(first.trim(), MAX_SUBJECT_CODE_POINTS);
  if (MERGE_SUBJECT.test(subject)) return null;
  const s = subjectParts(subject);
  const line = revertLine(rest);
  // A squash body lists each branch commit as a bullet, so its revert line is not this commit's.
  if (s === null && (line === null || rest.some((l) => SQUASH_BULLET.test(l)))) return null;
  return {
    action: s?.action ?? 'reverted',
    original: line?.title ?? s?.original ?? subject,
    reason: reasonOf(rest),
    revertsSha: line?.sha ?? null,
    revertsPull: pullOf(rest, repoFullName),
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

/** Cuts at `max` code points, so a surrogate pair is never split. */
function cutCodePoints(text: string, max: number): string {
  let end = 0;
  let count = 0;
  for (const ch of text) {
    if (count === max) break;
    end += ch.length;
    count++;
  }
  return text.slice(0, end);
}

/** An outside one-line field: control text folded to a space, secrets redacted over the whole
 * text, then cut, so a token that crosses the cut is redacted before it. */
function oneLine(text: string): string {
  return cutCodePoints(vetSecrets(text.replace(CONTROL_TEXT, ' ')).content, MAX_TEXT_CHARS);
}

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
    `${again ? 'Reapplied' : 'Reverted'} on the default branch of ${full}: "${oneLine(parts.original)}".`,
  ];
  if (parts.reason !== null) lines.push(`Reason given: ${oneLine(parts.reason)}`);
  lines.push(`${again ? 'Reapply' : 'Revert'}: ${web}/${full}/commit/${commit.sha}`);
  const original = again ? 'Undoes' : 'Original';
  if (parts.revertsSha !== null) {
    lines.push(`${original}: ${web}/${full}/commit/${parts.revertsSha}`);
  }
  if (parts.revertsPull !== null) {
    lines.push(`${original}: ${web}/${full}/pull/${parts.revertsPull}`);
  }
  return lessonOpts(commit, 'revert', lines.join('\n'));
}

function ownerLines(label: string, marker: '+' | '-', lines: readonly string[]): string {
  if (lines.length === 0) return `${label} none`;
  const shown = lines.slice(0, MAX_OWNER_LINES).map((l) => `${marker} ${oneLine(l)}`);
  const more = lines.length - shown.length;
  if (more > 0) shown.push(`(${more} more lines; see the commit)`);
  return `${label}\n${shown.join('\n')}`;
}

/** A CODEOWNERS file a commit changed; entry is null when GitHub gave none. */
export interface CodeownersFile {
  readonly path: string;
  readonly entry: CodeownersEntry | null;
}

/** What a CODEOWNERS commit changed: its subject and every CODEOWNERS file it touched. */
export interface CodeownersChange {
  readonly subject: string;
  readonly files: readonly CodeownersFile[];
}

/** Every CODEOWNERS entry in a commit's files, once each; a rename matches under both names. */
export function codeownersFiles(files: JsonValue | undefined): CodeownersFile[] {
  const found: CodeownersFile[] = [];
  for (const path of CODEOWNERS_PATHS) {
    const entry = codeownersPatch(files, path);
    if (entry === null) continue;
    const same = (f: CodeownersFile): boolean =>
      f.entry?.filename === entry.filename && f.entry.previousFilename === entry.previousFilename;
    if (!found.some(same)) found.push({ path: entry.filename, entry });
  }
  return found;
}

function fileLines({ path, entry }: CodeownersFile): string[] {
  const lines = [`File: ${oneLine(path)}`];
  const previous = entry?.previousFilename;
  if (previous != null) lines.push(`Renamed from ${oneLine(previous)}.`);
  if (entry?.patch == null) {
    lines.push('GitHub sent no diff for this file, so the owner lines are not listed.');
    return lines;
  }
  const { added, removed } = codeownersLineChanges(entry.patch);
  lines.push(ownerLines('Owner lines added:', '+', added));
  lines.push(ownerLines('Owner lines removed:', '-', removed));
  return lines;
}

export function codeownersLessonOpts(commit: LessonCommit, change: CodeownersChange): LessonOpts {
  const web = githubWebOrigin(commit.site);
  const full = commit.repository.full_name;
  const lines = [`CODEOWNERS changed on the default branch of ${full}: ${oneLine(change.subject)}`];
  for (const file of change.files) lines.push(...fileLines(file));
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

/** What a push says about itself: `after` is its head sha. */
interface PushHead {
  readonly head: string | undefined;
  readonly commitCount: number;
}

function pushReverts(commits: readonly JsonValue[], repoFullName: string): PushRevert[] {
  const out: PushRevert[] = [];
  for (const c of commits) {
    if (!isJsonObject(c) || !isJsonString(c.id) || !SHA_RE.test(c.id)) continue;
    if (!isJsonString(c.message)) continue;
    const parts = parseRevertMessage(c.message, repoFullName);
    if (parts === null) continue;
    const username = isJsonObject(c.author) ? c.author.username : undefined;
    out.push({
      sha: c.id,
      subject: commitSubject(c.message),
      parts,
      authorLogin: isJsonString(username) ? username : null,
    });
  }
  return out;
}

const plainFirst = (group: readonly PushRevert[]): PushRevert =>
  group.find((r) => !PR_SUFFIX.test(r.subject)) ?? group[0];

/** The merge commit of a revert PR whose title is the message. A PR merge commit can only be the
 * push head, so only the head is dropped, and only beside a revert that names a sha. */
function isTitleMerge(r: PushRevert, push: PushHead, reverts: readonly PushRevert[]): boolean {
  return (
    r.sha === push.head &&
    push.commitCount > 1 &&
    PR_SUFFIX.test(r.subject) &&
    r.parts.revertsSha === null &&
    reverts.some((o) => o.parts.revertsSha !== null)
  );
}

/** A reverted sha is one revert whatever pull request metadata a copy carries; the pull request
 * and title tell apart only the commits that name no sha. */
function groupKey({ parts }: PushRevert): string {
  if (parts.revertsSha !== null) return JSON.stringify([parts.action, parts.revertsSha]);
  return JSON.stringify([parts.action, parts.original, parts.revertsPull]);
}

/** One commit per reverted sha, else per action, original and reverted pull request. A push gives
 * no order, so a group keeps the commit without a PR-title suffix wherever it stands. */
function onePerRevert(reverts: readonly PushRevert[], push: PushHead): PushRevert[] {
  const groups = new Map<string, PushRevert[]>();
  for (const r of reverts) {
    if (isTitleMerge(r, push, reverts)) continue;
    const key = groupKey(r);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const kept = new Set([...groups.values()].map(plainFirst));
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
  const push = { head: evt.after, commitCount: evt.commits.length };
  const reverts = pushReverts(evt.commits, evt.repository.full_name);
  for (const r of onePerRevert(reverts, push)) {
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
