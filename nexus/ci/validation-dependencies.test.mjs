// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {checkValidationDependencies} from './validation-dependencies.mjs';

async function fixture(run){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-native-dependencies-'));
  try{
    for(const loader of ['lib64/ld-linux-x86-64.so.2','lib/ld-linux.so.2']){
      await fs.mkdir(path.dirname(root+'/'+loader),{recursive:true});
      await fs.writeFile(root+'/'+loader,'synthetic loader',{mode:0o700});
    }
    for(const [triplet,elfClass,machine]of [['x86_64-linux-gnu',2,62],['i386-linux-gnu',1,3]]){
      const directory=root+'/usr/lib/'+triplet;await fs.mkdir(directory,{recursive:true});
      for(const name of ['libgnutls.so.30','libfreetype.so.6','libX11.so.6','libXext.so.6']){
        const header=Buffer.alloc(20);header.write('\x7fELF');header[4]=elfClass;header[5]=1;header.writeUInt16LE(machine,18);
        await fs.writeFile(directory+'/'+name,header);
      }
    }
    await run(root);
  }finally{await fs.rm(root,{recursive:true});}
}
const resolved=()=>({status:0,signal:null,stdout:'libc.so.6 => /synthetic/libc.so.6\n',stderr:''});

test('both Unix ABIs and all transitive dependencies are checked without host search overrides',async()=>fixture(async root=>{
  const calls=[];
  const results=await checkValidationDependencies({root,execute:(loader,args,options)=>{calls.push({loader,args,options});return resolved();}});
  assert.equal(results.length,8);assert.deepEqual(results.map(x=>x.architecture),[...Array(4).fill('x86_64'),...Array(4).fill('i386')]);
  assert.ok(calls.slice(0,4).every(x=>x.loader.endsWith('/lib64/ld-linux-x86-64.so.2')));
  assert.ok(calls.slice(4).every(x=>x.loader.endsWith('/lib/ld-linux.so.2')));
  for(const call of calls){assert.equal(call.args[0],'--list');assert.equal(call.args.length,2);assert.ok(call.args[1].startsWith(root+'/'));assert.equal(call.options.timeout,10000);assert.ok(!Object.keys(call.options.env).some(k=>k.startsWith('LD_')));}
}));
test('amd64 prerequisites cannot hide missing i386 GnuTLS',async()=>fixture(async root=>{
  await fs.unlink(root+'/usr/lib/i386-linux-gnu/libgnutls.so.30');
  await assert.rejects(checkValidationDependencies({root,execute:resolved}),/i386 libgnutls\.so\.30.*missing/);
}));
test('missing i386 FreeType fails early rather than warning during native tests',async()=>fixture(async root=>{
  await fs.unlink(root+'/usr/lib/i386-linux-gnu/libfreetype.so.6');
  await assert.rejects(checkValidationDependencies({root,execute:resolved}),/i386 libfreetype\.so\.6.*missing/);
}));
test('a 64-bit library in the i386 directory is rejected before executing the loader',async()=>fixture(async root=>{
  await fs.copyFile(root+'/usr/lib/x86_64-linux-gnu/libgnutls.so.30',root+'/usr/lib/i386-linux-gnu/libgnutls.so.30');
  let calls=0;await assert.rejects(checkValidationDependencies({root,execute:()=>{calls++;return resolved();}}),/i386 libgnutls\.so\.30.*wrong ELF/);assert.equal(calls,4);
}));
test('missing transitive dependencies, loader errors, signals and timeouts are fatal',async()=>fixture(async root=>{
  for(const result of [
    {status:0,stdout:'libnettle.so.8 => not found'},
    {status:127,stderr:'libgmp.so.10: cannot open shared object file'},
    {status:null,signal:'SIGTERM',stdout:''},
    {status:null,error:Object.assign(new Error('loader timed out'),{code:'ETIMEDOUT'})},
    {status:0,stdout:'',stderr:''},
  ])await assert.rejects(checkValidationDependencies({root,execute:()=>result}),/dynamic dependencies do not resolve/);
}));
test('real library symlinks within the runner root are accepted, escaped targets are not',async()=>fixture(async root=>{
  const library=root+'/usr/lib/i386-linux-gnu/libgnutls.so.30';
  await fs.rename(library,library+'.actual');await fs.symlink('libgnutls.so.30.actual',library);
  assert.equal((await checkValidationDependencies({root,execute:resolved})).length,8);
  await fs.unlink(library);await fs.symlink('/etc/passwd',library);
  await assert.rejects(checkValidationDependencies({root,execute:resolved}),/escapes validation root/);
}));

test('missing i386 X11 driver libraries fail before compiling a runtime',async()=>{
  for(const name of ['libX11.so.6','libXext.so.6'])await fixture(async root=>{
    await fs.unlink(root+'/usr/lib/i386-linux-gnu/'+name);
    await assert.rejects(checkValidationDependencies({root,execute:resolved}),error=>error.message.includes('i386 '+name)&&error.message.includes('missing'));
  });
});
