# Plan: E2 first-class `skill` object (executable / exportable)

- Date: 2026-05-30
- Episode: 01KSWHXW8G8X8YGDB0G58MKFM2 (/dev-framework-rl, project_type=backend)
- Status: Draft (not yet engineering-reviewed)

## Goal

Promote `skill` to a first-class E2 object (after decision/prediction/incident/
process/policy), mirroring `src/processes.ts`. ROADMAP-RESEARCH specs it as
"executable; exports to AGENTS.md / CLAUDE.md". A skill is a reusable,
agent-followable capability: an instruction body + an optional trigger
(when to apply), evolving via the supersede delta lifecycle, with an EXPORT
renderer that emits the active skills as a markdown block for an agent
instruction file.

## Key design: "executable" = agent-followable-instruction-that-exports (NOT code exec)

The brainstorm grill settled the central ambiguity: literal code/command execution
from a stored memory row is a remote-code-execution non-starter for a memory
library, so it is OUT for v1. The safe + faithful reading of "executable; exports
to AGENTS.md/CLAUDE.md": a skill is an **executable instruction** - once exported
into the agent's in-force rules (AGENTS.md / CLAUDE.md), the agent reading it
executes it. The distinguishing capability is therefore the EXPORT renderer, not a
runtime. Literal execution is explicitly deferred (future, behind a sandbox).

skill reuses the process supersede machinery verbatim (superseded_by self-FK + CAS
+ INSERT-preflight + server-derived version + change_summary + supersede
tenant-match trigger). It DROPS process's `steps` (a skill's content is a single
`instructions` body) and ADDS `trigger_text` (optional).

Lifecycle: `active` -> `superseded` (a newer version replaces it) or `active` ->
`closed` (retired). Export renders ACTIVE skills only.

## The export renderer (the distinguishing deliverable)

`exportSkills(hippoRoot, tenantId): string` - renders the tenant's ACTIVE skills,
ordered by `skill_name` ASC (deterministic), into ONE markdown block:

```
## <skill_name>

**When:** <trigger_text>        (omitted when trigger is null)

<instructions>
```

(one H2 block per skill, separated by a blank line). Returns `''` when there are no
active skills (CLI prints "No active skills."). It RETURNS the string; it does NOT
write AGENTS.md / CLAUDE.md (writing those files is a separate operator action;
idempotent file-write with sentinels is deferred).

## Schema (migration v34) - NOTE: `trigger` is a SQL reserved word

`CURRENT_SCHEMA_VERSION` 33 -> 34. New `skills` table = the v32 processes table
minus `steps`, plus `instructions`/`trigger_text`:

- `id` INTEGER PK AUTOINCREMENT
- `memory_id` TEXT, FK -> memories(id) ON DELETE SET NULL
- `tenant_id` TEXT NOT NULL
- `skill_name` TEXT NOT NULL
- `instructions` TEXT NOT NULL
- `trigger_text` TEXT  (the optional "when to apply"; **named `trigger_text`, NOT
  `trigger`, because `TRIGGER` is a SQLite reserved keyword** - the TS domain field
  is `trigger`, mapped from the `trigger_text` column)
- `version` INTEGER NOT NULL DEFAULT 1
- `status` TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','closed'))
- `superseded_by` INTEGER, FK -> skills(id) ON DELETE SET NULL
- `superseded_at` TEXT
- `change_summary` TEXT
- `closed_at` TEXT
- `created_at` TEXT NOT NULL

Indexes: `idx_skills_tenant_status` (tenant_id, status), `idx_skills_memory`
(memory_id WHERE NOT NULL). Triggers (verbatim mirror, renamed): tenant-match
INSERT + UPDATE (vs memory) + supersede tenant-match UPDATE (self-FK).

No DB uniqueness on (tenant_id, skill_name): a partial-unique-active index would
fire mid-supersede (the INSERT-then-UPDATE pattern briefly has 2 active rows). The
supersede op is the intended way to update a skill; export renders whatever is
active. (Consistent with the other E2 objects; flagged for plan-eng.)

## Validation / DoS caps

- `skill_name` required, <= 256 chars; `instructions` required, <= 8192 (a body,
  so larger than the 4096 short-field cap); `trigger_text` optional, <= 1024;
  `change_summary` <= 4096. Enforced at the store (throws) + HTTP boundary (400).

## Module `src/skills.ts` (mirror processes.ts)

Exports: `SkillStatus`, `VALID_SKILL_STATES`, `Skill` (incl `skillName`,
`instructions`, `trigger: string|null`, `version`, `changeSummary`,
`supersededBy`), `SaveSkillOpts` (`skillName`, `instructions`, `trigger?`,
`changeSummary?`, `supersedesSkillId?`, `extraTags?`), `ListSkillsOpts`,
`saveSkill`, `closeSkill`, `loadSkillById`, `loadSkills`, `loadActiveSkills`,
`exportSkills`, `SKILL_HALF_LIFE_DAYS` (in memory.ts =90).

