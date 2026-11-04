// SPDX-License-Identifier: MIT
// Auditable source notice manifests. Every declared module carries its exact
// gitlink commit, every notice carries its module-relative path and SHA-256, and
// any missing, changed, unsafe or unresolved input fails closed before assembly
// writes an output or packaging ships an archive.
//
// Manifest layout, for example nexus/licenses/source-notices.json:
//   {schema:1, kind:'source-notices', family:'nexus'|'nexus-cachyos',
//    status:'ready'|'blocked', blockers:[string], coverage:[module path],
//    modules:[{path, commit, distribution, status, blockers?, reason?,
//              notices:[{path, sha256, name?}], contextFiles:[{path, sha256}]}],
//    excluded:[{path, decision:'not-built', reason}],
//    externalSources:[{module, path, status:'unresolved'|'resolved',
//                      reason?, commit?, sha256?}]}
// Notice files are staged into the payload. Context files stay in the
// corresponding source archive only and are never staged into the binary.
// Unknown keys and unknown enum values are rejected on purpose. Coverage only
// names the explicit notice subset this work inventories; it is not a claim of
// full legal closure over the whole pinned source graph. A ready manifest means
// the declared notice inventory is complete and matches the pinned bytes; it is
// not a legal certificate, an accepted agreement or a release approval.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sha256} from './inputs.mjs';

export const noticeDistributions=Object.freeze(['binary','linked','build-only']);
export const noticeDecisions=Object.freeze(['not-built']);
export const noticeStatuses=Object.freeze(['ready','blocked']);
export const noticeFamilies=Object.freeze(['nexus','nexus-cachyos']);
export const noticeExternalStatuses=Object.freeze(['unresolved','resolved']);
export const expandedNoticePrefixes=Object.freeze(['extras/','nvidia-libs/','vklayers/']);
// A single verified file stays bounded, and the whole verified set stays bounded
// so a manifest cannot turn notice staging into an unbounded read.
export const maxNoticeBytes=2*1024*1024;
export const maxNoticeBytesTotal=8*1024*1024;
export const baseNoticeManifest='source-notices.json';
export const variantNoticeManifest='cachyos-module-notices.json';

const modulePath=/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const noticeName=/^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const commit40=/^[a-f0-9]{40}$/;
const digest64=/^[a-f0-9]{64}$/;
const manifestKeys=['schema','kind','family','status','blockers','coverage','modules','excluded','externalSources'];
const moduleKeys=['path','commit','distribution','status','blockers','reason','notices','contextFiles'];
const noticeKeys=['path','sha256','name'];
const contextKeys=['path','sha256'];
const excludedKeys=['path','decision','reason'];
const externalKeys=['module','path','status','reason','commit','sha256'];

const fail=(label,message)=>{throw Error(label?label+': '+message:message);};

function rejectUnknownKeys(value,allowed,label){
  if(!value||typeof value!=='object'||Array.isArray(value))fail(label,'must be an object');
  for(const key of Object.keys(value))if(!allowed.includes(key))fail(label,'unknown key '+key);
  return value;
}

function text(value,label){
  if(typeof value!=='string'||!value.length||value!==value.trim())fail(label,'must be a non-empty trimmed string');
  return value;
}

function relativePath(value,label){
  text(value,label);
  if(value.includes('\\')||path.posix.isAbsolute(value))fail(label,'must be a relative POSIX path');
  const segments=value.split('/');
  if(segments.some(segment=>!segment||segment==='.'||segment==='..'))fail(label,'must not contain empty, . or .. segments');
  return value;
}

function moduleRelativePath(value,label){
  relativePath(value,label);
  if(!modulePath.test(value))fail(label,'must use only A-Z a-z 0-9 _ . - and / separators');
  return value;
}

function blockersOf(value,status,label){
  if(value===undefined){
    if(status==='blocked')fail(label,'a blocked entry must list at least one blocker');
    return [];
  }
  if(!Array.isArray(value))fail(label,'blockers must be an array');
  const list=value.map((entry,index)=>text(entry,label+' blocker '+index));
  if(status==='blocked'&&!list.length)fail(label,'a blocked entry must list at least one blocker');
  if(status!=='blocked'&&list.length)fail(label,'a ready entry must not list blockers');
  return list;
}

