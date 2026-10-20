// Throwaway preload (--require): counts and times SQLite and fs calls per vitest file, written at exit to DIAG_OUT.
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const sqlite = require('node:sqlite');

const outDir = process.env.DIAG_OUT;
const stats = new Map();
let depth = 0;
const now = () => performance.now();
const fileOf = () => globalThis.__vitest_worker__?.filepath ?? `pid:${process.pid}:${path.basename(process.argv[1] ?? '')}`;

function charge(op, t0) {
  const key = fileOf();
  let s = stats.get(key);
  if (!s) stats.set(key, (s = {}));
  const o = (s[op] ??= { n: 0, ms: 0 });
  o.n++;
  o.ms += now() - t0;
}

function wrap(obj, name, op = name) {
  const orig = obj[name];
  if (typeof orig !== 'function') return;
  obj[name] = Object.assign(function (...args) {
    if (depth > 0) return orig.apply(this, args);
    depth++;
    const t0 = now();
    try {
      return orig.apply(this, args);
    } finally {
      depth--;
      charge(op, t0);
    }
  }, orig);
}

for (const n of [
  'openSync', 'closeSync', 'writeFileSync', 'appendFileSync', 'copyFileSync', 'cpSync', 'rmSync', 'mkdtempSync',
  'mkdirSync', 'unlinkSync', 'renameSync', 'readFileSync', 'existsSync', 'statSync', 'lstatSync', 'readdirSync',
  'fsyncSync', 'realpathSync', 'rmdirSync', 'accessSync',
]) wrap(fs, n, `fs.${n}`);
syncBuiltinESMExports();

const Base = sqlite.DatabaseSync;
class Counted extends Base {
  constructor(...args) {
    const t0 = now();
    super(...args);
    charge(args[1]?.readOnly ? 'db.openRO' : 'db.open', t0);
    if (process.env.DIAG_STACKS) {
      Error.stackTraceLimit = 60;
      const frames = (new Error().stack ?? '')
        .split('\n')
        .filter((l) => /[\\/](src|tests)[\\/]/.test(l) && !/count\.cjs|src[\\/]db[\\/]|handles\.ts|bound\.ts/.test(l))
        .slice(0, Number(process.env.DIAG_STACKS))
        .map((l) => l.replace(/^.*?[\\/]((?:src|tests)[\\/][^:)]+:\d+).*$/, '$1').replace(/\\/g, '/'));
      charge(`open@${frames.join(' < ')}`, now());
    }
  }
  close() {
    const t0 = now();
    try {
      return super.close();
    } finally {
      charge('db.close', t0);
      if (now() - t0 > 0.4) charge('db.close.slow', t0);
    }
  }
  exec(sql) {
    const t0 = now();
    try {
      return super.exec(sql);
    } finally {
      const op = /^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(sql) ? `db.exec.${sql.trim().split(/\s/)[0].toUpperCase()}` : 'db.exec';
      charge(op, t0);
      if (op === 'db.exec.COMMIT' && now() - t0 > 0.4) charge('db.exec.COMMIT.slow', t0);
    }
  }
}
sqlite.DatabaseSync = Counted;
const St = sqlite.StatementSync?.prototype;
if (St) for (const n of ['run', 'get', 'all']) wrap(St, n, `stmt.${n}`);

function flush() {
  if (!outDir || stats.size === 0) return;
  depth++;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const lines = [...stats].map(([file, s]) => JSON.stringify({ pid: process.pid, file, s }));
    fs.writeFileSync(path.join(outDir, `${process.pid}.jsonl`), lines.join('\n') + '\n');
  } finally {
    depth--;
  }
}
setInterval(flush, 2000).unref();
process.on('exit', flush);
