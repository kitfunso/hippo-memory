### Changed

- **The VS Code and Copilot capture hooks now have store-level tests for a busy store, a killed worker, two sessions at once and a save from the wrong folder.** The tests run the built CLI against a real store. `docs/integrations/agent-inventory.md` lists what they cover, and three limits found while writing them. Internal only, no runtime behaviour changes.
