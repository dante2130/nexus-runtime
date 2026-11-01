// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import {project,readJson,sha256} from './inputs.mjs';
import {targets} from './target.mjs';
import {llvmMingwPin} from './llvm-mingw.mjs';
import {mediaRuntimeArchitectures} from './media-build-plan.mjs';
export async function verifyAuxiliary(directory,inputs,target=targets.x86_64){
  const bytes=await fs.readFile(path.join(directory,'auxiliary.json')),manifest=JSON.parse(bytes);
  const lockHash=sha256(await fs.readFile(path.join(project,'inputs.lock.json')));
  if(manifest.inputsSha256!==lockHash&&sha256(bytes)!==inputs.verifiedAuxiliaryManifestSha256)throw Error('Auxiliary producer does not match the checked inputs');
  for(const name of ['url','commit','version'])if(manifest.source?.[name]!==inputs.nghttp2[name])throw Error('Wrong nghttp2 source');
  if((manifest.arch??'x86_64')!==target.name)throw Error('Auxiliary components target another architecture');
  if(target.name==='arm64'){
    const pin=llvmMingwPin({NEXUS_LLVM_MINGW_URL:manifest.toolchain?.url,NEXUS_LLVM_MINGW_SHA256:manifest.toolchain?.sha256});
    if(Object.keys(manifest.toolchain).length!==2||pin.url!==manifest.toolchain.url)throw Error('Unpinned auxiliary toolchain');
  }else if(manifest.toolchain!==undefined)throw Error('Unexpected auxiliary toolchain');
  const layouts=[['headers',['nghttp2.h','nghttp2ver.h'],name=>'components/nghttp2/'+name],['libraries',target.peArchitectures,name=>'components/'+name+'/libnghttp2.dll'],['compatibility',['PlayFabGameSave.dll','gaming-services-version.exe','wine-launcher'],name=>'components/'+name]];
  for(const [group,names,file]of layouts){
    if(Object.keys(manifest[group]||{}).sort().join(',')!==[...names].sort().join(','))throw Error('Wrong auxiliary group: '+group);
    for(const name of names){
      const expected=manifest[group][name];
      if(!/^[a-f0-9]{64}$/.test(expected)||sha256(await fs.readFile(path.join(directory,file(name))))!==expected)throw Error('Auxiliary checksum mismatch: '+name);
    }
  }
  const media=await readJson(path.join(directory,'media/media-manifest.json'));
  const lock=await readJson(path.join(project,'runtime-media.lock.json'));
  if(media.version!==lock.version||media.source!==lock.url||media.sourceSha256!==lock.sha256)throw Error('Media source mismatch');
  if(!/^2\.(?:[0-9]|[12][0-9]|3[0-5])$/.test(media.maxGlibc))throw Error('Unportable media glibc requirement');
  const architectures=mediaRuntimeArchitectures(target);
  if(Object.keys(media.architectures||{}).sort().join(',')!==[...architectures].sort().join(','))throw Error('Incomplete media architectures');
  for(const triplet of architectures){
    const libraries=media.architectures[triplet].libraries;
    if(Object.keys(libraries||{}).sort().join(',')!==Object.keys(lock.libraries).sort().join(','))throw Error('Incomplete media libraries: '+triplet);
    for(const [soname,filename]of Object.entries(lock.libraries)){
      const item=libraries[soname];
      const bytes=await fs.readFile(path.join(directory,'media/stage/usr/lib',triplet,filename));
      if(item.filename!==filename||sha256(bytes)!==item.sha256)throw Error('Media checksum mismatch: '+triplet+'/'+soname);
      const [elfClass,machine]={'x86_64-linux-gnu':[2,62],'i386-linux-gnu':[1,3],'aarch64-linux-gnu':[2,183]}[triplet];
      if(bytes.length<20||bytes.readUInt32BE(0)!==0x7f454c46||bytes[4]!==elfClass||bytes[5]!==1||bytes.readUInt16LE(18)!==machine)throw Error('Wrong media ELF architecture: '+triplet+'/'+soname);
    }
  }
  return {manifest,manifestSha256:sha256(bytes),mediaSha256:sha256(await fs.readFile(path.join(directory,'media/media-manifest.json')))};
}
