import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from uuid import uuid4
from session import REPAIR, CORPUS, EXE, PIN, digest, launch, read, write
from run import score


def fingerprint(obj: object) -> str:
    return digest(json.dumps(obj,sort_keys=True,ensure_ascii=False).encode())


def blocks(messages: list, kind: str) -> list:
    return [b for m in messages if isinstance(m["content"],list) for b in m["content"] if b.get("type")==kind]


def compare(source: dict, actual: dict) -> dict:
    sm, am = source["messages"], actual["messages"]
    text = json.dumps(am,ensure_ascii=False)
    src_tools = {t["name"]:t for t in source["tools"]}
    got_tools = {t["name"]:t for t in actual["tools"]}
    shared = sorted(src_tools.keys() & got_tools.keys())
    definitions = {k: [field for field in sorted(src_tools[k].keys() | got_tools[k].keys())
                       if src_tools[k].get(field) != got_tools[k].get(field)] for k in shared}
    source_deferred = [k for k in sorted(src_tools.keys()-got_tools.keys()) if k in text
                       and any(k in b["text"] and "deferred" in b["text"].lower()
                               and b["text"] not in [x["text"] for x in blocks(sm,"text")]
                               for b in blocks(am,"text"))]
    missing = [b["text"] for b in blocks(sm,"text") if json.dumps(b["text"],ensure_ascii=False)[1:-1] not in text]
    def history(messages: list, kind: str) -> list:
        return [{k:v for k,v in b.items() if k!="cache_control"} for b in blocks(messages,kind)]
    return {"sourceModel":source["model"],"replayModel":actual["model"],
            "effortMatches":source["effort"]==actual.get("output_config",{}).get("effort"),
            "systemExact":source["system"]==actual["system"],
            "sourceSystemMatches":[b in actual["system"] for b in source["system"]],
            "billingRebuilt":actual["system"][0]["text"].startswith("x-anthropic-billing-header"),
            "sourceThinkingBlocks":len(blocks(sm,"thinking")),
            "replayThinkingBlocks":len(blocks(am,"thinking")),
            "messageRoles":[[m["role"] for m in msgs] for msgs in (sm,am)],
            "changedDefinitionFields":{k:v for k,v in definitions.items() if v},
            "missingToolsNamedInNewDeferredReminder":source_deferred,
            "systemBlocksExact":sum(b in actual["system"] for b in source["system"]),
            "stableBlockExact":source["system"][-1] in actual["system"],
            "toolSetExact":src_tools.keys()==got_tools.keys(),
            "allSchemasExact":src_tools==got_tools,
            "stableSystemPresent":any(source["system"][-1]["text"].strip() in b["text"] for b in actual["system"]),
            "systemHashes":[fingerprint(s) for s in (source["system"],actual["system"])],
            "toolHashes":[fingerprint(s) for s in (source["tools"],actual["tools"])],
            "toolsMissing":sorted(src_tools.keys()-got_tools.keys()),"toolsAdded":sorted(got_tools.keys()-src_tools.keys()),
            "schemasChanged":sorted(k for k in src_tools.keys() & got_tools.keys() if src_tools[k]!=got_tools[k]),
            "schemasExact":sorted(k for k in src_tools.keys() & got_tools.keys() if src_tools[k]==got_tools[k]),
            "missingTextBlocks":len(missing),"bashPresent":"Bash" in got_tools,
            "toolUsesExact":history(sm,"tool_use")==history(am,"tool_use"),
            "resultsExact":history(sm,"tool_result")==history(am,"tool_result"),
            "sourceMessages":len(sm),"rebuiltMessages":len(am),"messagesExact":sm==am}


