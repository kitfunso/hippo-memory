# hippo memory provider for Hermes Agent

This plugin connects Hermes Agent to hippo. Hermes then uses the same memory store as your other coding agents.

## What it does

- Before each turn, Hermes gets your pinned rules and the memories that match the prompt. This is the same text
  that the Claude Code prompt hook gives.
- The agent gets three tools. `hippo_recall` searches memory, `hippo_remember` saves one lesson or fact, and
  `hippo_outcome` tells hippo if the last recall helped.
- At the end of a session, and before each context compression, the plugin captures the text you typed and the
  assistant replies. It leaves out tool output, runtime notices, skill bodies and compaction summaries.
- All reads and writes go to the global hippo store (`$HIPPO_HOME`, else `~/.hippo/`), in any folder.
- The plugin reads that store from the home folder, so it gets the pinned rules of every project, as an agent
  started in the home folder does.

## Turn it on

`hippo hook install hermes` copies this folder into the active Hermes profile. Then select the provider:

```
hermes config set memory.provider hippo
```

Hermes runs one external memory provider at a time, so this command replaces the provider you had before.

## Where it runs

By default the plugin works only in your own local chats: the `cli`, `tui` and `desktop` platforms, with a `cli`,
`tui`, `desktop` or `oneshot` session source. It does nothing in gateway chats (Telegram, Discord, Slack), cron
jobs, Kanban workers and `hermes chat --source tool` runs, because other people or programs write there.

To use it on more platforms or session sources, list them in `config.yaml`. The list is empty by default.

```yaml
memory:
  provider: hippo
  hippo:
    platforms: [telegram, cron]
```

A delegated sub-agent can only recall. A cron job can recall and gets context, but it writes nothing.

## Settings

- `HIPPO_BIN`: the path to hippo's `bin/hippo.js` or to a hippo executable. On Windows, only a `.js` or an
  `.exe` file is accepted, and any other file, such as a `.cmd` or `.bat`, is refused.
- `HIPPO_TENANT`: the tenant that context, recall, remember and outcome use. Capture stays off for any tenant
  other than `default`, because `hippo capture --global` writes the default tenant.
