# Hippo + Codex (OpenAI) Integration

## Auto-install (recommended)

If your project has an `AGENTS.md`, just run:

```bash
hippo init
```

Hippo auto-detects the Codex config and patches `AGENTS.md` with the hook block below. No copy-paste needed.

---

## AGENTS.md snippet

```markdown
## Project Memory (Hippo)

At the start of every session, run:
```bash
hippo context --auto --budget 1500
```
Read the output before writing any code.

On errors or unexpected behaviour:
```bash
hippo remember "<description of what went wrong>" --error
```

On task completion:
```bash
hippo outcome --good
```

After significant coding sessions:
```bash
hippo learn --git
```
```

---

## Multi-repo learning

If you work across multiple repos, set up a weekly cron to scan all of them:

```bash
hippo learn --git --repos "~/repo-a,~/repo-b,~/repo-c" --days 7
hippo sleep
```

This extracts lessons from fix/revert/bug commits across repos and consolidates them into the memory store.

## Notes

- Hippo stores everything in `.hippo/` as markdown files. No database.
- `--budget 1500` is a good default for sub-agents. Increase to 3000 for complex tasks.
- Codex agents using `hippo context --auto` get task-relevant memories automatically detected from git state.
