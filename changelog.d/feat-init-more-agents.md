### Added

- **`hippo init`, `hippo setup` and `hippo hook install` add the hippo MCP server for Junie, Antigravity, Grok Build and Muse Code.** Init and setup write it when the host's folder exists on the machine: `~/.junie`, `~/.gemini/antigravity` or `~/.gemini/antigravity-cli`, `$GROK_HOME` (else `~/.grok`), or `$XDG_CONFIG_HOME/muse` (else `~/.config/muse`). `hippo hook install junie|antigravity|grok-build|muse-code` writes one host, and `hippo hook uninstall` removes only a default hippo entry, leaving hand-edited entries untouched. `hippo setup --all` writes every host and `--dry-run` names the files.
- **A setup page for Grok Bot and the Muse app.** `integrations/grok-bot-and-muse.md` gives the steps: `hippo serve`, a key from `hippo auth create`, a Cloudflare tunnel, and the connector settings in each app. The README lists the four MCP hosts and the page.

### Changed

- **Copilot now shares its MCP config code with the four new hosts.** The files hippo writes for Copilot and VS Code stay the same.
