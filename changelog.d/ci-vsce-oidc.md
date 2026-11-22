### Changed

- **The VS Code Marketplace publish signs in with Trusted Publishing, not a token.** `vscode-publish.yml` now runs `vsce publish --oidc`, backed by Trusted Publishing policies on the `kitfunso` publisher, so the `VSCE_PAT` secret is gone. Azure DevOps retires global personal access tokens on 1 December 2026, so a token-based publish would have stopped working. Open VSX still uses `OVSX_PAT`.
