### Fixed

- **The site shows the real GitHub star count after a deploy from a busy machine.** The build asked GitHub for the count without a token, hit the 60-an-hour anonymous limit and shipped the 9 Aug fallback (725, against 794 live). It now sends GITHUB_TOKEN, GH_TOKEN or the gh CLI login token when one is there.
