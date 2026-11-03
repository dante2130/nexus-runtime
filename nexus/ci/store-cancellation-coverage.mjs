// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileHash} from './provenance.mjs';

export const storeCancellationFixtures=Object.freeze(['win64/bin/nexus_store-context-cancellation.exe','win32/bin/nexus_store-context-cancellation.exe']);
export async function verifyStoreCancellationFixtures(root,hashes){
  root=await fs.realpath(root);
  for(const [index,relative]of storeCancellationFixtures.entries()){
    const file=path.join(root,relative),stat=await fs.lstat(file);
    if(!stat.isFile()||stat.size<256||stat.size>64*1024*1024||await fs.realpath(file)!==file||!hashes||typeof hashes[relative]!=='string'||!/^[a-f0-9]{64}$/.test(hashes[relative])||await fileHash(file)!==hashes[relative])throw Error('Missing or changed Store cancellation fixture: '+relative);
    const handle=await fs.open(file,'r');
    try{
      const header=Buffer.alloc(Math.min(stat.size,4096));await handle.read(header,0,header.length,0);
      if(header.toString('ascii',0,2)!=='MZ')throw Error('Invalid Store cancellation fixture');
      const pe=header.readUInt32LE(60);
      if(pe<64||pe+26>header.length||header.toString('ascii',pe,pe+4)!=='PE\0\0'||header.readUInt16LE(pe+4)!==(index===0?0x8664:0x14c)||header.readUInt16LE(pe+24)!==(index===0?0x20b:0x10b))throw Error('Wrong Store cancellation fixture architecture');
    }finally{await handle.close();}
  }
}
function noExceptionalCounts(value){
  return ['skipped','todo','flaky'].every(name=>value[name]===undefined||Number.isSafeInteger(value[name])&&value[name]===0);
}
export function assertStoreCancellationResult(result){
  if(result?.passed!==true||!Array.isArray(result.results)||!noExceptionalCounts(result)||result.status!==undefined&&result.status!==0||result.signal||result.failure!==undefined||result.error!==undefined)throw Error('Missing Store cancellation result');
  const rows=result.results.filter(row=>row?.name==='store-context-cancellation');
  if(rows.length!==1)throw Error('Missing or ambiguous Store cancellation coverage');
  const row=rows[0];
  if(!Number.isSafeInteger(row.checks)||row.checks<67||row.failures!==0||row.failure!==undefined||row.error!==undefined||row.status!==undefined&&row.status!==0||row.signal||row.passed!==undefined&&row.passed!==true||!noExceptionalCounts(row))throw Error('Incomplete Store cancellation coverage');
}
export async function readStoreCancellationResult(directory){
  const groups=(await fs.readdir(directory)).filter(name=>name.startsWith('nexus-store-test-'));
  if(groups.length!==1)throw Error('Missing or ambiguous Store result group');
  const result=JSON.parse(await fs.readFile(path.join(directory,groups[0],'results.json'),'utf8'));
  assertStoreCancellationResult(result);return result;
}
