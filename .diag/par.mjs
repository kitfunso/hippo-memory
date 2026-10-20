// Throwaway: runs N copies of bench-io.mjs at once on one folder, to see what contention adds.
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const [dir, copies = '4', n = '40'] = process.argv.slice(2);
const bench = join(import.meta.dirname, 'bench-io.mjs');
const runs = Array.from({ length: Number(copies) }, (_, i) =>
  new Promise((done) => {
    let out = '';
    const c = spawn(process.execPath, ['--no-warnings', bench, dir, n, `par${i} `], { env: { ...process.env, BENCH_HIPPO: '0' } });
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (out += d));
    c.on('close', () => done(out));
  }),
);
console.log((await Promise.all(runs)).join('\n'));
