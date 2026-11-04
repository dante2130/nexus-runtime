// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseWinHttpCancellation,assertHttpCancellationCoverage,verifyHttpCancellationFixtures} from './http-cancellation-coverage.mjs';
const wine=()=>({passed:true,results:[64,32].flatMap(bits=>[['winhttp-cancellation',59],['http-native-cancellation',46]].map(([name,floor])=>({name:name+'-'+bits,passed:true,status:0,checks:[floor]})))});
test('requires both exact private/native HTTP controls for both architectures',()=>{
 assert.doesNotThrow(()=>assertHttpCancellationCoverage(wine()));
 for(const mutate of [w=>w.passed=false,w=>w.results.pop(),w=>w.results.push(w.results[0]),w=>w.results[0].passed=false,w=>w.results[0].status=1,w=>w.results[0].checks=[58],w=>w.results[1].checks=[45],w=>w.results[0].checks=[],w=>w.results[0].checks=[undefined],w=>w.results[0].checks=[NaN],w=>w.results[0].checks=['59'],w=>w.results[0].checks=[Infinity]]){const w=wine();mutate(w);assert.throws(()=>assertHttpCancellationCoverage(w));}
});
test('parses ordinary Wine summary with no skip, failure or missing controls',()=>{
 assert.equal(parseWinHttpCancellation('0180:cancellation: 59 tests executed (0 marked as todo, 0 as flaky, 0 failures), 0 skipped.\r\n'),59);
 const actual='0180:cancellation: 59 tests executed (0 marked as todo, 0 as flaky, 0 failures), 0 skipped.';
 for(const output of ['',actual+'\n'+actual,actual.replace('59 tests','58 tests'),actual.replace('0 marked','1 marked'),actual.replace('0 as flaky','1 as flaky'),actual.replace('0 failures','1 failure'),actual.replace('0 skipped','1 skipped')])assert.throws(()=>parseWinHttpCancellation(output));
});
test('binds all four fixture bytes and PE architectures, rejects symlink aliases',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'http-cancellation-fixture-')),hashes={};
 try{
  for(const bits of [64,32])for(const relative of ['native/winhttp-cancellation-'+bits+'-probe.exe','win'+bits+'/bin/nexus_http-native-cancellation.exe']){
   const file=path.join(root,relative);await fs.mkdir(path.dirname(file),{recursive:true});const data=Buffer.alloc(512);data.write('MZ');data.writeUInt32LE(128,60);data.write('PE\0\0',128);data.writeUInt16LE(bits===64?0x8664:0x14c,132);data.writeUInt16LE(bits===64?0x20b:0x10b,152);await fs.writeFile(file,data);hashes[relative]=createHash('sha256').update(data).digest('hex');
  }
  await verifyHttpCancellationFixtures(root,hashes);
  const first='native/winhttp-cancellation-64-probe.exe',original=await fs.readFile(path.join(root,first));
  await assert.rejects(verifyHttpCancellationFixtures(root,{...hashes,[first]:undefined}));
  await fs.writeFile(path.join(root,first),'changed');await assert.rejects(verifyHttpCancellationFixtures(root,hashes));await fs.writeFile(path.join(root,first),original);
  const wrong=Buffer.from(original);wrong.writeUInt16LE(0x14c,132);await fs.writeFile(path.join(root,first),wrong);await assert.rejects(verifyHttpCancellationFixtures(root,{...hashes,[first]:createHash('sha256').update(wrong).digest('hex')}),/architecture/);
  const wrongMagic=Buffer.from(original);wrongMagic.writeUInt16LE(0x10b,152);await fs.writeFile(path.join(root,first),wrongMagic);await assert.rejects(verifyHttpCancellationFixtures(root,{...hashes,[first]:createHash('sha256').update(wrongMagic).digest('hex')}),/architecture/);await fs.writeFile(path.join(root,first),original);
  await fs.rename(path.join(root,first),path.join(root,'target.exe'));await fs.symlink('../target.exe',path.join(root,first));await assert.rejects(verifyHttpCancellationFixtures(root,hashes));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('paired validator and builder require native HTTP proof while preserving existing groups',async()=>{
 const base=new URL('./',import.meta.url),validator=await fs.readFile(new URL('validate-runtime.mjs',base),'utf8'),builder=await fs.readFile(new URL('build-fixtures.mjs',base),'utf8'),runner=await fs.readFile(new URL('wine-contracts.mjs',base),'utf8');
 assert.match(validator,/await verifyHttpCancellationFixtures\(fixtures,fixtureProof\.hashes\)/);assert.match(validator,/assertHttpCancellationCoverage\(wine\)/);assert.match(validator,/wine\.results\.length!==28/);
 assert.match(builder,/verifyHttpCancellationFixtures\(root,hashes\)/);assert.ok(builder.includes("wine+'/dlls/winhttp/tests/cancellation.c'"));assert.ok(runner.includes("await executeWinHttp(bits)"));assert.ok(runner.includes("'/bin/nexus_http-native-cancellation.exe'"));assert.match(runner,/\[\],\{\},46\)/);
 for(const gate of ['component','authentication','user-contracts','store','wine-native-contracts','http','media','graphics'])assert.ok(validator.includes(gate));
});