function statusOf(value,label){
  if(!noticeStatuses.includes(value))fail(label,'unknown status '+String(value));
  return value;
}

function noticeEntry(value,label){
  rejectUnknownKeys(value,noticeKeys,label);
  const file=relativePath(value.path,label+' path');
  if(typeof value.sha256!=='string'||!digest64.test(value.sha256))fail(label,'sha256 must be 64 lowercase hex characters');
  if(value.name!==undefined&&(typeof value.name!=='string'||!noticeName.test(value.name)))fail(label,'name must be a safe payload file name');
  return {path:file,sha256:value.sha256,...(value.name===undefined?{}:{name:value.name})};
}

// Context files stay in the corresponding source archive and are never staged
// into the binary payload. They record files whose bytes must remain available
// even when they are not part of the distributed notice set, for example CC-BY
// specification or test data, or source headers whose rights are still blocked.
function contextEntry(value,label){
  rejectUnknownKeys(value,contextKeys,label);
  const file=relativePath(value.path,label+' path');
  if(typeof value.sha256!=='string'||!digest64.test(value.sha256))fail(label,'sha256 must be 64 lowercase hex characters');
  return {path:file,sha256:value.sha256};
}

// Deterministic payload names keep a manifest readable without repeating a name
// for every file: both the module path and the notice path are flattened.
export function derivedNoticeName(modulePathValue,noticePathValue){
  const flatten=value=>value.replace(/[^A-Za-z0-9._+-]+/g,'-');
  return flatten(modulePathValue)+'-'+flatten(noticePathValue);
}

