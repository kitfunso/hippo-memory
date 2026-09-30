# Keep automatic global fallback separate from explicit continuity

Date: 2026-09-30
Status: accepted
Links: https://github.com/kitfunso/hippo-memory/pull/343

## Context
Projectless CLI recall and context could miss an initialized global store. Selecting that store also made task-state readers assume its unfinished task belonged to the caller.

## Constraints and evidence
- `tests/store-root-walkup.test.ts` seeds foreign active snapshot, handoff and events. Matching and no-match built CLI fallback must exclude all three while returning eligible memories.
- `tests/codex-hooks.test.ts` drives the installed command, checking pin delivery, global source labels, repeat suppression, foreign-handoff exclusion and global opt-out.
- `tests/mcp-recall-continuity.test.ts` preserves public opt-in and explicitly authorized private-scope continuity from a deliberately selected API store. A blanket global API guard failed both existing contracts.
- The final source commit `67e8725` passes the full root suite and CI. Reproduce with `npx vitest run --maxWorkers=4`; detailed results are in the local episode trajectory.

## Decision
Reuse the existing project-then-global store selector for CLI recall and context. Search and account a global primary once, retaining its physical source labels. Automatic context and CLI fallback continuity omit global task state until the caller-project boundary is proven. Preserve the existing explicit-root API/MCP scoped opt-in continuity contract.

## Alternatives considered
- Restrict only the pinned hook route: ordinary context and direct CLI continuity still expose unrelated task state.
- Deny global continuity in every API call: breaks published explicit opt-in and private-scope behavior.
- Match global task state to the caller immediately: requires a proven project identity and admission contract beyond this bounded store-discovery fix.

## Consequences
- Projectless callers can receive eligible global memories without borrowing another project's unfinished task.
- Explicit scoped API continuity remains available. This is not proof of delivery or task benefit across other coding agents.
- Globally stored task delivery stays deferred; ranking and memory admission policies are unchanged.

## Reconsider when
- A caller-project identity contract and negative wrong-project fixtures prove safe global task-state delivery across the supported runtimes.
