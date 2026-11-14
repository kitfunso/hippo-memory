"""Harbor's Claude Code agent, with a Debian 11 image's apt sources moved to archive.debian.org first (Amendment 7,
dated notes 1). Every other image is left as it is. run_tbench.py loads it by import path."""
from __future__ import annotations

from typing import override

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.environments.base import BaseEnvironment

# Debian 11 moved to archive.debian.org in 2026; deb.debian.org still serves its index but 404s files it lists.
ARCHIVE_DEBIAN_11 = r"""grep -q '^11' /etc/debian_version 2>/dev/null || exit 0
for f in /etc/apt/sources.list /etc/apt/sources.list.d/*; do
  [ -f "$f" ] || continue
  sed -i -E 's#https?://(deb|security)\.debian\.org/#http://archive.debian.org/#' "$f" || exit 1
done"""


class ArchivedDebianClaudeCode(ClaudeCode):
    @override
    async def install(self, environment: BaseEnvironment) -> None:
        r = await environment.exec(command=ARCHIVE_DEBIAN_11, user="root")
        if r.return_code != 0:
            raise RuntimeError(f"moving Debian 11 apt sources to the archive failed: {r.stdout} {r.stderr}")
        await super().install(environment)
