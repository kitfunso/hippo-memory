# hippo

hippo-memory is a memory store for AI agents. Track W adds a work queue to it, where runtimes
claim cards. These terms have one fixed meaning in the hippo code, the `hippo` CLI and ROADMAP.md.

## Language

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
