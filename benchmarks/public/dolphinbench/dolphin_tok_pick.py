"""Print the name of the Claude subscription token with the most weekly room, from a one-token ping each.

Stdout: one token name, or nothing. Stderr: one JSON line per token (name, sha256 prefix, status, headers),
never a value.
Exit 0 with a name; exit 3 when no token has room (stderr then names the earliest reset).
"""
import hashlib
import json
import sys
import urllib.error
import urllib.request
import winreg

NAMES = ("Z0_SUB_TOKEN_1", "Z0_SUB_TOKEN_2", "Z0_SUB_TOKEN_3")  # Keith 16 Nov: any of the three with room
BODY = json.dumps({"model": "claude-sonnet-5-5", "max_tokens": 1,
                   "system": "You are Claude Code, Anthropic's official CLI for Claude.",
                   "messages": [{"role": "user", "content": "Reply OK"}]}).encode()


def ping(token: str) -> tuple[int, dict[str, str]]:
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=BODY, method="POST", headers={
        "Authorization": f"Bearer {token}", "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01",
        "content-type": "application/json", "User-Agent": "claude-cli"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            code, hdr = r.status, r.headers
    except urllib.error.HTTPError as e:
        code, hdr = e.code, e.headers
    return code, {k.lower().replace("anthropic-ratelimit-unified-", ""): v for k, v in hdr.items()
                  if k.lower().startswith("anthropic-ratelimit-unified")}


def main() -> int:
    key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment")
    seen, room, resets = set(), [], []
    for name in NAMES:
        token = winreg.QueryValueEx(key, name)[0].strip()
        h = hashlib.sha256(token.encode()).hexdigest()[:8]
        if h in seen:
            continue
        seen.add(h)
        code, rl = ping(token)
        print(json.dumps({"name": name, "sha": h, "http": code, **rl}), file=sys.stderr)
        ok = code == 200 and rl.get("7d-status", "allowed") == "allowed" and rl.get("5h-status", "allowed") == "allowed"
        if ok:
            room.append((float(rl.get("7d-utilization", 1)), name))
        resets += [int(rl[k]) for k in ("7d-reset", "5h-reset") if rl.get(k, "").isdigit()]
    if not room:
        print(json.dumps({"none": True, "earliest_reset": min(resets) if resets else None}), file=sys.stderr)
        return 3
    print(min(room)[1])
    return 0


if __name__ == "__main__":
    sys.exit(main())
