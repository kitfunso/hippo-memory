import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { corpus, digest, dist, experiments, freeze, json, read, slice, study } from './paths.mjs';

const { loadRound3, firstApplies, transcripts } = await import(pathToFileURL(path.join(experiments, 'scripts/load.mjs')));
const {checkerIdentity}=await import(pathToFileURL(path.join(slice,'scripts/token-eval/checker-identity.mjs')));
const checkerHashes=new Map();
const { collectSessionTurns } = await dist('surface/capture/transcript.js');
const { followUpRules } = await dist('surface/capture/follow-up.js');
const { ruleDetectors } = await dist('surface/capture/detector.js');
const data = name => read(path.join(experiments, 'data', name + '.json'));
freeze(path.join(corpus,'end-check-prod-replay.json'),fs.readFileSync(path.join(experiments,'data/end-check-prod-replay.json')));
const lines = f => fs.readFileSync(f, 'utf8').trimEnd().split('\n').map(JSON.parse);
const byId = rows => new Map(rows.map(x => [x.i, x]));
const prompts = new Map(data('model-capture-prompts').map(x => [JSON.stringify(x.turns), x]));
const pickAnswers = byId(data('model-capture-answers'));
const detectorPrompts = byId(data('detector-prod-prompts'));
const detectorAnswers = byId(data('detector-prod-answers'));
const index = transcripts();
const { filtered } = loadRound3();
const labels = new Map(data('failures').filter(x => x.arm === 'A2').map(x => [x.sessionId, x]));
const tools = read('C:/eval-authors/r3-repos.json');
const sessions = new Map();
const runCache = new Map();
const exclusions = [];
const units = [];

function storedReply(item, answer) {
  return {send: async req => {
    assert.equal(req.prompt, item.prompt, 'saved prompt differs from slice build');
    return {ok: true, text: answer.reply};
  }};
}
const warn = msg => { throw new Error(msg); };
async function previousRules(r) {
  if (sessions.has(r.sessionId)) return sessions.get(r.sessionId);
  const src = index.get(r.sessionId);
  assert.ok(src, 'prior transcript missing: ' + r.sessionId);
  const transcript = fs.readFileSync(src.file);
  const turns = collectSessionTurns(transcript.toString(), undefined, {scriptedIsHuman: true})
    .filter(t => t.role === 'user').slice(1).map(t => t.text);
  const item = prompts.get(JSON.stringify(turns));
  assert.ok(!turns.length || item, 'no frozen reply for ' + r.sessionId);
  const rules = [];
  if (item) {
    const answer = pickAnswers.get(item.i);
    const picked = await followUpRules(turns, storedReply(item, answer), warn);
    const contents = picked.rules.map(x => x.content);
    const detector = detectorPrompts.get(item.i);
    const reply = detectorAnswers.get(item.i);
    const found = await ruleDetectors(contents, storedReply(detector, reply), warn);
    for (const [i, content] of contents.entries()) rules.push({content, detector: found.detectors[i]});
    json(path.join(corpus,'replies', item.i + '.json'), {item, answer, detector, reply});
  }
  freeze(path.join(corpus,'prior',r.sessionId + '.jsonl'), transcript);
  const row = {sessionId:r.sessionId, sha256:digest(transcript), position:r.position,
    created:r.startedAt, kind:r.kind, promptId:item?.i ?? null, rules};
  sessions.set(r.sessionId, row);
  return row;
}

function runData(runDir) {
  if (!runCache.has(runDir)) {
    const ledger = lines(path.join(runDir,'ledger.jsonl')).filter(x => x.arm === 'A2' && x.when === 'pre-session');
    runCache.set(runDir, {ledger, records:lines(path.join(runDir,'runs.jsonl')).filter(x => x.arm === 'A2')});
  }
  return runCache.get(runDir);
}

