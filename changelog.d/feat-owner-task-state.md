### Added

- **A shared store keeps each developer's task state apart.** On a store with `sharedStore: true`, snapshots, handoffs and failure log rows carry the caller's owner and project. A developer's prompt context, recall and compact-resume show only their own snapshot and handoff, in any of their sessions in that project. Local stores are unchanged.
- **`hippo-memory/server` exports five calls for a hook caller on another machine.** `preCompactForCaller`, `compactResumeForCaller`, `saveCompactionItemsForCaller`, `captureFailureForCaller` and `sessionEndHandoffForCaller` each bind the session to the caller's owner first, then write under the context's tenant, the key's owner and the caller's project. None reads the environment or the working directory. A retry of `saveCompactionItemsForCaller` or `captureFailureForCaller` with the same request id gets the first answer and writes nothing twice. A request id another session already sent gets `ConflictError`, so no caller can read, settle or finish another session's row.
- **`bindSessionOwner` and `ownerOrSubject` are on `hippo-memory/server`.** A session id belongs to the first owner that writes for it. Another owner gets `ConflictError`.
- **`hippo-memory/session-text` gains `transcriptWorkingState`, `WORKING_STATE_CAPS`, `lessonFromFailure`, `failureReport`, `collectHandoffEvidence` and the compaction item parsers.** None of them imports the store, so a hook with no store can read a session with them.
- **`Actor` gains `owner`.** It is an owned key's owner, and MCP over HTTP carries it too.

### Changed

- **Schema v54 adds owner columns and a `session_owners` table. The first owner row makes older binaries refuse the store.** Rows from before v54 stay unowned and never reach an owner's read. The first session bind or owner snapshot raises `min_compatible_binary` to `TASK_OWNER_MIN_BINARY`, because an older binary would close other developers' snapshots. Back up the store and upgrade every hippo binary that shares it before developers start using it.
- **`scripts/check-expiring-keys-floor.mjs` checks `TASK_OWNER_MIN_BINARY` too.** It also fails on a checkout with no git tags, where every tag check would pass by finding nothing, and on a floor that names no release tag unless it is the package version being released.
- **Both binary floors are 1.64.0, the first release that ships v53 and v54.** At 1.63.2 they equalled the released binary, which has neither, so the floors shut no older binary out.

### Fixed

- **A failure text is cut to 200 characters after the sharing scrub, not before.** A mask can be longer than what it hides, so the old order could push the text past the limit. `failureReport` now scrubs and then cuts, and `captureFailureForCaller` scrubs and cuts again. The cut never splits an emoji or other character outside the Basic Multilingual Plane. A caller's working state and compaction items are cut back to their caps after the server's scrub in the same way, and an item sent past 500 characters is refused.
- **The per-prompt hook shows the task snapshot and handoff when no memory is picked.** Before, a prompt that matched no memory, with nothing pinned, printed nothing, and the snapshot and handoff were dropped with it. Since prompt recall became the default, any such prompt hit this. Turning off `pinnedInject` still prints nothing.
