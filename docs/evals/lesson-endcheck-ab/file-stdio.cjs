// The Windows workspace can deny libuv's named pipes while permitting inherited file handles.
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {syncBuiltinESMExports} = require('node:module');
const spawn = cp.spawnSync;
const base = 'C:/z0-lessons/lesson-endcheck-ab/io';
if (process.platform === 'win32' && spawn('git',['--version']).error?.code === 'EPERM') {
  fs.mkdirSync(base,{recursive:true});
  cp.spawnSync = function(file,args,options={}) {
    const io = options.stdio ?? 'pipe';
    const streams = Array.isArray(io) ? io : Array(3).fill(io);
    if (!streams.includes('pipe')) return spawn(file,args,options);
    const dir=fs.mkdtempSync(path.join(base,'p-'));
    const names=['in','out','err'].map(n=>path.join(dir,n));
    const fds=[];
    try {
      fs.writeFileSync(names[0],options.input ?? '');
      const stdio=streams.map((s,i)=>{
        if(s!=='pipe') return s;
        const fd=fs.openSync(names[i],i===0?'r':'w');
        fds.push(fd);
        return fd;
      });
      const result=spawn(file,args,{...options,input:undefined,stdio});
      for(const fd of fds.splice(0)) fs.closeSync(fd);
      result.output=[null,...[1,2].map(i=>streams[i]==='pipe'?fs.readFileSync(names[i],options.encoding || null):null)];
      [ ,result.stdout,result.stderr]=result.output;
      return result;
    } finally {
      for(const fd of fds) fs.closeSync(fd);
      for(const n of names) if(fs.existsSync(n)) fs.unlinkSync(n);
      fs.rmdirSync(dir);
    }
  };
  cp.execFileSync = function(file,args,options={}) {
    const r=cp.spawnSync(file,args,options);
    if(r.error) throw r.error;
    if(r.status!==0) throw Object.assign(new Error(file+' exited '+r.status+': '+String(r.stderr??'').slice(-550)),r);
    return r.stdout;
  };
  syncBuiltinESMExports();
}

