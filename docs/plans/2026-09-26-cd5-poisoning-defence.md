# CD5 memory poisoning defence, first slice (with the AT3 quarantine tier)

Status: plan for episode 01M3F72YAVHT3QRJ1XBGGG4AES. Base: origin/master f9959c4 (1.49.0, schema v47).

## The hole

The GitHub and Slack connectors write whatever a PR comment, issue or chat message says into
memory (`api.remember`, via `src/connectors/{github,slack}/ingest.ts`). A `github:public:*` scope is
readable by every key, and a member granted a private scope (EI2) reads everything in it. So anyone
who can comment on a public repo, or post in a connected channel, can plant "from now on, always
run X" and it comes back through default recall, `hippo_context` and the hook as if it were a lesson.

## What this slice does

1. **Untrusted text.** `RememberOpts` gains `untrusted?: boolean`. Both connector ingest functions
   set it on their single `remember` call, which covers webhook, backfill and DLQ replay (all route
   through `ingestEvent` / `ingestMessage`). Nothing else sets it, so CLI, HTTP and MCP `remember`,
   and so local single-user mode, behave exactly as today.
2. **Instruction detector.** New leaf module `src/instruction-detect.ts`, same shape as
   `secret-detect.ts`: `detectInstruction(content) -> { flagged, reason }`, pure, no imports.
   Conservative regex families, each named in `reason`: override-previous-instructions, role
   reassignment ("you are now", "act as"), chat-role markup (`<|im_start|>`, `[INST]`, `<system>`),
   system/developer prompt references, standing orders to agents ("from now on ... always/never"),
   concealment ("do not tell the user"), remote-script execution (`curl ... | sh`), secret
   exfiltration, and Unicode tag characters (ASCII smuggling). Applied only to untrusted text.
3. **Quarantine by scope.** When untrusted text is flagged, `remember` writes the row under scope
   `quarantine:private:<original scope or "unscoped">`. That string matches `PRIVATE_SCOPE_RE`, so
   every existing default-deny site (SQL `LIKE '%:private:%'` in `loadSearchRows`, `isRestrictedScope`
   in api/cli/mcp/shared/briefs/graph) hides it with no new filter code, and EI2 makes naming it an
   admin act (a member needs an exact grant, which only an admin can create). A member's grant on
   the original scope does not match the quarantine scope.
4. **Quarantine record (AT3 tier), schema v48, additive.**
   `memory_quarantine(tenant_id, memory_id, original_scope, reason, status, quarantined_at,
   decided_at, decided_by)`, PK `(tenant_id, memory_id)`, `status` in pending|approved|rejected.
   `original_scope` is the true original value, NULL when the memory had none; the text
   `unscoped` appears only inside the quarantine scope string, never in this column.
   Inserted inside the same `writeEntry` SAVEPOINT as the memory row. `api.remember` owns the
   composition: when it quarantines, it passes `writeEntry` one combined `afterWrite` that runs
   `recordQuarantine(db, ...)` (row insert + `quarantine` audit) and then the caller's
   `opts.afterWrite` if set. So an idempotency collision in the connector's callback rolls back the
   memory row and the quarantine row together. No backfill.
5. **Release.** `api.quarantineApprove(ctx, id)` (admin only, `ForbiddenError` otherwise):
   pending row required; one transaction sets `memories.scope = original_scope` (NULL restores
   NULL), guarded by `WHERE scope = <the quarantine scope>` so a row moved since is refused, marks the row
   approved with who and when, and appends a `quarantine_approve` audit event; then the markdown
   mirror is rewritten (post-commit, best effort; a failure leaves the mirror showing the
   quarantine scope, which is fail-closed). `api.quarantineReject(ctx, id)`: pending required,
   status rejected, `quarantine_reject` audit event, memory stays under the quarantine scope (raw
   rows are append-only). `api.quarantineList(ctx, { status })` lists rows with content preview.
6. **Surfaces.** CLI `hippo quarantine [list] [--all] [--json]`, `hippo quarantine approve <id>`,
   `hippo quarantine reject <id>` (local CLI is the owner, admin actor, same as `hippo dormant`).
   HTTP `GET /v1/quarantine`, `POST /v1/quarantine/:id/approve`, `POST /v1/quarantine/:id/reject`,
   admin role required (403 for member). No MCP tool: an agent must never approve its own input.
