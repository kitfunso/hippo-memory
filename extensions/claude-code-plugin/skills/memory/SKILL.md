---
name: memory
description: Project memory powered by Hippo. Use when starting a session, after learning something, after hitting an error, or when the user mentions memory/remember/recall.
---

# Hippo Memory

One memory for every agent you'll ever use. Hippo writes what you teach a coding agent into a store in your repo, and your other agents read that same store.
Unused memories weaken over a year or two, each recall keeps one longer, and pinned rules never fade.

## At the start of a task

The plugin's UserPromptSubmit hook injects pinned rules and the memories that match each prompt, so do not load them yourself.

Only if no hippo memory block has appeared in this session, run this at the start of a task:

```bash
hippo context --auto --budget 1500
```

Read the output. These are things the project has learned from past sessions.

## When you learn something non-obvious

```bash
hippo remember "<the lesson in 1-2 sentences>" --tag <category>
```

## When you hit an error or unexpected failure

```bash
hippo remember "<what failed, why, and how you fixed it>" --error
```

The `--error` flag doubles the half-life, so the lesson lasts twice as long.

## After completing work successfully

```bash
hippo outcome --good
```

If the recalled memories were irrelevant:

```bash
hippo outcome --bad
```

## When stuck or hitting repeated errors

```bash
hippo recall "<what's going wrong>" --budget 2000 --why
```

## When a stored fact is no longer true

```bash
hippo supersede <id> "<the new fact>"
```

The old memory leaves recall but stays on record.

## When making an architectural decision

```bash
hippo decide "<decision>" --context "<why>"
```

Decisions get a recall boost so they surface when relevant, and stay active until superseded.

## When migrating or replacing a tool

```bash
hippo invalidate "<old tool>" --reason "migrated to <new tool>"
```

Or let `hippo learn --git` detect it automatically from migration commits.

## After significant coding sessions

```bash
hippo learn --git
```

This scans recent commits, auto-extracts lessons, and invalidates memories about replaced tools.

## Export memories

```bash
hippo export memories.json
hippo export --format markdown memories.md
```

## Check memory health

```bash
hippo status
```
