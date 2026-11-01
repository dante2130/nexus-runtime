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
import os from 'node:os';
const sdk='registry.gitlab.steamos.cloud/proton/steamrt4/sdk/x86_64@sha256:'+'a'.repeat(64);
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
test('source checks include distribution policies without packaging or full SDK work',()=>{
  const text=fs.readFileSync(path.join(repository,'.github/workflows/nexus-source.yml'),'utf8');
  assert.ok(text.includes('nexus/ci/*.test.mjs'));assert.doesNotMatch(text,/build-fixtures|validate-runtime|package-runtime|cache\/save|upload-artifact/);
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
  assert.ok(validator.includes('wine.results.length!==22'));
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
  assert.ok(validator.includes('wine.results.length!==22'));
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
  }finally{fs.rmSync(root,{recursive:true});}
});
