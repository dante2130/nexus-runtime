// SPDX-License-Identifier: MIT
// Focused regression for the auditable source-check plan. It only builds and
// inspects plans; it never executes the full plan or a native fixture.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {
  MODES,SOURCE_ONLY_MARKER,TEST_GROUPS,NATIVE_TEST_FILES,assertTestPath,enumerateTestFiles,
  resolveMode,readEventContext,buildPlan,assertNoUnreviewedCompilers,planSummary,
} from './source-check-plan.mjs';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const modulePath=path.join(repository,'nexus/ci/source-check-plan.mjs');
const workflowPath=path.join(repository,'.github/workflows/nexus-source.yml');

async function independentTestFiles(){
  const files=[];
  for(const group of TEST_GROUPS){
    for(const entry of await fs.readdir(path.join(repository,...group.split('/')),{withFileTypes:true})){
      if(entry.isFile()&&entry.name.endsWith('.test.mjs'))files.push(group+'/'+entry.name);
    }
  }
  return files.sort();
}

async function workflowText(){return fs.readFile(workflowPath,'utf8');}

// Minimal YAML scan: every run entry with an inline or literal block body.
function runBlocks(text){
  const blocks=[];
  let current=null,indent=0;
  for(const line of text.split('\n')){
    const start=/^(\s*)(?:-\s+)?run:\s*(\||.*)$/.exec(line);
    if(start){
      if(current)blocks.push(current.join('\n'));
      indent=start[1].length;
      current=start[2]==='|'?[]:[start[2]];
      continue;
    }
    if(!current)continue;
    if(!line.trim()){current.push('');continue;}
    if(line.length-line.trimStart().length<=indent){blocks.push(current.join('\n'));current=null;continue;}
    current.push(line);
  }
  if(current)blocks.push(current.join('\n'));
  return blocks;
}

test('the default full plan selects every existing test file and omits nothing',async()=>{
  const expected=await independentTestFiles();
  const plan=await buildPlan({mode:'full',root:repository});
  assert.equal(plan.mode,'full');
  assert.deepEqual([...plan.allFiles],expected);
  assert.deepEqual([...plan.selected],expected);
  assert.deepEqual([...plan.omittedNative],[]);
  for(const file of NATIVE_TEST_FILES)assert.ok(plan.selected.includes(file),file);
  assert.deepEqual([...await enumerateTestFiles(repository)],expected);
});

test('explicit source-only mode excludes exactly the three reviewed native fixture files',async()=>{
  const expected=(await independentTestFiles()).filter(file=>!NATIVE_TEST_FILES.includes(file));
  const plan=await buildPlan({mode:'source-only',root:repository});
  assert.deepEqual([...NATIVE_TEST_FILES],[
    'nexus/fex-overcommit.test.mjs',
    'nexus/tests/build-rules.test.mjs',
    'nexus/runtime-compat/staging.test.mjs',
  ]);
  assert.deepEqual([...plan.selected],expected);
  assert.deepEqual([...plan.omittedNative],[...NATIVE_TEST_FILES]);
  for(const file of NATIVE_TEST_FILES){
    assert.ok(plan.allFiles.includes(file),file+' must still be enumerated');
    assert.ok(!plan.selected.includes(file),file+' must not run in source-only mode');
  }
  assert.equal(plan.selected.length,plan.allFiles.length-NATIVE_TEST_FILES.length);
  assert.equal([...plan.allFiles].filter(file=>!plan.selected.includes(file)).length,3);
  for(const file of plan.selected)await fs.access(path.join(repository,...file.split('/')));
});

test('unknown, empty and injected modes are rejected before any test runs',async()=>{
  for(const mode of ['FULL','source-only ','full; echo pwned','source_only','all','',null,undefined]){
    await assert.rejects(buildPlan({mode,root:repository}),/Unsupported source-check mode/);
  }
  for(const mode of ['FULL','full; echo pwned','source_only','']){
    const result=spawnSync(process.execPath,[modulePath,'--mode',mode],{cwd:repository,encoding:'utf8'});
    assert.notEqual(result.status,0,mode);
    assert.match(result.stderr,/Unsupported source-check mode/,mode);
    assert.ok(!result.stdout.includes('Source-check mode: full'),'a rejected mode must not start a full run');
  }
  const usage=spawnSync(process.execPath,[modulePath],{cwd:repository,encoding:'utf8'});
  assert.notEqual(usage.status,0);
  assert.match(usage.stderr,/Usage: source-check-plan\.mjs/);
});

