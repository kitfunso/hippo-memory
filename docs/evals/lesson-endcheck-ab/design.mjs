import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { corpus, digest, loadPlan, study } from './paths.mjs';

export const alpha = 0.05;
const target = 0.8;
const repair = 0.5;
const reverse = 0.04;
const bytes=fs.readFileSync(path.join(corpus,'end-check-prod-replay.json'));
if(digest(bytes)!=='f97adf4af3858c05c29a141bc8353a0d404e36b5e675c876b756634f4409448e') throw new Error('replay pin changed');
const replay = JSON.parse(bytes);
const reach = replay.fails.omission.listed / (replay.fails.omission.n + replay.passes.omission.n);
const net = repair * reach;
const gain = net + reverse;
function binomial(n,p) {
  const v = Array(n+1).fill(0);
  v[0] = 1;
  for (let k = 1; k <= n; k++)
    for (let j = k; j >= 0; j--) v[j] = v[j]*(1-p) + (j ? v[j-1]*p : 0);
  return v;
}
const tails = new Map();
function tail(n) {
  if (!tails.has(n)) {
    const row = binomial(n,0.5);
    for (let k = n-1; k >= 0; k--) row[k] += row[k+1];
    tails.set(n,row);
  }
  return tails.get(n);
}
export const signP = (gains, losses) => Math.min(1,tail(gains+losses)[gains]);
const wins = [0];
function power(n) {
  const d = gain+reverse;
  while (wins.length <= n) {
    const m = wins.length;
    wins.push(binomial(m,gain/d).reduce((p,x,k) => p+(signP(k,m-k)<=alpha ? x : 0),0));
  }
  return binomial(n,d).reduce((p,x,k)=>p+x*wins[k],0);
}
const units = loadPlan().units;
const omissions = units.filter(x => x.kind === 'omission');
let required = 1;
while (power(required) < target) required++;
const blocks = Math.ceil(required/omissions.length);
export const schedule = units.flatMap(u =>
  Array.from({length:u.kind === 'omission' ? blocks : 1}, (_,i) => {
    const key = u.id+'-'+(i+1);
    const onFirst = parseInt(digest(study+'/coin/'+key).slice(0,2),16)%2 === 1;
    return {key,id:u.id,block:i+1,order:onFirst?['ON','OFF']:['OFF','ON']};
  })).sort((a,b) => digest(study+'/order/'+a.key).localeCompare(digest(study+'/order/'+b.key)));
export function sizing() {
  const n = blocks*omissions.length;
  const seed1 = omissions.filter(u=>u.seed===1).length;
  return {alpha,target,repair,reverse,reach,net,required,seed1,powerSeed1:power(seed1),
    powerOnePass:power(omissions.length),blocks,omissionPairs:n,power:power(n),
    pairs:schedule.length,sessions:2*schedule.length,replay:{
      fails:replay.fails.omission,passes:replay.passes.omission,allPass:Object.values(replay.passes).reduce((s,x)=>s+x.n,0),
      otherListings:replay.otherAtFirstApply,listed:replay.sessionsListing,total:replay.sessions}};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(sizing()));

