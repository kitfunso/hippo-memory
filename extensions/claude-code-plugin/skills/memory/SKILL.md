---
name: memory
description: Project memory powered by Hippo. Use when starting a session, after learning something, after hitting an error, or when the user mentions memory/remember/recall. Auto-invoked at session start.
---

# Hippo Memory

This project uses Hippo for biologically-inspired memory across sessions.
Memories decay over time unless retrieved. Errors stick longer. Sleep consolidates.

## At session start (MANDATORY)

Before doing any work, load relevant context:

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

The `--error` flag doubles the half-life. Hard lessons don't fade quietly.

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
