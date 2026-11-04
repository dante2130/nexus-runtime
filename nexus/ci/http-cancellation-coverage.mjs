// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileHash} from './provenance.mjs';

export const httpCancellationControls=Object.freeze([['winhttp-cancellation',59],['http-native-cancellation',46]]);
export function parseWinHttpCancellation(output){
  const matches=[...output.matchAll(/(?:^|\n)[^\r\n]*:cancellation: (\d+) tests executed \((\d+) marked as todo, (\d+) as flaky, (\d+) failures?\), (\d+) skipped\./g)];
  if(matches.length!==1)throw Error('Missing or ambiguous WinHTTP cancellation summary');
  const [checks,todo,flaky,failures,skipped]=matches[0].slice(1).map(Number);
  if(!Number.isSafeInteger(checks)||checks<59||todo!==0||flaky!==0||failures!==0||skipped!==0)throw Error('Incomplete WinHTTP cancellation controls');
  return checks;
}
export function assertHttpCancellationCoverage(wine){
  if(wine?.passed!==true||!Array.isArray(wine.results))throw Error('Missing private HTTP cancellation coverage');
  for(const bits of [64,32])for(const [kind,floor]of httpCancellationControls){
    const rows=wine.results.filter(row=>row?.name===kind+'-'+bits);
    if(rows.length!==1||rows[0].passed!==true||rows[0].status!==0||rows[0].signal||!Array.isArray(rows[0].checks)||rows[0].checks.length!==1||!Number.isSafeInteger(rows[0].checks[0])||rows[0].checks[0]<floor)throw Error('Incomplete private HTTP cancellation: '+kind+'-'+bits);
  }
}
export async function verifyHttpCancellationFixtures(root,hashes){
  root=await fs.realpath(root);
  for(const bits of [64,32])for(const relative of ['native/winhttp-cancellation-'+bits+'-probe.exe','win'+bits+'/bin/nexus_http-native-cancellation.exe']){
    const file=path.join(root,relative),stat=await fs.lstat(file);
    if(!stat.isFile()||stat.size<256||stat.size>64*1024*1024||await fs.realpath(file)!==file||!hashes||typeof hashes[relative]!=='string'||!/^[a-f0-9]{64}$/.test(hashes[relative])||await fileHash(file)!==hashes[relative])throw Error('Missing or changed private HTTP fixture: '+relative);
    const handle=await fs.open(file,'r');
    try{
      const header=Buffer.alloc(Math.min(stat.size,4096));await handle.read(header,0,header.length,0);
      if(header.toString('ascii',0,2)!=='MZ')throw Error('Invalid private HTTP fixture');
      const pe=header.readUInt32LE(60);
      if(pe<64||pe+26>header.length||header.toString('ascii',pe,pe+4)!=='PE\0\0'||header.readUInt16LE(pe+4)!==(bits===64?0x8664:0x14c)||header.readUInt16LE(pe+24)!==(bits===64?0x20b:0x10b))throw Error('Wrong private HTTP fixture architecture');
    }finally{await handle.close();}
  }
}