export function validateNoticeManifest(document,label){
  rejectUnknownKeys(document,manifestKeys,label);
  if(document.schema!==1)fail(label,'unsupported schema');
  if(document.kind!=='source-notices')fail(label,'unsupported kind');
  if(!noticeFamilies.includes(document.family))fail(label,'unknown family '+String(document.family));
  const status=statusOf(document.status,label);
  const blockers=blockersOf(document.blockers,status,label);
  if(!Array.isArray(document.coverage)||!document.coverage.length)fail(label,'coverage must be a non-empty array');
  const coverage=document.coverage.map((entry,index)=>moduleRelativePath(entry,label+' coverage '+index));
  if(new Set(coverage).size!==coverage.length)fail(label,'duplicate coverage path');
  if(!Array.isArray(document.modules)||!document.modules.length)fail(label,'modules must be a non-empty array');
  const modules=document.modules.map((entry,index)=>{
    const entryLabel=label+' module '+index;
    rejectUnknownKeys(entry,moduleKeys,entryLabel);
    const entryPath=moduleRelativePath(entry.path,entryLabel+' path');
    const entryLabelPath=label+' module '+entryPath;
    if(typeof entry.commit!=='string'||!commit40.test(entry.commit))fail(entryLabelPath,'commit must be 40 lowercase hex characters');
    if(!noticeDistributions.includes(entry.distribution))fail(entryLabelPath,'unknown distribution '+String(entry.distribution));
    const entryStatus=statusOf(entry.status,entryLabelPath);
    const entryBlockers=blockersOf(entry.blockers,entryStatus,entryLabelPath);
    const reason=entry.reason===undefined?undefined:text(entry.reason,entryLabelPath+' reason');
    if(!Array.isArray(entry.notices))fail(entryLabelPath,'notices must be an array');
    const notices=entry.notices.map((notice,index)=>noticeEntry(notice,entryLabelPath+' notice '+index));
    if(new Set(notices.map(notice=>notice.path)).size!==notices.length)fail(entryLabelPath,'duplicate notice path');
    const contextSource=entry.contextFiles===undefined?[]:entry.contextFiles;
    if(!Array.isArray(contextSource))fail(entryLabelPath,'contextFiles must be an array when present');
    const contextFiles=contextSource.map((file,index)=>contextEntry(file,entryLabelPath+' context '+index));
    if(new Set(contextFiles.map(file=>file.path)).size!==contextFiles.length)fail(entryLabelPath,'duplicate context file path');
    if(contextFiles.some(file=>notices.some(notice=>notice.path===file.path)))fail(entryLabelPath,'context files must not duplicate a notice path');
    if(entry.distribution==='build-only'){
      if(!reason)fail(entryLabelPath,'build-only modules require an explicit reason');
      if(notices.length)fail(entryLabelPath,'build-only modules must not declare distributed notices');
    }else if(!notices.length&&entryStatus==='ready')fail(entryLabelPath,entry.distribution+' modules require notices');
    return {path:entryPath,commit:entry.commit,distribution:entry.distribution,status:entryStatus,blockers:entryBlockers,reason,notices,contextFiles};
  });
  if(new Set(modules.map(module=>module.path)).size!==modules.length)fail(label,'duplicate module path');
  const modulePaths=new Set(modules.map(module=>module.path));
  if(status==='ready'&&modules.some(module=>module.status==='blocked'))fail(label,'a ready manifest must not declare a blocked module');
  const excludedSource=document.excluded===undefined?[]:document.excluded;
  if(!Array.isArray(excludedSource))fail(label,'excluded must be an array when present');
  const excluded=excludedSource.map((entry,index)=>{
    const entryLabel=label+' excluded '+index;
    rejectUnknownKeys(entry,excludedKeys,entryLabel);
    const entryPath=moduleRelativePath(entry.path,entryLabel+' path');
    if(!noticeDecisions.includes(entry.decision))fail(entryLabel+' '+entryPath,'unknown decision '+String(entry.decision));
    const reason=text(entry.reason,entryLabel+' '+entryPath+' reason');
    if(modulePaths.has(entryPath))fail(entryLabel+' '+entryPath,'is also declared as a module');
    if(!coverage.some(root=>entryPath===root||entryPath.startsWith(root+'/')))fail(entryLabel+' '+entryPath,'is outside every coverage path');
    return {path:entryPath,decision:entry.decision,reason};
  });
  if(new Set(excluded.map(entry=>entry.path)).size!==excluded.length)fail(label,'duplicate excluded path');
  const externalSource=document.externalSources===undefined?[]:document.externalSources;
  if(!Array.isArray(externalSource))fail(label,'externalSources must be an array when present');
  const externalSources=externalSource.map((entry,index)=>{
    const entryLabel=label+' external source '+index;
    rejectUnknownKeys(entry,externalKeys,entryLabel);
    const module=moduleRelativePath(entry.module,entryLabel+' module');
    const entryPath=relativePath(entry.path,entryLabel+' path');
    if(!noticeExternalStatuses.includes(entry.status))fail(entryLabel+' '+module+'/'+entryPath,'unknown status '+String(entry.status));
    if(!modulePaths.has(module))fail(entryLabel+' '+module,'is not a declared module');
    if(entry.status==='unresolved'){
      if(entry.commit!==undefined||entry.sha256!==undefined)fail(entryLabel+' '+module+'/'+entryPath,'an unresolved source must not claim a commit or a checksum');
      if(entry.reason===undefined)fail(entryLabel+' '+module+'/'+entryPath,'an unresolved source requires a reason');
      return {module,path:entryPath,status:entry.status,reason:text(entry.reason,entryLabel+' '+module+'/'+entryPath+' reason')};
    }
    if(typeof entry.commit!=='string'||!commit40.test(entry.commit))fail(entryLabel+' '+module+'/'+entryPath,'resolved source requires a 40 character commit');
    if(typeof entry.sha256!=='string'||!digest64.test(entry.sha256))fail(entryLabel+' '+module+'/'+entryPath,'resolved source requires a 64 character sha256');
    return {module,path:entryPath,status:entry.status,commit:entry.commit,sha256:entry.sha256};
  });
  if(new Set(externalSources.map(entry=>entry.module+'/'+entry.path)).size!==externalSources.length)fail(label,'duplicate external source path');
  for(const module of modules)if(!coverage.some(root=>module.path===root||module.path.startsWith(root+'/')))fail(label,module.path+' is outside every coverage path');
  for(const root of coverage)if(!modulePaths.has(root))fail(label,root+' is a coverage path without a module entry');
  return {family:document.family,status,blockers,coverage,modules,excluded,externalSources};
}

