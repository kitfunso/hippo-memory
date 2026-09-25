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

## Verifying a release

Releases from 1.47.0 on are published from GitHub Actions with npm provenance. `npm audit signatures` in a project that depends on hippo-memory checks them, and the npm package page links each version to the commit and workflow run that built it.

The GitHub release of each version from 1.47.0 on carries `hippo-memory-<version>.cdx.json`, a CycloneDX software bill of materials (SBOM) of the packages the npm tarball ships, including those bundled into the dashboard.
