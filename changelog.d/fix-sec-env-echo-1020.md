### Fixed

- **An unknown tool in `HIPPO_AGENT_MEMORY_TOOLS` is counted, not echoed.** The import warning used to print each unknown entry of the variable as given, so a secret set in it by mistake reached the log. It now names the variable and the number of entries it ignored. An unknown tool in `agentMemories.tools` in `config.json` is still named.
