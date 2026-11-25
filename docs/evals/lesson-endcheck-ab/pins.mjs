import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {corpus,digest,repo,scored,slice} from './paths.mjs';

function tree(root,keep) {
  const files=fs.readdirSync(root,{recursive:true,withFileTypes:true}).filter(f=>f.isFile()&&keep(f.name))
    .map(f=>path.relative(root,path.join(f.parentPath,f.name)).replaceAll('\\','/')).sort();
  return digest(files.map(f=>f+' '+digest(fs.readFileSync(path.join(root,f)))).join('\n'));
}
export function pins() {
  return {
    sliceJs:tree(path.join(slice,'dist'),f=>f.endsWith('.js')),
    sliceCli:digest(fs.readFileSync(path.join(slice,'bin/hippo.js'))),
    checkerTree:tree(path.join(corpus,'checks'),()=>true),
    runner:tree(path.join(repo,'scripts/token-eval'),f=>f.endsWith('.mjs')),
    tools:digest(fs.readFileSync('C:/eval-authors/s3x-env.ps1')),
    round3:digest(fs.readFileSync(path.join(scored,'pins-r3c.json'))),
  };
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(pins()));

