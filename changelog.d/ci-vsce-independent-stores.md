### Fixed

- **A failed Open VSX publish no longer stops the VS Code Marketplace publish.** The Marketplace step in `vscode-publish.yml` now runs whenever the package step worked, and the job still fails if either store fails. Before, Open VSX refusing a version (for example while the `kitfunso` namespace waits for approval) skipped the Marketplace too.
