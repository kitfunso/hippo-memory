// Restricted Windows jobs can reject libuv's named pipes even for git --version.
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const original = cp.spawnSync;
if (process.platform === 'win32' && original('git',['--version']).error?.code === 'EPERM') {
  const scratch = require('node:os').tmpdir();
  cp.spawnSync = function spawn(file,args,options={}) {
    if (options.stdio==='inherit' || options.stdio==='ignore') return original(file,args,options);
    const dir=fs.mkdtempSync(path.join(scratch,'proc-'));
    const names=['in','out','err'].map(n=>path.join(dir,n));
    fs.writeFileSync(names[0],options.input ?? '');
    const fds=names.map((name,i)=>fs.openSync(name,i===0?'r':'w'));
    let result;
    try {
      result=original(file,args,{...options,input:undefined,stdio:fds});
      const enc=options.encoding==='buffer' ? undefined : options.encoding;
      const stdout=fs.readFileSync(names[1],enc),stderr=fs.readFileSync(names[2],enc);
      return {...result,stdout,stderr,output:[null,stdout,stderr]};
    } finally {
      for(const fd of fds) fs.closeSync(fd);
      for(const f of names) fs.unlinkSync(f);
      fs.rmdirSync(dir);
    }
  };
  cp.execFileSync = function execute(file,args,options={}) {
    const result=cp.spawnSync(file,args,options);
    if (result.error) throw result.error;
    if (result.status!==0) throw Object.assign(Error(file+' exited '+result.status+': '+String(result.stderr).slice(-500)),result);
    return result.stdout;
  };
  require('node:module').syncBuiltinESMExports();
}
