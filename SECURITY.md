# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: on the repository's **Security** tab, choose **Report a vulnerability** (GitHub private vulnerability reporting). Include:

- the hippo-memory version (`hippo --version`) and how you run it (CLI, MCP server, HTTP server, plugin);
- the steps to reproduce, and what an attacker gains;
- whether the issue is already public;
- if your setup matters, the file `hippo support-bundle` writes: versions, doctor checks, redacted config and store counts, with no memory text unless you add `--include-logs`.

You should get an acknowledgement within 3 working days and an assessment within 10. Fixes ship as a patch release, with credit in the changelog unless you ask otherwise.

## Supported versions

| Version | Supported |
|---|---|
| The current `latest` npm tag | Yes. Fixes ship in the next release. |
| Each minor version promoted to `stable` | For 12 months from its promotion. Fixes ship as patch releases of that minor; once `latest` has moved past it, they are published under the npm tag `maint-<x.y>`. |
| Anything else | No: upgrade to `stable` or `latest`. |

`docs/release-policy.md` ("Support window") covers promotions and which fixes are backported.

## Scope

In scope:
- the `hippo` CLI and its hooks;
- the MCP server (`hippo mcp`);
- the HTTP server (`hippo serve`), its API keys and tenant isolation;
- the connectors;
- the agent plugins in `extensions/`.

Especially relevant:
- one tenant, scope or API key reading another's memories;
- secrets reaching a memory, a log or an outside API unredacted;
- a hook that runs attacker-controlled input;
- anything that deletes memories without the caller's authority.

Out of scope:
- attacks that need an attacker who already controls the machine or the `.hippo` directory;
- denial of service on a server bound to loopback.

## Security defaults

From 2.0 the HTTP server starts strict, and each default has one explicit opt-out:

- A keyless request from this machine (`HIPPO_ALLOW_KEYLESS_LOCAL=1`) acts as a member. Mint an admin key for anything that needs admin.
- A non-loopback bind without TLS refuses to start. `--allow-cleartext` or `HIPPO_ALLOW_CLEARTEXT=1` allows it behind a TLS-terminating proxy.
- `HIPPO_CLIENT_IP_HEADER` is read only from the peers in `HIPPO_TRUSTED_PROXIES`, and the server refuses to start with the header set and no proxy listed, or with `*` listed.
- Each API key owner gets 20 requests a second, burst 40. `HIPPO_CALLER_RPS` sets the rate, and `0` turns the limit off.
- An API key minted with no role is a member key.
- `hippo watch` runs its command with no shell, and 3.0 removed the `--shell` opt-in.

`docs/UPGRADING-2.0.md` lists each default with its opt-out.

## Verifying a release

Releases from 1.47.0 on are published from GitHub Actions with npm provenance. `npm audit signatures` in a project that depends on hippo-memory checks them, and the npm package page links each version to the commit and workflow run that built it.

The GitHub release of each version from 1.47.0 on carries `hippo-memory-<version>.cdx.json`, a CycloneDX software bill of materials (SBOM) of the packages the npm tarball ships, including those bundled into the dashboard.