// The prepared source graph records the recursive `git submodule status` output
// with one leading space, so every listed commit already equals the recorded
// gitlink. Anything else is rejected instead of guessed.
export function noticeModuleInventory(graph){
  const lines=graph?.submodules;
  if(!Array.isArray(lines)||!lines.length)throw Error('The prepared source graph has no recursive submodule inventory');
  const inventory=[],seen=new Set();
  for(const line of lines){
    const match=/^ ([a-f0-9]{40}) (\S+)/.exec(line.trimEnd());
    if(!match)throw Error('Malformed prepared submodule inventory entry');
    const [,commit,modulePathValue]=match;
    if(!modulePath.test(modulePathValue)||modulePathValue.split('/').some(segment=>!segment||segment==='.'||segment==='..'))throw Error('Unsafe prepared submodule path: '+modulePathValue);
    if(seen.has(modulePathValue))throw Error('Duplicate prepared submodule path: '+modulePathValue);
    seen.add(modulePathValue);inventory.push({path:modulePathValue,commit});
  }
  return inventory;
}

export function normalizeNoticeInventory(inventory){
  if(!Array.isArray(inventory)||!inventory.length)throw Error('A source module inventory is required');
  const modules=new Map();
  for(const entry of inventory){
    if(!entry||typeof entry!=='object')throw Error('Invalid source module inventory entry');
    const entryPath=moduleRelativePath(entry.path,'inventory');
    if(typeof entry.commit!=='string'||!commit40.test(entry.commit))throw Error('Invalid inventory commit for '+entryPath);
    if(modules.has(entryPath))throw Error('Duplicate inventory module: '+entryPath);
    modules.set(entryPath,entry.commit);
  }
  return modules;
}

export function expandedNoticeModules(inventory){
  const modules=normalizeNoticeInventory(inventory);
  return [...modules.keys()].filter(modulePathValue=>expandedNoticePrefixes.some(prefix=>modulePathValue.startsWith(prefix))).sort();
}

