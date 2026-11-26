const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const original = cp.spawnSync;
const probeEnv = {SystemRoot:process.env.SystemRoot, PATH:process.env.PATH};
const mode = process.env.LESSON_STDIO ??
  (process.platform === 'win32' && original('git',['--version'],{env:probeEnv,windowsHide:true}).error?.code === 'EPERM' ? 'file' : 'pipe');
if (!['file','pipe'].includes(mode)) throw Error('LESSON_STDIO must be file or pipe, not '+mode);
module.exports = mode;
if (mode === 'file') {
  const scratch = require('node:os').tmpdir();
  cp.spawnSync = function spawn(file,args,options={}) {
    const io = options.stdio ?? 'pipe';
    const streams = Array.isArray(io) ? io : Array(3).fill(io);
    if (!streams.includes('pipe')) return original(file,args,options);
    const dir=fs.mkdtempSync(path.join(scratch,'proc-'));
    const names=streams.map((s,i)=>path.join(dir,'fd'+i));
    const fds=[];
    try {
      fs.writeFileSync(names[0],options.input ?? '');
      const stdio=streams.map((s,i)=>{
        if (s!=='pipe') return s;
        const fd=fs.openSync(names[i],i===0?'r':'w');
        fds.push(fd);
        return fd;
      });
      const result=original(file,args,{...options,input:undefined,stdio});
      for(const fd of fds.splice(0)) fs.closeSync(fd);
      const enc=options.encoding==='buffer' ? undefined : options.encoding;
      const output=streams.map((s,i)=>i>0 && s==='pipe' ? fs.readFileSync(names[i],enc) : null);
      return {...result,stdout:output[1],stderr:output[2],output};
    } finally {
      for(const fd of fds) fs.closeSync(fd);
      for(const f of names) if (fs.existsSync(f)) fs.unlinkSync(f);
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
