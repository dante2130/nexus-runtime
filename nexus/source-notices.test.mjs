// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {project,repository} from './inputs.mjs';
import {
  baseNoticeManifest,
  derivedNoticeName,
  expandedNoticeModules,
  noticeModuleInventory,
  sourceNoticePlan,
  stageSourceNotices,
  validateNoticeManifest,
  verifyNoticePlan,
  verifySourceNoticeArchive,
  verifySourceNotices,
  variantNoticeManifest,
} from './source-notices.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const commit=value=>value.repeat(40).slice(0,40);
const hex=value=>value.repeat(64).slice(0,64);

function gitlinks(){
  const output=execFileSync('git',['ls-tree','-r','HEAD'],{cwd:repository,encoding:'utf8'});
  const links=new Map();
  for(const line of output.split('\n')){
    const match=/^160000 commit ([a-f0-9]{40})\t(.+)$/.exec(line);
    if(match)links.set(match[2],match[1]);
  }
  return links;
}

function readManifest(file){
  return JSON.parse(fs.readFileSync(path.join(project,'licenses',file),'utf8'));
}

function baseDocument({modules=[],excluded,externalSources,coverage=['mod-a'],extra={}}={}){
  return {
    schema:1,
    kind:'source-notices',
    family:'nexus',
    status:'ready',
    coverage,
    modules,
    ...(excluded===undefined?{}:{excluded}),
    ...(externalSources===undefined?{}:{externalSources}),
    ...extra,
  };
}

function linkedModule(pathValue,commitValue,notices,extra={}){
  return {path:pathValue,commit:commitValue,distribution:'linked',status:'ready',notices,...extra};
}

function scratch(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-source-notices-'));
  const projectRoot=path.join(root,'project'),source=path.join(root,'source');
  fs.mkdirSync(path.join(projectRoot,'licenses'),{recursive:true});
  fs.mkdirSync(source,{recursive:true});
  return {
    root,
    project:projectRoot,
    source,
    write(file,document){
      fs.writeFileSync(path.join(projectRoot,'licenses',file),typeof document==='string'?document:JSON.stringify(document,null,2)+'\n');
      return this;
    },
    manifestBytes(){
      return fs.readFileSync(path.join(projectRoot,'licenses',baseNoticeManifest),'utf8');
    },
    module(relative){
      fs.mkdirSync(path.join(source,relative),{recursive:true});
      return this;
    },
    file(module,relative,content){
      const target=path.join(source,module,relative);
      fs.mkdirSync(path.dirname(target),{recursive:true});
      fs.writeFileSync(target,content);
      return {path:relative,sha256:digest(content)};
    },
    cleanup(){fs.rmSync(root,{recursive:true,force:true});},
  };
}

// Tiny synthetic archives only. This is not a runtime build, candidate or
// package artifact; it lets the read-only archive inspection run offline. The
// builder uses the Python tarfile writer so hardlink, symlink, directory and
// duplicate entries can be crafted exactly.
const archiveBuilder=`
import io,json,sys,tarfile
spec=json.load(sys.stdin)
with tarfile.open(spec['archive'],'w:xz') as tar:
    for entry in spec['entries']:
        info=tarfile.TarInfo(entry['name'])
        kind=entry.get('type','file')
        if kind=='symlink':
            info.type=tarfile.SYMTYPE
            info.linkname=entry['link']
            tar.addfile(info)
        elif kind=='hardlink':
            info.type=tarfile.LNKTYPE
            info.linkname=entry['link']
            tar.addfile(info)
        elif kind=='directory':
            info.type=tarfile.DIRTYPE
            tar.addfile(info)
        else:
            data=entry['content'].encode()
            info.size=len(data)
            tar.addfile(info,io.BytesIO(data))
`;