export function sourceNoticePlan({manifests,inventory}){
  if(!Array.isArray(manifests)||!manifests.length)throw Error('At least one source notice manifest is required');
  const available=normalizeNoticeInventory(inventory);
  const families=new Set(),modules=new Map(),excluded=new Map(),externalSources=[],coverageRoots=[],blockers=[];
  const names=new Map(),files=[];
  for(const record of manifests){
    if(!record||typeof record.file!=='string')throw Error('Invalid source notice manifest record');
    const document=validateNoticeManifest(record.document,record.file);
    if(families.has(document.family))throw Error('Duplicate source notice manifest family: '+document.family);
    families.add(document.family);files.push({file:record.file,family:document.family,status:document.status});
    for(const message of document.blockers)blockers.push(record.file+': '+message);
    for(const root of document.coverage)coverageRoots.push({root,file:record.file});
    for(const module of document.modules){
      if(modules.has(module.path))throw Error('Duplicate source notice module across manifests: '+module.path);
      if(!available.has(module.path))throw Error('Declared source notice module is absent from the source graph: '+module.path);
      if(available.get(module.path)!==module.commit)throw Error('Source notice pin does not match the recorded gitlink: '+module.path);
      for(const message of module.blockers)blockers.push(module.path+': '+message);
      modules.set(module.path,module);
    }
    for(const entry of document.excluded){
      if(excluded.has(entry.path))throw Error('Duplicate excluded source module across manifests: '+entry.path);
      if(!available.has(entry.path))throw Error('Excluded source module is absent from the source graph: '+entry.path);
      excluded.set(entry.path,entry);
    }
    for(const entry of document.externalSources)externalSources.push(entry);
  }
  // An unresolved external source blocks the whole inventory regardless of the
  // manifest or module status, because its bytes cannot be verified.
  for(const entry of externalSources)if(entry.status==='unresolved')blockers.push(entry.module+'/'+entry.path+': '+entry.reason);
  // A materialized file may be both a shipped notice and a resolved external
  // source, but then both records must describe the same bytes. An unresolved
  // source may not also be declared as present.
  for(const entry of externalSources){
    const module=modules.get(entry.module);
    if(!module)continue;
    const declared=module.notices.find(notice=>notice.path===entry.path)??module.contextFiles.find(file=>file.path===entry.path);
    if(!declared)continue;
    if(entry.status==='unresolved')throw Error('An unresolved external source must not be declared as a notice or context file: '+entry.module+'/'+entry.path);
    if(declared.sha256!==entry.sha256)throw Error('Notice and external source records disagree on the bytes of '+entry.module+'/'+entry.path);
  }
  const covered=new Set([...modules.keys(),...excluded.keys()]);
  for(const {root} of coverageRoots)for(const [modulePathValue] of available)if((modulePathValue===root||modulePathValue.startsWith(root+'/'))&&!covered.has(modulePathValue))throw Error('Uncovered checked-out submodule under '+root+': '+modulePathValue);
  for(const modulePathValue of expandedNoticeModules(inventory))if(!covered.has(modulePathValue))throw Error('Expanded source module is not covered by a notice manifest: '+modulePathValue);
  const notices=[],contextFiles=[];
  for(const module of modules.values()){
    for(const notice of module.notices){
      const name=notice.name??derivedNoticeName(module.path,notice.path);
      if(!noticeName.test(name)||path.posix.basename(name)!==name)throw Error('Unsafe source notice name: '+name);
      if(names.has(name))throw Error('Duplicate source notice name '+name+' for '+module.path+'/'+notice.path+' and '+names.get(name));
      names.set(name,module.path+'/'+notice.path);
      notices.push({name,module:module.path,path:notice.path,sha256:notice.sha256});
    }
    for(const file of module.contextFiles)contextFiles.push({module:module.path,path:file.path,sha256:file.sha256});
  }
  const external=externalSources.map(entry=>({...entry}));
  return {
    manifests:files,
    modules:[...modules.values()].map(({path:p,commit,distribution,status})=>({path:p,commit,distribution,status})),
    excluded:[...excluded.values()],
    externalSources:external,
    notices:notices.sort((left,right)=>left.name.localeCompare(right.name)),
    contextFiles:contextFiles.sort((left,right)=>(left.module+'/'+left.path).localeCompare(right.module+'/'+right.path)),
    blockers,
  };
}

async function readManifest(file){
  let text;
  try{text=await fs.readFile(file,'utf8');}
  catch(error){if(error.code==='ENOENT')throw Error('Required source notice manifest is missing: '+file);throw error;}
  let document;
  try{document=JSON.parse(text);}
  catch(error){throw Error('Invalid JSON in source notice manifest '+file+': '+error.message);}
  return document;
}

export async function loadNoticeManifests({project,family,inventory}){
  if(!noticeFamilies.includes(family))throw Error('Unknown runtime family for source notices: '+String(family));
  const directory=path.join(project,'licenses');
  const manifests=[{file:baseNoticeManifest,document:await readManifest(path.join(directory,baseNoticeManifest))}];
  if(expandedNoticeModules(inventory).length){
    const file=path.join(directory,variantNoticeManifest),document=await readManifest(file);
    if(document.family!==family)throw Error('Expanded source modules require the '+family+' notice manifest, found '+String(document.family)+' in '+variantNoticeManifest);
    manifests.push({file:variantNoticeManifest,document});
  }
  return manifests;
}

async function lstatOrFail(target,label,message){
  try{return await fs.lstat(target);}
  catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')fail(label,message);throw error;}
}

