## Project Memory (Hippo)

At the start of each task, call the `hippo_recall` tool with a short query that
names the task. Read the memories it returns before you write any code.

When you learn something that should outlive this session (a decision and its
reason, a user preference, why something failed), call the `hippo_remember`
tool right then, while you work, never as a closing step. Set `error` to true
for a failure. Leave out secrets and personal details.

The installed hooks load pinned memories when a session starts and capture
the session as you work, so there is nothing to run before you finish.
