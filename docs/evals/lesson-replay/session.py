import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import uuid
import winreg
import sys


ROOT = Path("C:/z0-lessons/lesson-replay")
CORPUS = ROOT / "corpus"
REPAIR = ROOT / "third"
EXE = Path("C:/z0-runs/scored/bin/claude.exe")
PIN = "5064e6e0572dca86257363ca04d48653eef20ef27f1bd04b504ed7199ed3fd13"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read(path: Path) -> object:
    return json.loads(path.read_bytes())


def write(path: Path, obj: object) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")


def child_env(folder: Path) -> dict:
    keep = ("SystemRoot WINDIR ComSpec PATH PATHEXT ProgramFiles ProgramFiles(x86) SystemDrive ProgramW6432 "
            "ProgramData ALLUSERSPROFILE PUBLIC CommonProgramFiles CommonProgramFiles(x86) CommonProgramW6432 "
            "DriverData OS PROCESSOR_ARCHITECTURE PROCESSOR_IDENTIFIER PROCESSOR_LEVEL PROCESSOR_REVISION "
            "NUMBER_OF_PROCESSORS USERNAME USERDOMAIN USERDOMAIN_ROAMINGPROFILE COMPUTERNAME LOGONSERVER "
            "SESSIONNAME PSModulePath LANG LC_ALL LC_CTYPE TERM USER LOGNAME SHELL TZ "
            "GIT_EDITOR GCM_INTERACTIVE "
            "CLAUDE_CODE_GIT_BASH_PATH").split()
    env = {key: os.environ[key] for key in keep if key in os.environ}
    for key in ("HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "CLAUDE_CONFIG_DIR", "HIPPO_HOME", "CODEX_HOME"):
        target = folder / {"USERPROFILE":"home","CLAUDE_CONFIG_DIR":"claude-config"}.get(key,key.lower())
        target.mkdir(exist_ok=True)
        env[key] = str(target)
    return dict(env, DISABLE_AUTOUPDATER="1", PYTHONUTF8="1", GIT_TERMINAL_PROMPT="0")


def login(name: str) -> str:
    if not re.fullmatch(r"Z0_SUB_TOKEN(?:_[123])?", name):
        raise ValueError("Expected a subscription variable name")
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
        value = winreg.QueryValueEx(key, name)[0]
    if not isinstance(value, str) or not value.startswith("sk-ant-oat"):
        raise ValueError("Selected User variable does not contain a subscription credential")
    return value


def prompt_for(req: dict, row: dict, arm: str) -> str:
    cue = "Continue."
    if arm in ("reference", "unchanged"):
        return cue
    if not row["clean"]:
        raise ValueError("Ambiguous lesson carrier")
    slot = row["span"]
    block = req["messages"][0]["content"][slot["index"]]
    original = slot["text"]
    if block["text"].count(original) != 1:
        raise ValueError("Lesson span changed")
    replacement = ""
    if arm not in ("cut", "need-sonnet"):
        command = row["rule"]
        if arm == "paraphrase":
            command = row["paraphrase"]
        if arm == "checklist":
            command = "Before finishing, check this item: " + command
        if arm == "start":
            replacement = command
        else:
            count = int(arm[1:]) if re.fullmatch(r"d(2|50|300)", arm) else 0
            noise = [f"For catalog record R{i:03}, put its display title in the heading field." for i in range(count)]
            cue = "\n".join([*noise, command, cue])
    block["text"] = block["text"].replace(original, replacement)
    return cue


def prefix(req: dict, cwd: Path, sid: str) -> list:
    rows = []
    for msg in req["messages"]:
        role = msg["role"]
        blocks = msg["content"]
        if isinstance(blocks, str):
            blocks = [{"type": "text", "text": blocks}]
        if role == "system":
            role = "user"
            blocks = [{"type": "text", "text": "<system-reminder>\n"+b["text"]+"\n</system-reminder>"} for b in blocks]
        blocks = [{k:v for k,v in b.items() if k != "cache_control"} for b in blocks
                  if b["type"] not in ("thinking", "redacted_thinking")]
        if not blocks:
            continue
        message = {"role": role, "content": blocks}
        if role == "assistant":
            message.update(type="message", id="msg_"+uuid.uuid4().hex, model=req["model"],
                           stop_reason="tool_use", stop_sequence=None,
                           usage={"input_tokens":0,"output_tokens":0})
        rows.append({"type":role,"message":message,"sessionId":sid,"uuid":str(uuid.uuid4()),
                     "parentUuid":rows[-1]["uuid"] if rows else None,"isSidechain":False,
                     "userType":"external","cwd":str(cwd),"version":"2.1.323",
                     "timestamp":"2026-11-25T00:00:00.000Z"})
    return rows


def workspace(req: dict, row: dict, cwd: Path, env: dict) -> Path:
    original = Path(row["source"]).parents[4]
    r3 = Path("C:/z0-runs/scored/r3run").resolve()
    if original.parent.parent.resolve() != r3:
        raise ValueError("Expected a round three input")
    environment = next(m["content"] for m in req["messages"] if m["role"]=="system")
    old_work = Path(re.search(r"Primary working directory: ([^\r\n]+)", environment)[1])
    if not old_work.resolve().is_relative_to(original / "runs") or old_work.name != "work":
        raise ValueError("Unexpected historical workspace")
    text = "\n".join(b.get("text","") for b in req["messages"][0]["content"])
    commits = re.findall(r"(?m)^([0-9a-f]{7,40}) (?:z0 eval: [^\n]+|base|snapshot)$",text)
    git = ["git","-c","safe.directory="+old_work.as_posix(),"-C",str(old_work)]
    for commit in commits:
        resolved = subprocess.run([*git, "rev-parse", "--verify", commit+"^{commit}"], capture_output=True, env=env)
        if resolved.returncode:
            continue
        sha = resolved.stdout.decode().strip()
        # A one-time fetch leaves neither a remote nor shared writable objects pointing at the frozen run.
        local = ["git", "-c", "safe.directory="+old_work.as_posix(), "-C", str(cwd)]
        for args in (["init", "--quiet", "--template="],
                     ["fetch", "--quiet", "--depth=1", "--no-tags", old_work.as_uri(), sha],
                     ["checkout", "--quiet", "--detach", sha]):
            subprocess.run([*local, *args], capture_output=True, check=True, env=env)
        write(cwd.parent/"workspace.json", {"commit":sha, "exactStartCommit":commit==commits[0]})
        break
    else:
        raise ValueError("No pre-task commit available")
    # The prefix already carries instruction files. A second copy can reintroduce a cut lesson.
    for filename in ("CLAUDE.md","AGENTS.md"):
        (cwd/filename).unlink(missing_ok=True)
    return original


def arm_path(folder: Path, historical: Path, arm: str, env: dict) -> None:
    names=("hippo","hippo.cmd","hippo.bat","hippo.exe","hippo.ps1")
    dirs=[Path(p.strip('"')) for p in env["PATH"].split(os.pathsep) if p]
    clean=[str(d) for d in dirs if not any((d/n).is_file() for n in names)]
    if arm in ("A2","A5"):
        sequence,seed=historical.parents[2].name,historical.parent.name
        origin=historical.parents[4]
        source=origin/"runs"/sequence/arm/seed/"bin"
        destination=folder/"bin"
        destination.mkdir()
        for name in ("hippo","hippo.cmd"):
            shim=(source/name).read_text()
            entry=re.search(r'"([^"\r\n]+[\\/]bin[\\/]hippo\.js)"',shim)[1]
            if not Path(entry).exists():
                installed=next((d/"node_modules/hippo-memory/bin/hippo.js" for d in dirs
                                if (d/"node_modules/hippo-memory/bin/hippo.js").is_file()),None)
                if not installed:
                    raise ValueError("Hippo arm requires its CLI")
                shim=shim.replace(entry,str(installed))
                write(folder/"hook-runtime.json",{"replacement":str(installed),"sha256":digest(installed.read_bytes())})
            (destination/name).write_text(shim.replace(str(origin),str(folder/"home")),encoding="utf-8")
        clean.insert(0,str(destination))
    env["PATH"]=os.pathsep.join(clean)


def launch(folder: Path, row: dict, arm: str, token_var: str, local_url: str = "", saved: bool = False) -> tuple:
    env = child_env(folder)
    req_file = CORPUS / (row["sid"]+".json")
    if digest(req_file.read_bytes()) != row["sha256"]:
        raise ValueError("Prefix digest mismatch")
    req = read(req_file)
    cue = prompt_for(req,row,arm)
    cwd = folder / "work"
    cwd.mkdir()
    original = workspace(req,row,cwd,env)
    proj = Path(env["CLAUDE_CONFIG_DIR"]) / "projects" / re.sub("[^a-zA-Z0-9]", "-", str(cwd))
    proj.mkdir(parents=True)
    sid = str(uuid.uuid4())
    transcript = proj / (sid+".jsonl")
    rows = prefix(req, cwd, sid)
    transcript.write_text("".join(json.dumps(m)+"\n" for m in rows), encoding="utf-8")
    system = folder / "system.txt"
    settings = folder / "settings.json"
    historical = Path(row["source"])
    arm_path(folder,historical,row["arm"],env)
    sequence = historical.parents[2].name
    settings_obj = read(original/"settings"/f"{sequence}-{row['arm']}-seed{row['seed']}.json")
    hooks = settings_obj.setdefault("hooks",{})
    for groups in hooks.values():
        for group in groups:
            for hook in group["hooks"]:
                hook["command"] = hook["command"].replace(str(original/"hook-home"),str(folder/"home"))
    hook_cmd = f'"{Path(sys.executable).as_posix()}" -B "{Path(__file__).with_name("observe.py").as_posix()}"'
    for event, matcher in (("PreToolUse",""),("PostToolUse","Bash|PowerShell"),("PostToolUseFailure","Bash|PowerShell")):
        hooks.setdefault(event,[]).append({"matcher":matcher,"hooks":[{"type":"command","command":hook_cmd}]})
    write(settings,settings_obj)
    write(folder/"observer.json",{"check":row["check"],"args":row["args"],"original":str(original)})
    model = "claude-sonnet-5-5" if arm=="need-sonnet" else req["model"]
    env.update(CLAUDE_CODE_EFFORT_LEVEL=req["effort"],CLAUDE_CODE_SUBAGENT_MODEL=model,
               CLAUDE_CODE_SUBAGENT_MODEL_FORCE="1", CLAUDE_CODE_DISABLE_AUTO_MEMORY="1" if row["arm"] in ("A0","A4") else "0",
               EVAL_SEED=str(row["seed"]),HIPPO_AGENT_MEMORY_TOOLS="claude-code,codex",HIPPO_CAPTURE_SCRIPTED="1",
               REPLAY_FOLDER=str(folder))
    fork = str(uuid.uuid4())
    argv = [str(EXE),"-p","--output-format","json","--setting-sources","project","--settings",str(settings),
            "--strict-mcp-config","--permission-mode","bypassPermissions","--model",model,
            "--resume",sid,"--fork-session","--session-id",fork]
    if saved:
        system.write_bytes(req["system"][-1]["text"].encode("utf-8"))
        argv.extend(["--system-prompt-file",str(system)])
    if local_url:
        env.update(ANTHROPIC_BASE_URL=local_url, CLAUDE_CODE_OAUTH_TOKEN="offline-placeholder")
    else:
        env["CLAUDE_CODE_OAUTH_TOKEN"] = login(token_var)
    result = subprocess.run(argv,cwd=cwd,env=env,input=cue,capture_output=True,timeout=600,
                            encoding="utf-8",errors="replace")
    result_obj = json.loads(result.stdout) if result.stdout.strip() else {}
    events = []
    log = proj/(fork+".jsonl")
    if log.exists():
        history = [json.loads(s) for s in log.read_bytes().splitlines()]
        # Fork logs can include copied history. Only messages after our new user cue qualify.
        indices = [i for i,e in enumerate(history) if e.get("type")=="user" and
                   e.get("message",{}).get("content") in (cue,[{"type":"text","text":cue}])]
        if indices:
            events = history[indices[0]+1:]
    events.append(result_obj)
    write(folder/"cli-status.json",{"exit":result.returncode,"subtype":result_obj.get("subtype"),
          "turns":result_obj.get("num_turns"),"newAssistant":sum(e.get("type")=="assistant" for e in events)})
    return events, req, result.returncode
