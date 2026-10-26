### Changed

- **3.0 break: the option types named `*Opts` now end in `Options`.** `SleepOptions`, `ServeOptions`, `AppendAuditOptions`, `PushGoalOptions` and the nine other published types take the new ending; only the names change. The same pass adds the `node:` prefix to every Node built-in import, joins strings the old line wrap had split, names the meta keys and slice widths once, and splits the two largest test snapshots into one file per surface or route.
