// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileHash} from './ci/provenance.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(root,file)=>file.startsWith(root+path.sep);
export async function writeFamilyManifest(runtime,{family,sourceRepository,sourceCommit,sourceLockSha256}){
  if(family!=='nexus'||sourceRepository!=='domsvoboda/nexus-runtime'||!/^[a-f0-9]{40}$/.test(sourceCommit)||!/^[a-f0-9]{64}$/.test(sourceLockSha256))throw Error('Exact managed Standard source identity required');
  const root=await fs.realpath(runtime),files={},symlinks={};
  const metadata=JSON.parse(await fs.readFile(path.join(root,'XODUS_NEXUS_PATCH.json'),'utf8'));
  if(metadata.schema!==1||metadata.sourceGraph?.proton!==sourceCommit||metadata.sourceLockSha256!==sourceLockSha256)throw Error('Managed source identity disagrees with assembled metadata');
  async function scan(directory){
    for(const entry of (await fs.readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
      const file=path.join(directory,entry.name),name=path.relative(root,file).split(path.sep).join('/');
      if(name==='nexus-family.json')throw Error('Managed family manifest already exists');
      if(name.includes('\\'))throw Error('Unsupported managed payload path');
      if(entry.isDirectory())await scan(file);
      else if(entry.isFile())files[name]=await fileHash(file);
      else if(entry.isSymbolicLink()){
        const target=await fs.readlink(file);
        const templateMapping=name==='files/share/default_pfx/dosdevices/z:'&&target==='/';
        if(!templateMapping&&(path.isAbsolute(target)||!inside(root,await fs.realpath(file))))throw Error('External managed payload link: '+name);
        symlinks[name]=target;
      }else throw Error('Unsupported managed payload entry: '+name);
    }
  }
  await scan(root);
  const critical=['proton','files/bin/wine','files/bin/wineserver','files/bin/wine.nexus-original','XODUS_NEXUS_PATCH.json',
    ...['PlayFabGameSave.dll','gaming-services-version.exe','package-registration.exe'].map(n=>'files/share/xodus-nexus/compat/'+n),
    ...['x86_64','i386'].flatMap(cpu=>['xgameruntime.dll','winhttp.dll','libnghttp2.dll'].map(n=>`files/lib/wine/${cpu}-windows/${n}`))];
  for(const file of critical)if(!files[file])throw Error('Managed launch payload incomplete: '+file);
  if(!(await fs.lstat(path.join(root,'files/share/default_pfx'))).isDirectory())throw Error('Managed default prefix is not a real directory');
  for(const file of ['proton','files/bin/wine','files/bin/wineserver'])await fs.access(path.join(root,file),fs.constants.X_OK);
  // Managed launcher family receipts are x64-only; ARM64 remains legacy experimental.
  const identity={schema:1,family,sourceRepository,sourceCommit,arch:'x64',prefixSchema:1,sourceLockSha256,files,symlinks};
  const buildId=digest(JSON.stringify(identity));
  const manifest={...identity,buildId},bytes=JSON.stringify(manifest,null,2)+'\n';
  await fs.writeFile(path.join(root,'nexus-family.json'),bytes,{flag:'wx'});
  // This is packaging metadata only. The caller never writes or activates current.json.
  return {schema:1,family,sourceRepository,sourceCommit,buildId,manifestSha256:digest(bytes)};
}
