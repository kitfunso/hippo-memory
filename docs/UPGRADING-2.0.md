# Upgrading to 2.0

## Config

A `config.json` that exists but cannot be parsed, or that does not hold a JSON object, now stops the command with an error that names the file and the parse error. Before, hippo logged one warning and ran on the defaults, which silently dropped your settings (for example `sharedStore`).

To upgrade: run any hippo command, read the error, and fix the file. To go back to the defaults, delete `config.json`.
