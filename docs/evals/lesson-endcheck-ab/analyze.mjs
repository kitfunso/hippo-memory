import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {loadPlan,read,revision,root} from './paths.mjs';
import {schedule,signP} from './design.mjs';
import {upperNet} from './safety.mjs';
import {armBinding,audited,auditFile,readAudits} from './crash-audit.mjs';

const units=new Map(loadPlan().units.map(u=>[u.id,u]));
const fmt=x=>x.toFixed(4);
const harmMargin=0.05;
const valid=r=>r && ['pass','fail','na'].includes(r.first) && Number.isInteger(r.stops) && Array.isArray(r.listings) &&
  Number.isInteger(r.nonStopTimeouts) && r.nonStopTimeouts>=0 &&
  Number.isInteger(r.productionTimeouts) && r.productionTimeouts>=0 && r.productionTimeouts<=r.stops-r.listings.length &&
  r.listings.every(l=>['pass','fail','na'].includes(l.atStop) && Number.isInteger(l.target) && l.target>=0 && Number.isInteger(l.other) && l.other>=0);
export function summarize(results) {
  const total=(arm,key)=>results.reduce((n,r)=>n+(r[arm]?.[key]??0),0);
  const missing=arm=>results.filter(r=>!r[arm]).length;
  const infra='INFRA production_timeouts_OFF='+total('off','productionTimeouts')+' production_timeouts_ON='+total('on','productionTimeouts')
    +' non_stop_timeouts_OFF='+total('off','nonStopTimeouts')+' non_stop_timeouts_ON='+total('on','nonStopTimeouts')
    +' missing_OFF='+missing('off')+' missing_ON='+missing('on');
  if(results.length!==schedule.length) return ['INCOMPLETE closed_pairs='+results.length+'/'+schedule.length+' verdict=withheld',infra];
  const primary=results.filter(r=>r.u.kind==='omission');
  const historical=results.filter(r=>r.u.historicalPass && r.p.block===1);
  const counts=rows=>{
    const assigned=rows.length;
    rows=rows.filter(r=>r.off && r.on);
    const off=rows.filter(r=>r.off.first!=='pass').length,on=rows.filter(r=>r.on.first!=='pass').length;
    const gain=rows.filter(r=>r.off.first!=='pass' && r.on.first==='pass').length;
    const harm=rows.filter(r=>r.on.first!=='pass' && r.off.first==='pass').length;
    return {off,on,gain,harm,n:rows.length,missing:assigned-rows.length};
  };
  const a=counts(primary),s=counts(historical);
  const p=signP(a.gain,a.harm+a.missing);
  const diff=a.harm-a.gain, assigned=a.n+a.missing;
  const low=(diff-a.missing)/assigned,highEffect=(diff+a.missing)/assigned;
  const verdict=low>=0?'kill':highEffect<0 && p<=0.05?'lower':'inconclusive';
  const high=upperNet(s.n+s.missing,s.harm+s.missing,s.gain);
  const list=(rows,fn)=>rows.filter(r=>r.on?.listings.some(fn)).length;
  const targetFalse=list(historical,l=>l.target && l.atStop!=='fail');
  const rate=(v,n)=>n?fmt(v/n):'NA';
  return [
    'CLOSED pairs='+results.length+'/'+schedule.length,
    'PRIMARY omission_pairs='+a.n+' missing='+a.missing+' OFF_fail='+a.off+' ON_fail='+a.on+' OFF_rate='+rate(a.off,a.n)+' ON_rate='+rate(a.on,a.n)+
      ' ON_minus_OFF='+rate(diff,a.n)+' rescued='+a.gain+' harmed='+a.harm+' effect_min='+fmt(low)+' effect_max='+fmt(highEffect)+
      ' p_one_sided_max='+fmt(p)+' verdict='+verdict,
    'PASS_STRATUM pairs='+s.n+' missing='+s.missing+' OFF_fail='+s.off+' ON_fail='+s.on+' rescued='+s.gain+' harmed='+s.harm+
      ' ON_minus_OFF='+rate(s.harm-s.gain,s.n)+' net_upper95='+fmt(high)+' margin='+fmt(harmMargin)+' safety='+(high<harmMargin?'within_margin':'unresolved'),
    'LISTINGS historical_pass_target='+list(historical,l=>l.target>0)+' historical_pass_false_target='+targetFalse+
      ' historical_pass_other='+list(historical,l=>l.other>0)+' historical_pass_denominator='+historical.filter(r=>r.on).length+
      ' all_ON_any='+list(results,()=>true)+' all_ON_denominator='+results.filter(r=>r.on).length,
    'FAMILY '+JSON.stringify(Object.fromEntries([...new Set(primary.map(r=>r.u.family))].sort().map(f=>[f,counts(primary.filter(r=>r.u.family===f))]))),
    infra,
  ];
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  assert.ok(!args.length || (args.length===1 && ['--fixture','--fixture-missing'].includes(args[0])),'unexpected argument');
  const results=[];
  const audits=args.length?new Map():readAudits(auditFile(root));
  for(const p of schedule) {
    const u=units.get(p.id);
    if(args.length) {
      const clean={first:'pass',stops:0,productionTimeouts:0,nonStopTimeouts:0,listings:[]};
      const on={...clean,stops:1,productionTimeouts:results.length===0?1:0};
      results.push({p,u,off:{...clean,first:u.historicalPass?'pass':'fail'},on:args[0]==='--fixture-missing' && !results.length?null:on});
      continue;
    }
    const f=path.join(root,'trial',p.key,'result.json');
    if(!fs.existsSync(f))continue;
    const row=read(f);
    assert.equal(row.pair,p.key);assert.equal(row.id,p.id);
    assert.match(row.seedHash,/^[0-9a-f]{64}$/);
    const {ON:on,OFF:off}=row.rows;
    assert.equal(row.revision,revision);
    assert.ok(on===null?row.missing.ON:valid(on) && on.stops>0);
    assert.ok(off===null?row.missing.OFF:valid(off) && !off.listings.length && !off.stops);
    const base=path.join(root,'trial',p.key);
    results.push({p,u,off:audited(off,p.key,'OFF',audits,armBinding(base,'OFF')),on:audited(on,p.key,'ON',audits,armBinding(base,'ON'))});
  }
  console.log(summarize(results).join('\n'));
  if(results.length!==schedule.length)process.exitCode=2;
}