function buildArchive(root,entries){
  const archive=path.join(root,`archive-${Date.now()}-${Math.random().toString(16).slice(2,8)}.tar.xz`);
  const result=spawnSync('python3',['-I','-c',archiveBuilder],{input:JSON.stringify({archive,entries}),encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  assert.equal(result.status,0,String(result.stderr));
  return archive;
}

function tarListing(archive){
  return execFileSync('tar',['-tJf',archive],{encoding:'utf8'}).trim().split('\n');
}

function inspectArchive(archive,expected){
  const tool=path.join(project,'ci','inspect-source-archive.py');
  const result=spawnSync('python3',['-I',tool],{input:JSON.stringify({archive,expected}),encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  return {status:result.status,report:JSON.parse(String(result.stdout||'{}'))};
}

test('the committed base manifest pins match the recorded top-level gitlinks',()=>{
  const document=readManifest(baseNoticeManifest);
  const validated=validateNoticeManifest(document,baseNoticeManifest);
  assert.equal(validated.family,'nexus');
  assert.equal(validated.status,'ready');
  assert.deepEqual(validated.blockers,[]);
  assert.deepEqual(validated.coverage,['dxvk','dxvk-igdext','vkd3d','vkd3d-proton','dxvk-nvapi']);
  const links=gitlinks();
  let topLevel=0;
  for(const module of validated.modules){
    assert.equal(module.status,'ready',module.path);
    if(module.path.includes('/'))continue;
    topLevel+=1;
    assert.equal(links.get(module.path),module.commit,module.path);
  }
  assert.equal(topLevel,5);
  // The shared module set stays family neutral: no CachyOS-only namespace.
  for(const module of validated.modules)assert.ok(!['extras','nvidia-libs','vklayers'].includes(module.path.split('/')[0]),module.path);
  const paths=validated.modules.map(module=>module.path);
  assert.ok(paths.includes('dxvk'),'dxvk is covered');
  assert.ok(paths.includes('dxvk-igdext'),'dxvk-igdext is covered');
  assert.ok(paths.includes('vkd3d'),'vkd3d is covered');
  assert.ok(paths.includes('vkd3d-proton'),'vkd3d-proton is covered');
  assert.ok(paths.includes('dxvk-nvapi'),'dxvk-nvapi is covered');
  const noticesOf=modulePathValue=>validated.modules.find(module=>module.path===modulePathValue).notices.map(notice=>notice.path);
  assert.deepEqual(noticesOf('vkd3d-proton'),['COPYING','LICENSE','AUTHORS','include/private/nvShaderExtnEnums.h','libs/vkd3d-shader/checksum.c','libs/vkd3d/shaders/cs_gdeflate.comp']);
  assert.ok(noticesOf('vkd3d-proton/khronos/Vulkan-Headers').includes('LICENSES/Apache-2.0.txt'));
  assert.deepEqual(noticesOf('vkd3d'),['COPYING','LICENSE','AUTHORS','libs/vkd3d-shader/checksum.c']);
  assert.deepEqual(noticesOf('dxvk-igdext'),['LICENSE.md','dxvk-igdext_third-party-programs.md','d3dext-sdk/include/public/igdext.h']);
  assert.ok(noticesOf('dxvk-nvapi').includes('LICENSE'));
  assert.ok(noticesOf('dxvk-nvapi/external/vkroots').includes('LICENSES/LGPL-2.1-or-later.txt'));
  assert.deepEqual(validated.excluded.map(entry=>entry.decision),['not-built','not-built']);
});

test('the DXVK nested build and link inputs are all covered by the shared manifest',()=>{
  const document=readManifest(baseNoticeManifest);
  const validated=validateNoticeManifest(document,baseNoticeManifest);
  const modules=new Map(validated.modules.map(module=>[module.path,module]));
  // Every Meson subproject and vendored header tree that the pinned DXVK build
  // compiles or links into a shipped DLL is an explicit module with a notice.
  const expected=Object.freeze({
    'dxvk':['LICENSE'],
    'dxvk/include/native/directx':['COPYING.MinGW-w64.txt'],
    'dxvk/include/spirv':['LICENSE','LICENSES/MIT.txt'],
    'dxvk/include/vulkan':['LICENSE.md','LICENSES/Apache-2.0.txt','LICENSES/MIT.txt'],
    'dxvk/subprojects/dxbc-spirv':['LICENSE'],
    'dxvk/subprojects/dxbc-spirv/submodules/spirv_headers':['LICENSE','LICENSES/MIT.txt'],
    'dxvk/subprojects/libdisplay-info':['LICENSE'],
  });
  for(const [modulePath,noticePaths] of Object.entries(expected)){
    const module=modules.get(modulePath);
    assert.ok(module,'DXVK nested input is not declared: '+modulePath);
    assert.equal(module.distribution,'linked',modulePath);
    assert.deepEqual(module.notices.map(notice=>notice.path),noticePaths,modulePath);
  }
  const contextOf=modulePathValue=>(modules.get(modulePathValue).contextFiles??[]).map(file=>file.path);
  assert.deepEqual(contextOf('dxvk/include/vulkan'),['REUSE.toml']);
  assert.deepEqual(contextOf('dxvk/subprojects/libdisplay-info'),['test/data/LICENSE.CC-BY-4.0']);
  assert.ok(contextOf('dxvk/include/spirv').includes('LICENSES/CC-BY-4.0.txt'));
  assert.ok(contextOf('dxvk/subprojects/dxbc-spirv/submodules/spirv_headers').includes('LICENSES/CC-BY-4.0.txt'));
  let nested=0;
  for(const pathValue of modules.keys())if(pathValue.startsWith('dxvk/'))nested+=1;
  assert.equal(nested,6,'every checked-out DXVK nested module is declared');
  // With an initialized checkout, confirm that the pinned DXVK build really
  // compiles or links these inputs. Source-only runs have no submodule content.
  const dxvkMesonFile=path.join(repository,'dxvk/meson.build');
  if(fs.existsSync(dxvkMesonFile)){
    const dxvkMeson=fs.readFileSync(dxvkMesonFile,'utf8');
    assert.ok(dxvkMeson.includes("subproject('dxbc-spirv')"));
    assert.ok(dxvkMeson.includes("fallback: ['libdisplay-info', 'di_dep']"));
    assert.ok(dxvkMeson.includes("'./include/native/directx'"));
    assert.ok(dxvkMeson.includes("'./include/vulkan/include'"));
    assert.ok(dxvkMeson.includes("'./include/spirv/include'"));
  }
});

test('a committed variant manifest stays schema valid and consistent with its own status',()=>{
  if(!fs.existsSync(path.join(project,'licenses',variantNoticeManifest)))return;
  const document=readManifest(variantNoticeManifest);
  const validated=validateNoticeManifest(document,variantNoticeManifest);
  assert.equal(validated.family,'nexus-cachyos');
  // The shared test proves the ready/blocked invariant without assuming either
  // state for the variant manifest or hardcoding this family's readiness.
  if(validated.status==='blocked')assert.ok(validated.blockers.length,'a blocked manifest prints its blockers');
  else assert.deepEqual(validated.blockers,[]);
  if(validated.status==='ready')assert.ok(validated.modules.every(module=>module.status==='ready'),'a ready manifest has no blocked module');
  const links=gitlinks();
  for(const module of validated.modules){
    if(module.path.includes('/'))continue;
    if(!links.has(module.path))continue;
    assert.equal(links.get(module.path),module.commit,module.path);
  }
});

test('a complete synthetic fixture verifies, stages the exact bytes and refuses to overwrite',async()=>{
  const fixture=scratch();
  try{
    const link=fixture.file('mod-a','LICENSE','MIT fixture license\n');
    const nested=fixture.file('mod-a/sub','LICENSE','Nested fixture license\n');
    const document=baseDocument({modules:[linkedModule('mod-a',commit('a'),[link])]});
    document.modules.push(linkedModule('mod-a/sub',commit('b'),[nested]));
    document.excluded=[];
    fixture.write(baseNoticeManifest,document);
    const inventory=[{path:'mod-a',commit:commit('a')},{path:'mod-a/sub',commit:commit('b')}];
    const verified=await verifySourceNotices({project:fixture.project,sourceRoot:fixture.source,family:'nexus',inventory});
    assert.equal(verified.notices.length,2);
    const [first]=verified.notices;
    assert.equal(first.name,'mod-a-LICENSE');
    assert.equal(first.bytes.toString(),'MIT fixture license\n');
    assert.equal(derivedNoticeName('mod-a/sub','LICENSE'),'mod-a-sub-LICENSE');
    const staged=path.join(fixture.root,'stage');
    await stageSourceNotices(staged,verified.notices);
    assert.equal(fs.readFileSync(path.join(staged,'mod-a-LICENSE'),'utf8'),'MIT fixture license\n');
    assert.equal(fs.readFileSync(path.join(staged,'mod-a-sub-LICENSE'),'utf8'),'Nested fixture license\n');
    await assert.rejects(stageSourceNotices(staged,verified.notices),/EEXIST/);
  }finally{fixture.cleanup();}
});

test('an unknown checked-out submodule under a coverage path fails closed',()=>{
  const document=baseDocument({modules:[linkedModule('mod-a',commit('a'),[{path:'LICENSE',sha256:hex('1')}])]});
  assert.throws(()=>sourceNoticePlan({manifests:[{file:baseNoticeManifest,document}],inventory:[{path:'mod-a',commit:commit('a')},{path:'mod-a/extra',commit:commit('c')}]}),/Uncovered checked-out submodule/);
});

test('a repinned module and an absent module both fail closed',()=>{
  const document=baseDocument({modules:[linkedModule('mod-a',commit('a'),[{path:'LICENSE',sha256:hex('1')}])]});
  assert.throws(()=>sourceNoticePlan({manifests:[{file:baseNoticeManifest,document}],inventory:[{path:'mod-a',commit:commit('b')}]}),/does not match the recorded gitlink/);
  assert.throws(()=>sourceNoticePlan({manifests:[{file:baseNoticeManifest,document}],inventory:[{path:'other',commit:commit('a')}]}),/absent from the source graph/);
});

test('unknown keys, classes and placeholder statuses are rejected',()=>{
  const notice={path:'LICENSE',sha256:hex('1')};
  for(const [change,message] of [
    [{schema:2},/unsupported schema/],
    [{kind:'something-else'},/unsupported kind/],
    [{family:'nexus-mystery'},/unknown family/],
    [{status:'pending'},/unknown status/],
    [{status:'blocked'},/blocked entry must list at least one blocker/],
    [{extraKey:true},/unknown key extraKey/],
    [{coverage:['mod-a','mod-b']},/is a coverage path without a module entry/],
  ]){
    const document=baseDocument({modules:[linkedModule('mod-a',commit('a'),[notice])]});
    Object.assign(document,change);
    assert.throws(()=>validateNoticeManifest(document,baseNoticeManifest),message,JSON.stringify(Object.keys(change)));
  }
  const document=baseDocument({modules:[linkedModule('mod-a',commit('a'),[notice])]});
  document.modules[0].distribution='project-only';
  assert.throws(()=>validateNoticeManifest(document,baseNoticeManifest),/unknown distribution/);
  document.modules[0].distribution='binary';
  document.modules[0].notices=[];
  assert.throws(()=>validateNoticeManifest(document,baseNoticeManifest),/binary modules require notices/);
  document.modules[0].distribution='build-only';
  assert.throws(()=>validateNoticeManifest(document,baseNoticeManifest),/build-only modules require an explicit reason/);
  document.modules[0].reason='Tool only';
  document.modules[0].notices=[notice];
  assert.throws(()=>validateNoticeManifest(document,baseNoticeManifest),/build-only modules must not declare distributed notices/);
  document.modules[0].notices=[];
  assert.equal(validateNoticeManifest(document,baseNoticeManifest).modules[0].distribution,'build-only');
});

test('unknown exclusion decisions, unsafe paths and duplicates fail closed',()=>{
  const module=linkedModule('mod-a',commit('a'),[{path:'LICENSE',sha256:hex('1')}]);
  const badDecision=baseDocument({modules:[module],excluded:[{path:'mod-a/x',decision:'probably-fine',reason:'because'}]});
  assert.throws(()=>validateNoticeManifest(badDecision,baseNoticeManifest),/unknown decision/);
  const outside=baseDocument({modules:[module],excluded:[{path:'other/x',decision:'not-built',reason:'because'}]});
  assert.throws(()=>validateNoticeManifest(outside,baseNoticeManifest),/outside every coverage path/);
  for(const unsafe of ['../LICENSE','/LICENSE','a//b','a/./b','a/../b','a\\b']){
    const document=baseDocument({modules:[linkedModule('mod-a',commit('a'),[{path:unsafe,sha256:hex('1')}])]});
    assert.throws(()=>validateNoticeManifest(document,baseNoticeManifest),/relative POSIX path|empty, \. or \.\. segments/,unsafe);
  }
  const duplicateName=baseDocument({modules:[
    linkedModule('mod-a',commit('a'),[{path:'LICENSE',sha256:hex('1'),name:'shared-notice'}]),
    linkedModule('mod-a/sub',commit('b'),[{path:'LICENSE',sha256:hex('2'),name:'shared-notice'}]),
  ]});
  assert.throws(()=>sourceNoticePlan({manifests:[{file:baseNoticeManifest,document:duplicateName}],inventory:[{path:'mod-a',commit:commit('a')},{path:'mod-a/sub',commit:commit('b')}]}),/Duplicate source notice name/);
  const duplicateModule=baseDocument({modules:[module]});
  assert.throws(()=>sourceNoticePlan({manifests:[{file:baseNoticeManifest,document:duplicateModule},{file:variantNoticeManifest,document:{...duplicateModule,family:'nexus-cachyos'}}],inventory:[{path:'mod-a',commit:commit('a')}]}),/Duplicate source notice module|Duplicate source notice manifest family/);
});

test('a changed hash, a directory, a symlink and a missing file fail closed',async()=>{
  const fixture=scratch();
  try{
    fixture.module('mod-a');
    const good=fixture.file('mod-a','LICENSE','fixture\n');
    const write=document=>fixture.write(baseNoticeManifest,baseDocument({modules:[linkedModule('mod-a',commit('a'),[document])]}));
    const inventory=[{path:'mod-a',commit:commit('a')}];
    write(good);
    const verified=await verifySourceNotices({project:fixture.project,sourceRoot:fixture.source,family:'nexus',inventory});
    assert.equal(verified.notices.length,1);
    write({path:'LICENSE',sha256:hex('0')});
    await assert.rejects(verifySourceNotices({project:fixture.project,sourceRoot:fixture.source,family:'nexus',inventory}),/sha256 does not match/);
    fs.rmSync(path.join(fixture.source,'mod-a/LICENSE'));
    fs.mkdirSync(path.join(fixture.source,'mod-a/LICENSE'));
    write({path:'LICENSE',sha256:hex('0')});
    await assert.rejects(verifySourceNotices({project:fixture.project,sourceRoot:fixture.source,family:'nexus',inventory}),/not a regular file/);
    fs.rmSync(path.join(fixture.source,'mod-a/LICENSE'),{recursive:true});
    fs.writeFileSync(path.join(fixture.root,'outside'),'outside\n');
    fs.symlinkSync(path.join(fixture.root,'outside'),path.join(fixture.source,'mod-a/LICENSE'));
    write({path:'LICENSE',sha256:digest('outside\n')});
    await assert.rejects(verifySourceNotices({project:fixture.project,sourceRoot:fixture.source,family:'nexus',inventory}),/refuses a symbolic link path component/);
    fs.rmSync(path.join(fixture.source,'mod-a/LICENSE'));
    await assert.rejects(verifySourceNotices({project:fixture.project,sourceRoot:fixture.source,family:'nexus',inventory}),/declared file is missing/);
  }finally{fixture.cleanup();}
});

test('a module reached through a symbolic link ancestor fails closed',async()=>{
  const fixture=scratch();
  try{
    const real=path.join(fixture.source,'real-group','mod-a');
    fs.mkdirSync(real,{recursive:true});
    fs.writeFileSync(path.join(real,'LICENSE'),'linked license\n');
    fs.symlinkSync(path.join(fixture.source,'real-group'),path.join(fixture.source,'group'));
    fixture.write(baseNoticeManifest,baseDocument({modules:[linkedModule('group/mod-a',commit('a'),[{path:'LICENSE',sha256:digest('linked license\n')}])],coverage:['group/mod-a']}));
    await assert.rejects(verifySourceNotices({project:fixture.project,sourceRoot:fixture.source,family:'nexus',inventory:[{path:'group/mod-a',commit:commit('a')}]}),/refuses a symbolic link path component: group\/mod-a/);
    // The same module without the link ancestor verifies normally.
    fs.rmSync(path.join(fixture.source,'group'));
    fs.mkdirSync(path.join(fixture.source,'group'));
    fs.renameSync(real,path.join(fixture.source,'group','mod-a'));
    const verified=await verifySourceNotices({project:fixture.project,sourceRoot:fixture.source,family:'nexus',inventory:[{path:'group/mod-a',commit:commit('a')}]});
    assert.equal(verified.notices.length,1);
  }finally{fixture.cleanup();}
});

test('symbolic link components inside a module are refused even when they stay inside the root',async()=>{
  const fixture=scratch();
  try{
    fixture.file('mod-a','real/LICENSE','inner license\n');
    fs.symlinkSync('real',path.join(fixture.source,'mod-a/link'));
    fs.writeFileSync(path.join(fixture.root,'outside'),'outside license\n');
    fs.symlinkSync(path.join(fixture.root,'outside'),path.join(fixture.source,'mod-a/escape'));
    const document=baseDocument({modules:[linkedModule('mod-a',commit('a'),[{path:'link/LICENSE',sha256:digest('inner license\n')},{path:'escape',sha256:digest('outside license\n')}])]});
    fixture.write(baseNoticeManifest,document);
    const inventory=[{path:'mod-a',commit:commit('a')}];
    await assert.rejects(verifySourceNotices({project:fixture.project,sourceRoot:fixture.source,family:'nexus',inventory}),/refuses a symbolic link path component/);
    fixture.write(baseNoticeManifest,baseDocument({modules:[linkedModule('mod-a',commit('a'),[{path:'real/LICENSE',sha256:digest('inner license\n')}])]}));
    const verified=await verifySourceNotices({project:fixture.project,sourceRoot:fixture.source,family:'nexus',inventory});
    assert.equal(verified.notices[0].bytes.toString(),'inner license\n');
  }finally{fixture.cleanup();}
});

test('reserved legacy notice names cannot be taken over by a manifest',async()=>{
  const fixture=scratch();
  try{
    fixture.module('mod-a');
    const file=fixture.file('mod-a','LICENSE','fixture\n');
    fixture.write(baseNoticeManifest,baseDocument({modules:[linkedModule('mod-a',commit('a'),[file])]}));
    const inventory=[{path:'mod-a',commit:commit('a')}];
    await assert.rejects(verifySourceNotices({project:fixture.project,sourceRoot:fixture.source,family:'nexus',inventory,reservedNames:['mod-a-LICENSE']}),/collides with an existing notice/);
  }finally{fixture.cleanup();}
});

test('a blocked manifest or module aborts assembly unless a local check opts in',async()=>{
  const fixture=scratch();
  try{
    const file=fixture.file('mod-a','LICENSE','fixture\n');
    const inventory=[{path:'mod-a',commit:commit('a')}];
    const request={project:fixture.project,sourceRoot:fixture.source,family:'nexus',inventory};
    const blockedModule={...linkedModule('mod-a',commit('a'),[file]),status:'blocked',blockers:['rights not recorded']};
    fixture.write(baseNoticeManifest,baseDocument({modules:[blockedModule],extra:{status:'blocked',blockers:['inventory incomplete']}}));
    await assert.rejects(verifySourceNotices(request),/blocked for distribution/);
    const allowed=await verifySourceNotices({...request,allowBlocked:true});
    assert.deepEqual(allowed.plan.blockers,['source-notices.json: inventory incomplete','mod-a: rights not recorded']);
    fixture.write(baseNoticeManifest,baseDocument({modules:[linkedModule('mod-a',commit('a'),[file])],extra:{status:'blocked',blockers:['inventory incomplete']}}));
    await assert.rejects(verifySourceNotices(request),/blocked for distribution/);
    // A blocked child under a ready top level is a contradiction and is rejected.
    fixture.write(baseNoticeManifest,baseDocument({modules:[blockedModule]}));
    assert.throws(()=>validateNoticeManifest(JSON.parse(fixture.manifestBytes()),baseNoticeManifest),/a ready manifest must not declare a blocked module/);
    // Ready entries may carry an explicitly empty blocker list, not a non-empty one.
    const readyEmpty={...linkedModule('mod-a',commit('a'),[file]),blockers:[]};
    fixture.write(baseNoticeManifest,baseDocument({modules:[readyEmpty],extra:{blockers:[]}}));
    const verified=await verifySourceNotices(request);
    assert.deepEqual(verified.plan.blockers,[]);
    fixture.write(baseNoticeManifest,baseDocument({modules:[{...readyEmpty,blockers:['stale note']}]}));
    await assert.rejects(verifySourceNotices(request),/a ready entry must not list blockers/);
    fixture.write(baseNoticeManifest,baseDocument({modules:[linkedModule('mod-a',commit('a'),[file])],extra:{blockers:['stale note']}}));
    await assert.rejects(verifySourceNotices(request),/a ready entry must not list blockers/);
  }finally{fixture.cleanup();}
});

test('context files are verified and their archived bytes are required in the source archive',async()=>{
  const fixture=scratch();
  try{
    const notice=fixture.file('mod-a','LICENSE','fixture\n');
    const context=fixture.file('mod-a','test/data/LICENSE.CC-BY-4.0','cc by text\n');
    const module={...linkedModule('mod-a',commit('a'),[notice]),contextFiles:[context]};
    fixture.write(baseNoticeManifest,baseDocument({modules:[module]}));
    const inventory=[{path:'mod-a',commit:commit('a')}];
    const verified=await verifySourceNotices({project:fixture.project,sourceRoot:fixture.source,family:'nexus',inventory});
    assert.equal(verified.contextFiles.length,1);
    assert.equal(verified.notices.length,1);
    const manifestBytes=fixture.manifestBytes();
    const entries=[
      {name:'source/nexus/licenses/source-notices.json',content:manifestBytes},
      {name:'source/mod-a/LICENSE',content:'fixture\n'},
      {name:'source/mod-a/test/data/LICENSE.CC-BY-4.0',content:'cc by text\n'},
    ];
    const archive=buildArchive(fixture.root,entries);
    const listing=tarListing(archive);
    await verifySourceNoticeArchive({project:fixture.project,sourceRoot:fixture.source,family:'nexus',inventory,listing,archive});
    await assert.rejects(verifySourceNoticeArchive({project:fixture.project,sourceRoot:fixture.source,family:'nexus',inventory,listing:listing.filter(name=>!name.includes('CC-BY-4.0')),archive}),/omits declared notice inputs: source\/mod-a\/test\/data\/LICENSE.CC-BY-4.0/);
    await assert.rejects(verifySourceNoticeArchive({project:fixture.project,sourceRoot:fixture.source,family:'nexus',inventory,listing:listing.filter(name=>name!=='source/nexus/licenses/source-notices.json'),archive}),/omits declared notice inputs: source\/nexus\/licenses\/source-notices.json/);
    await assert.rejects(verifySourceNoticeArchive({project:fixture.project,sourceRoot:fixture.source,family:'nexus',inventory,listing,archive:path.join(fixture.root,'missing.tar.xz')}),/archive is missing/);
    await assert.rejects(verifySourceNoticeArchive({project:fixture.project,sourceRoot:fixture.source,family:'nexus',inventory,listing}),/absolute corresponding source archive path is required/);
  }finally{fixture.cleanup();}
});

test('the corresponding source archive is checked for real bytes, entry types and duplicates',async()=>{
  const fixture=scratch();
  try{
    const notice=fixture.file('mod-a','LICENSE','right license\n');
    fixture.write(baseNoticeManifest,baseDocument({modules:[linkedModule('mod-a',commit('a'),[notice])]}));
    const inventory=[{path:'mod-a',commit:commit('a')}];
    const manifestBytes=fixture.manifestBytes();
    const request={project:fixture.project,sourceRoot:fixture.source,family:'nexus',inventory};
    const manifest={name:'source/nexus/licenses/source-notices.json',content:manifestBytes};
    const goodNotice={name:'source/mod-a/LICENSE',content:'right license\n'};
    const good=buildArchive(fixture.root,[manifest,goodNotice]);
    await verifySourceNoticeArchive({...request,listing:tarListing(good),archive:good});
    // Same entry name, wrong notice bytes.
    const wrong=buildArchive(fixture.root,[manifest,{name:'source/mod-a/LICENSE',content:'wrong license\n'}]);
    await assert.rejects(verifySourceNoticeArchive({...request,listing:tarListing(wrong),archive:wrong}),/archived bytes do not match the declared sha256: source\/mod-a\/LICENSE/);
    // A symlink stored under the expected notice name.
    const link=buildArchive(fixture.root,[manifest,{name:'source/mod-a/LICENSE',type:'symlink',link:'/etc/passwd'}]);
    await assert.rejects(verifySourceNoticeArchive({...request,listing:tarListing(link),archive:link}),/not a regular tar entry: source\/mod-a\/LICENSE/);
    // A hardlink entry whose target carries the correct bytes is still not regular.
    const hardlink=buildArchive(fixture.root,[manifest,{name:'source/mod-a/target',content:'right license\n'},{name:'source/mod-a/LICENSE',type:'hardlink',link:'source/mod-a/target'}]);
    await assert.rejects(verifySourceNoticeArchive({...request,listing:tarListing(hardlink),archive:hardlink}),/not a regular tar entry: source\/mod-a\/LICENSE/);
    // A non-directory entry stored for an ancestor of a declared member.
    const ancestor=buildArchive(fixture.root,[manifest,{name:'source/mod-a',type:'symlink',link:'/tmp/elsewhere'},goodNotice]);
    await assert.rejects(verifySourceNoticeArchive({...request,listing:tarListing(ancestor),archive:ancestor}),/non-directory entry for an ancestor of a declared member: source\/mod-a/);
    // The archive itself repeats a declared member even when the caller listing does not.
    const duplicate=buildArchive(fixture.root,[manifest,goodNotice,{name:'source/mod-a/LICENSE',content:'right license\n'}]);
    const dedupedListing=[...new Set(tarListing(duplicate))];
    await assert.rejects(verifySourceNoticeArchive({...request,listing:dedupedListing,archive:duplicate}),/archive repeats a declared member: source\/mod-a\/LICENSE/);
    // Archived manifest that differs from the reviewed manifest bytes.
    const changed=buildArchive(fixture.root,[{name:manifest.name,content:manifestBytes.replace('"ready"','"blocked"')},goodNotice]);
    await assert.rejects(verifySourceNoticeArchive({...request,listing:tarListing(changed),archive:changed}),/archived bytes do not match the declared sha256: source\/nexus\/licenses\/source-notices.json/);
    // A declared member larger than the bounded per-entry limit is refused by size.
    const oversized='a'.repeat(2*1024*1024+1);
    const huge=buildArchive(fixture.root,[{name:'source/mod-a/LICENSE',content:oversized}]);
    const inspected=inspectArchive(huge,[{name:'source/mod-a/LICENSE',sha256:digest(oversized)}]);
    assert.equal(inspected.report.ok,false);
    assert.match(inspected.report.error,/declared member exceeds the 2097152 byte limit/);
  }finally{fixture.cleanup();}
});

test('a notice and a resolved external source sharing one archive member are verified once',async()=>{
  const fixture=scratch();
  try{
    const notice=fixture.file('mod-a','LICENSE','fixture\n');
    const header=fixture.file('mod-a','src/generated.h','header\n');
    const module={...linkedModule('mod-a',commit('a'),[notice,{path:'src/generated.h',sha256:header.sha256}])};
    fixture.write(baseNoticeManifest,baseDocument({modules:[module],externalSources:[{module:'mod-a',path:'src/generated.h',status:'resolved',commit:commit('c'),sha256:header.sha256}]}));
    const request={project:fixture.project,sourceRoot:fixture.source,family:'nexus',inventory:[{path:'mod-a',commit:commit('a')}]};
    const verified=await verifySourceNotices(request);
    assert.equal(verified.notices.length,2);
    const manifestBytes=fixture.manifestBytes();
    const archive=buildArchive(fixture.root,[
      {name:'source/nexus/licenses/source-notices.json',content:manifestBytes},
      {name:'source/mod-a/LICENSE',content:'fixture\n'},
      {name:'source/mod-a/src/generated.h',content:'header\n'},
    ]);
    const listing=tarListing(archive);
    assert.equal(listing.filter(name=>name==='source/mod-a/src/generated.h').length,1,'the archive stores the shared member once');
    await verifySourceNoticeArchive({...request,listing,archive});
    // The same member with different bytes for the two records is refused before the archive check.
    const conflicting={...module,notices:[notice,{path:'src/generated.h',sha256:digest('other\n')}]};
    fixture.write(baseNoticeManifest,baseDocument({modules:[conflicting],externalSources:[{module:'mod-a',path:'src/generated.h',status:'resolved',commit:commit('c'),sha256:header.sha256}]}));
    await assert.rejects(verifySourceNotices(request),/disagree on the bytes of mod-a\/src\/generated\.h/);
  }finally{fixture.cleanup();}
});

test('external build inputs record a provenance gap and block while unresolved',async()=>{
  const fixture=scratch();
  try{
    const notice=fixture.file('mod-a','LICENSE','fixture\n');
    const module=linkedModule('mod-a',commit('a'),[notice]);
    const inventory=[{path:'mod-a',commit:commit('a')}];
    const request={project:fixture.project,sourceRoot:fixture.source,family:'nexus',inventory};
    let published=false;
    // A ready manifest with a ready module is still blocked by an unresolved source.
    fixture.write(baseNoticeManifest,baseDocument({modules:[module],externalSources:[{module:'mod-a',path:'src/generated.h',status:'unresolved',reason:'upstream downloads by tag without a checksum'}]}));
    await assert.rejects(verifySourceNotices(request).then(()=>{published=true;}),/blocked for distribution: mod-a\/src\/generated\.h: upstream downloads by tag/);
    assert.equal(published,false,'no output stage may run while an external source is unresolved');
    const blocked=await verifySourceNotices({...request,allowBlocked:true});
    assert.equal(blocked.externalSources[0].status,'unresolved');
    for(const broken of [
      {module:'mod-a',path:'src/generated.h',status:'unresolved'},
      {module:'mod-a',path:'src/generated.h',status:'unresolved',reason:'gap',sha256:hex('1')},
      {module:'mod-a',path:'src/generated.h',status:'resolved',reason:'gap'},
      {module:'unknown',path:'src/generated.h',status:'unresolved',reason:'gap'},
    ]){
      fixture.write(baseNoticeManifest,baseDocument({modules:[module],externalSources:[broken]}));
      await assert.rejects(verifySourceNotices({...request,allowBlocked:true}),/requires a reason|must not claim|resolved source requires|not a declared module/,JSON.stringify(broken));
    }
    fixture.file('mod-a','src/generated.h','header\n');
    const resolvedSource={module:'mod-a',path:'src/generated.h',status:'resolved',commit:commit('c'),sha256:digest('header\n')};
    fixture.write(baseNoticeManifest,baseDocument({modules:[module],externalSources:[resolvedSource]}));
    const resolved=await verifySourceNotices(request);
    assert.equal(resolved.externalSources[0].status,'resolved');
    const manifestBytes=fixture.manifestBytes();
    const archive=buildArchive(fixture.root,[
      {name:'source/nexus/licenses/source-notices.json',content:manifestBytes},
      {name:'source/mod-a/LICENSE',content:'fixture\n'},
      {name:'source/mod-a/src/generated.h',content:'header\n'},
    ]);
    await verifySourceNoticeArchive({...request,listing:tarListing(archive),archive});
    // A materialized header may also be a notice, but both records need the same bytes.
    const asNotice={...module,notices:[notice,{path:'src/generated.h',sha256:digest('header\n')}]};
    fixture.write(baseNoticeManifest,baseDocument({modules:[asNotice],externalSources:[resolvedSource]}));
    const both=await verifySourceNotices(request);
    assert.equal(both.notices.length,2);
    assert.equal(both.externalSources.length,1);
    const disagreeing={...module,notices:[notice,{path:'src/generated.h',sha256:hex('2')}]};
    fixture.write(baseNoticeManifest,baseDocument({modules:[disagreeing],externalSources:[resolvedSource]}));
    await assert.rejects(verifySourceNotices(request),/disagree on the bytes of mod-a\/src\/generated\.h/);
    // An unresolved source may not also be declared as present.
    fixture.write(baseNoticeManifest,baseDocument({modules:[{...module,notices:[notice,{path:'src/generated.h',sha256:digest('header\n')}]}],externalSources:[{module:'mod-a',path:'src/generated.h',status:'unresolved',reason:'gap'}]}));
    await assert.rejects(verifySourceNotices({...request,allowBlocked:true}),/must not be declared as a notice or context file/);
  }finally{fixture.cleanup();}
});

test('expanded namespaces are detected and require their own variant manifest',async()=>{
  assert.deepEqual(expandedNoticeModules([{path:'mod-a',commit:commit('a')},{path:'extras/d7vk',commit:commit('b')},{path:'vklayers/x',commit:commit('c')}]),['extras/d7vk','vklayers/x']);
  const fixture=scratch();
  try{
    fixture.module('mod-a');
    const file=fixture.file('mod-a','LICENSE','fixture\n');
    fixture.write(baseNoticeManifest,baseDocument({modules:[linkedModule('mod-a',commit('a'),[file])]}));
    const inventory=[{path:'mod-a',commit:commit('a')},{path:'extras/d7vk',commit:commit('b')}];
    await assert.rejects(verifySourceNotices({project:fixture.project,sourceRoot:fixture.source,family:'nexus',inventory}),/Required source notice manifest is missing/);
    const variant=baseDocument({modules:[linkedModule('nvidia-libs/nvenc',commit('d'),[{path:'LICENSE.md',sha256:hex('1')}])],coverage:['nvidia-libs/nvenc'],extra:{family:'nexus-cachyos'}});
    fixture.write(variantNoticeManifest,variant);
    await assert.rejects(verifySourceNotices({project:fixture.project,sourceRoot:fixture.source,family:'nexus',inventory}),/require the nexus notice manifest/);
    const expandedInventory=[...inventory,{path:'nvidia-libs/nvenc',commit:commit('d')}];
    assert.throws(()=>sourceNoticePlan({manifests:[{file:baseNoticeManifest,document:baseDocument({modules:[linkedModule('mod-a',commit('a'),[file])]})},{file:variantNoticeManifest,document:variant}],inventory:expandedInventory}),/not covered by a notice manifest: extras\/d7vk/);
  }finally{fixture.cleanup();}
});

test('the prepared source graph inventory is required and parsed strictly',()=>{
  const graph={submodules:[' '+'a'.repeat(40)+' vkd3d-proton (0bb64c5)',' '+'b'.repeat(40)+' dxvk-nvapi (heads/master)']};
  assert.deepEqual(noticeModuleInventory(graph),[{path:'vkd3d-proton',commit:'a'.repeat(40)},{path:'dxvk-nvapi',commit:'b'.repeat(40)}]);
  assert.throws(()=>noticeModuleInventory({}),/no recursive submodule inventory/);
  assert.throws(()=>noticeModuleInventory({submodules:[]}),/no recursive submodule inventory/);
  assert.throws(()=>noticeModuleInventory({submodules:['+'+'a'.repeat(40)+' vkd3d-proton']}),/Malformed prepared submodule inventory/);
  assert.throws(()=>noticeModuleInventory({submodules:[' '+'a'.repeat(40)+' ../escape']}),/Unsafe prepared submodule path/);
});

test('a selected manifest can be validated alone against a partial input tree',async()=>{
  const fixture=scratch();
  try{
    const file=fixture.file('extras/d7vk','LICENSE','fixture license\n');
    const document={schema:1,kind:'source-notices',family:'nexus-cachyos',status:'ready',coverage:['extras/d7vk'],modules:[linkedModule('extras/d7vk',commit('b'),[file])]};
    const inventory=[{path:'extras/d7vk',commit:commit('b')}];
    const plan=sourceNoticePlan({manifests:[{file:variantNoticeManifest,document}],inventory});
    const verified=await verifyNoticePlan({plan,sourceRoot:fixture.source,allowBlocked:true});
    assert.equal(verified.notices.length,1);
    assert.equal(verified.notices[0].name,'extras-d7vk-LICENSE');
    assert.equal(verified.notices[0].bytes.toString(),'fixture license\n');
    const blocked={...document,status:'blocked',blockers:['rights not recorded'],modules:[{...document.modules[0],status:'blocked',blockers:['rights not recorded']}]};
    const blockedPlan=sourceNoticePlan({manifests:[{file:variantNoticeManifest,document:blocked}],inventory});
    await assert.rejects(verifyNoticePlan({plan:blockedPlan,sourceRoot:fixture.source}),/blocked for distribution/);
    const allowed=await verifyNoticePlan({plan:blockedPlan,sourceRoot:fixture.source,allowBlocked:true});
    assert.equal(allowed.notices.length,1);
  }finally{fixture.cleanup();}
});

test('assembly verifies notices before it creates the output and packaging re-checks the archive',()=>{
  const assembly=fs.readFileSync(path.join(project,'assemble-runtime.mjs'),'utf8');
  assert.ok(assembly.includes('verifySourceNotices({project,sourceRoot:source'));
  assert.ok(assembly.includes('stageSourceNotices(notices,sourceNotices.notices)'));
  assert.ok(assembly.indexOf('await verifySourceNotices(')<assembly.indexOf('await fs.mkdir(output'));
  assert.ok(assembly.indexOf('await verifySourceNotices(')<assembly.indexOf("fs.copyFile(path.join(source,'FEX/LICENSE')"));
  assert.ok(assembly.includes('inventory:noticeModuleInventory(graph)'));
  for(const file of ['package-runtime.mjs','package-runtime-arm64.mjs']){
    const text=fs.readFileSync(path.join(project,'ci',file),'utf8');
    assert.ok(text.includes('verifySourceNoticeArchive({project:built.source'),file);
    assert.ok(text.includes('archive:output+\'/\'+source'),file);
    assert.ok(text.includes('await verifySourceNotices({project:built.source'),file);
    assert.ok(text.indexOf('await verifySourceNotices(')<text.indexOf("tar(['-cJf'"),file+' must preflight before creating artifacts');
  }
});