// Refuses any symbolic link below the resolved root, including ancestors of the
// module path and of the file, then reads through a no-follow descriptor and
// verifies the bytes against the fstat size so a bounded read cannot be bypassed.
async function readPinnedFile(root,relative,expectedSha256,label){
  const segments=relative.split('/');
  if(segments.some(segment=>!segment||segment==='.'||segment==='..'))fail(label,'refuses an unsafe path');
  let current=root,stat;
  for(const [index,segment] of segments.entries()){
    current=path.join(current,segment);
    stat=await lstatOrFail(current,label,index===segments.length-1?'declared file is missing':'declared path is missing');
    if(stat.isSymbolicLink())fail(label,'refuses a symbolic link path component: '+relative);
  }
  if(!stat.isFile())fail(label,'declared file is not a regular file');
  if(stat.size>maxNoticeBytes)fail(label,'declared file exceeds the bounded read limit');
  let handle;
  try{handle=await fs.open(current,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}
  catch(error){
    if(error.code==='ELOOP')fail(label,'refuses a symbolic link path component: '+relative);
    if(error.code==='ENOENT'||error.code==='ENOTDIR')fail(label,'declared file is missing');
    throw error;
  }
  try{
    const opened=await handle.stat();
    if(!opened.isFile())fail(label,'declared file is not a regular file');
    if(opened.size>maxNoticeBytes)fail(label,'declared file exceeds the bounded read limit');
    if(opened.size!==stat.size)fail(label,'declared file changed while reading');
    const bytes=Buffer.alloc(opened.size);
    let offset=0;
    while(offset<bytes.length){
      const {bytesRead}=await handle.read(bytes,offset,bytes.length-offset,offset);
      if(!bytesRead)break;
      offset+=bytesRead;
    }
    const overflow=Buffer.alloc(1);
    const {bytesRead:extra}=await handle.read(overflow,0,1,opened.size);
    if(offset!==bytes.length||extra)fail(label,'declared file changed while reading');
    if(sha256(bytes)!==expectedSha256)fail(label,'declared sha256 does not match the pinned bytes');
    return bytes;
  }finally{await handle.close();}
}

async function pinnedBytes(realSource,modulePathValue,relative,expectedSha256,label){
  return readPinnedFile(realSource,modulePathValue+'/'+relative,expectedSha256,label);
}

export async function verifyNoticePlan({plan,sourceRoot,reservedNames=[],allowBlocked=false}){
  if(!plan||!Array.isArray(plan.notices))throw Error('A source notice plan is required');
  if(plan.blockers.length&&!allowBlocked)throw Error('Source notice inventory is blocked for distribution: '+plan.blockers.join('; '));
  const source=await fs.realpath(sourceRoot);
  const notices=[];
  const reserved=new Set(reservedNames);
  let total=0;
  const accounted=bytes=>{
    total+=bytes.length;
    if(total>maxNoticeBytesTotal)throw Error('Verified notice inputs exceed the bounded aggregate limit of '+maxNoticeBytesTotal+' bytes');
  };
  for(const notice of plan.notices){
    if(reserved.has(notice.name))throw Error('Source notice name collides with an existing notice: '+notice.name);
    if(notices.some(entry=>entry.name===notice.name))throw Error('Duplicate source notice name: '+notice.name);
    const bytes=await pinnedBytes(source,notice.module,notice.path,notice.sha256,notice.name);
    accounted(bytes);
    notices.push({...notice,bytes});
  }
  const contextFiles=[];
  for(const file of plan.contextFiles){
    const bytes=await pinnedBytes(source,file.module,file.path,file.sha256,file.module+'/'+file.path);
    accounted(bytes);
    contextFiles.push({...file});
  }
  const externalSources=[];
  for(const entry of plan.externalSources){
    if(entry.status==='resolved')accounted(await pinnedBytes(source,entry.module,entry.path,entry.sha256,entry.module+'/'+entry.path));
    externalSources.push({...entry});
  }
  return {plan,notices,contextFiles,externalSources};
}

export async function verifySourceNotices({project,sourceRoot,family,inventory,reservedNames=[],allowBlocked=false}){
  const manifests=await loadNoticeManifests({project,family,inventory});
  if(!manifests.some(manifest=>manifest.document.family==='nexus'))throw Error('The shared source notice manifest for family nexus is required');
  return verifyNoticePlan({plan:sourceNoticePlan({manifests,inventory}),sourceRoot,reservedNames,allowBlocked});
}

export async function stageSourceNotices(directory,verified){
  if(!Array.isArray(verified))throw Error('Verified source notices are required');
  await fs.mkdir(directory,{recursive:true});
  for(const notice of verified){
    if(typeof notice.name!=='string'||!noticeName.test(notice.name)||path.posix.basename(notice.name)!==notice.name)throw Error('Unsafe source notice name: '+String(notice.name));
    if(!Buffer.isBuffer(notice.bytes))throw Error('Verified source notice bytes are required: '+notice.name);
    await fs.writeFile(path.join(directory,notice.name),notice.bytes,{flag:'wx'});
  }
}

// The corresponding source archive has no .git metadata, so completeness is
// checked against the recorded prepared inventory, the manifest paths and the
// re-verified content hashes of the built source tree. The packaging caller also
// passes the exact archive, so the actual archived members are streamed read
// only: membership, uniqueness, entry type, bounded size and the stored bytes are
// verified instead of trusting the caller's listing.
export async function verifySourceNoticeArchive({project,sourceRoot,family,inventory,listing,archive}){
  if(!Array.isArray(listing)||!listing.length)throw Error('A corresponding source archive listing is required');
  if(typeof archive!=='string'||!path.isAbsolute(archive))throw Error('An absolute corresponding source archive path is required');
  const archiveStat=await fs.lstat(archive).catch(error=>{if(error.code==='ENOENT')throw Error('The corresponding source archive is missing: '+archive);throw error;});
  if(!archiveStat.isFile())throw Error('The corresponding source archive is not a regular file: '+archive);
  const verified=await verifySourceNotices({project,sourceRoot,family,inventory});
  // One expected path per archive member. A notice and a resolved external source
  // may describe the same materialized file, which is then verified once.
  const expected=new Map();
  const add=async(name,digest)=>{
    if(expected.has(name)){
      if(expected.get(name)!==digest)throw Error('Conflicting expected hashes for '+name);
      return;
    }
    expected.set(name,digest);
  };
  for(const manifest of verified.plan.manifests){
    const reviewed=await fs.readFile(path.join(project,'licenses',manifest.file));
    await add('source/nexus/licenses/'+manifest.file,sha256(reviewed));
  }
  for(const notice of verified.notices)await add('source/'+notice.module+'/'+notice.path,notice.sha256);
  for(const file of verified.contextFiles)await add('source/'+file.module+'/'+file.path,file.sha256);
  for(const entry of verified.externalSources)if(entry.status==='resolved')await add('source/'+entry.module+'/'+entry.path,entry.sha256);
  // Additional compatibility check on the caller listing. It is not proof of the
  // archive contents; the streamed inspection below is authoritative.
  const counts=new Map();
  for(const name of listing)counts.set(name,(counts.get(name)??0)+1);
  const missing=[],duplicated=[],unsafe=[];
  for(const name of expected.keys()){
    if(!counts.has(name))missing.push(name);
    if((counts.get(name)??0)>1)duplicated.push(name);
    if(name.startsWith('/')||name.includes('\\')||name.split('/').some(segment=>!segment||segment==='.'||segment==='..'))unsafe.push(name);
  }
  if(missing.length)throw Error('Corresponding source archive omits declared notice inputs: '+missing.join(', '));
  if(duplicated.length)throw Error('Corresponding source archive repeats declared notice inputs: '+duplicated.join(', '));
  if(unsafe.length)throw Error('Corresponding source archive contains an unsafe declared path: '+unsafe.join(', '));
  const expectedList=[...expected].map(([name,digest])=>({name,sha256:digest}));
  const inspector=path.join(path.dirname(fileURLToPath(import.meta.url)),'ci/inspect-source-archive.py');
  const result=spawnSync('python3',['-I',inspector],{input:JSON.stringify({archive,expected:expectedList}),encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:30*60*1000,maxBuffer:8*1024*1024});
  let report;
  try{report=JSON.parse(String(result.stdout||''));}
  catch(error){report=undefined;}
  if(report&&report.ok===false)throw Error('Corresponding source archive check failed: '+report.error);
  if(result.status!==0||!report||report.ok!==true)throw Error('Cannot inspect the corresponding source archive: '+(String(result.stderr||'').trim()||'the bounded archive inspector failed'));
  return verified.plan;
}
