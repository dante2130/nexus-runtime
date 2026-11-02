// SPDX-License-Identifier: MIT
// Ubuntu validation runs outside the SDK and needs both native Unix ABIs.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const architectures=[
  {name:'x86_64',elfClass:2,machine:62,loader:'/lib64/ld-linux-x86-64.so.2',triplet:'x86_64-linux-gnu'},
  {name:'i386',elfClass:1,machine:3,loader:'/lib/ld-linux.so.2',triplet:'i386-linux-gnu'},
];
// Native i386 Wine GUI probes need the X11 driver dependencies too.
const libraries=['libgnutls.so.30','libfreetype.so.6','libX11.so.6','libXext.so.6'];

export async function checkValidationDependencies({root='/',execute=spawnSync}={}){
  root=await fs.realpath(root);
  const host=relative=>path.join(root,relative);
  async function contained(file){
    const resolved=await fs.realpath(file);
    if(root!=='/'&&!resolved.startsWith(root+path.sep))throw Error('Prerequisite escapes validation root');
    return resolved;
  }
  const env={...process.env};
  for(const key of Object.keys(env))if(/^LD_/.test(key))delete env[key];
  const results=[];
  for(const arch of architectures){
    const loader=await contained(host(arch.loader));
    await fs.access(loader,fs.constants.X_OK);
    for(const library of libraries){
      try{
        let file;
        for(const directory of ['/usr/lib/','/lib/']){
          try{file=await contained(host(directory+arch.triplet+'/'+library));break;}
          catch(error){if(error.code!=='ENOENT')throw error;}
        }
        if(!file)throw Error('matching library is missing');
        const handle=await fs.open(file,'r'),header=Buffer.alloc(20);
        try{
          const stat=await handle.stat();
          if(!stat.isFile()||(await handle.read(header,0,header.length,0)).bytesRead!==header.length)
            throw Error('library is not a regular ELF file');
        }finally{await handle.close();}
        if(header.subarray(0,4).toString('hex')!=='7f454c46'||header[4]!==arch.elfClass||header[5]!==1||header.readUInt16LE(18)!==arch.machine)
          throw Error('wrong ELF architecture');
        const r=execute(loader,['--list',file],{env,encoding:'utf8',timeout:10000,maxBuffer:512*1024});
        const output=(r.stdout||'')+(r.stderr||'');
        if(r.status!==0||r.signal||r.error||!output.trim()||/not found/i.test(output))
          throw Error('dynamic dependencies do not resolve: '+(r.error?.message||output.trim()||r.signal||r.status));
        results.push({architecture:arch.name,library,file});
      }catch(error){throw Error(arch.name+' '+library+' prerequisite failed: '+error.message,{cause:error});}
    }
  }
  return results;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==2)throw Error('Usage: validation-dependencies.mjs');
  for(const r of await checkValidationDependencies())console.log(r.architecture+' '+r.library+' dependencies PASS');
}
