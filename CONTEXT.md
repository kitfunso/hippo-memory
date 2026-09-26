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

**Raw receipt**:
A `kind='raw'` memory: a connector message or imported note, append-only. Sleep never
deletes one; only the raw archive removes it.
_Avoid_: raw memory, transcript

**Token ledger**:
The record of every block of memory text hippo handed an agent: surface, session, estimated
tokens, and whether it was sent or skipped as unchanged. Counts only, never the text.
_Avoid_: usage log, telemetry, cost log

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

### Access

**Scope**:
The access boundary of a memory's source, one channel or one repo (`slack:private:C123`,
`github:public:org/repo`), stored on the memory. Null means no boundary.
_Avoid_: ACL, permission, visibility

**Restricted scope**:
A scope default recall hides: `<source>:private:*`, or a quarantine bucket such as
`unknown:legacy`. Reading one means naming it.
_Avoid_: private scope (it covers quarantine too), secret scope

**Scope grant**:
Permission for one member API key to read one restricted scope. Admin keys, the local CLI and
stdio MCP need none.
_Avoid_: ACL entry, share, permission

**Derived memory**:
A memory built from other memories' content: a consolidation merge, a DAG summary or profile, an
extracted fact. It carries the restricted scope of its sources and is never built from sources in
two different restricted scopes, or from a restricted and an unrestricted one.
_Avoid_: summary (one kind only), rollup

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
