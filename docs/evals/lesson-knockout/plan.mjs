import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { drawOrder } from '../../../scripts/token-eval/lessons.mjs';
import stdioMode from './local-stdio.cjs';

export const root = 'C:/z0-lessons/lesson-knockout';
export const tasks = 'C:/z0-runs/r4/tasks';
export const e1 = 'C:/Users/skf_s/Documents/hippo-mechanisms-2026-11-24/experiment1';
export const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const pins = read('C:/z0-runs/r4/pins-r4.json');
export const folder = path.dirname(fileURLToPath(import.meta.url));
export const arms = ['T', 'Tp', 'N'];
export const APPARATUS = 3;
export const DENIED_TOOLS = ['WebFetch', 'WebSearch', 'Agent', 'Task'];
export const DISPATCH_LOG = 'dispatch.jsonl';
export const dispatchEnv = url => ({CLAUDE_CODE_ENABLE_TELEMETRY:'1',OTEL_LOGS_EXPORTER:'otlp',OTEL_METRICS_EXPORTER:'none',
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL:'http/json',OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:url,OTEL_LOGS_EXPORT_INTERVAL:'500'});
export const preload = name => '--require "'+path.join(folder,name).replaceAll('\\','/')+'"';
export function assertNodeStarts(env, label) {
  const probe = spawnSync(process.execPath, ['-e','process.exit(0)'], {env, windowsHide:true, stdio:['ignore','ignore','inherit']});
  if (probe.status !== 0) throw Error(label+' cannot start node (exit '+probe.status+'): '+(probe.error?.message ?? 'see stderr above'));
}
export function checkerEnv(extra) {
  const env = {...process.env};
  for (const key of Object.keys(env)) if (/token|secret|key|proxy|^CLAUDE|^ANTHROPIC|^HIPPO|^AWS|^Z0_/i.test(key)) delete env[key];
  Object.assign(env, {GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'NUL', GIT_TERMINAL_PROMPT:'0', GIT_OPTIONAL_LOCKS:'0',
    NODE_OPTIONS:preload('local-stdio.cjs'), LESSON_STDIO:stdioMode}, extra);
  assertNodeStarts(env, 'Checker environment');
  return env;
}
const rank = (role, id) => hash(`lesson-knockout|1|${role}|${id}`);
const ordered = (items, key) => [...items].sort((a,b) => key(a).localeCompare(key(b), 'en'));
const chains = read('C:/eval-authors/r3-repos.json');
const labels = read(path.join(e1,'data/lesson-labels.json')).lessons;

export function checkTaskPins() {
  const index=fs.readFileSync(path.join(tasks,'sha256.txt'));
  if(hash(index)!==pins['sha256:tasks']) throw Error('Changed frozen task index');
  for(const line of index.toString().trim().split(/\r?\n/)) {
    const match=/^([0-9a-f]{64})\s+([\w./-]+)$/.exec(line);
    if(!match || match[2].split('/').includes('..') || path.isAbsolute(match[2])) throw Error('Bad task pin');
    if(hash(fs.readFileSync(path.join(tasks,match[2])))!==match[1]) throw Error('Changed frozen file '+match[2]);
  }
}

export function roster() {
  const primary = [], reserve = [];
  for (const repo of [...pins.batch1Keys.split(','), ...pins.batch2Keys.split(',')]) {
    const file = path.join(tasks,repo,'tasks-run.json');
    const spec = read(file), seq = spec.sequences.find(s => s.id === repo);
    const order = drawOrder(seq,spec.families,1);
    const families = ordered(spec.families,f => rank('family',f.id));
    for (const [i,f] of families.entries()) {
      const lesson = f.lessons.find(l => !l.supersedes);
      const paired = order.map(id => seq.tasks.find(t => t.id === id)).filter(t => t.lessonId === lesson.id);
      const teach = paired.find(t => t.kind === 'teach'), apply = paired.find(t => t.kind === 'apply');
      const checkPath = path.resolve(path.dirname(file),lesson.check.script);
      if (!teach || !apply || !fs.existsSync(checkPath)) throw Error('Incomplete task '+f.id);
      const unit = {id:f.id,repo,source:seq.repo,toolchain:chains[repo].toolchain,cls:labels[f.id]?.[0] ?? 'unlabelled',
        lesson:{...lesson,checkPath},teach,apply,specHash:hash(fs.readFileSync(file)),
        checkerHash:hash(fs.readFileSync(checkPath)),order:ordered(arms,a => rank('order',f.id+'|'+a))};
      (i===0 ? primary : reserve).push(unit);
    }
  }
  return ordered([...primary,...ordered(reserve,u=>rank('reserve',u.id)).slice(0,49-primary.length)],u=>rank('unit',u.id));
}

export function background(u) {
  return ordered(roster().filter(v=>v.repo!==u.repo && !v.lesson.rule.toLowerCase().includes(u.lesson.keyPhrase.toLowerCase())),
    v=>rank('background',u.id+'|'+v.id)).slice(0,20).map(v=>v.lesson.rule);
}

export function checkedRoster() {
  checkTaskPins();
  const units=roster();
  if(hash(JSON.stringify(units))!=='7b3e3078f73cd6c11a2a6e50aabad48728016f5aae6f28a2db50daa1db8a2e42')
    throw Error('Roster drift');
  return units;
}

export function guardPaths(units) {
  return [...new Set(units.flatMap(u=>[u.source,path.join(tasks,u.repo,'tasks-run.json'),u.lesson.checkPath]))];
}

export async function estimate() {
  const {loadRound3, firstApplies} = await import(pathToFileURL(path.join(e1,'scripts/load.mjs')));
  const {records,filtered} = loadRound3();
  const teaches = records.filter(r=>r.arm==='A2' && r.kind==='teach' && r.teachTurns===1 && !r.invalid && !r.timedOut && !r.agentError);
  const applies = firstApplies(filtered,'A2').filter(r=>!r.invalid && !r.timedOut && !r.agentError);
  const fields = ['inputTokens','cacheWriteTokens','cacheReadTokens','outputTokens'];
  function mean(rows,includeResume) {
    return Object.fromEntries(fields.map(f=>[f, rows.reduce((n,r)=>{
      const v=r.usage.firstSession[f]+(includeResume ? r.usage.extra[f] : 0);
      if (!Number.isFinite(v)) throw Error('Missing usage '+r.taskId);
      return n+v;
    },0)/rows.length]));
  }
  const teach=mean(teaches,true),apply=mean(applies,false),units=roster().length;
  const projected=Object.fromEntries(fields.map(f=>[f,Math.round(units*(teach[f]+arms.length*apply[f]))]));
  return {units,repos:new Set(roster().map(u=>u.repo)).size,teachSessions:units,applySessions:units*arms.length,
    sessions:units*(1+arms.length),cliInvocations:units*(2+arms.length), historicalTeach:teaches.length,
    historicalApply:applies.length,teach,apply,projected,totalTokens:Object.values(projected).reduce((a,b)=>a+b)};
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const units=roster();
  const command=process.argv[2];
  console.log(JSON.stringify(command==='usage' ? await estimate() :
    command==='guards' ? guardPaths(units) :
    command==='labels' ? Object.fromEntries(['variant','omission','pattern','unlabelled'].map(c=>[c,units.filter(u=>u.cls===c).map(u=>u.id)])) :
    {sha256:hash(JSON.stringify(units)),units:units.map(u=>[u.id,u.teach.id,u.apply.id,u.order])},null,2));
}
