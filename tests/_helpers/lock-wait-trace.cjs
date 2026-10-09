// Preloaded into a spawned CLI: writes the lock waits the process asked for to LOCK_WAIT_TRACE_DIR/<pid>.json, a figure a slow runner cannot inflate.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, StatementSync } = require('node:sqlite');

const SQLITE_BUSY_CODES = new Set([5, 6, 517]);
const timeoutOf = new WeakMap();
const ownerOf = new WeakMap();
const trace = { busy: [], sleeps: [] };

function noteBusy(db, sql, error) {
  if (SQLITE_BUSY_CODES.has(error?.errcode)) trace.busy.push({ sql, waitMs: timeoutOf.get(db) ?? 0 });
}

const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function tracedExec(sql) {
  const set = /^PRAGMA busy_timeout = (\d+)$/.exec(sql);
  if (set) timeoutOf.set(this, Number(set[1]));
  try {
    return exec.call(this, sql);
  } catch (error) {
    noteBusy(this, sql, error);
    throw error;
  }
};

const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function tracedPrepare(sql) {
  const statement = prepare.call(this, sql);
  ownerOf.set(statement, { db: this, sql });
  return statement;
};

for (const method of ['run', 'get', 'all', 'iterate']) {
  const original = StatementSync.prototype[method];
  StatementSync.prototype[method] = function tracedStatement(...params) {
    try {
      return original.apply(this, params);
    } catch (error) {
      const owner = ownerOf.get(this);
      if (owner) noteBusy(owner.db, owner.sql, error);
      throw error;
    }
  };
}

// The busy-retry loops wait here between tries, on a handle whose own timeout may be 0.
const wait = Atomics.wait;
Atomics.wait = function tracedWait(array, index, value, ms) {
  trace.sleeps.push(ms);
  return wait.call(this, array, index, value, ms);
};

process.on('exit', () => {
  const dir = process.env.LOCK_WAIT_TRACE_DIR;
  // A worker that outlives its test finds the scratch folder gone.
  if (dir && fs.existsSync(dir)) fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify(trace));
});
