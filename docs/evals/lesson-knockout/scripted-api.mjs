import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

const ev=(type,data)=>'event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n';
const start=(model,id,input=5)=>ev('message_start',{message:{id,type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,
  usage:{input_tokens:input,output_tokens:1,cache_creation_input_tokens:0,cache_read_input_tokens:0}}});
export function sse(model,id,blocks,stop,input) {
  let s=start(model,id,input);
  blocks.forEach((b,i)=>{
    if(b.type==='text') {
      s+=ev('content_block_start',{index:i,content_block:{type:'text',text:''}});
      s+=ev('content_block_delta',{index:i,delta:{type:'text_delta',text:b.text}});
    } else {
      s+=ev('content_block_start',{index:i,content_block:{type:'tool_use',id:b.id,name:b.name,input:{}}});
      s+=ev('content_block_delta',{index:i,delta:{type:'input_json_delta',partial_json:JSON.stringify(b.input)}});
    }
    s+=ev('content_block_stop',{index:i});
  });
  return s+ev('message_delta',{delta:{stop_reason:stop,stop_sequence:null},usage:{output_tokens:5}})+ev('message_stop',{});
}
const lastUser=body=>Array.isArray(body?.messages) ? body.messages.findLast(m=>m?.role==='user')?.content : undefined;
const lastText=body=>JSON.stringify(lastUser(body)??'');
const toolResult=body=>{
  const c=lastUser(body);
  return Array.isArray(c) && c.some(b=>b.type==='tool_result');
};