function surfaceFiles(runDir, r, snap) {
  const cell = [r.sequence,'A2','seed' + r.seed];
  const gradeDir = path.join(runDir,'grading',...cell);
  const archived = fs.readFileSync(path.join(gradeDir,r.taskId+'.surfaces.txt'));
  const out = [];
  for (const surface of ['instructions','autoMemory','userInstructions','hippoWork','hippoGlobal']) {
    for (const e of snap.surfaces[surface]) {
      if (surface.startsWith('hippo') && !/\/(buffer|episodic|semantic)\/[^/]+\.md$/.test(e.path)) continue;
      assert.ok(!e.link && !e.error && !e.path.split('/').includes('..'), 'unsupported surface');
      const header = Buffer.from('=== '+e.path+'\n');
      const off = archived.indexOf(header);
      let bytes = off < 0 ? Buffer.alloc(0) : archived.subarray(off+header.length,off+header.length+e.size);
      if (digest(bytes) !== e.sha256) {
        const old = path.join(runDir,'runs',...cell,e.path);
        if (fs.existsSync(old)) bytes = fs.readFileSync(old);
      }
      if (digest(bytes) !== e.sha256) throw new Error('unrecoverable '+surface);
      freeze(path.join(corpus,'blobs',e.sha256), bytes);
      out.push({surface,path:e.path,sha256:e.sha256});
    }
  }
  return out;
}

for (const r of firstApplies(filtered, 'A2')) {
  const label = labels.get(r.sessionId);
  assert.equal(label.fail, r.lessons[0].first !== 'pass');
  if (label.cls !== 'omission' && label.fail) continue;
  const {runDir} = index.get(r.sessionId);
  const {ledger,records} = runData(runDir);
  const match = x => x.seed === r.seed && x.sequence === r.sequence;
  const snap = ledger.findLast(x => match(x) && x.taskId === r.taskId && x.position === r.position);
  assert.ok(snap);
  let files;
  try { files = surfaceFiles(runDir,r,snap); }
  catch (e) {
    if (!e.message.startsWith('unrecoverable ')) throw e;
    exclusions.push({id:r.sessionId, cls:label.cls, family:r.familyId, reason:e.message}); continue;
  }
  const history = [];
  for (const prior of records.filter(x => match(x) && x.position < r.position && x.sessionId &&
    (x.kind === 'teach' || x.correctionTurns > 0)).sort((a,b) => a.position-b.position)) {
    history.push(await previousRules(prior));
  }
  const dir = path.dirname(r.repo);
  const spec = read(path.join(dir,'tasks-run.json'));
  const task = spec.sequences.find(s => s.id === r.sequence).tasks.find(t => t.id === r.taskId);
  const lessons = spec.families.find(f => f.id === r.familyId).lessons;
  const lesson = lessons.find(l => l.id === r.lessons[0].lessonId);
  assert.ok(task && lesson && history.some(x => x.kind === 'teach'));
  const checker = path.join(dir,lesson.check.script);
  const checkDir = path.join(corpus,'checks',r.sequence,path.dirname(lesson.check.script));
  const owner=path.dirname(checker);
  for (const f of fs.readdirSync(owner,{recursive:true,withFileTypes:true}).filter(f=>f.isFile())) {
    const source=path.join(f.parentPath,f.name);
    freeze(path.join(checkDir,path.relative(owner,source)),fs.readFileSync(source));
  }
  const checkPath=path.join(checkDir,path.basename(checker));
  const key=JSON.stringify([checkPath,lesson.check.args]);
  if(!checkerHashes.has(key)) checkerHashes.set(key,checkerIdentity({...lesson,checkPath}));
  const grade=read(path.join(runDir,'grading',r.sequence,'A2','seed'+r.seed,r.taskId+'.grade.json'));
  assert.equal(checkerHashes.get(key),grade.checkers[lesson.id],'historical checker or its dependencies differ');
  units.push({id:r.sessionId,sequence:r.sequence,family:r.familyId,seed:r.seed,position:r.position,
    kind:label.cls,historicalPass:!label.fail,repo:r.repo,task,lesson:{...lesson,
      checkPath:path.join(checkDir,path.basename(checker))},toolchain:tools[r.sequence].toolchain,
    history,files});
}
const plan = {study, units, exclusions};
json(path.join(corpus,'plan.json'),plan);
const om = units.filter(u => u.kind === 'omission');
console.log(JSON.stringify({eligible:units.length,omissions:om.length,seed1:om.filter(u=>u.seed===1).length,
  historicalOmissionFails:om.filter(u=>!u.historicalPass).length,controls:units.length-om.length,
  prior:sessions.size,exclusions:exclusions.length,planSha:digest(fs.readFileSync(path.join(corpus,'plan.json')))}));

