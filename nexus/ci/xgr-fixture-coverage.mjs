// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileHash} from './provenance.mjs';

// These remain x86 clients on the ARM/FEX validation route as well.
export const fixtureAbis=Object.freeze({win64:{machine:0x8664,magic:0x20b},win32:{machine:0x14c,magic:0x10b}});
export const fixtureControls=Object.freeze([
  {gate:'store',name:'store-entitlements',binary:'nexus_store-entitlements.exe',minimum:1237},
  {gate:'store',name:'store-context-cancellation',binary:'nexus_store-context-cancellation.exe',minimum:67},
  {gate:'store',name:'receipt-ipc',binary:'nexus_receipt-ipc.exe',minimum:122},
  {gate:'component',name:'nexus_taskqueue-unwind-wait',binary:'nexus_taskqueue-unwind-wait.exe',minimum:17},
  {gate:'component',name:'nexus_taskqueue-composite-waiters',binary:'nexus_taskqueue-composite-waiters.exe',minimum:96},
]);
export const requiredXgrFixtures=Object.freeze(Object.entries(fixtureAbis).flatMap(([abi,format])=>fixtureControls.map(control=>Object.freeze({relative:abi+'/bin/'+control.binary,...format}))));
export async function verifyXgrFixtures(root,hashes){
  root=await fs.realpath(root);
  for(const {relative,machine,magic}of requiredXgrFixtures){
    const file=path.join(root,relative),stat=await fs.lstat(file);
    if(!stat.isFile()||stat.size<256||stat.size>64*1024*1024||await fs.realpath(file)!==file||!hashes||typeof hashes[relative]!=='string'||!/^[a-f0-9]{64}$/.test(hashes[relative])||await fileHash(file)!==hashes[relative])throw Error('Missing or changed XGR fixture: '+relative);
    const handle=await fs.open(file,'r');
    try{
      const header=Buffer.alloc(Math.min(stat.size,4096));await handle.read(header,0,header.length,0);
      if(header.toString('ascii',0,2)!=='MZ')throw Error('Invalid XGR fixture');
      const pe=header.readUInt32LE(60);
      if(pe<64||pe+26>header.length||header.toString('ascii',pe,pe+4)!=='PE\0\0'||header.readUInt16LE(pe+4)!==machine||header.readUInt16LE(pe+24)!==magic)throw Error('Wrong XGR fixture architecture');
    }finally{await handle.close();}
  }
}
function noExceptionalCounts(value){
  return ['skipped','todo','flaky'].every(name=>value[name]===undefined||Number.isSafeInteger(value[name])&&value[name]===0);
}
function cleanOutcome(value){
  return noExceptionalCounts(value)&&(value.failures===undefined||value.failures===0)&&value.failure===undefined&&value.error===undefined&&(value.status===undefined||value.status===0)&&!value.signal;
}
export function assertXgrResult(result,gate){
  const controls=fixtureControls.filter(control=>control.gate===gate);
  if(!controls.length||result?.passed!==true||!Array.isArray(result.results)||!cleanOutcome(result))throw Error('Missing XGR '+gate+' result');
  for(const {name,minimum}of controls){
    const rows=result.results.filter(row=>row?.name===name);
    if(rows.length!==1)throw Error('Missing or ambiguous XGR coverage: '+name);
    const row=rows[0];
    if(!Number.isSafeInteger(row.checks)||row.checks<minimum||row.failures!==0||row.passed!==undefined&&row.passed!==true||!cleanOutcome(row))throw Error('Incomplete XGR coverage: '+name);
  }
}
export async function readXgrResult(directory,gate){
  const prefix={store:'nexus-store-test-',component:'nexus-component-test-'}[gate];
  if(!prefix)throw Error('Unknown XGR result gate');
  const groups=(await fs.readdir(directory)).filter(name=>name.startsWith(prefix));
  if(groups.length!==1)throw Error('Missing or ambiguous XGR '+gate+' result group');
  const result=JSON.parse(await fs.readFile(path.join(directory,groups[0],'results.json'),'utf8'));
  assertXgrResult(result,gate);return result;
}