export async function startScriptedApi(ca) {
  let n=0;
  const seen=[],offers=[],once_=new Set(),stalls=new Set(),sockets=new Map(),tcp=new Map();
  const server=https.createServer({key:fs.readFileSync(path.join(ca,'leaf.key')),cert:fs.readFileSync(path.join(ca,'leaf.pem')),
    ALPNCallback:({protocols})=>{ offers.push(protocols); return protocols.includes('http/1.1') ? 'http/1.1' : undefined; }},async (req,res)=>{
    const chunks=[];
    for await(const c of req) chunks.push(c);
    const raw=Buffer.concat(chunks),k=++n,id='msg_scripted_'+k,rid='req_scripted_'+k;
    const record=kind=>seen.push({n:k,kind,method:req.method,path:req.url,sha256:createHash('sha256').update(raw).digest('hex'),
      requestId:rid,authSha256:createHash('sha256').update(String(req.headers.authorization??'')).digest('hex'),metadata:raw.includes('"metadata"'),
      requestClass:req.headers['x-claude-code-request-class']??null,auxiliary:req.headers['x-claude-code-auxiliary-type']??null,
      headers:req.rawHeaders.map((v,i)=>i%2 && /^authorization$/i.test(req.rawHeaders[i-1]) ? '*' : v),socket:sockets.get(req.socket) ?? sockets.set(req.socket,sockets.size+1).get(req.socket),
      protocol:req.socket.alpnProtocol || null,stream:/"stream":true/.test(raw.toString('utf8'))});
    const json=(status,body,extra={})=>{ res.writeHead(status,{'content-type':'application/json','request-id':rid,...extra}); res.end(JSON.stringify(body)); };
    if(req.method!=='POST' || !req.url.startsWith('/v1/messages')) { record('other'); return json(404,{type:'error',error:{type:'not_found_error',message:'scripted'}}); }
    let body=null;
    try { body=JSON.parse(raw.toString('utf8')); } catch {}
    if(!body || typeof body!=='object' || Array.isArray(body) || !Array.isArray(body.messages)) { record('malformed'); return json(400,{type:'error',error:{type:'invalid_request_error',message:'malformed'}}); }
    const text=lastText(body),model=body.model;
    if(req.url.startsWith('/v1/messages/count_tokens')) { record('count'); return json(200,{input_tokens:10}); }
    const stream=(payload,kind,gzip=false)=>{
      record(kind);
      res.writeHead(200,{'content-type':'text/event-stream','request-id':rid,...(gzip&&{'content-encoding':'gzip'})});
      res.end(gzip?zlib.gzipSync(payload):payload);
    };
    const sent=(blocks,stop,kind,gzip,input)=>stream(sse(model,id,blocks,stop,input),kind,gzip);
    const first=key=>!once_.has(key+text) && once_.add(key+text);
    if(req.headers['x-claude-code-request-class']==='compaction') return sent([{type:'text',text:'<summary>Scripted summary.</summary>'}],'end_turn','compaction');
    if(text.includes('CASE:toolong') && first('toolong')) { record('toolong'); return json(400,{type:'error',error:{type:'invalid_request_error',
      message:'prompt is too long: 250000 tokens > 200000 maximum'}}); }
    if(text.includes('CASE:bigctx') && !toolResult(body)) return sent([{type:'tool_use',id:'toolu_'+k,name:'Read',input:{file_path:'a.txt'}}],'tool_use','tool',false,990000);
    if(toolResult(body)) return sent([{type:'text',text:'Done.'}],'end_turn','final');
    if(text.includes('CASE:tool')) return sent([{type:'tool_use',id:'toolu_'+k,name:'Read',input:{file_path:'a.txt'}}],'tool_use','tool');
    if(text.includes('CASE:gzip')) return sent([{type:'text',text:'Done.'}],'end_turn','final',true);
    if(text.includes('CASE:wording')) { record('wording'); return json(400,{type:'error',error:{type:'invalid_request_error',
      message:'Claude AI usage limit reached; you hit your limit (rate_limit_error, overloaded_error).'}}); }
    if(text.includes('CASE:big')) return sent([{type:'text',text:'x'.repeat(2_000_000)}],'end_turn','big');
    if(text.includes('CASE:trailers')) {
      record('trailers');
      res.writeHead(200,{'content-type':'text/event-stream','request-id':rid,'trailer':'x-check'});
      res.write(sse(model,id,[{type:'text',text:'Done.'}],'end_turn'));
      res.addTrailers({'x-check':'1'});
      return res.end();
    }
    if(text.includes('CASE:limit')) { record('limit'); return json(429,{type:'error',error:{type:'rate_limit_error',
      message:'This request would exceed your account usage limit.'}},{'x-should-retry':'false'}); }
    if(text.includes('CASE:retry') && first('retry')) { record('overloaded'); return json(529,{type:'error',error:{type:'overloaded_error',
      message:'Overloaded'}},{'x-should-retry':'true'}); }
    if(text.includes('CASE:busy') && first('busy')) { record('busy'); return json(429,{type:'error',error:{type:'rate_limit_error',
      message:'Rate limited'}},{'x-should-retry':'true','retry-after':'0'}); }
    if(text.includes('CASE:exhaust')) { record('exhaust'); return json(529,{type:'error',error:{type:'overloaded_error',
      message:'Overloaded'}},{'x-should-retry':'true','retry-after':'0'}); }
    if(text.includes('CASE:reset') && first('reset')) {
      record('reset');
      res.writeHead(200,{'content-type':'text/event-stream','request-id':rid});
      res.write(start(model,id));
      return setTimeout(()=>tcp.get(req.socket.remotePort)?.resetAndDestroy(),50);
    }
    if(text.includes('CASE:plain')) { record('plain'); return json(200,{id,type:'message',role:'assistant',model,content:[{type:'text',text:'Done.'}],
      stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:5,output_tokens:2}}); }
    if(text.includes('CASE:midstream') && first('midstream')) return stream(start(model,id)+ev('error',{error:{type:'overloaded_error',
      message:'Overloaded'}}),'midstream');
    if(text.includes('CASE:hold')) { record('hold'); stalls.add(res); return; }
    if(text.includes('CASE:stall')) {
      record('stall');
      res.writeHead(200,{'content-type':'text/event-stream','request-id':rid});
      res.write(start(model,id));
      stalls.add(res);
      return;
    }
    if(text.includes('CASE:')) return sent([{type:'text',text:'Done.'}],'end_turn','final');
    return sent([{type:'text',text:'ok'}],'end_turn','side');
  });
  server.on('connection',s=>tcp.set(s.remotePort,s));
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return {upstream:{host:'127.0.0.1',port:server.address().port,ca:fs.readFileSync(path.join(ca,'ca.pem'))},seen,offers,
    close:()=>new Promise(resolve=>{ for(const r of stalls) r.destroy(); server.close(resolve); server.closeAllConnections(); })};
}
