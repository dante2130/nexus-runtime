// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {repository} from '../inputs.mjs';
import {fixtureControls,requiredXgrFixtures,verifyXgrFixtures,assertXgrResult,readXgrResult} from './xgr-fixture-coverage.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
function pe(machine,magic){const b=Buffer.alloc(512);b.write('MZ');b.writeUInt32LE(128,60);b.write('PE\0\0',128,'binary');b.writeUInt16LE(machine,132);b.writeUInt16LE(magic,152);return b;}
async function fixture(fn){const root=await fs.mkdtemp(path.join(repository,'.xgr-fixtures-'));try{const hashes={};for(const {relative,machine,magic}of requiredXgrFixtures){const file=path.join(root,relative),bytes=pe(machine,magic);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);hashes[relative]=sha(bytes);}await fn(root,hashes);}finally{await fs.rm(root,{recursive:true,force:true});}}
const valid=gate=>({passed:true,results:fixtureControls.filter(c=>c.gate===gate).map(c=>({name:c.name,checks:c.minimum,failures:0}))});
test('every mandatory fixture requires its exact inventory hash and explicit ABI',()=>fixture(async(root,hashes)=>{
 assert.equal(requiredXgrFixtures.length,10);await verifyXgrFixtures(root,hashes);
 for(const {relative}of requiredXgrFixtures){const missing={...hashes};delete missing[relative];await assert.rejects(verifyXgrFixtures(root,missing),/fixture/);await assert.rejects(verifyXgrFixtures(root,{...hashes,[relative]:'a'.repeat(64)}),/fixture/);}
}));
test('matching hashes cannot hide wrong Machine or optional magic for any fixture',()=>fixture(async(root,hashes)=>{
 for(const {relative,machine,magic}of requiredXgrFixtures){const file=path.join(root,relative);for(const bytes of [pe(machine===0x8664?0x14c:0x8664,magic),pe(machine,magic===0x20b?0x10b:0x20b),Buffer.alloc(512)]){await fs.writeFile(file,bytes);await assert.rejects(verifyXgrFixtures(root,{...hashes,[relative]:sha(bytes)}),/fixture/);}await fs.writeFile(file,pe(machine,magic));}
}));
test('missing files, symlinked files and intermediate aliases fail closed',()=>fixture(async(root,hashes)=>{
 const file=path.join(root,requiredXgrFixtures[2].relative),copy=file+'.original';await fs.rename(file,copy);await assert.rejects(verifyXgrFixtures(root,hashes));await fs.symlink(copy,file);await assert.rejects(verifyXgrFixtures(root,hashes),/fixture/);await fs.unlink(file);await fs.rename(copy,file);
 const bin=path.dirname(file);await fs.rename(bin,bin+'.original');await fs.symlink(bin+'.original',bin);await assert.rejects(verifyXgrFixtures(root,hashes),/fixture/);
}));
test('Store and component require their own complete unique numeric result rows',()=>{
 for(const gate of ['store','component']){assertXgrResult(valid(gate),gate);const base=valid(gate);for(const row of base.results){for(const checks of [undefined,null,NaN,Infinity,String(row.checks),row.checks-1,row.checks+.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>assertXgrResult({...base,results:base.results.map(x=>x===row?{...x,checks}:x)},gate));assert.throws(()=>assertXgrResult({...base,results:base.results.filter(x=>x!==row)},gate));assert.throws(()=>assertXgrResult({...base,results:[...base.results,row]},gate));}}
 assert.throws(()=>assertXgrResult(valid('store'),'component'));assert.throws(()=>assertXgrResult(valid('component'),'store'));assert.throws(()=>assertXgrResult(valid('store'),'authentication'));
});
test('failed, skipped, todo, flaky and error metadata cannot claim coverage',()=>{
 for(const gate of ['store','component']){const base=valid(gate);for(const changed of [{failures:1},{failures:'0'},{failures:NaN},{passed:false},{passed:'true'},{status:1},{signal:'SIGTERM'},{failure:{}},{error:null},{todo:1},{flaky:1},{skipped:true},{skipped:'0'}])assert.throws(()=>assertXgrResult({...base,...changed},gate));for(const row of base.results)for(const changed of [{failures:1},{failures:'0'},{passed:false},{status:1},{signal:'SIGTERM'},{failure:{}},{error:'x'},{todo:1},{flaky:1},{skipped:true}])assert.throws(()=>assertXgrResult({...base,results:base.results.map(x=>x===row?{...x,...changed}:x)},gate));}
});
test('result lookup binds each gate to its exact unique output group',()=>fixture(async(root)=>{
 for(const gate of ['store','component']){await assert.rejects(readXgrResult(root,gate),/group/);const prefix=gate==='store'?'nexus-store-test-':'nexus-component-test-';const dir=path.join(root,prefix+'one');await fs.mkdir(dir);await fs.writeFile(path.join(dir,'results.json'),JSON.stringify(valid(gate)));await readXgrResult(root,gate);await fs.mkdir(path.join(root,prefix+'two'));await assert.rejects(readXgrResult(root,gate),/group/);}
}));
test('generation and both validators enforce fixture and result coverage without new top-level groups',async()=>{
 const read=n=>fs.readFile(path.join(repository,n),'utf8'),build=await read('nexus/ci/build-fixtures.mjs');assert.ok(build.includes('await verifyXgrFixtures(root,hashes)'));
 for(const name of ['validate-runtime.mjs','validate-runtime-arm64.mjs']){const text=await read('nexus/ci/'+name);assert.ok(text.includes('await verifyXgrFixtures(fixtures,fixtureProof.hashes)'));assert.ok(text.includes('await readXgrResult(directory,gate)'));}
 const checkpoint=await read('nexus/ci/runtime-checkpoint.test.py');for(const name of ['nexus_receipt-ipc.exe','nexus_taskqueue-unwind-wait.exe','nexus_store-context-cancellation.exe'])assert.ok(checkpoint.includes(name));
});