test('a missing reviewed native fixture fails closed instead of silently widening source-only',async()=>{
  const all=await independentTestFiles();
  for(const missing of NATIVE_TEST_FILES){
    const remaining=all.filter(file=>file!==missing);
    for(const mode of ['full','source-only']){
      await assert.rejects(buildPlan({mode,files:remaining,root:repository}),
        new RegExp('stale; missing expected file\\(s\\): '+missing.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
    }
  }
});

test('the plan rejects unstable, foreign or non-test paths',async()=>{
  const all=await independentTestFiles();
  const unsafe=[
    '../nexus/build-policy.test.mjs',
    '/nexus/build-policy.test.mjs',
    'nexus/ci/../build-policy.test.mjs',
    'nexus\\build-policy.test.mjs',
    'nexus//build-policy.test.mjs',
    'nexus/ci/sub/build-policy.test.mjs',
    'nexus/other/build-policy.test.mjs',
    'nexus/build-policy.mjs',
    'nexus/build-policy.test.mjs ',
    ' nexus/build-policy.test.mjs',
  ];
  for(const file of unsafe){
    await assert.rejects(buildPlan({mode:'full',files:[...all,file],root:repository}),
      /Unsafe test path|outside the reviewed source-check groups/,file);
  }
  for(const file of ['nexus/build-policy.test.mjs','nexus/ci/source-check-plan.test.mjs'])assert.equal(assertTestPath(file),file);
});

test('push and pull request markers keep the existing exact [source-only] semantics',()=>{
  assert.equal(SOURCE_ONLY_MARKER,'[source-only]');
  const marked='nexus: dependency pins\n\n[source-only]\n';
  assert.equal(resolveMode({eventName:'push',headCommitMessage:marked}),'source-only');
  assert.equal(resolveMode({eventName:'push',headCommitMessage:'nexus: dependency pins'}),'full');
  assert.equal(resolveMode({eventName:'pull_request',pullRequestTitle:'nexus: [source-only] dependency pins'}),'source-only');
  assert.equal(resolveMode({eventName:'pull_request',pullRequestTitle:'nexus: dependency pins'}),'full');
  // A push reads only its HEAD commit message; a pull request reads only its title.
  assert.equal(resolveMode({eventName:'push',headCommitMessage:'plain',pullRequestTitle:marked}),'full');
  assert.equal(resolveMode({eventName:'pull_request',pullRequestTitle:'plain',headCommitMessage:marked}),'full');
  // Missing or unknown event values fail closed to the normal full plan.
  assert.equal(resolveMode(),'full');
  assert.equal(resolveMode({}),'full');
  assert.equal(resolveMode({eventName:'push'}),'full');
  assert.equal(resolveMode({eventName:'pull_request'}),'full');
  assert.equal(resolveMode({eventName:'workflow_dispatch',headCommitMessage:marked,pullRequestTitle:marked}),'full');
  assert.equal(resolveMode({eventName:'push',headCommitMessage:'[Source-Only]'}),'full');
  // Resolution depends only on the event type and marker, not on the branch.
  for(const ref of ['refs/heads/main','refs/heads/develop','refs/heads/feature/example','refs/heads/fix/example'])
    assert.equal(resolveMode({eventName:'push',headCommitMessage:marked,ref}),'source-only');
  for(const base of ['main','develop'])
    assert.equal(resolveMode({eventName:'pull_request',pullRequestTitle:'nexus: [source-only] pins',base}),'source-only');
});

test('GITHUB_EVENT_PATH is parsed safely and any missing context stays full',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-source-check-event-'));
  const write=async(name,value)=>{
    const file=path.join(root,name);
    await fs.writeFile(file,typeof value==='string'?value:JSON.stringify(value));
    return file;
  };
  try{
    const markedPush=await write('push.json',{head_commit:{message:'nexus: pins\n\n[source-only]'}});
    assert.equal(resolveMode(await readEventContext({eventName:'push',eventPath:markedPush})),'source-only');
    const plainPush=await write('plain-push.json',{head_commit:{message:'nexus: pins'}});
    assert.equal(resolveMode(await readEventContext({eventName:'push',eventPath:plainPush})),'full');
    const markedPr=await write('pr.json',{pull_request:{title:'nexus: [source-only] pins'}});
    assert.equal(resolveMode(await readEventContext({eventName:'pull_request',eventPath:markedPr})),'source-only');
    const plainPr=await write('plain-pr.json',{pull_request:{title:'nexus: pins'}});
    assert.equal(resolveMode(await readEventContext({eventName:'pull_request',eventPath:plainPr})),'full');
    // A push never reads the pull request title and a PR never reads a commit message.
    const mixedPush=await write('mixed-push.json',{head_commit:{message:'plain'},pull_request:{title:'[source-only]'}});
    assert.equal(resolveMode(await readEventContext({eventName:'push',eventPath:mixedPush})),'full');
    const mixedPr=await write('mixed-pr.json',{head_commit:{message:'[source-only]'},pull_request:{title:'plain'}});
    assert.equal(resolveMode(await readEventContext({eventName:'pull_request',eventPath:mixedPr})),'full');
    // Missing, unreadable, invalid or wrongly typed context falls back to full.
    for(const context of [
      await readEventContext({eventName:'push',eventPath:path.join(root,'absent.json')}),
      await readEventContext({eventName:'push',eventPath:''}),
      await readEventContext({eventName:'push',eventPath:await write('invalid.json','{not json')}),
      await readEventContext({eventName:'push',eventPath:await write('array.json',['[source-only]'])}),
      await readEventContext({eventName:'push',eventPath:await write('object.json',{head_commit:{message:['[source-only]']}})}),
      await readEventContext({eventName:'push',eventPath:await write('nested.json',{head_commit:null,pull_request:null})}),
      await readEventContext({eventName:'workflow_dispatch',eventPath:markedPush}),
      await readEventContext({eventName:'',eventPath:markedPush}),
    ])assert.equal(resolveMode(context),'full');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('untrusted event text never reaches the shell or the mode output',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-source-check-mode-'));
  const canary=path.join(root,'injected');
  const exists=async()=>fs.stat(canary).then(()=>true,()=>false);
  const write=async(name,value)=>{const file=path.join(root,name);await fs.writeFile(file,JSON.stringify(value));return file;};
  const detect=(eventName,eventPath)=>{
    const env={...process.env,GITHUB_EVENT_NAME:eventName};
    if(eventPath===undefined)delete env.GITHUB_EVENT_PATH;
    else env.GITHUB_EVENT_PATH=eventPath;
    return spawnSync(process.execPath,[modulePath,'--detect-mode'],{cwd:repository,encoding:'utf8',env});
  };
  try{
    const hostile=`fix: source\n$(touch ${canary}) \`touch ${canary}\` [source-only] ; touch ${canary}\n`;
    const pushFile=await write('push.json',{head_commit:{message:hostile}});
    const push=detect('push',pushFile);
    assert.equal(push.status,0,push.stderr);
    assert.equal(push.stdout,'mode=source-only\n');
    assert.match(push.stdout,/^mode=(?:full|source-only)\n$/,'the output stays inside the allowlist');
    assert.equal(await exists(),false);
    assert.ok(!push.stderr.includes('touch'),'the untrusted message must not be echoed');
    assert.ok(!push.stdout.includes('touch'));
    const plainFile=await write('plain.json',{head_commit:{message:'$(touch '+canary+')'}});
    const plain=detect('push',plainFile);
    assert.equal(plain.status,0,plain.stderr);
    assert.equal(plain.stdout,'mode=full\n');
    assert.equal(await exists(),false);
    const titleFile=await write('title.json',{pull_request:{title:'$(touch '+canary+') [source-only]'}});
    const title=detect('pull_request',titleFile);
    assert.equal(title.status,0,title.stderr);
    assert.equal(title.stdout,'mode=source-only\n');
    assert.equal(await exists(),false);
    // Missing context and an unexpected event name keep the full plan.
    const missing=detect('pull_request',undefined);
    assert.equal(missing.status,0,missing.stderr);
    assert.equal(missing.stdout,'mode=full\n');
    const unknown=detect('workflow_dispatch',titleFile);
    assert.equal(unknown.status,0,unknown.stderr);
    assert.equal(unknown.stdout,'mode=full\n');
    const invalid=detect('push',await (async()=>{const file=path.join(root,'invalid.json');await fs.writeFile(file,'{');return file;})());
    assert.equal(invalid.status,0,invalid.stderr);
    assert.equal(invalid.stdout,'mode=full\n');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('source-only refuses unreviewed compiler invocations and reports omissions honestly',async()=>{
  const plan=await buildPlan({mode:'source-only',root:repository});
  await assertNoUnreviewedCompilers(plan.selected,repository);
  const lines=planSummary(plan);
  const text=lines.join('\n');
  assert.match(text,/Source-check mode: source-only/);
  for(const file of NATIVE_TEST_FILES)assert.ok(text.includes('omitted '+file),file);
  assert.match(text,/NOT run, NOT passed, no native coverage/);
  const full=planSummary(await buildPlan({mode:'full',root:repository})).join('\n');
  assert.ok(!full.includes('omitted '));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-source-check-compiler-'));
  try{
    await fs.mkdir(path.join(root,'nexus/ci'),{recursive:true});
    const fixture=path.join(root,'nexus/ci/future.test.mjs');
    const command=['execFile','Sync'].join(''); // keep this source file free of the literal pattern
    await fs.writeFile(fixture,command+'('+JSON.stringify('c++')+',[]);\n');
    await assert.rejects(assertNoUnreviewedCompilers(['nexus/ci/future.test.mjs'],root),/unreviewed compiler/);
    await fs.writeFile(fixture,'assert.ok('+JSON.stringify('cmake --build')+'.length);\n');
    await assertNoUnreviewedCompilers(['nexus/ci/future.test.mjs'],root);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('the workflow keeps full checks by default and gates only explicit source-only runs',async()=>{
  const workflow=await workflowText();
  assert.deepEqual(MODES,['full','source-only']);
  assert.match(workflow,/branches: \[main, develop, 'feature\/\*\*', 'fix\/\*\*'\]/);
  assert.match(workflow,/pull_request:\n    branches: \[main, develop\]/);
  assert.ok(!workflow.includes('[skip ci]')&&!workflow.includes('[skip-ci]'),'no skip-ci bypass');
  // The source-only mode is available for push to main/develop and PRs to both.
  const pushBlock=workflow.slice(workflow.indexOf('  push:'),workflow.indexOf('  pull_request:'));
  const prBlock=workflow.slice(workflow.indexOf('  pull_request:'),workflow.indexOf('permissions:'));
  for(const name of ['main','develop'])assert.ok(pushBlock.includes(name)&&prBlock.includes(name),'trigger keeps '+name);
  // Event payloads enter only through GITHUB_EVENT_PATH. The workflow must not
  // interpolate any event field and must emit only the allowlisted mode output.
  assert.ok(!workflow.includes('${{ github.event'),'event payloads must not be interpolated');
  assert.ok(!/SOURCE_CHECK_(?:EVENT|COMMIT_MESSAGE|PULL_REQUEST_TITLE)/.test(workflow),'no event text in env');
  assert.match(workflow,/node nexus\/ci\/source-check-plan\.mjs --detect-mode >> "\$GITHUB_OUTPUT"/);
  assert.match(workflow,/id: mode/);
  assert.match(workflow,/if: steps\.mode\.outputs\.mode == 'full'/);
  assert.match(workflow,/if: steps\.mode\.outputs\.mode == 'source-only'/);
  assert.ok(!workflow.includes('env.SOURCE_CHECK_MODE'),'install gates must use the step output');
  assert.match(workflow,/SOURCE_CHECK_MODE: \$\{\{ steps\.mode\.outputs\.mode \}\}/);
  assert.match(workflow,/node nexus\/check-source\.mjs/);
  assert.match(workflow,/node nexus\/ci\/source-check-plan\.mjs --mode "\$SOURCE_CHECK_MODE"/);
  assert.ok(!/node --test nexus\/\*\.test\.mjs/.test(workflow),'the raw test glob must be replaced by the audited plan runner');
  assert.match(workflow,/git diff --check/);
  assert.match(workflow,/actionlint_1\.7\.12_linux_amd64\.tar\.gz/);
  assert.match(workflow,/actionlint" -shellcheck= -pyflakes= \.github\/workflows\/nexus-source\.yml/);
  // The mode step is not branch-gated, so source-only holds on every trigger.
  const modeStep=workflow.slice(workflow.indexOf('Select source-check mode'),workflow.indexOf('--detect-mode'));
  assert.ok(!modeStep.includes('if:')&&!modeStep.includes('github.ref'),'mode selection must not be branch-gated');
  // No run body may interpolate expressions or pass through event text.
  const blocks=runBlocks(workflow);
  assert.ok(blocks.length>=5,blocks.join('\n---\n'));
  for(const block of blocks){
    assert.ok(!block.includes('${{'),'run body must not interpolate expressions: '+block);
    assert.ok(!block.includes('SOURCE_CHECK_COMMIT_MESSAGE')&&!block.includes('SOURCE_CHECK_PULL_REQUEST_TITLE'));
  }
  const full=workflow.slice(workflow.indexOf("if: steps.mode.outputs.mode == 'full'"),workflow.indexOf("if: steps.mode.outputs.mode == 'source-only'"));
  for(const name of ['python3','zstd','cmake','make','rsync','gcc','g++','gcc-mingw-w64-x86-64','g++-mingw-w64-x86-64','gcc-mingw-w64-i686','g++-mingw-w64-i686'])
    assert.ok(full.includes(name),'full install keeps '+name);
  const sourceOnly=workflow.slice(workflow.indexOf("if: steps.mode.outputs.mode == 'source-only'"),workflow.indexOf('node nexus/check-source.mjs'));
  assert.match(sourceOnly,/install -y --no-install-recommends python3 make/);
  for(const name of ['zstd','cmake','rsync','gcc','g++','mingw'])
    assert.ok(!sourceOnly.includes(name),'source-only install must not install '+name);
});

test('candidate workflows keep their main-only and source-only guards unchanged',async()=>{
  const inputs=JSON.parse(await fs.readFile(path.join(repository,'nexus/inputs.lock.json'),'utf8'));
  const cachy=Boolean(inputs.variant);
  for(const name of ['nexus-runtime.yml','nexus-runtime-arm64.yml']){
    const text=await fs.readFile(path.join(repository,'.github/workflows',name),'utf8');
    const guards=text.split('\n').filter(line=>/^    if: /.test(line));
    assert.equal(guards.length,3,name+' must keep exactly the three job-level guards');
    for(const guard of guards){
      assert.match(guard,/github\.ref == 'refs\/heads\/main'/,name);
      assert.match(guard,/!contains\(github\.event\.head_commit\.message, '\[source-only\]'\)/,name);
    }
    if(cachy&&name==='nexus-runtime-arm64.yml')
      for(const guard of guards)assert.match(guard,/github\.repository == 'domsvoboda\/nexus-runtime'/);
  }
  const workflow=await workflowText();
  if(cachy){
    assert.match(workflow,/fetch-depth: 0/);
    assert.match(workflow,/id: xgr-pin/);
    assert.match(workflow,/node nexus\/ci\/xgr-source-pin\.mjs/);
    assert.match(workflow,/path: pinned-xgr-source/);
    assert.match(workflow,/EXPECTED_XGR_COMMIT: \$\{\{ steps\.xgr-pin\.outputs\.commit \}\}/);
    assert.match(workflow,/scripts\/test-source-only\.test\.mjs/);
  }else{
    assert.ok(!workflow.includes('xgr-pin'),'the Standard tree has no pinned XGR checkout step');
  }
});
