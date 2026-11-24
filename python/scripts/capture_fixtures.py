from __future__ import annotations
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx


REPO_ROOT = Path(__file__).resolve().parents[2]
HIPPO_BIN = REPO_ROOT / "bin" / "hippo.js"
FIXTURES_DIR = Path(__file__).resolve().parent.parent / "tests" / "fixtures"
PORT = int(os.environ.get("HIPPO_FIXTURE_PORT", "3787"))


def wait_for_health(url: str, timeout: float = 20.0) -> None:
    deadline = time.time() + timeout
    last_err = None
    while time.time() < deadline:
        try:
            r = httpx.get(f"{url}/health", timeout=2.0)
            if r.status_code == 200:
                return
            last_err = f"status {r.status_code}"
        except Exception as e:
            last_err = str(e)
        time.sleep(0.2)
    raise RuntimeError(f"hippo serve did not respond on {url}/health within {timeout}s (last: {last_err})")


def save(name: str, data) -> None:
    path = FIXTURES_DIR / f"{name}.json"
    path.write_text(json.dumps(data, indent=2, sort_keys=False) + "\n")
    print(f"  saved {path.relative_to(REPO_ROOT)}")


def main() -> int:
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)

    tmp_home = tempfile.mkdtemp(prefix="hippo-fixtures-")
    env = {**os.environ, "HIPPO_HOME": tmp_home, "HIPPO_TENANT": "default"}

    print(f"[capture_fixtures] HIPPO_HOME={tmp_home}")
    print(f"[capture_fixtures] spawning serve on port {PORT}")

    proc = subprocess.Popen(
        ["node", str(HIPPO_BIN), "serve", "--port", str(PORT)],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        cwd=tmp_home,
    )

    try:
        url = f"http://127.0.0.1:{PORT}"
        wait_for_health(url)
        print(f"[capture_fixtures] /health up at {url}")

        key = next(Path(tmp_home).rglob("server.key")).read_text().strip()
        headers = {"authorization": f"Bearer {key}"}
        with httpx.Client(base_url=url, timeout=10.0, headers=headers) as client:
            save("health", client.get("/health").json())

            ids = []
            seeds = [
                "fixture seed alpha",
                "fixture seed bravo for context test",
                "fixture seed charlie last-recall target",
            ]
            for i, content in enumerate(seeds):
                r = client.post("/v1/memories", json={"content": content, "kind": "distilled"})
                r.raise_for_status()
                env_data = r.json()
                ids.append(env_data["id"])
                if i == 0:
                    save("remember", env_data)

            r = client.get("/v1/memories", params={"q": "fixture", "limit": 5})
            save("recall", r.json())

            r = client.get(f"/v1/recall/drill/{ids[0]}", params={"budget": 500})
            save("drill", r.json())

            r = client.get("/v1/context", params={"budget": 500})
            save("context", r.json())

            r = client.post("/v1/outcome", json={"ids": [ids[2]], "good": True})
            save("outcome-with-ids", r.json())

            client.get("/v1/memories", params={"q": "fixture charlie", "limit": 3})
            r = client.post("/v1/outcome", json={"good": False})
            save("outcome-last-recall", r.json())

            r = client.post("/v1/sleep", json={"dry_run": True})
            save("sleep-dry-run", r.json())

            r = client.get("/v1/sessions/none-existing/assemble")
            save("assemble-error", {"status": r.status_code, "body_text": r.text})

            r = client.post(f"/v1/memories/{ids[1]}/archive", json={"reason": "fixture capture"})
            save("archive", r.json())

            new_r = client.post("/v1/memories", json={"content": "fixture supersede replacement"})
            new_id = new_r.json()["id"]
            r = client.post(f"/v1/memories/{ids[0]}/supersede", json={"newId": new_id})
            save("supersede", r.json())

            r = client.post(f"/v1/memories/{new_id}/promote")
            content_type = r.headers.get("content-type", "")
            body = r.json() if content_type.startswith("application/json") else r.text
            save("promote", {"status": r.status_code, "body": body})

            fresh_r = client.post("/v1/memories", json={"content": "fixture forget target"})
            fresh_id = fresh_r.json()["id"]
            r = client.delete(f"/v1/memories/{fresh_id}")
            save("forget", r.json())

            r = client.post("/v1/auth/keys", json={"label": "fixture-test-key"})
            auth_created = r.json()
            save("auth-created", auth_created)
            key_id = auth_created.get("keyId") or auth_created.get("key_id") or auth_created.get("id")

            r = client.get("/v1/auth/keys", params={"active": "true"})
            save("auth-list", r.json())

            if key_id:
                r = client.delete(f"/v1/auth/keys/{key_id}")
                save("auth-revoked", r.json())
            else:
                save("auth-revoked", {"note": "skipped: could not derive key_id from auth-created payload"})

            r = client.get("/v1/audit", params={"limit": 20})
            save("audit", r.json())

        print("\n[capture_fixtures] all endpoints captured")
        return 0

    finally:
        print("[capture_fixtures] stopping serve")
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(tmp_home, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
