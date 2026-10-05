# hippo

hippo-memory is a memory store for AI agents. Track W adds a work queue to it, where runtimes
claim cards. These terms have one fixed meaning in the hippo code, the `hippo` CLI and ROADMAP.md.

## Language

### Memory lifecycle

**Dormant memory**:
A memory sleep moved out of active memory instead of deleting it, because it faded
(`dormant.enabled`, on by default). It keeps its content and can be restored or forgotten for
good until `dormant.retentionDays` expires it.
_Avoid_: archived memory (the raw archive keeps metadata only), deleted, cold

**Churn-stale memory**:
A memory whose named file, code symbol or `npm run` script changed or disappeared in its own
repo's git history after the memory was stored or last confirmed (`churnStaleness.enabled`, off by
default). Tagged `churn-stale`, it ranks at half weight until a positive outcome confirms it.
Never deleted for it.
_Avoid_: invalidated (the commit-message path, which halves half-life), outdated, expired

**Superseded memory**:
A memory replaced by a newer one that states the changed fact: `superseded_by` names the
replacement. Context never injects it; recall and explain skip it unless asked
(`--include-superseded`, `--as-of`).
Only an explicit supersede sets it today (`hippo supersede`, `POST /v1/memories/:id/supersede`).
ROADMAP Z6's "retired" means superseded or invalidated, never deleted.
_Avoid_: deduped (sleep's dedup deletes a near-copy outright), dormant, stale

**Raw receipt**:
A `kind='raw'` memory: a connector message or imported note, append-only. Sleep never
deletes one; only the raw archive removes it.
_Avoid_: raw memory, transcript

**Compaction memory**:
A memory `hippo post-compact` saves from one item of the summariser's "Memories for hippo" list:
tagged `compaction-memory`, source `compaction:<session id>`, kind distilled, confidence observed.
It fades like any other memory. An item that restates a memory the project already holds is not
saved again; when another session restates it, that memory is strengthened as a recall would. The session that
compacted is not shown it again in its own prompts.
_Avoid_: summary memory (the summary lives in the compaction record), snapshot (the task snapshot is a different thing)

**Keep rule**:
A tag and a source prefix that together keep a memory out of automatic deletion; today one pair
per imported agent memory tool. Both must match, because a merge copies a source's tags onto
a row whose source is `consolidation`. `canAutoDelete` and `AUTO_DELETABLE_SQL` in `src/memory.ts`
apply it and change together. `hippo forget` and `hippo supersede` still work on a kept memory.
_Avoid_: pin (a person sets that), retention policy, allowlist

**Imported agent memory**:
A memory hippo copied from another coding agent's own memory: a Claude Code auto memory note, a Codex memory, and the
like. It follows its source item: kept while the item exists, superseded when the item changes, set aside as dormant
(restorable) when the item is deleted.
_Avoid_: synced memory, external memory, auto memory (Claude Code's own feature)

**Token ledger**:
The record of every block of memory text hippo handed an agent: surface, session, estimated
tokens, and whether it was sent or skipped as unchanged. Counts only, never the text.
_Avoid_: usage log, telemetry, cost log

**Delivery ledger**:
The optional per-turn record of the per-prompt hook: one event per call and one row per
candidate memory, saying whether it was emitted, reused or rejected and why.
Ids, hashes, counts and reasons only, never the text. Off by default; kept 90 days.
_Avoid_: delivery log, trace, telemetry

**Failure log**:
Every failed tool call the capture-error hook sees, stored as a memory or not: outcome, session,
tool, the routine rule that skipped it, and hashes of the error, never its text. Kept 90 days.
_Avoid_: error log, failure history

**Mirror**:
A file derived from `hippo.db` and written after the change commits: the markdown files,
`stats.json` and the conflict files. Never the source of truth; a failed mirror write warns and
the change stands. `index.json` is an export, written only by `rebuildIndex()`, not a mirror.
_Avoid_: cache, index (for the markdown files)

**Repeat**:
A rated failure (stored, duplicate or store-failed, from a session with an id) whose signature
another session hit first. Repeat-error rate compares repeats per session between a hippo arm and
a holdout arm; it is never reported as one absolute number.
_Avoid_: duplicate (that is a lesson hippo already holds), recurrence

**At-risk memory**:
An unpinned memory whose strength, projected 30 days ahead, falls under 0.2. The dashboard's
Health view counts and colours projects by their share of these. A pinned memory is never at risk.
_Avoid_: fading (that is the 0.2 to 0.5 band), weak, stale (that is a confidence tier)

### Access

**Origin project**:
The lowercased project a memory was captured in (`origin_project`). An empty string means
user-global, shown as Global; null means a row from before schema v39, shown as Unassigned.
The Health view groups memories by it. Unlike scope, it grants no access.
_Avoid_: project scope, workspace, repo (for the grouping)


**Scope**:
The access boundary of a memory's source, one channel or one repo (`slack:private:C123`,
`github:public:org/repo`), stored on the memory. Null means no boundary.
_Avoid_: ACL, permission, visibility

**Restricted scope**:
A scope default recall hides: `<source>:private:*` (including `quarantine:private:*`), or a
quarantine bucket such as `unknown:legacy`. Reading one means naming it.
_Avoid_: private scope (it covers quarantine too), secret scope

**Scope grant**:
Permission for one member API key to read one restricted scope. Admin keys, the local CLI and
stdio MCP need none.
_Avoid_: ACL entry, share, permission

**Auth resolver**:
A function the server asks to vouch for a bearer token that is not an API key. Tokens are routed
by shape: an `hk_` token goes only to API-key validation, any other token only to the resolver.
Returns a tenant, subject, role and scope grants, or nothing (a 401). It throws only when its
upstream is down; a throw or a missed deadline is a 503, which a stream heartbeat skips rather than
treating as revocation. It runs on every authenticated request and every stream heartbeat, so it
must be cache-backed. Its admin role is tenant admin: no other tenant's audit log, no host-wide
sleep. It can mint and revoke member API keys only. A key a member mints for itself expires; a
member key an admin mints never does, so it keeps working after the user leaves the identity
provider until someone revokes it.
_Avoid_: auth plugin, identity provider

**Key owner**:
The auth-resolver subject that minted a self-service API key for itself. A member signed in
through the resolver lists and may revoke only the keys it owns; a key an admin or the CLI mints
has no owner.
_Avoid_: owner (alone; a claimant or assignee is something else), creator, minter

**Key expiry**:
The time after which an API key fails on every route. Self-service keys always have one; other
keys have none. The first key with an expiry raises the store's binary floor, since an older
binary would ignore it.
_Avoid_: TTL (that is the setting, not the time), expiry (alone; a reclaim is something else)

**Audit cursor**:
The last audit event id an exporter has read; `listAuditEventsAfter` returns the events after it.
Retention prune deletes events whether or not they were exported, so an exporter must keep up with
the prune window; gaps in ids are normal.
_Avoid_: offset, page token

**Derived memory**:
A memory built from other memories' content: a consolidation merge, a DAG summary or profile, an
extracted fact. It carries the restricted scope of its sources and is never built from sources in
two different restricted scopes, or from a restricted and an unrestricted one.
_Avoid_: summary (one kind only), rollup

**Quarantined memory**:
Connector-ingested text that reads like instructions to an agent, held under a
`quarantine:private:<original scope>` restricted scope until an admin approves (scope restored) or
rejects it (stays hidden).
_Avoid_: flagged memory, poisoned memory

### Work queue

**Card**:
A claimable unit of work: runtimes compete for one card and the first claim wins.
_Avoid_: task, ticket, job

**Run**:
One runtime's claim of a card, lasting until the card is blocked, reclaimed or completed.
_Avoid_: attempt, session

**Live run**:
The one run of a card that has not ended. A card has exactly one while running or in review, and
none otherwise.
_Avoid_: current run, open attempt

**Run id**:
The number of a run. Quoting the live run's id is how a runtime proves a card is still its own.
_Avoid_: fencing token, receipt, lock id

**Claimant**:
The runtime whose run is a card's live run.
_Avoid_: holder, owner, worker

**Assignee**:
The runtime a card names: its claimant while running or in review, the runtime of its last run once
done or shelved, and none otherwise.
_Avoid_: owner, worker

**Lease**:
The time until which a running card's claimant counts as alive. A lease has expired once that
time has passed, and a running card with no lease counts as expired.
_Avoid_: lock, timeout, TTL

**Heartbeat**:
A claimant's signal that it is still working on a running card, which moves the lease forward.
_Avoid_: ping, keepalive, renewal

**Reclaim**:
The sweep that returns every running card whose lease has expired to ready.
_Avoid_: expiry, steal, requeue, release

**Board**:
Every card in the work queue, laid out in one column per status.
_Avoid_: kanban, tracker

### Hooks

**Hook payload**:
The JSON a host writes to a hook command's stdin at spawn. Optional, and absent only counts as a manual run when the read finished on its own; a read that timed out proves nothing either way.
_Avoid_: stdin text, hook input, hook data

**Compaction record**:
The row in the `compactions` table for one Claude Code compaction: `hippo pre-compact` writes it
`started`, `hippo post-compact` moves it to `summarised` and then `done`. It holds the session,
whether a task snapshot was saved, the summary with secrets scrubbed, every item of the "Memories
for hippo" list and how many became memories. It is not a memory: recall, context and sleep's memory
passes never read it. `hippo sleep`, or the daily runner for the global store, finishes one left
`started` or `summarised` for over 10 minutes;
a compaction that never wrote a summary is closed as `no-summary`.
_Avoid_: compaction summary, compaction log, snapshot

**User correction**:
A human message that tells the agent something it just did, said, proposed or assumed is wrong
or unwanted, or turns it against that. A detected one is a candidate lesson, not a stored memory.
_Avoid_: feedback (outcomes are feedback too), complaint, redirect

**Sub-agent transcript**:
The JSONL file Claude Code writes for one delegated agent, in the parent session's `subagents/`
folder and apart from the parent's own transcript. Each turn ends in a text-only message that goes
back to the parent; the last one is its final report. Session-end capture reads only the parent's.
_Avoid_: sidechain log, child transcript

### Support

**Support bundle**:
The JSON file `hippo support-bundle` writes for a support ticket: versions, doctor checks, config
with secret fields redacted, store counts and log file names. It never holds memory text, except
in the log lines `--include-logs` adds, which can quote it.
_Avoid_: diagnostics dump, debug archive (it is one JSON file)

**Supported line**:
A minor version (`x.y`) promoted to the `stable` npm tag. It gets security and data-loss fixes as
patch releases for 12 months from that promotion, even after `stable` moves on.
_Avoid_: LTS
