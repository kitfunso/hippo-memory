"""The setup stage of dolphin_official.py: installs everything the sandboxes run, root-owned and read-only, under
/opt, unpacks the official source bundles, builds the patched official tree, and records it all in setup.json.
Each install is skipped when its target already exists, so a rerun only refreshes the runner's own files."""
from __future__ import annotations

import hashlib
import json
import logging
import pwd
import re
import shutil
import subprocess
import tarfile
import urllib.request
from argparse import Namespace
from pathlib import Path

from dolphin_home import BENCH
from dolphin_official import BASE, CLAUDE_VERSION, HERE, HOMES, INGEST_UID, SETUP, TEST_UID, sha256_file, utc

log = logging.getLogger("dolphin_official")
CLAUDE_SOURCE = Path("/home/skf_s/dolphin/claude-code/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe")
MODEL_SOURCE = Path("/mnt/c/Users/skf_s/AppData/Roaming/npm/node_modules/@huggingface/transformers/.cache")
SITE_SOURCE = BENCH / ".venv-dolphin-wsl" / "lib" / "python3.12" / "site-packages"
TRANSFORMERS = "@huggingface/transformers@4.2.0"
EMBED_MODEL = "Xenova/all-MiniLM-L6-v2"
MODELS = Path("/opt/hippo-models")
CODE = ("harness", "reference", "graders", "pricing", "mock_mcp", "registry")
USERS = {TEST_UID: "dolphin-test", INGEST_UID: "dolphin-ingest"}
EVIDENCE = "https://dolphinbench-review.vercel.app/leaderboard/evidence"
# The official Claude Mem0 evaluation source bundles: code, tests and the published per-test app inputs.
BUNDLES = {
    "morgan": "87bf36c0f03b533a001df2c1016f0e214fa48d76672c200aabfb281f83bd17a5",
    "alex": "00f0b99207e5c6dc41f8411e7b6a6c33fa7bd6275d9fd3515c71885ee7c9c910",
    "riley": "87f4179f2f6ddedd45398120740b2bcd3968d6df4403f7cfb1b036c342beb906",
}


def run(command: list[str], **kwargs) -> subprocess.CompletedProcess:
    return subprocess.run(command, check=True, capture_output=True, text=True, **kwargs)


def tree_hash(root: Path) -> str:
    """The official source_hash rule: relative path, a zero byte, then the bytes, over sorted files."""
    digest = hashlib.sha256()
    for item in sorted(root.rglob("*")):
        if item.is_file() and not set(item.relative_to(root).parts) & {".git", "__pycache__", "node_modules"}:
            digest.update(str(item.relative_to(root)).encode() + b"\0")
            digest.update(item.read_bytes())
    return digest.hexdigest()


def lock_down(path: Path) -> None:
    run(["chown", "-R", "root:root", str(path)])
    run(["chmod", "-R", "go-w", str(path)])


def install_claude() -> dict:
    target = Path(f"/opt/claude-{CLAUDE_VERSION}/bin/claude")
    if not target.exists():
        target.parent.mkdir(parents=True)
        shutil.copyfile(CLAUDE_SOURCE, target)
        target.chmod(0o755)
        lock_down(target.parents[1])
    version = run([str(target), "--version"]).stdout.strip()
    if not version.startswith(CLAUDE_VERSION):
        raise SystemExit(f"{target} reports {version}; the run pins {CLAUDE_VERSION}")
    return {"bin": str(target.parent), "dir": str(target.parents[1]), "version": version,
            "sha256": sha256_file(target)}


