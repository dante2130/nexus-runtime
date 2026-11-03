// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {repository} from '../inputs.mjs';
import {storeCancellationFixtures,verifyStoreCancellationFixtures,assertStoreCancellationResult,readStoreCancellationResult} from './store-cancellation-coverage.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
function pe(bits){const b=Buffer.alloc(512);b.write('MZ');b.writeUInt32LE(128,60);b.write('PE\0\0',128,'binary');b.writeUInt16LE(bits===64?0x8664:0x14c,132);b.writeUInt16LE(bits===64?0x20b:0x10b,152);return b;}
async function fixture(fn){const root=await fs.mkdtemp(path.join(repository,'.store-cancellation-'));try{const hashes={};for(const [i,relative]of storeCancellationFixtures.entries()){const file=path.join(root,relative),bytes=pe(i===0?64:32);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);hashes[relative]=sha(bytes);}await fn(root,hashes);}finally{await fs.rm(root,{recursive:true,force:true});}}
test('both Store cancellation executables require their exact inventory hashes',()=>fixture(async(root,hashes)=>{
 await verifyStoreCancellationFixtures(root,hashes);
 for(const relative of storeCancellationFixtures){const missing={...hashes};delete missing[relative];await assert.rejects(verifyStoreCancellationFixtures(root,missing),/fixture/);await assert.rejects(verifyStoreCancellationFixtures(root,{...hashes,[relative]:'a'.repeat(64)}),/fixture/);}
 await fs.unlink(path.join(root,storeCancellationFixtures[0]));await assert.rejects(verifyStoreCancellationFixtures(root,hashes));
}));
test('matching hashes cannot hide wrong PE machine, magic or malformed header',()=>fixture(async(root,hashes)=>{
 for(const [index,relative]of storeCancellationFixtures.entries()){
  const file=path.join(root,relative),valid=pe(index===0?64:32);
  for(const bytes of [pe(index===0?32:64),Buffer.from(valid),Buffer.alloc(512)]){
   if(bytes.equals(valid))bytes.writeUInt16LE(index===0?0x10b:0x20b,152);
   await fs.writeFile(file,bytes);await assert.rejects(verifyStoreCancellationFixtures(root,{...hashes,[relative]:sha(bytes)}),/fixture/);
  }
  await fs.writeFile(file,valid);
 }
}));
test('fixture links, intermediate aliases and directories fail closed',()=>fixture(async(root,hashes)=>{
 const relative=storeCancellationFixtures[0],file=path.join(root,relative),copy=file+'.original';await fs.rename(file,copy);await fs.symlink(copy,file);await assert.rejects(verifyStoreCancellationFixtures(root,hashes),/fixture/);await fs.unlink(file);await fs.rename(copy,file);
 const bin=path.dirname(file);await fs.rename(bin,bin+'.original');await fs.symlink(bin+'.original',bin);await assert.rejects(verifyStoreCancellationFixtures(root,hashes),/fixture/);await fs.unlink(bin);await fs.rename(bin+'.original',bin);
 await fs.unlink(file);await fs.mkdir(file);await assert.rejects(verifyStoreCancellationFixtures(root,hashes),/fixture/);
}));
const valid=()=>({passed:true,results:[{name:'store-context-cancellation',checks:67,failures:0}]});
test('Store cancellation result requires exactly one genuinely successful numeric 67-check row',()=>{
 assertStoreCancellationResult(valid());assertStoreCancellationResult({passed:true,results:[{...valid().results[0],checks:70}]});
 for(const checks of [undefined,null,NaN,Infinity,'67',66,67.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>assertStoreCancellationResult({passed:true,results:[{...valid().results[0],checks}]}));
 for(const result of [{passed:'true',results:valid().results},{passed:false,results:valid().results},{passed:true},{passed:true,results:{}},{passed:true,results:[]},{passed:true,results:[...valid().results,...valid().results]},{passed:true,results:[{...valid().results[0],failures:1}]}])assert.throws(()=>assertStoreCancellationResult(result));
 for(const field of ['skipped','todo','flaky'])for(const value of [1,true,'0',NaN]){assert.throws(()=>assertStoreCancellationResult({...valid(),[field]:value}));assert.throws(()=>assertStoreCancellationResult({passed:true,results:[{...valid().results[0],[field]:value}]}));}
 for(const changed of [{status:1},{signal:'SIGTERM'},{passed:false},{failures:'0'},{error:'failure'},{failure:{}}])assert.throws(()=>assertStoreCancellationResult({passed:true,results:[{...valid().results[0],...changed}]}));
 for(const error of ['failure',null,{}])assert.throws(()=>assertStoreCancellationResult({...valid(),error}));
});
test('native result lookup rejects missing or ambiguous result groups',()=>fixture(async(root)=>{
 await assert.rejects(readStoreCancellationResult(root),/group/);const group=path.join(root,'nexus-store-test-one');await fs.mkdir(group);await fs.writeFile(path.join(group,'results.json'),JSON.stringify(valid()));await readStoreCancellationResult(root);await fs.mkdir(path.join(root,'nexus-store-test-two'));await assert.rejects(readStoreCancellationResult(root),/group/);
}));
test('generation and both native validators enforce the same coverage before acceptance',async()=>{
 const read=n=>fs.readFile(path.join(repository,n),'utf8');const build=await read('nexus/ci/build-fixtures.mjs');assert.ok(build.includes('await verifyStoreCancellationFixtures(root,hashes)'));assert.ok(build.includes("'cmake','--build','/fixtures/'+abi"));
 for(const name of ['validate-runtime.mjs','validate-runtime-arm64.mjs']){const source=await read('nexus/ci/'+name);assert.ok(source.includes('await verifyStoreCancellationFixtures(fixtures,fixtureProof.hashes)'));assert.ok(source.includes('await readStoreCancellationResult(directory)'));}
 const checkpoint=await read('nexus/ci/runtime-checkpoint.test.py');assert.ok(checkpoint.includes('nexus_store-context-cancellation.exe'));assert.ok(checkpoint.includes("('unchanged Store cancellation fixture ' + abi).encode()"));
});
