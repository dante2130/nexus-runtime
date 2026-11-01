// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mediaBuildTargets,mediaRuntimeArchitectures} from './media-build-plan.mjs';
import {targets} from './target.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {verifyAuxiliary} from './auxiliary.mjs';

test('x86 media builds both ELF ABIs and never treats PE architecture as the Unix ABI',()=>{
  const build=mediaBuildTargets('x64');
  assert.deepEqual(build.map(item=>item.triplet),['x86_64-linux-gnu','i386-linux-gnu']);
  assert.deepEqual(mediaRuntimeArchitectures(targets.x86_64),build.map(item=>item.triplet));
  assert.ok(build[1].options.includes('--cc=gcc -m32'));
  assert.equal(build[1].machine,'Intel 80386');
});

test('ARM64 keeps native media for Wine and FEX without inventing an x86 cross toolchain',()=>{
  assert.deepEqual(mediaBuildTargets('arm64').map(item=>item.triplet),['aarch64-linux-gnu']);
  assert.deepEqual(mediaRuntimeArchitectures(targets.arm64),['aarch64-linux-gnu']);
  assert.throws(()=>mediaBuildTargets('ia32'),/Unsupported/);
});

test('actual auxiliary admission requires both ABIs, exact hashes and matching ELF machines',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-media-abis-'));
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const inputs=JSON.parse(await fs.readFile(new URL('./inputs.lock.json',import.meta.url)));
  const lock=JSON.parse(await fs.readFile(new URL('./runtime-media.lock.json',import.meta.url)));
  const write=async(name,bytes)=>{const file=path.join(root,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);return hash(bytes);};
  try{
    const manifest={schema:1,inputsSha256:hash(await fs.readFile(new URL('./inputs.lock.json',import.meta.url))),source:inputs.nghttp2,headers:{},libraries:{},compatibility:{}};
    for(const name of ['nghttp2.h','nghttp2ver.h'])manifest.headers[name]=await write('components/nghttp2/'+name,Buffer.from(name));
    for(const name of ['x86_64','i386'])manifest.libraries[name]=await write('components/'+name+'/libnghttp2.dll',Buffer.from(name));
    for(const name of ['PlayFabGameSave.dll','gaming-services-version.exe','wine-launcher'])manifest.compatibility[name]=await write('components/'+name,Buffer.from(name));
    await write('auxiliary.json',JSON.stringify(manifest));
    const media={version:lock.version,source:lock.url,sourceSha256:lock.sha256,maxGlibc:'2.35',architectures:{}};
    for(const [triplet,elfClass,machine]of [['x86_64-linux-gnu',2,62],['i386-linux-gnu',1,3]]){
      const libraries={};
      for(const [soname,filename]of Object.entries(lock.libraries)){
        const bytes=Buffer.alloc(24);bytes.writeUInt32BE(0x7f454c46);bytes[4]=elfClass;bytes[5]=1;bytes.writeUInt16LE(machine,18);
        libraries[soname]={filename,sha256:await write('media/stage/usr/lib/'+triplet+'/'+filename,bytes)};
      }
      media.architectures[triplet]={libraries};
    }
    const save=()=>write('media/media-manifest.json',JSON.stringify(media));
    await save();await verifyAuxiliary(root,inputs);
    const x86=media.architectures['i386-linux-gnu'];delete media.architectures['i386-linux-gnu'];await save();
    await assert.rejects(verifyAuxiliary(root,inputs),/Incomplete media architectures/);
    media.architectures['i386-linux-gnu']=x86;
    const item=Object.values(x86.libraries)[0],wrong=Buffer.alloc(24);wrong.writeUInt32BE(0x7f454c46);wrong[4]=2;wrong[5]=1;wrong.writeUInt16LE(62,18);
    item.sha256=await write('media/stage/usr/lib/i386-linux-gnu/'+item.filename,wrong);await save();
    await assert.rejects(verifyAuxiliary(root,inputs),/Wrong media ELF architecture/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
