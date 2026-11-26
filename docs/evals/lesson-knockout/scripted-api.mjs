import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

const ev=(type,data)=>'event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n';
const start=(model,id)=>ev('message_start',{message:{id,type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,
  usage:{input_tokens:5,output_tokens:1,cache_creation_input_tokens:0,cache_read_input_tokens:0}}});
export function sse(model,id,blocks,stop) {
  let s=start(model,id);
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
const lastUser=body=>(body.messages??[]).findLast(m=>m.role==='user')?.content;
const lastText=body=>JSON.stringify(lastUser(body)??'');
const toolResult=body=>{
  const c=lastUser(body);
  return Array.isArray(c) && c.some(b=>b.type==='tool_result');
};

export async function startScriptedApi(ca) {
  let n=0;
  const seen=[],once_=new Set(),stalls=new Set();
  const server=https.createServer({key:fs.readFileSync(path.join(ca,'leaf.key')),cert:fs.readFileSync(path.join(ca,'leaf.pem'))},async (req,res)=>{
    const chunks=[];
    for await(const c of req) chunks.push(c);
    const raw=Buffer.concat(chunks),k=++n,id='msg_scripted_'+k,rid='req_scripted_'+k;
    const record=kind=>seen.push({n:k,kind,method:req.method,path:req.url,sha256:createHash('sha256').update(raw).digest('hex'),
      requestId:rid,authSha256:createHash('sha256').update(String(req.headers.authorization??'')).digest('hex'),metadata:raw.includes('"metadata"')});
    const json=(status,body,extra={})=>{ res.writeHead(status,{'content-type':'application/json','request-id':rid,...extra}); res.end(JSON.stringify(body)); };
    if(req.method!=='POST' || !req.url.startsWith('/v1/messages')) { record('other'); return json(404,{type:'error',error:{type:'not_found_error',message:'scripted'}}); }
    const body=JSON.parse(raw.toString('utf8')),text=lastText(body),model=body.model;
    if(req.url.startsWith('/v1/messages/count_tokens')) { record('count'); return json(200,{input_tokens:10}); }
    const stream=(payload,kind,gzip=false)=>{
      record(kind);
      res.writeHead(200,{'content-type':'text/event-stream','request-id':rid,...(gzip&&{'content-encoding':'gzip'})});
      res.end(gzip?zlib.gzipSync(payload):payload);
    };
    const sent=(blocks,stop,kind,gzip)=>stream(sse(model,id,blocks,stop),kind,gzip);
    const first=key=>!once_.has(key+text) && once_.add(key+text);
    if(toolResult(body)) return sent([{type:'text',text:'Done.'}],'end_turn','final');
    if(text.includes('CASE:tool')) return sent([{type:'tool_use',id:'toolu_'+k,name:'Read',input:{file_path:'a.txt'}}],'tool_use','tool');
    if(text.includes('CASE:gzip')) return sent([{type:'text',text:'Done.'}],'end_turn','final',true);
    if(text.includes('CASE:limit')) { record('limit'); return json(429,{type:'error',error:{type:'rate_limit_error',
      message:'This request would exceed your account usage limit.'}},{'x-should-retry':'false'}); }
    if(text.includes('CASE:retry') && first('retry')) { record('overloaded'); return json(529,{type:'error',error:{type:'overloaded_error',
      message:'Overloaded'}},{'x-should-retry':'true'}); }
    if(text.includes('CASE:midstream') && first('midstream')) return stream(start(model,id)+ev('error',{error:{type:'overloaded_error',
      message:'Overloaded'}}),'midstream');
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
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return {upstream:{host:'127.0.0.1',port:server.address().port,ca:fs.readFileSync(path.join(ca,'ca.pem'))},seen,
    close:()=>new Promise(resolve=>{ for(const r of stalls) r.destroy(); server.close(resolve); server.closeAllConnections(); })};
}
