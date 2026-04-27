# `hippo init` lazy-DB-creation footgun

## Symptom

`hippo init` returns 0 but `.hippo/hippo.db` does not exist. Only
`integrations/`, `logs/`, `runs/` subdirs are created.

A subsequent `hippo init` says `"Already initialized at <path>"` and
still does not create the db. The db only appears after the first
successful `hippo remember`.

This bit `ingest_direct.py` on 2026-04-26 — the script does
`subprocess.run([hippo, "init", ...])`, sees a 0 return code, then
opens `.hippo/hippo.db` directly via SQLite and fails with `hippo.db
not found`.

## Root cause

`isInitialized(hippoRoot)` in `src/store.ts` was `fs.existsSync(hippoRoot)` —
returns true the moment `.hippo/` exists, regardless of whether
`hippo.db` was ever created. `autoInstallHooks` / `setupDailySchedule`
in the init path can create `.hippo/integrations`, `.hippo/logs`, or
`.hippo/runs` early. After that, every later `hippo init` reads
`isInitialized` as true, prints "Already initialized", and skips
`initStore` (which is what actually creates `hippo.db`).

## Fix applied

`src/store.ts` `isInitialized` now checks `path.join(hippoRoot, 'hippo.db')`
instead of just the directory. A partial `.hippo/` is no longer treated
as initialized.

## Workaround for tooling that hits a still-buggy binary

`ingest_direct.py` keeps a one-shot seed-remember after init that
forces schema creation when `hippo.db` is missing, then proceeds with
direct SQLite writes. Safe to leave in place even after the store.ts
fix lands — it becomes a no-op when init works correctly.

## Why this matters beyond the benchmark

Any external tool that does `hippo init` and then opens the SQLite
file directly was vulnerable. With the fix, `hippo init` is now
idempotent and creates the db on every run that finds it missing,
regardless of what subdirs exist already.
