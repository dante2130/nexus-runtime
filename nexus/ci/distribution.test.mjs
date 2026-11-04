// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {project,repository} from '../inputs.mjs';
import {cachePlan} from './cache-plan.mjs';
import {validateGateResults} from './provenance.mjs';
import {sourceArchiveArgs} from './source-archive.mjs';
import {TEST_GROUPS,NATIVE_TEST_FILES,buildPlan} from './source-check-plan.mjs';
import os from 'node:os';
import crypto from 'node:crypto';
const sdk='registry.gitlab.steamos.cloud/proton/steamrt4/sdk/x86_64@sha256:'+'a'.repeat(64);
const sha256Bytes=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
// Run the exact production streamed inspector over the real archive bytes instead
// of trusting a member-name listing.
function inspectSourceArchive(archive,expected){
  const request={archive,expected:expected.map(([name,bytes])=>({name,sha256:sha256Bytes(bytes)}))};
  return spawnSync('python3',['-I',path.join(project,'ci','inspect-source-archive.py')],{input:JSON.stringify(request),encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
}
function writeArchiveFixture(root,entries){
  for(const [relative,bytes]of Object.entries(entries)){const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);}
}
test('cache is bounded and namespace depends on immutable SDK, not source revision',()=>{
  const a=cachePlan(sdk,'1'.repeat(40)),b=cachePlan(sdk,'2'.repeat(40)),c=cachePlan(sdk.replace(/a$/,'b'),'1'.repeat(40));
  assert.equal(a.namespace,b.namespace);assert.notEqual(a.key,b.key);assert.equal(a.restorePrefix,b.restorePrefix);assert.notEqual(a.restorePrefix,c.restorePrefix);assert.equal(a.maxSize,'3G');assert.equal(a.compilerCheck,'content');
  assert.throws(()=>cachePlan('latest','1'.repeat(40)));assert.throws(()=>cachePlan(sdk,'main'));
});
test('full candidate workflow is main-only, read-only and cannot promote',()=>{
  const text=fs.readFileSync(path.join(repository,'.github/workflows/nexus-runtime.yml'),'utf8');
  assert.match(text,/branches: \[main\]/);assert.equal((text.match(/if: github\.ref == 'refs\/heads\/main'/g)||[]).length,3);
  assert.doesNotMatch(text,/pull_request|contents: write|gh release|APPROVE_RELEASE|\.ssh|\.config/);
  for(const command of ['build-runtime.mjs','build-fixtures.mjs','validate-runtime.mjs','package-runtime.mjs'])assert.ok(text.includes(command));
  assert.match(text,/actions\/cache\/restore@v4/);assert.match(text,/actions\/cache\/save@v4/);assert.match(text,/!cancelled\(\)/);assert.match(text,/CCACHE_MAXSIZE: 3G/);assert.match(text,/CCACHE_COMPILERCHECK: content/);
  assert.match(text,/runs-on: ubuntu-22\.04/);assert.match(text,/xvfb-run -a node nexus\/ci\/validate-runtime/);
});
test('source checks run the audited four-group plan with full native coverage and no packaging or full SDK work',async()=>{
  const text=fs.readFileSync(path.join(repository,'.github/workflows/nexus-source.yml'),'utf8');
  // The audited plan runner is the only test entry point. The old literal glob
  // must not return and no packaging or full SDK command may be added.
  assert.match(text,/node nexus\/ci\/source-check-plan\.mjs --mode "\$SOURCE_CHECK_MODE"/);
  assert.ok(!text.includes('nexus/ci/*.test.mjs'));
  assert.ok(!/node --test nexus\/\*\.test\.mjs/.test(text));
  assert.doesNotMatch(text,/build-fixtures|validate-runtime|package-runtime|cache\/save|upload-artifact/);
  // The plan still enumerates all four reviewed groups, including this ci
  // directory, in both modes so distribution policy tests keep running.
  assert.deepEqual([...TEST_GROUPS],['nexus','nexus/tests','nexus/ci','nexus/runtime-compat']);
  const full=await buildPlan({mode:'full'}),sourceOnly=await buildPlan({mode:'source-only'});
  for(const group of TEST_GROUPS)assert.ok(full.selected.some(file=>file.startsWith(group+'/')),'full plan enumerates '+group);
  assert.ok(full.selected.includes('nexus/ci/distribution.test.mjs'));
  assert.ok(sourceOnly.selected.includes('nexus/ci/distribution.test.mjs'));
  // Full mode preserves every native fixture; source-only omits exactly those.
  assert.equal(full.selected.length,full.allFiles.length);
  for(const file of NATIVE_TEST_FILES)assert.ok(full.selected.includes(file),'full plan retains '+file);
  assert.deepEqual([...sourceOnly.omittedNative],[...NATIVE_TEST_FILES]);
  for(const file of NATIVE_TEST_FILES)assert.ok(!sourceOnly.selected.includes(file));
  assert.equal(sourceOnly.selected.length,full.selected.length-NATIVE_TEST_FILES.length);
});
test('Ubuntu 24 validation installs and checks i386 crypto and fonts before compiling',()=>{
  const text=fs.readFileSync(path.join(repository,'.github/workflows/nexus-runtime.yml'),'utf8');
  const runtime=text.slice(text.indexOf('  runtime:'));
  assert.match(runtime,/runs-on: ubuntu-24\.04/);
  assert.ok(runtime.indexOf('dpkg --add-architecture i386')<runtime.indexOf('Acquire::https::Timeout=30 update'));
  assert.match(runtime,/libgnutls30t64:i386 libfreetype6:i386/);
  assert.ok(runtime.indexOf('libgnutls30t64:i386')<runtime.indexOf('validation-dependencies.mjs'));
  assert.ok(runtime.indexOf('validation-dependencies.mjs')<runtime.indexOf('Build coherent pinned SDK runtime'));
});
test('runner paths are initialized in a step, never in the restricted job-level environment',()=>{
  const text=fs.readFileSync(path.join(repository,'.github/workflows/nexus-runtime.yml'),'utf8');
  const runtime=text.slice(text.indexOf('  runtime:'));
  const jobEnv=runtime.slice(runtime.indexOf('    env:'),runtime.indexOf('    steps:',runtime.indexOf('    env:')));
  assert.doesNotMatch(jobEnv,/runner\./);
  assert.match(text,/CCACHE_DIR=%s\/nexus-ccache/);assert.match(text,/CARGO_HOME=%s\/nexus-cargo/);
  const checks=fs.readFileSync(path.join(repository,'.github/workflows/nexus-source.yml'),'utf8');
  assert.match(checks,/actionlint\/releases\/download\/v1\.7\.12/);
  assert.match(checks,/8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8/);
});
test('SDK fixture compilation uses real matching Wine and a private writable cache',()=>{
  const text=fs.readFileSync(project+'/ci/build-fixtures.mjs','utf8');
  assert.match(text,/src=\$\{built\.runtime\},dst=\/engine,readonly/);
  assert.match(text,/-DWINE_EXECUTABLE=\/engine\/files\/'\+bin\+'\/wine/);
  // x86_64 candidates keep files/bin and their own SDK; ARM64 uses its pinned SDK.
  assert.match(text,/sdk=arm64\?built\.inputs\.sdkArm64:built\.inputs\.sdk,hostTools=arm64\?'aarch64':'x86_64',bin=arm64\?'bin-arm64':'bin'/);
  assert.match(text,/-DCMAKE_CXX_FLAGS=-O2/);
  assert.match(text,/CCACHE_DIR=\/fixtures\/compiler-cache/);
  assert.match(text,/CCACHE_MAXSIZE=128M/);
  assert.match(text,/--network=none/);
  assert.doesNotMatch(text,/WINE_EXECUTABLE=\/bin\/(?:true|false)|ENABLE_TESTS=OFF/);
  assert.doesNotMatch(text,/-DNDEBUG|-fno-rtti|allow-multiple-definition|CMAKE_BUILD_TYPE=Release/);
});
test('evidence uploads cannot recursively follow prefix Z drive links',()=>{
  const text=fs.readFileSync(path.join(repository,'.github/workflows/nexus-runtime.yml'),'utf8');
  const evidence=text.slice(text.indexOf('name: Retain synthetic test evidence'));
  assert.doesNotMatch(evidence,/\*\*|pfx|dosdevices/);
  assert.match(evidence,/nexus-validation\/win64\/nexus-\*\/\*\.json/);
  assert.match(evidence,/nexus-validation\/win32\/nexus-\*\/\*\.log/);
});
test('the PlayFab folder contract exercises the exact candidate proxy without changing fixtures',()=>{
  const text=fs.readFileSync(project+'/ci/wine-contracts.mjs','utf8');
  assert.match(text,/proxy=files\+'\/share\/xodus-nexus\/compat\/PlayFabGameSave.dll'/);
  assert.match(text,/fileHash\(proxy\)!==await fileHash\(folder\+'\/PlayFabGameSave.dll'\)/);
  assert.match(text,/execute\('playfab-folder',folder\+/);
});
test('both ABI crypto probes are compiled, executed and required in native validation',()=>{
  const fixture=fs.readFileSync(project+'/ci/build-fixtures.mjs','utf8');
  const contracts=fs.readFileSync(project+'/ci/wine-contracts.mjs','utf8');
  const validator=fs.readFileSync(project+'/ci/validate-runtime.mjs','utf8');
  const probe=fs.readFileSync(project+'/runtime-tests/crypto-probe.c','utf8');
  assert.ok(fixture.includes("for(const bits of [64,32])compile('crypto-'+bits+'-probe.exe','crypto-probe.c',['-Wextra','-Werror','-lncrypt','-lbcrypt'],bits)"));
  assert.ok(contracts.includes("await execute('crypto-'+bits,tests+'/crypto-'+bits+'-probe.exe',[],{},40)"));
  assert.ok(validator.includes('wine.results.length!==28'));
  for(const name of ['NCryptCreatePersistedKey','NCryptSignHash','NCryptVerifySignature','BCryptSignHash','BCryptVerifySignature','BCRYPT_ECDSA_P521_ALGORITHM','BCRYPT_RSA_ALGORITHM'])
    assert.ok(probe.includes(name),name);
  assert.doesNotMatch(probe,/todo_wine|win_skip|XUser|XGameSave|XODUS/);
});
test('both ABI PackageId lifetimes and packaged/unpackaged results are mandatory',()=>{
  const fixture=fs.readFileSync(project+'/ci/build-fixtures.mjs','utf8');
  const contracts=fs.readFileSync(project+'/ci/wine-contracts.mjs','utf8');
  const validator=fs.readFileSync(project+'/ci/validate-runtime.mjs','utf8');
  const probe=fs.readFileSync(project+'/runtime-tests/package-id-probe.c','utf8');
  assert.ok(fixture.includes("compile('package-id-'+bits+'-probe.exe','package-id-probe.c'"));
  assert.ok(fixture.includes("obj+'/dlls/kernelbase/'+arch+'-windows/libkernelbase.a'"));
  assert.ok(contracts.includes("await execute('package-id-'+bits,tests+'/package-id-'+bits+'-probe.exe')"));
  for(const text of [contracts,validator])assert.ok(text.includes('[2478,6,24]'));
  assert.ok(validator.includes("r.name==='package-id-'+bits"));
  for(const api of ['IPackageStatics_get_Current','IPackage_get_Id','IPackageId_get_Name','APPMODEL_ERROR_NO_PACKAGE','CreateThread','IPackageId_Release'])assert.ok(probe.includes(api),api);
  assert.doesNotMatch(probe,/todo_wine|win_skip|XUser|XGameSave/);
});
test('both ABI ApplicationData cache, identity and negative folder checks are mandatory',()=>{
  const fixture=fs.readFileSync(project+'/ci/build-fixtures.mjs','utf8');
  const contracts=fs.readFileSync(project+'/ci/wine-contracts.mjs','utf8');
  const validator=fs.readFileSync(project+'/ci/validate-runtime.mjs','utf8');
  const probe=fs.readFileSync(project+'/runtime-tests/applicationdata-probe.c','utf8');
  assert.ok(fixture.includes("compile('applicationdata-'+bits+'-probe.exe','applicationdata-probe.c'"));
  assert.ok(contracts.includes("await execute('applicationdata-'+bits,tests+'/applicationdata-'+bits+'-probe.exe')"));
  for(const text of [contracts,validator])assert.ok(text.includes('[45,7,25]'));
  assert.ok(validator.includes('wine.results.length!==28'));
  for(const api of ['IApplicationData2_get_LocalCacheFolder','IApplicationData_get_LocalFolder','GetCurrentPackageFamilyName','ERROR_DIRECTORY','APPMODEL_ERROR_NO_PACKAGE','first==second','IStorageItem_get_DateCreated'])assert.ok(probe.includes(api),api);
  assert.doesNotMatch(probe,/todo_wine|win_skip|XUser|XGameSave/);
});
test('packaging rejects all non-main and untrusted contexts before accessing a candidate',()=>{
  for(const ref of ['refs/heads/develop','refs/pull/1/merge','refs/tags/test']){
    const r=spawnSync(process.execPath,[project+'/ci/package-runtime.mjs','/missing','/missing'],{env:{...process.env,GITHUB_REF:ref,GITHUB_REPOSITORY:'domsvoboda/nexus-runtime',GITHUB_SHA:'a'.repeat(40),GITHUB_RUN_ID:'123'},encoding:'utf8'});
    assert.notEqual(r.status,0);assert.match(r.stderr,/Packaging requires an exact main/);
  }
});
test('all twelve native gate identities must pass in exact order without omissions',()=>{
  const names=['win64-component','win64-authentication','win64-user-contracts','win64-store','win32-component','win32-authentication','win32-user-contracts','win32-store','wine-native-contracts','http','media','graphics'];
  const values=names.map(name=>({name,status:0,signal:null,sha256:'a'.repeat(64)}));validateGateResults(values);
  assert.throws(()=>validateGateResults(values.slice(1)));
  for(const change of [{status:1},{signal:'SIGTERM'},{error:'timeout'},{name:'win64-component'},{sha256:'invalid'}]){
    const altered=structuredClone(values);Object.assign(altered[5],change);assert.throws(()=>validateGateResults(altered));
  }
});
test('actual source archive preserves nested source and gitlinks, never credentials or binary downloads',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-source-archive-'));
  try{
    const source=root+'/source-input',aux=root+'/aux',work=root+'/work',archive=root+'/source.tar.xz';
    const entries={'source-input/.git/config':'synthetic credential placeholder','source-input/.gitmodules':'public gitlink urls','source-input/contrib/download.zip':'binary download','source-input/wine/.git/config':'nested git metadata','source-input/wine/dlls/xgameruntime/CMakeLists.txt':'cmake source','source-input/nexus/licenses/GCC-runtime-copyright':'license','aux/nghttp2-src/COPYING':'nghttp2 license','aux/auxiliary.json':'{}','aux/media/ffmpeg-4.4.8.tar.xz':'pinned source archive','aux/media/media-manifest.json':'{}','work/prepared.json':'{}','work/runtime-dependency-sources/manifest.json':'{}','work/runtime-dependency-sources/codec.orig.tar.xz':'corresponding SDK codec source'};
    for(const [relative,bytes]of Object.entries(entries)){const file=root+'/'+relative;fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);}
    const packed=spawnSync('tar',sourceArchiveArgs(archive,source,aux,work,'4.4.8'),{encoding:'utf8'});assert.equal(packed.status,0,packed.stderr);
    const list=spawnSync('tar',['-tJf',archive],{encoding:'utf8'});assert.equal(list.status,0,list.stderr);
    const names=list.stdout.trim().split('\n');
    for(const name of ['source/.gitmodules','source/wine/dlls/xgameruntime/CMakeLists.txt','source/nexus/licenses/GCC-runtime-copyright','nghttp2-src/COPYING','media/ffmpeg-4.4.8.tar.xz','prepared.json'])assert.ok(names.includes(name),name);
    for(const name of ['runtime-dependency-sources/manifest.json','runtime-dependency-sources/codec.orig.tar.xz'])assert.ok(names.includes(name),name);
    assert.ok(!names.some(n=>n.split('/').includes('.git')||n.includes('download.zip')));
    assert.equal(names[0],'source/','the archive root entry must be source/');
    assert.ok(!names.includes('.')&&!names.includes('./'),'the archive must not contain a root dot member');
    assert.ok(!names.some(n=>n.replace(/\/+$/,'').split('/').some(part=>!part||part==='.'||part==='..')),'archive members must be safe');
    const inspected=inspectSourceArchive(archive,[['source/.gitmodules','public gitlink urls'],['source/wine/dlls/xgameruntime/CMakeLists.txt','cmake source'],['source/nexus/licenses/GCC-runtime-copyright','license']]);
    assert.equal(inspected.status,0,inspected.stdout+inspected.stderr);
    assert.deepEqual(JSON.parse(inspected.stdout),{ok:true,members:3,bytes:38});
  }finally{fs.rmSync(root,{recursive:true});}
});
test('legacy source archive recipe is rejected for its root dot entry and the actual recipe passes',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-source-archive-legacy-'));
  try{
    writeArchiveFixture(root,{'source-input/.gitmodules':'public gitlink urls','source-input/wine/dlls/xgameruntime/CMakeLists.txt':'cmake source','aux/nghttp2-src/COPYING':'nghttp2 license','aux/auxiliary.json':'{}','aux/media/ffmpeg-4.4.8.tar.xz':'pinned source archive','aux/media/media-manifest.json':'{}','work/prepared.json':'{}','work/runtime-dependency-sources/manifest.json':'{}'});
    const source=root+'/source-input',aux=root+'/aux',work=root+'/work';
    const actual=sourceArchiveArgs(root+'/actual.tar.xz',source,aux,work,'4.4.8');
    const rootTransform='--transform=flags=rh;s,^\\.$,source,';
    assert.equal(actual.filter(arg=>arg===rootTransform).length,1,'the producer must emit exactly one exact-root transform');
    const legacy=actual.filter(arg=>arg!==rootTransform).map(arg=>arg===root+'/actual.tar.xz'?root+'/legacy.tar.xz':arg);
    assert.equal(legacy.length,actual.length-1);
    const legacyPack=spawnSync('tar',legacy,{encoding:'utf8'});assert.equal(legacyPack.status,0,legacyPack.stderr);
    const legacyList=spawnSync('tar',['-tJf',root+'/legacy.tar.xz'],{encoding:'utf8'});assert.equal(legacyList.status,0,legacyList.stderr);
    assert.equal(legacyList.stdout.trim().split('\n')[0],'./','the legacy recipe keeps the root dot entry');
    const expected=[['source/.gitmodules','public gitlink urls'],['source/wine/dlls/xgameruntime/CMakeLists.txt','cmake source']];
    const legacyInspect=inspectSourceArchive(root+'/legacy.tar.xz',expected);
    assert.notEqual(legacyInspect.status,0,'the legacy archive must fail the strict inspector');
    assert.match(legacyInspect.stdout,/unsafe member name in archive: \./);
    const actualPack=spawnSync('tar',actual,{encoding:'utf8'});assert.equal(actualPack.status,0,actualPack.stderr);
    const actualInspect=inspectSourceArchive(root+'/actual.tar.xz',expected);
    assert.equal(actualInspect.status,0,actualInspect.stdout+actualInspect.stderr);
  }finally{fs.rmSync(root,{recursive:true});}
});
test('source archive keeps symbolic link targets while transforming member and hardlink names',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-source-links-'));
  try{
    writeArchiveFixture(root,{'source-input/tuning/run.sh':'run script','source-input/outside.txt':'outside','source-input/hard-source':'hardlink payload','source-input/.git/config':'synthetic credential placeholder','source-input/wine/.git/config':'nested git metadata','source-input/contrib/download.zip':'binary download','aux/nghttp2-src/COPYING':'nghttp2 license','aux/auxiliary.json':'{}','aux/media/ffmpeg-4.4.8.tar.xz':'pinned source archive','aux/media/media-manifest.json':'{}','work/prepared.json':'{}','work/runtime-dependency-sources/manifest.json':'{}'});
    const source=root+'/source-input',aux=root+'/aux',work=root+'/work';
    fs.linkSync(source+'/hard-source',source+'/hard-link');
    fs.symlinkSync('./tuning/run.sh',source+'/link-dotrel');
    fs.symlinkSync('../outside.txt',source+'/link-parent');
    fs.symlinkSync('../../outside.txt',source+'/link-up');
    fs.symlinkSync('.',source+'/link-dot');
    fs.symlinkSync('./',source+'/link-dotslash');
    const actual=sourceArchiveArgs(root+'/actual.tar.xz',source,aux,work,'4.4.8');
    assert.equal(actual.filter(arg=>arg.startsWith('--transform=flags=rh;')).length,2,'both transforms must be scoped to member and hardlink names');
    assert.ok(!actual.some(arg=>arg.startsWith('--transform=')&&!arg.startsWith('--transform=flags=rh;')),'no default-scope transform may remain');
    const pack=spawnSync('tar',actual,{encoding:'utf8'});assert.equal(pack.status,0,pack.stderr);
    const list=spawnSync('tar',['-tJf',root+'/actual.tar.xz'],{encoding:'utf8'});assert.equal(list.status,0,list.stderr);
    const names=list.stdout.trim().split('\n');
    assert.equal(names[0],'source/','the archive root entry must be source/');
    assert.ok(!names.some(n=>n.replace(/\/+$/,'').split('/').some(part=>!part||part==='.'||part==='..')),'archive members must be safe');
    assert.ok(!names.some(n=>n.split('/').includes('.git')||n.includes('download.zip')),'existing .git and contrib exclusions must remain');
    for(const name of ['source/tuning/run.sh','source/outside.txt','source/link-dotrel','source/link-parent','source/link-up','source/link-dot','source/link-dotslash','source/hard-source'])assert.ok(names.includes(name),name);
    const verbose=spawnSync('tar',['-tvJf',root+'/actual.tar.xz'],{encoding:'utf8'});assert.equal(verbose.status,0,verbose.stderr);
    const hardlinks=verbose.stdout.split('\n').filter(line=>line.startsWith('h'));
    assert.equal(hardlinks.length,1,'exactly one hardlink record expected');
    assert.match(hardlinks[0],/ link to source\/hard-(source|link)$/,'the hardlink target must use the transformed member name');
    const extract=root+'/extract';fs.mkdirSync(extract);
    const untar=spawnSync('tar',['-xJf',root+'/actual.tar.xz','-C',extract],{encoding:'utf8'});assert.equal(untar.status,0,untar.stderr);
    assert.equal(fs.readlinkSync(extract+'/source/link-dotrel'),'./tuning/run.sh','a ./ relative target must stay byte-identical');
    assert.equal(fs.readlinkSync(extract+'/source/link-parent'),'../outside.txt','a ../ relative target must stay byte-identical');
    assert.equal(fs.readlinkSync(extract+'/source/link-up'),'../../outside.txt');
    assert.equal(fs.readlinkSync(extract+'/source/link-dot'),'.');
    assert.equal(fs.readlinkSync(extract+'/source/link-dotslash'),'./');
    assert.equal(fs.readFileSync(extract+'/source/tuning/run.sh','utf8'),'run script');
    assert.equal(fs.readFileSync(extract+'/source/hard-source','utf8'),'hardlink payload');
    assert.equal(fs.readFileSync(extract+'/source/hard-link','utf8'),'hardlink payload');
    assert.equal(fs.statSync(extract+'/source/hard-source').ino,fs.statSync(extract+'/source/hard-link').ino,'extracted hardlinks must share the inode');
    const inspected=inspectSourceArchive(root+'/actual.tar.xz',[['source/tuning/run.sh','run script'],['source/outside.txt','outside']]);
    assert.equal(inspected.status,0,inspected.stdout+inspected.stderr);
    const legacy=actual.map(arg=>arg.startsWith('--transform=flags=rh;')?arg.replace('flags=rh;',''):arg).map(arg=>arg===root+'/actual.tar.xz'?root+'/legacy.tar.xz':arg);
    assert.equal(legacy.length,actual.length);
    const legacyPack=spawnSync('tar',legacy,{encoding:'utf8'});assert.equal(legacyPack.status,0,legacyPack.stderr);
    const legacyExtract=root+'/legacy-extract';fs.mkdirSync(legacyExtract);
    const legacyUntar=spawnSync('tar',['-xJf',root+'/legacy.tar.xz','-C',legacyExtract],{encoding:'utf8'});assert.equal(legacyUntar.status,0,legacyUntar.stderr);
    assert.equal(fs.readlinkSync(legacyExtract+'/source/link-dotrel'),'source/tuning/run.sh','the legacy scope must reproduce the target rewrite');
    assert.equal(fs.readlinkSync(legacyExtract+'/source/link-dot'),'source','the legacy scope also rewrites a dot target');
    assert.equal(fs.readlinkSync(legacyExtract+'/source/link-dotslash'),'source/');
    assert.equal(fs.readlinkSync(legacyExtract+'/source/link-parent'),'../outside.txt');
  }finally{fs.rmSync(root,{recursive:true});}
});
test('strict source archive inspector rejects unsafe members and non-regular declared entries',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-source-archive-controls-'));
  try{
    const expected=[['source/nexus/licenses/GCC-runtime-copyright','license']];
    fs.mkdirSync(path.join(root,'escape'),{recursive:true});
    fs.writeFileSync(path.join(root,'escape','escape.txt'),'escape');
    const unsafeArchive=root+'/unsafe.tar.xz';
    const unsafePack=spawnSync('tar',['--transform=s,^escape/,../,','-cJf',unsafeArchive,'-C',root,'escape/escape.txt'],{encoding:'utf8'});
    assert.equal(unsafePack.status,0,unsafePack.stderr);
    const unsafe=inspectSourceArchive(unsafeArchive,expected);
    assert.notEqual(unsafe.status,0,'an unsafe archive member must be rejected');
    assert.match(unsafe.stdout,/unsafe member name in archive: \.\.\/escape\.txt/);
    fs.mkdirSync(path.join(root,'link'),{recursive:true});
    fs.symlinkSync('../missing-target',path.join(root,'link','LICENSE'));
    const linkArchive=root+'/link.tar.xz';
    const linkPack=spawnSync('tar',['--transform=s,^link/LICENSE$,source/nexus/licenses/GCC-runtime-copyright,','-cJf',linkArchive,'-C',root,'link/LICENSE'],{encoding:'utf8'});
    assert.equal(linkPack.status,0,linkPack.stderr);
    const link=inspectSourceArchive(linkArchive,expected);
    assert.notEqual(link.status,0,'a symlink declared as a source member must be rejected');
    assert.match(link.stdout,/declared member is not a regular tar entry: source\/nexus\/licenses\/GCC-runtime-copyright/);
  }finally{fs.rmSync(root,{recursive:true});}
});

test('pending shutdown is checked in both ABIs without weakening existing native gates',()=>{
  const fixture=fs.readFileSync(project+'/ci/build-fixtures.mjs','utf8');
  const runner=fs.readFileSync(project+'/ci/wine-contracts.mjs','utf8');
  const validator=fs.readFileSync(project+'/ci/validate-runtime.mjs','utf8');
  assert.ok(fixture.includes("for(const bits of [64,32])compile('pending-shutdown-'+bits+'-probe.exe'"));
  assert.ok(runner.includes("execute('pending-shutdown-'+bits,tests+'/pending-shutdown-'+bits+'-probe.exe',[],{},113)"));
  assert.ok(validator.includes("r.name==='pending-shutdown-'+bits&&r.checks.length===1&&r.checks[0]>=113"));
});
