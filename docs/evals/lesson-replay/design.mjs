import { createHash } from 'node:crypto';

export const root = 'C:/z0-lessons/lesson-replay';
export const e1 = 'C:/Users/skf_s/Documents/hippo-mechanisms-2026-11-24/experiment1';
export const hash = data => createHash('sha256').update(data).digest('hex');
export const seed = 'lesson-replay-2026-11-25';
export const order = (rows, salt) => rows.sort((a,b) => hash(seed+salt+a.id).localeCompare(hash(seed+salt+b.id)));
export const reps = 12;
export const smokeN = 20;
export const threshold = {agreement: .80, perClass: .70, rateGap: .10, equivalent: .10};
// The alternate wording preserves the command that the source checker grades.
export const families = {
  'gr3-f1': ['pytest|py.test|make', 'not _int', 'Exclude integration cases when testing. Use pytest tests/ -k "not _int".'],
  'q118-f1': ['pytest|py.test', 'not (gpy or pybnn or sklearn or notebooks)', "Filter every pytest run with -m 'not (gpy or pybnn or sklearn or notebooks)'."],
  'q12-f1': ['dotnet', 'net8.0', 'Select .NET 8 when running CoreTests: dotnet test tests/CoreTests/ --framework net8.0.'],
  'q133-f2': ['gradle', ':svg-to-compose:jvmTest', 'For tests, invoke ./gradlew --no-daemon :svg-to-compose:jvmTest.'],
  'q14-f3': ['go', '-race', 'Enable the race detector whenever running go test. Use go test -race.'],
  'q140-f1': ['mvn', 'clean package', 'Build the changed module and its dependencies using ./mvnw clean package -am -pl <module>.'],
  'q212-f2': ['npm|vitest|npx', 'npm test --', 'Select the test file through the npm script: npm test -- <file>.'],
  'q226-f3': ['jest|npm', 'tests/unit/jest.config.mjs', 'Select the unit configuration: npx jest --config=tests/unit/jest.config.mjs.'],
  'q253-f3': ['dotnet', 'TurboXml.Tests/TurboXml.Tests.csproj -c Release', 'Run TurboXml tests in Release: dotnet test src/TurboXml.Tests/TurboXml.Tests.csproj -c Release.'],
  'q256-f1': ['pytest|py.test', 'uv run pytest', 'Start pytest through uv using uv run pytest.'],
};
export const arms = ['cut','start','near','d2','d50','d300','paraphrase','checklist','need-sonnet'];
export function jobs(rows, phase) {
  const expand = (r, arm, n) => Array.from({length:n}, (_,i) => ({
    id: [phase,r.sid,arm,i].join('.'), sid:r.sid, arm, replicate:i,
  }));
  if (phase === 'smoke') {
    const candidates = rows.filter(r => r.family==='gr3-f1');
    const byClass = [false,true].map(label => order(candidates.filter(r=>r.pass===label).map(r=>({...r,id:r.sid})), 'sample'));
    if (byClass.some(group=>!group.length)) throw Error('Smoke requires both historical classes');
    return order(Array.from({length:smokeN}, (_,i) => {
      const group=byClass[i%2], row=group[Math.floor(i/2)%group.length];
      return expand(row,'unchanged',1).map(j=>({...j,id:j.id+'.'+i,replicate:i}))[0];
    }),phase);
  }
  if (phase === 'gate') return order(rows.flatMap(r=>expand(r,'unchanged',2)),phase);
  if (phase !== 'treatment') throw Error('Unknown phase');
  return order(rows.filter(r=>r.clean).flatMap(r =>
    ['reference',...arms].flatMap(a=>expand(r,a,reps))), phase);
}
