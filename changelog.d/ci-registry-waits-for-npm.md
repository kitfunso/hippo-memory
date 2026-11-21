### Fixed

- **The MCP Registry step waits for npm to show the new version.** It checked npm once, 13 seconds after the 3.11.0 publish, while npm took about 3.5 minutes to show that version, so the listing failed until the job ran again. It now checks every 20 seconds for up to 10 minutes.
