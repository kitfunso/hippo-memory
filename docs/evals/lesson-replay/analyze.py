import argparse
import json
from math import sqrt
from pathlib import Path
from session import CORPUS, ROOT, REPAIR, read


def wilson(p: float, n: int) -> tuple:
    z = 1.959963984540054
    center = p+z*z/(2*n)
    half = z*sqrt(p*(1-p)/n+z*z/(4*n*n))
    return ((center-half)/(1+z*z/n),(center+half)/(1+z*z/n))


def analyze(phase: str, ledger: Path) -> dict:
    rows={r["sid"]:r for r in read(CORPUS/"manifest.json")}
    plan=read(CORPUS/(phase+".json"))
    results={}
    for line in ledger.read_text(encoding="utf-8").splitlines() if ledger.exists() else []:
        r=json.loads(line)
        if r["id"] in results: raise ValueError("Repeated attempt")
        results[r["id"]]=r
    if results.keys()-{j["id"] for j in plan}: raise ValueError("Unscheduled attempt")
    errors=sum(r["status"]!="ok" for r in results.values())
    if any(r["status"]=="ok" and type(r["pass"]) is not bool for r in results.values()):
        raise ValueError("Nonbinary grade")
    out={"phase":phase,"planned":len(plan),"completed":len(results)-errors,"errors":errors,
         "status":"INCOMPLETE","metrics":None}
    if errors or len(plan)!=len(results): return out
    if phase in ("smoke","gate"):
        pairs=[(rows[j["sid"]]["pass"],results[j["id"]]["pass"]) for j in plan]
        n=len(pairs)
        matches=sum(a==b for a,b in pairs)
        rates={str(label).lower():sum(a==b==label for a,b in pairs)/sum(a==label for a,b in pairs)
               for label in [True,False]}
        delta=sum(int(b)-int(a) for a,b in pairs)/n
        passed=matches/n>=.80 and min(rates.values())>=.70 and abs(delta)<=.10
        out.update(status="PASS" if passed else "KILL_REPLAY",
                   metrics={"agreement":matches/n,"classAgreement":rates,"historicalPass":sum(a for a,b in pairs)/n,
                            "replayPass":sum(b for a,b in pairs)/n,"rateDifference":delta})
        return out
    groups={}
    for j in plan:
        groups.setdefault(j["arm"],[]).append(int(results[j["id"]]["pass"]))
    rates={arm:sum(values)/len(values) for arm,values in sorted(groups.items())}
    contrasts={}
    for a,b in [("reference","cut"),("near","start"),("near","d2"),("near","d50"),("near","d300"),
                ("paraphrase","near"),("checklist","near"),("cut","need-sonnet")]:
        x,y=rates[a],rates[b]
        lx,ux=wilson(x,len(groups[a]))
        ly,uy=wilson(y,len(groups[b]))
        delta=x-y
        lo=delta-sqrt((x-lx)**2+(uy-y)**2)
        hi=delta+sqrt((ux-x)**2+(y-ly)**2)
        contrasts[a+"_"+b]={"difference":delta,"interval":[lo,hi],"equivalent":lo>-.1 and hi<.1}
    out.update(status="COMPLETE",metrics={"pass":rates,"contrasts":contrasts,
        "contentInert":contrasts["reference_cut"]["equivalent"],
        "noPlacementOrScale":all(contrasts[k]["equivalent"] for k in ["near_start","near_d2","near_d50","near_d300"])})
    return out


if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("phase",choices=["smoke","gate","treatment"])
    ledgers=parser.add_mutually_exclusive_group()
    ledgers.add_argument("--first-pass",action="store_true")
    ledgers.add_argument("--route-b",action="store_true")
    args=parser.parse_args()
    root=ROOT/"route-b" if args.route_b else ROOT if args.first_pass else REPAIR
    print(json.dumps(analyze(args.phase,root/(args.phase+".jsonl")),separators=(",",":")))
