### Added

- **Session capture counts when the agent followed a stored rule and the person still corrected it.** With `capture.followUpRules` set to `"model"`, capture marks a stored rule with a `detect:flagged:<session id>` tag when, before the person's correction, the agent ran the rule's command, then ran the same program again without it, and the correction restates the rule or names its command. A rule holds at most 3 such tags, one for each session. A dry run, a `--global` capture or a capture with no session id writes none, and the Stop hook output does not change.