- `saveSkill`: memory mirror (tags `['skill', ...extra]`, source 'skill',
  confidence 'verified', layer Semantic, half_life SKILL_HALF_LIFE_DAYS) + skills
  row in the writeEntry SAVEPOINT. Supersede preflight (status='active' + version)
  before INSERT; CAS `id != newId`; server-derived version; change_summary. Emits
  `skill_create` (+ `skill_supersede`). Memory content = name + optional trigger +
  instructions.
- `closeSkill(id)`: CAS active-only; `skill_close`.
- `exportSkills`: read active, ORDER BY skill_name ASC, render the markdown block.
- Row<->domain maps `trigger_text` column <-> `trigger` field.

## 3-site audit lockstep

`skill_create`, `skill_supersede`, `skill_close` in audit.ts AuditOp union +
cli.ts VALID_AUDIT_OPS + server.ts VALID_AUDIT_OPS. Pinned by
`tests/audit-ops-skill-lockstep.test.ts`.

## CLI / HTTP / SDK (mirror processes; reuse shared helpers)

- CLI `cmdSkill`: `new "<name>" --instructions "<text>" [--trigger "<when>"]` /
  `list [--status]` / `get <id>` / `supersede <id> --instructions "<text>"
  [--trigger] [--change]` / `close <id>` / `export`. Strict `parsePositiveSkillId`
  (`/^\d+$/`). No repeatable flags (all single-value).
- HTTP `/v1/skills`: POST (new), GET (list+status; **reuse the shared
  `parseListLimit`**), GET `/v1/skills/export` (returns `{markdown}`; placed BEFORE
  the `/:id` GET), GET `/v1/skills/:id`, POST `/v1/skills/:id/supersede`, POST
  `/v1/skills/:id/close`. DoS caps; 404/409 mapping.
- Python SDK: `Skill` model + `new_skill`/`supersede_skill`/`close_skill`/
  `list_skills`/`get_skill`/`export_skills` (async + sync); `__init__` + BOTH
  `__all__` lists (models.py AND __init__.py - codex P3 carry-forward).

## Tests (real DB, no mocks)

- `tests/skills-store.test.ts`: dual-write SAVEPOINT atomicity; supersede CAS +
  version chain + self-supersede preflight; close guard (active-only;
  cannot-close-superseded); not-found vs wrong-state; cross-tenant triggers
  (memory + supersede); ON DELETE SET NULL + old-version-loadable; status filters;
  validation (missing name/instructions; caps); **exportSkills** (renders active
  only, name-ASC order, trigger omitted when null, excludes superseded/closed,
  empty -> ''); loadActiveSkills.
- `tests/http-skills.test.ts`: POST/GET/get/supersede/close + **GET /export**, auth
  gate, status validation, cross-tenant isolation, DoS cap, fractional-limit 400
  (confirms the shared parseListLimit covers the new route).
- `tests/audit-ops-skill-lockstep.test.ts`: 3 ops in the 3 sites.
- `tests/skill-cli.test.ts`: `skill new <name>` arg-shift (codex P2 class);
  malformed-id rejected on close/supersede; new->supersede version chain; export
  prints active skills.
- `python/tests/test_skills.py`: Pydantic round-trip + SDK method presence + both
  __all__ contain Skill.
- **Schema-version bump**: 20 assertion sites 33 -> 34 (same 9 files; grep-verified;
  binary-mode script; physics vecDot / SL trap numbers untouched).

## Steps (each verify-checked)

1. db.ts: CURRENT_SCHEMA_VERSION 33->34 + v34 skills migration (trigger_text col).
2. src/memory.ts SKILL_HALF_LIFE_DAYS=90; src/skills.ts module + exportSkills.
3. audit.ts/cli.ts/server.ts: 3 ops lockstep.
4. CLI cmdSkill + dispatch + help.
5. HTTP /v1/skills routes (incl /export, reuse parseListLimit).
6. Python SDK Skill + 6 methods + both __all__.
7. CHANGELOG Unreleased entry (em-dash-free).
8. 20 schema-version assertions 33->34; grep-confirm zero schema .toBe(33) remain.
9. Full build + vitest + pytest green.

## Risks & mitigations

- `trigger` reserved word: column is `trigger_text`; verified intent in the schema.
- "executable" scope creep: v1 is instruction + export; code exec deferred. Don't
  build a runtime/sandbox.
- export determinism: ORDER BY skill_name ASC; test the rendered string.
- Self-supersede / dual-write: process preflight + CAS verbatim.
- Sibling-clone (audit rule 8): REUSE parseListLimit, don't clone the limit block.
- models.__all__ AND __init__.__all__ both updated (codex P3).
- Schema-version drift: 20 sites; grep-confirm post-bump.
- Line endings: targeted Edits (repo uniformly LF).
- Ships via merge; CHANGELOG Unreleased; NO publish.

## Out of scope (noted)

- Literal code/command execution of a skill (sandbox/runtime): future.
- Writing the export block into AGENTS.md / CLAUDE.md files (idempotent
  sentinel-bounded write): future. v1 export returns the string.
- DB name-uniqueness / a structured trigger-matcher engine: future.
- `--format claude|agents` variants: not needed (both are markdown; one format).