def probe(saved: bool) -> dict:
    if digest(EXE.read_bytes()) != PIN:
        raise ValueError("Binary changed")
    rows = {r["sid"]:r for r in read(CORPUS/"manifest.json")}
    job = read(CORPUS/"smoke.json")[0]
    folder = REPAIR / ("wire-"+uuid4().hex[:10])
    folder.mkdir()
    bodies = []
    class Receiver(BaseHTTPRequestHandler):
        def log_message(self, *args: object) -> None:
            pass

        def do_POST(self) -> None:
            payload = self.rfile.read(int(self.headers.get("Content-Length",0)))
            if self.path.split("?")[0]=="/v1/messages":
                data = json.loads(payload)
                if data.get("tools"):
                    bodies.append(data)
                    self.send_response(200)
                    self.send_header("Content-Type","text/event-stream")
                    self.end_headers()
                    n=len(bodies)
                    message={"id":f"msg_offline_{n}","type":"message","role":"assistant","model":data["model"],
                             "content":[],"stop_reason":None,"usage":{"input_tokens":1,"output_tokens":0}}
                    stream=[("message_start",{"message":message}),
                            ("content_block_start",{"index":0,"content_block":{"type":"tool_use",
                             "id":f"toolu_offline_{n}","name":"Bash","input":{}}}),
                            ("content_block_delta",{"index":0,"delta":{"type":"input_json_delta",
                             "partial_json":json.dumps({"command":"echo offline > tool-executed.txt" if n==1
                                                       else "python -m pytest --version"})}}),
                            ("content_block_stop",{"index":0}),
                            ("message_delta",{"delta":{"stop_reason":"tool_use","stop_sequence":None},
                                              "usage":{"output_tokens":1}}),("message_stop",{})]
                    if n>=3:
                        stream[1:3]=[("content_block_start",{"index":0,"content_block":{"type":"text","text":""}}),
                                     ("content_block_delta",{"index":0,"delta":{"type":"text_delta","text":"Done."}})]
                        stream[-2][1]["delta"]["stop_reason"]="end_turn"
                    for event,fields in stream:
                        self.wfile.write(f"event: {event}\ndata: {json.dumps(dict(type=event,**fields))}\n\n".encode())
                    return
            self.send_response(400)
            self.send_header("Content-Type","application/json")
            self.end_headers()
            self.wfile.write(b'{"type":"error","error":{"type":"invalid_request_error","message":"offline receipt"}}')

        def do_GET(self) -> None:
            self.send_error(404)
    with ThreadingHTTPServer(("127.0.0.1",0),Receiver) as server:
        Thread(target=server.serve_forever,daemon=True).start()
        try:
            events,source,rc=launch(folder,rows[job["sid"]],"unchanged","",f"http://127.0.0.1:{server.server_port}",saved)
        finally:
            server.shutdown()
    if not bodies:
        print(json.dumps({"requests":len(bodies),"exit":rc,"events":[e.get("type") for e in events]}))
        raise ValueError("Expected one local decision request")
    report=compare(source,bodies[0])
    report["fixtureEvents"]=[{k:e[k] for k in ("type","subtype","num_turns") if k in e}
                             for e in events if e.get("type") in ("assistant","user","result")]
    report["fixtureToolResults"]=[{"id":b["tool_use_id"],"error":bool(b.get("is_error")),
                                  "detail":str(b.get("content",""))[:350]}
        for e in events if e.get("type")=="user" for b in e["message"]["content"]
        if isinstance(b,dict) and b.get("type")=="tool_result" and b["tool_use_id"].startswith("toolu_offline_")]
    report["fixtureGrade"]=score(folder,rows[job["sid"]],events,rc,"unchanged")
    report["toolExecuted"]=(folder/"work"/"tool-executed.txt").is_file()
    report["requests"]=len(bodies)
    report.update(sid=job["sid"],binary=PIN, folder=folder.name, mode="local receipt without a subscription")
    report["ready"]=all(report[k] for k in ("toolExecuted","stableSystemPresent","bashPresent","toolUsesExact","resultsExact","effortMatches")) and not report["missingTextBlocks"] and report["sourceModel"]==report["replayModel"] and report["fixtureGrade"].get("grade")==1
    return report


def main() -> None:
    REPAIR.mkdir(exist_ok=True)
    variants={key:probe(key=="saved") for key in ("native","saved")}
    def rank(key: str) -> tuple:
        r=variants[key]
        return r["systemExact"],r["stableBlockExact"],r["systemBlocksExact"]
    selected=max(variants,key=rank)
    report={**variants[selected],"selected":selected,"variants":variants}
    write(REPAIR/"wire.json",report)
    print(json.dumps(report))
    if not report["ready"]:
        raise SystemExit(1)


if __name__=="__main__":
    main()