def install_hippo(spec: str) -> dict:
    """hippo and the embedder in one npm prefix: hippo finds @huggingface/transformers beside itself."""
    label = re.sub(r"[^A-Za-z0-9.]+", "-", re.sub(r"^hippo-memory[-@]?", "", Path(spec).name))
    prefix = Path("/opt") / f"hippo-{label}"
    if not prefix.exists():
        staging = prefix.with_name(prefix.name + ".staging")
        shutil.rmtree(staging, ignore_errors=True)
        run(["npm", "install", "--prefix", str(staging), "--no-audit", "--no-fund", "--ignore-scripts",
             "--omit=dev", spec, TRANSFORMERS], timeout=3600)
        staging.rename(prefix)
        lock_down(prefix)
    package = json.loads((prefix / "node_modules" / "hippo-memory" / "package.json").read_text())
    lock = json.loads((prefix / "package-lock.json").read_text())["packages"]
    return {"spec": spec, "dir": str(prefix), "bin": str(prefix / "node_modules" / ".bin"),
            "version": package["version"], "integrity": lock["node_modules/hippo-memory"].get("integrity"),
            "transformers": lock["node_modules/@huggingface/transformers"]["version"],
            "onnxruntime_node": lock.get("node_modules/onnxruntime-node", {}).get("version"),
            "node": run(["node", "--version"]).stdout.strip(), "npm_scripts": "ignored"}


def install_models() -> dict:
    target = MODELS / EMBED_MODEL
    if not target.exists():
        shutil.copytree(MODEL_SOURCE / EMBED_MODEL, target)
        lock_down(MODELS)
    files = {str(p.relative_to(target)): sha256_file(p) for p in sorted(target.rglob("*")) if p.is_file()}
    onnx = "onnx/model_quantized.onnx" if "onnx/model_quantized.onnx" in files else "onnx/model.onnx"
    return {"dir": str(MODELS), "model": EMBED_MODEL, "onnx": onnx, "files": files}


def install_plugin(source: Path, overlay: bool) -> dict:
    staging = Path("/opt/hippo-plugin.staging")
    shutil.rmtree(staging, ignore_errors=True)
    shutil.copytree(source, staging, ignore=shutil.ignore_patterns(".git", "__pycache__", "node_modules"))
    mcp = staging / ".mcp.json"
    overlaid = overlay and not mcp.exists()
    if overlaid:  # SHORTCUT: proof only, until the plugin ships its own .mcp.json
        mcp.write_text(json.dumps({"mcpServers": {"hippo-memory": {"command": "hippo", "args": ["mcp"]}}}, indent=2))
    servers = json.loads(mcp.read_text()) if mcp.exists() else {}
    servers = servers.get("mcpServers", servers)
    manifest = json.loads((staging / ".claude-plugin" / "plugin.json").read_text())
    if manifest.get("name") != "hippo-memory" or "hippo-memory" not in servers:
        raise SystemExit("the plugin must be named hippo-memory and declare an MCP server named hippo-memory")
    digest = tree_hash(staging)
    target = Path(f"/opt/hippo-plugin-{digest[:12]}")
    if target.exists():
        shutil.rmtree(staging)
    else:
        staging.rename(target)
        lock_down(target)
    return {"dir": str(target), "source": str(source), "sha256": digest, "name": manifest["name"],
            "version": manifest.get("version"), "mcp_overlay": overlaid, "mcp_server": servers["hippo-memory"]}


def install_bundles() -> dict:
    found = {}
    for persona, digest in BUNDLES.items():
        archive = HOMES / "bundles" / f"claude-mem0-{persona}-source.tar.gz"
        url = f"{EVIDENCE}/claude-mem0-{persona}-source.tar.gz/"
        archive.parent.mkdir(parents=True, exist_ok=True)
        if not archive.exists():
            with urllib.request.urlopen(url, timeout=600) as response:
                archive.write_bytes(response.read())
        if sha256_file(archive) != digest:
            raise SystemExit(f"{archive} does not match the published sha256")
        target = HOMES / "bundles" / persona
        if not target.exists():
            staging = target.with_name(persona + ".staging")
            shutil.rmtree(staging, ignore_errors=True)
            with tarfile.open(archive) as packed:
                packed.extractall(staging, filter="data")
            staging.rename(target)
        found[persona] = {"url": url, "sha256": digest, "dir": str(target),
                          "code": {name: tree_hash(target / name) for name in CODE}}
    if any(info["code"] != found["morgan"]["code"] for info in found.values()):
        raise SystemExit("the three bundles ship different code; one patched tree cannot serve all personas")
    return found


