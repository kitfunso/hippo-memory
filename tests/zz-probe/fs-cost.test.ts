// THROWAWAY timing probe for wave 1020e: each test's duration in the CI log is the cost of 2,000 of one file operation.
import { describe, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeFileAtomic } from '../../src/util/atomic-write.js';

const N = 2000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-fs-'));
const name = (kind: string, i: number): string => path.join(dir, `${kind}-${i}.md`);
const text = 'x'.repeat(300);

describe('probe fs cost x2000', () => {
  it('a writeFileSync of a new file', () => {
    for (let i = 0; i < N; i++) fs.writeFileSync(name('plain', i), text);
  }, 120_000);
  it('a writeFileSync over an existing file', () => {
    for (let i = 0; i < N; i++) fs.writeFileSync(name('plain', i), text);
  }, 120_000);
  it('a writeFileAtomic durable false of a new file', () => {
    for (let i = 0; i < N; i++) writeFileAtomic(name('atomic', i), text, { durable: false });
  }, 120_000);
  it('a writeFileAtomic durable false over an existing file', () => {
    for (let i = 0; i < N; i++) writeFileAtomic(name('atomic', i), text, { durable: false });
  }, 120_000);
  it('an lstat, exists and realpath of an existing file', () => {
    for (let i = 0; i < N; i++) {
      fs.lstatSync(name('plain', i));
      fs.existsSync(name('plain', i));
      fs.realpathSync(name('plain', i));
    }
  }, 120_000);
  it('an open and close of an existing file', () => {
    for (let i = 0; i < N; i++) fs.closeSync(fs.openSync(name('plain', i), 'r'));
  }, 120_000);
  it('a rename to a new name', () => {
    for (let i = 0; i < N; i++) fs.renameSync(name('plain', i), name('moved', i));
  }, 120_000);
  it('an rmSync of a file', () => {
    for (let i = 0; i < N; i++) fs.rmSync(name('moved', i));
  }, 120_000);
  it('a mkdir and rmdir', () => {
    for (let i = 0; i < N; i++) {
      fs.mkdirSync(name('dir', i));
      fs.rmdirSync(name('dir', i));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});
