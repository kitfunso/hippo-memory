import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {loadPlan,read,root} from './paths.mjs';
import {schedule,signP} from './design.mjs';

const units=new Map(loadPlan().units.map(u=>[u.id,u]));
const fmt=x=>x.toFixed(4);
const harmMargin=0.05;
const valid=r=>r && ['pass','fail','na'].includes(r.first) && Number.isInteger(r.stops) && Array.isArray(r.listings) &&
  r.listings.every(l=>['pass','fail','na'].includes(l.atStop) && Number.isInteger(l.target) && l.target>=0 && Number.isInteger(l.other) && l.other>=0);
const cdf=(n,k,p)=>{
  let term=(1-p)**n, total=term;
  for(let j=1;j<=k;j++){term*=((n-j+1)/j)*p/(1-p);total+=term;}
  return total;
};
function upper(n,k) {
  if(k===n)return 1;
  let lo=0,hi=1;
  for(let i=0;i<60;i++){const mid=(lo+hi)/2;if(cdf(n,k,mid)>0.05)lo=mid;else hi=mid;}
  return hi;
}
export function summarize(results) {
  if(results.length!==schedule.length) return ['INCOMPLETE pairs='+results.length+'/'+schedule.length+' verdict=withheld'];
  const primary=results.filter(r=>r.u.kind==='omission');
  const historical=results.filter(r=>r.u.historicalPass && r.p.block===1);
  const counts=rows=>{
    const off=rows.filter(r=>r.off.first!=='pass').length,on=rows.filter(r=>r.on.first!=='pass').length;
    const gain=rows.filter(r=>r.off.first!=='pass' && r.on.first==='pass').length;
    const harm=rows.filter(r=>r.on.first!=='pass' && r.off.first==='pass').length;
    return {off,on,gain,harm,n:rows.length};
  };
  const a=counts(primary),s=counts(historical);
  const p=signP(a.gain,a.harm);
  const verdict=a.on>=a.off?'kill':p<=0.05?'lower':'inconclusive';
  const high=upper(s.n,s.harm);
  const targetFalse=historical.filter(r=>r.on.listings.some(l=>l.target && l.atStop!=='fail')).length;
  const list=(rows,fn)=>rows.filter(r=>r.on.listings.some(fn)).length;
  return [
    'COMPLETE pairs='+results.length+'/'+schedule.length,
    'PRIMARY omission_pairs='+a.n+' OFF_fail='+a.off+' ON_fail='+a.on+' OFF_rate='+fmt(a.off/a.n)+' ON_rate='+fmt(a.on/a.n)+
      ' ON_minus_OFF='+fmt((a.on-a.off)/a.n)+' rescued='+a.gain+' harmed='+a.harm+' p_one_sided='+fmt(p)+' verdict='+verdict,
    'PASS_STRATUM pairs='+s.n+' OFF_fail='+s.off+' ON_fail='+s.on+' rescued='+s.gain+' harmed='+s.harm+
      ' harm_upper95='+fmt(high)+' margin='+fmt(harmMargin)+' safety='+(high<harmMargin?'within_margin':'unresolved'),
    'LISTINGS historical_pass_target='+list(historical,l=>l.target>0)+' historical_pass_false_target='+targetFalse+
      ' historical_pass_other='+list(historical,l=>l.other>0)+' historical_pass_denominator='+s.n+
      ' all_ON_any='+list(results,()=>true)+' all_ON_denominator='+results.length,
    'FAMILY '+JSON.stringify(Object.fromEntries([...new Set(primary.map(r=>r.u.family))].sort().map(f=>[f,counts(primary.filter(r=>r.u.family===f))]))),
  ];
}
const args=process.argv.slice(2);
assert.ok(!args.length || (args.length===1 && args[0]==='--fixture'),'unexpected argument');
const results=[];
for(const p of schedule) {
  const u=units.get(p.id);
  if(args.length) {
    const clean={first:'pass',stops:0,listings:[]};
    results.push({p,u,off:{...clean,first:u.historicalPass?'pass':'fail'},on:{...clean,stops:1}});
    continue;
  }
  const f=path.join(root,'trial',p.key,'result.json');
  if(!fs.existsSync(f))continue;
  const row=read(f);
  assert.equal(row.pair,p.key);assert.equal(row.id,p.id);
  assert.match(row.seedHash,/^[0-9a-f]{64}$/);
  const {ON:on,OFF:off}=row.rows;
  assert.ok(valid(on) && valid(off) && on.stops>0 && !off.listings.length && !off.stops);
  results.push({p,u,off,on});
}
console.log(summarize(results).join('\n'));
if(results.length!==schedule.length)process.exitCode=2;

