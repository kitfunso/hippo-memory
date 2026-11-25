import argparse
import json
from pathlib import Path
import subprocess
from analyze import analyze
from itertools import groupby
from observe import grade
from session import CORPUS, EXE, PIN, REPAIR, digest, launch, read, write


def score(folder: Path, row: dict, events: list, rc: int, arm: str) -> dict:
    answers=[e for e in events if e.get("type")=="assistant"]
    result=next((e for e in reversed(events) if e.get("type")=="result"),{})
    usage=result.get("usage",{})
    spent={k:usage.get(k,0) for k in ("input_tokens","cache_creation_input_tokens","cache_read_input_tokens","output_tokens")}
    for e in events:
        attachment=e.get("attachment",{})
        if attachment.get("type")=="hook_non_blocking_error":
            return {"status":"hook_error","hook":attachment.get("hookName"),"usage":spent}
        content=e.get("message",{}).get("content",[])
        for block in content if isinstance(content,list) else []:
            if (block.get("type")=="tool_result" and block.get("is_error")
                and "uv_spawn" in str(block.get("content"))):
                return {"status":"tool_launch_error","usage":spent}
    models={a["message"].get("model") for a in answers}
    expected="claude-sonnet-5-5" if arm=="need-sonnet" else row["model"]
    if (not answers or any(a.get("error") or a.get("isApiErrorMessage") for a in answers)
        or models!={expected} or rc or result.get("subtype")!="success"
        or result.get("is_error") or result.get("permission_denials")):
        return {"status":"cli_error","exit":rc,"subtype":result.get("subtype"),"usage":spent,
                "code":next((a.get("error") for a in answers if a.get("error")),None)}
    code = 3
    for _,decision in groupby(answers,lambda a:a["message"]["id"]):
        commands=[b["input"]["command"] for a in decision for b in a["message"]["content"]
                  if b.get("type")=="tool_use" and b.get("name") in ("Bash","PowerShell")]
        if commands:
            code = grade(folder,row,commands)
            if code != 3:
                write(folder/"commands.json",commands)
                break
    return {"status":"ok","pass":code==0,"grade":code,"usage":spent,"turns":result.get("num_turns")}


def run(phase: str, token: str) -> bool:
    if phase=="smoke" and token!="Z0_SUB_TOKEN": raise ValueError("Smoke token must be Z0_SUB_TOKEN")
    wire=read(REPAIR/"wire.json")
    if digest(EXE.read_bytes())!=PIN:
        raise ValueError("Claude Code executable differs from the registered binary")
    if not wire["ready"]:
        report=analyze(phase,REPAIR/(phase+".jsonl"))
        write(REPAIR/(phase+"-result.json"),report)
        print("Offline fixture failed. See repair/wire.json. No session launched.")
        print(json.dumps(report))
        return False
    seal=CORPUS/"seal.json"
    if digest(seal.read_bytes())!="769a5518fc7aff1672a88afdf85fc9fe17c2258315bc8efd631e143a6e3d42b9":
        raise ValueError("Corpus seal differs from registration")
    for name,expected in read(seal).items():
        if digest((CORPUS/name).read_bytes())!=expected: raise ValueError("Frozen file changed: "+name)
    predecessor={"gate":"smoke","treatment":"gate"}.get(phase)
    if predecessor and analyze(predecessor,REPAIR/(predecessor+".jsonl"))["status"]!="PASS":
        raise ValueError("Preceding gate did not pass")
    ledger=REPAIR/(phase+".jsonl")
    plan=read(CORPUS/(phase+".json"))
    rows={r["sid"]:r for r in read(CORPUS/"manifest.json")}
    for job in plan:
        existing={r["id"]:r for r in map(json.loads, ledger.read_text().splitlines())} if ledger.exists() else {}
        if any(r["status"]!="ok" for r in existing.values()): raise ValueError("Unresolved attempt")
        if job["id"] in existing: continue
        folder=REPAIR/job["id"]
        folder.mkdir(exist_ok=False)
        try:
            row=rows[job["sid"]]
            events,_,rc=launch(folder,row,job["arm"],token,saved=wire["selected"]=="saved")
            result=score(folder,row,events,rc,job["arm"])
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
            result={"status":"launch_error","code":type(error).__name__}
        with ledger.open("a",encoding="utf-8") as output:
            output.write(json.dumps({"id":job["id"],**result})+"\n")
        print(job["id"],result["status"],flush=True)
        if result["status"]!="ok": break
    report=analyze(phase,ledger)
    write(REPAIR/(phase+"-result.json"),report)
    print(json.dumps(report))
    return report["status"] in ("PASS","COMPLETE")


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("phase",choices=["smoke","gate","treatment"])
    parser.add_argument("--token-var",required=True)
    args=parser.parse_args()
    raise SystemExit(0 if run(args.phase,args.token_var) else 1)
