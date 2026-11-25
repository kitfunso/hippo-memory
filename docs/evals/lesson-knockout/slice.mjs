import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const revision='70eb87c0fdabdcc96754c80ccb4f975df87213ca';
export const build='f02c2334a659c0fb245be0f7dbb809fb10ef79160f80ea4868bf093976fa0d4f';
assert(process.env.KNOCKOUT_SLICE_ROOT,'Set KNOCKOUT_SLICE_ROOT to the pinned Slice 1 checkout');
export const slice=fs.realpathSync(process.env.KNOCKOUT_SLICE_ROOT);
assert.equal(execFileSync('git',['-C',slice,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),revision);
const digest=createHash('sha256');
const paths=['bin/hippo.js','package.json','package-lock.json'];
function visit(dir) {
  for(const item of fs.readdirSync(path.join(slice,dir),{withFileTypes:true})) {
    const name=dir+'/'+item.name;
    assert(!item.isSymbolicLink(),'Linked build artifact '+name);
    if(item.isDirectory()) visit(name);
    else { assert(item.isFile()); paths.push(name); }
  }
}
visit('dist');
for(const name of paths.sort()) {
  const bytes=fs.readFileSync(path.join(slice,name));
  digest.update(name+'\0'+createHash('sha256').update(bytes).digest('hex')+'\n');
}
const actual=digest.digest('hex');
assert.equal(actual,build,'Slice build bytes changed');
export const mod=name=>import(pathToFileURL(path.join(slice,'dist',name+'.js')));