def build_official(bundles: dict) -> dict:
    """The morgan bundle's code with the hippo-memory branches; tests and app inputs stay per persona."""
    tree, source = BASE / "official", Path(bundles["morgan"]["dir"])
    shutil.rmtree(tree, ignore_errors=True)
    for name in CODE:
        shutil.copytree(source / name, tree / name, ignore=shutil.ignore_patterns("__pycache__"))
    patch = HERE / "official" / "hippo-memory.patch"
    run(["patch", "-p1", "--batch", "--forward", "-d", str(tree), "-i", str(patch)])
    agent = "local_bwrap_agent.py"
    shutil.copyfile(HERE / "official" / agent, tree / "reference" / "execution" / agent)
    diff = "".join(subprocess.run(["diff", "-ruN", "-x", "__pycache__", str(source / name), str(tree / name)],
                                  capture_output=True, text=True, check=False).stdout for name in CODE)
    (BASE / "official-diff.patch").write_text(diff)
    lock_down(tree)
    return {"dir": str(tree), "from": str(source), "patch_sha256": sha256_file(patch),
            "diff": str(BASE / "official-diff.patch"), "diff_sha256": sha256_file(BASE / "official-diff.patch"),
            "files_changed": sorted(set(re.findall(r"^\+\+\+ (\S+)", diff, flags=re.MULTILINE)))}


def install_runner_files() -> dict:
    for folder in ("bin", "fake/bin", "etc"):
        (BASE / folder).mkdir(parents=True, exist_ok=True)
    for name in ("dolphin_sandbox.py", "dolphin_bridge_client.py"):
        shutil.copyfile(HERE / name, BASE / "bin" / name)
    python = BASE / "bin" / "python"
    if not python.is_symlink():
        python.symlink_to("/usr/bin/python3")
    fake = BASE / "fake" / "bin" / "claude"
    shutil.copyfile(HERE / "dolphin_fake_official.py", fake)
    fake.chmod(0o755)
    (BASE / "etc" / "resolv.conf").write_bytes(Path("/etc/resolv.conf").read_bytes())
    if not (BASE / "site").exists():
        shutil.copytree(SITE_SOURCE, BASE / "site", ignore=shutil.ignore_patterns("__pycache__"))
    run(["/usr/bin/python3", "-c", "import mcp, yaml"], env={"PYTHONPATH": str(BASE / "site")})
    return {"bin": str(fake.parent), "sha256": sha256_file(fake), "site": str(BASE / "site"),
            "sandbox_sha256": sha256_file(BASE / "bin" / "dolphin_sandbox.py")}


def setup_stage(args: Namespace) -> None:
    for uid, name in USERS.items():
        if pwd.getpwuid(uid).pw_name != name:
            raise SystemExit(f"uid {uid} must be the user {name}")
    BASE.mkdir(parents=True, exist_ok=True)
    claude = install_claude()
    hippo = install_hippo(args.hippo)
    models = install_models()
    plugin = install_plugin(args.plugin.resolve(), args.mcp_overlay)
    bundles = install_bundles()
    official = build_official(bundles)
    fake = install_runner_files()
    read_only = [str(BASE / "bin"), str(BASE / "fake"), claude["dir"], hippo["dir"], models["dir"], plugin["dir"]]
    (BASE / "sandbox.json").write_text(json.dumps({"ro": read_only}, indent=1))
    lock_down(BASE)
    setup = {"at": utc(), "claude": claude, "hippo": hippo, "models": models, "plugin": plugin, "bundles": bundles,
             "official": official, "fake": fake,
             "sandbox": {"bwrap": run(["bwrap", "--version"]).stdout.strip(), "ro": read_only,
                         "users": {str(uid): name for uid, name in USERS.items()},
                         "kernel": run(["uname", "-r"]).stdout.strip()}}
    SETUP.write_text(json.dumps(setup, indent=1))
    log.info("setup: claude %s, hippo %s, plugin %s, official diff %s", claude["sha256"][:12], hippo["version"],
             plugin["sha256"][:12], official["diff_sha256"][:12])
    print(json.dumps({"setup": str(SETUP), "plugin_sha256": plugin["sha256"], "hippo": hippo["version"],
                      "files_changed": official["files_changed"]}, indent=1))