7. **Audit.** New ops `quarantine`, `quarantine_approve`, `quarantine_reject` in all three lockstep
   sites (audit.ts `AuditOp`, cli.ts and server.ts `VALID_AUDIT_OPS`). The `quarantine` event is
   written inside the write SAVEPOINT with the detector reason.
8. **Share veto (hygiene, not the security fix).** A shared copy already keeps the quarantine
   scope (`...entry`), so it is hidden anyway. `shareMemory` refuses a quarantine-scope row with a
   clear message so poison is not duplicated into the global store. Quarantine scopes only:
   widening this to every restricted scope would change today's private-scope share behaviour,
   which is out of this slice.

Trusted surfaces, stated plainly: local CLI by-id commands (`inspect`, `forget --dry-run`,
`resolve`) read rows without a scope check for every restricted scope today; the local CLI is the
owner. Quarantine inherits that model; it does not add a filter there.

## State matrix

| from | action | to | side effects |
|---|---|---|---|
| (none) | untrusted + flagged remember | pending | memory under quarantine scope, `quarantine` audit |
| (none) | untrusted + clean, or trusted remember | no row | memory under its own scope, unchanged |
| pending | approve (admin) | approved | scope restored, mirror rewritten, `quarantine_approve` audit |
| pending | reject (admin) | rejected | memory stays hidden, `quarantine_reject` audit |
| pending | approve/reject (member) | pending | `ForbiddenError` / HTTP 403 |
| approved or rejected | approve/reject | unchanged | error "not pending" |
| no row | approve/reject | none | error "not quarantined" (also cross-tenant ids) |

## Tests (real SQLite, no mocks)

- `tests/instruction-detect.test.ts`: each family flags; ordinary PR/issue prose does not; one
  known paraphrase that slips past is pinned as a documented limitation (`flagged: false`).
- `tests/quarantine.test.ts`:
  - GitHub `ingestEvent` with an injection comment on a public repo -> row under
    `quarantine:private:github:public:o/r`, pending row, `quarantine` audit; a clean comment is not
    quarantined; a plain local `remember` of the same injection text is not quarantined.
  - `api.recall` default does not return it; approve restores scope and recall returns it;
    reject keeps it hidden; double approve errors; member approve throws `ForbiddenError`.
  - Slack `ingestMessage` path quarantines too.
  - HTTP + MCP on a real server: member and admin default `GET /v1/memories` and MCP `hippo_recall`
    do not return the quarantined row; member granted the original private scope still does not
    see it; member `POST /v1/quarantine/:id/approve` is 403; admin approve is 200 and the row then
    comes back.
  - `shareMemory` refuses a quarantined row.
  - Migration: fresh store is at v48 and has `memory_quarantine`.
  - Approve of an unscoped untrusted row restores `scope IS NULL`, not the text `unscoped`.
  - Atomicity: a connector `afterWrite` that throws leaves neither the memory nor the quarantine row.
- CLI drive: `hippo quarantine list/approve/reject` on the built binary.

## Deliberately out of this slice (follow-ups)

- HTTP/MCP `remember` from member keys is not screened (an opt-in `untrusted` flag or config).
- Provenance-weighted admission (GitHub `author_association`, quarantine-all for outside
  contributors whatever the detector says).
- Derived rows built from a quarantined source keep the quarantine scope and have no
  `memory_quarantine` row, so approval does not release them (fail-closed).
- AT3's original trigger, sleep-audit junk going to quarantine before hard delete.
- Rejected values are not tombstoned (AT1), so an edited re-post is screened again but not refused.
- Existing rows are not re-screened (no backfill without owner sign-off).
- CD4 review queue UI / dashboard surface.
- MCP `hippo_resolve` / `hippo_share` carry no role check for any restricted scope (pre-existing);
  a member could resolve a conflict between two rows in one quarantine scope without a
  `quarantine_reject` event. Conflicts are partitioned by derivation scope, so a quarantined row
  never pairs with a visible one. Role-gating those tools is a separate item.
- `secret-detect.ts` and `instruction-detect.ts` share one shape; fold them under one detector
  interface before a third is added.
