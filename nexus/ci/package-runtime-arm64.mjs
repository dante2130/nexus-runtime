// SPDX-License-Identifier: MIT
// Package the exact validated ARM64 main CI bytes and corresponding sources.
// Only the upstream repository's candidates are marked promotable.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {readJson,sourceEnvironment} from '../inputs.mjs';
import {fileHash,treeHash,assertPortable} from './provenance.mjs';
import {sourceArchiveArgs} from './source-archive.mjs';
import {noticeModuleInventory,verifySourceNoticeArchive,verifySourceNotices} from '../source-notices.mjs';
const [outputArg,validationArg]=process.argv.slice(2);
if(process.env.GITHUB_REF!=='refs/heads/main'||!/^[\w.-]+\/[\w.-]+$/.test(process.env.GITHUB_REPOSITORY||'')||!/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA||'')||!/^\d+$/.test(process.env.GITHUB_RUN_ID||''))throw Error('Packaging requires an exact main GitHub runtime build');
if(!outputArg||!validationArg||process.argv.length!==4)throw Error('BUILD_OUTPUT VALIDATION required');
const output=await fs.realpath(outputArg),validation=await fs.realpath(validationArg);
const built=await readJson(output+'/built.json'),proof=await readJson(validation+'/results.json');
if(built.metadata.targetArchitecture!=='arm64'||built.graph.proton!==process.env.GITHUB_SHA||!/^nexus-runtime-11\.0-experimental-arm64-g[a-f0-9]{8}$/.test(built.name)||path.dirname(built.runtime)!==output||path.basename(built.runtime)!==built.name)throw Error('Not the exact ARM64 main distribution source');
const gates=['arm64-layout','arm64-prefix-boot','arm64-load-aarch64','arm64-load-x86_64','arm64-load-i386',...['win64','win32'].flatMap(abi=>['component','authentication','user-contracts','store'].map(gate=>abi+'-'+gate)),'arm64-http','arm64-media','arm64-graphics'];
if(proof.passed!==true||proof.arch!=='arm64'||proof.stableApproved!==false||proof.realGameTest!==false||proof.builtSha256!==await fileHash(output+'/built.json')||proof.treeSha256!==await treeHash(built.runtime)||JSON.stringify(proof.graph)!==JSON.stringify(built.graph))throw Error('Unvalidated or changed runtime');
if(proof.results.length!==gates.length||proof.results.some((r,i)=>r.name!==gates[i]||r.status!==0||r.signal||r.error))throw Error('Incomplete or failed ARM64 gates');
for(const r of proof.results)if(!r.log.startsWith(validation+'/')||await fileHash(r.log)!==r.sha256)throw Error('Changed native log');
await assertPortable(built.runtime);
if(execFileSync('git',['rev-parse','HEAD'],{cwd:built.source,encoding:'utf8'}).trim()!==process.env.GITHUB_SHA)throw Error('Corresponding source moved');
const media=await readJson(built.aux+'/media/media-manifest.json');
if(await fileHash(built.aux+'/media/ffmpeg-'+media.version+'.tar.xz')!==media.sourceSha256)throw Error('Corresponding FFmpeg source changed');
// Preflight: a blocked or incomplete notice inventory must fail before any
// candidate artifact is created. Existing outputs are never removed here.
const noticeInventory=noticeModuleInventory(built.graph);
await verifySourceNotices({project:built.source+'/nexus',sourceRoot:built.source,family:'nexus',inventory:noticeInventory});
const env={...sourceEnvironment(),XZ_OPT:'-T2'};
function tar(args){execFileSync('tar',args,{env,stdio:'inherit',timeout:20*60*1000});}
const binary=built.name+'-aarch64.tar.xz',source=built.name+'-source.tar.xz';
for(const name of [binary,source,'candidate.json'])try{await fs.access(output+'/'+name);throw Error('Do not replace an existing candidate');}catch(e){if(e.code!=='ENOENT')throw e;}
tar(['-cJf',output+'/'+binary,'-C',output,built.name]);
tar(sourceArchiveArgs(output+'/'+source,built.source,built.aux,built.prepared,media.version));
const listing=execFileSync('tar',['-tJf',output+'/'+source],{encoding:'utf8',maxBuffer:32*1024*1024,timeout:120000}).trim().split('\n');
if(listing.some(n=>path.isAbsolute(n)||n.split('/').some(v=>v==='..'||v==='.git'))||!listing.includes('source/.gitmodules')||!listing.includes('source/wine/dlls/xgameruntime/CMakeLists.txt')||!listing.includes('source/nexus/licenses/GCC-runtime-copyright'))throw Error('Corresponding source archive incomplete');
// The archive carries no .git metadata, so the declared pins, notice paths,
// uniqueness, regularity and content bytes are verified from the real archive.
await verifySourceNoticeArchive({project:built.source+'/nexus',sourceRoot:built.source,family:'nexus',inventory:noticeInventory,listing,archive:output+'/'+source});
const files=[];
for(const name of [binary,source]){
  const checksum=name.replace(/\.tar\.xz$/,'.sha512sum');
  await fs.writeFile(output+'/'+checksum,await fileHash(output+'/'+name,'sha512')+'  '+name+'\n',{flag:'wx'});
  for(const file of [name,checksum])files.push({name:file,sha256:await fileHash(output+'/'+file),size:(await fs.stat(output+'/'+file)).size});
}
const manifest={schema:1,kind:'runtime',arch:'arm64',promotable:process.env.GITHUB_REPOSITORY==='domsvoboda/nexus-runtime',repository:process.env.GITHUB_REPOSITORY,commit:process.env.GITHUB_SHA,ref:process.env.GITHUB_REF,runId:process.env.GITHUB_RUN_ID,files,sourceGraph:built.graph,sdk:built.inputs.sdkArm64,auxiliaryToolchain:built.metadata.auxiliaryToolchain,requiresBackendVersion:built.metadata.requiresBackendVersion,requiresLauncherVersion:built.metadata.requiresLauncherVersion,validation:{nativeGateCount:proof.results.length,treeSha256:proof.treeSha256,resultsSha256:await fileHash(validation+'/results.json'),realGameTest:false,stableApproved:false}};
await fs.writeFile(output+'/candidate.json',JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
console.log('Packaged exact validated ARM64 main CI bytes and corresponding sources. No release was published.');
