// SPDX-License-Identifier: MIT
// Auditable test plan for the Nexus Proton source-check job.
// The normal plan runs every existing test file, including the native build
// fixtures. Only an explicit [source-only] push commit message or pull request
// title selects the noncompiling plan, which omits the reviewed native fixture
// files and reports them as not run and not passed.
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export const MODES=Object.freeze(['full','source-only']);
export const SOURCE_ONLY_MARKER='[source-only]';
export const TEST_GROUPS=Object.freeze(['nexus','nexus/tests','nexus/ci','nexus/runtime-compat']);
// Reviewed test files that compile C/C++ with a real compiler or the MinGW
// toolchain. Adding a compiling fixture requires an explicit review and a new
// entry here; the source-only plan fails closed while an entry is missing.
export const NATIVE_TEST_FILES=Object.freeze([
  'nexus/fex-overcommit.test.mjs',
  'nexus/tests/build-rules.test.mjs',
  'nexus/runtime-compat/staging.test.mjs',
]);
const TEST_NAME=/^[a-z0-9._-]+\.test\.mjs$/;
const COMPILER_INVOCATION=/(?:execFileSync|execFile|spawnSync|spawn)\(\s*['"](?:cc|c\+\+|gcc|g\+\+|clang|clang\+\+|cmake|ninja|x86_64-w64-mingw32-gcc|x86_64-w64-mingw32-g\+\+|i686-w64-mingw32-gcc|i686-w64-mingw32-g\+\+)['"]/;
const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');

// Repository-relative POSIX paths only, flat inside the four reviewed groups.
export function assertTestPath(relative){
  if(typeof relative!=='string'||!relative.length)throw Error('Unsafe test path: '+String(relative));
  if(relative!==relative.trim()||relative.includes('\\')||relative.includes('..')||path.posix.isAbsolute(relative))
    throw Error('Unsafe test path: '+relative);
  const separator=relative.lastIndexOf('/');
  const directory=separator<0?'':relative.slice(0,separator),name=relative.slice(separator+1);
  if(!TEST_GROUPS.includes(directory)||!TEST_NAME.test(name))
    throw Error('Test path is outside the reviewed source-check groups: '+relative);
  return relative;
}

export async function enumerateTestFiles(root=repository){
  const found=[];
  for(const group of TEST_GROUPS){
    const directory=path.join(root,...group.split('/'));
    let entries;
    try{entries=await fs.readdir(directory,{withFileTypes:true});}
    catch(error){throw Error('Missing source-check group directory '+group+': '+error.message);}
    for(const entry of entries){
      if(!entry.name.endsWith('.test.mjs'))continue;
      if(entry.isSymbolicLink())throw Error('Source-check test must be a regular file: '+group+'/'+entry.name);
      if(entry.isFile())found.push(assertTestPath(group+'/'+entry.name));
    }
  }
  const files=Object.freeze([...new Set(found)].sort());
  if(!files.length)throw Error('No source-check test files were found');
  return files;
}

// Mirrors the existing workflow convention exactly: a push reads only the
// pushed HEAD commit message, a pull request reads only its title. Any other
// event or a missing value keeps the normal full plan.
export function resolveMode({eventName,headCommitMessage,pullRequestTitle}={}){
  const marked=value=>typeof value==='string'&&value.includes(SOURCE_ONLY_MARKER);
  if(eventName==='push')return marked(headCommitMessage)?'source-only':'full';
  if(eventName==='pull_request')return marked(pullRequestTitle)?'source-only':'full';
  return 'full';
}

// Reads the runner-provided event payload from GITHUB_EVENT_PATH without any
// shell interpolation. A missing, unreadable or malformed context resolves to
// the normal full plan, so only an explicit marker can select source-only mode.
export async function readEventContext({eventName=process.env.GITHUB_EVENT_NAME,eventPath=process.env.GITHUB_EVENT_PATH}={}){
  const name=typeof eventName==='string'?eventName:'';
  if(name!=='push'&&name!=='pull_request')return {eventName:'other'};
  let payload;
  try{
    if(typeof eventPath!=='string'||!eventPath)throw Error('Missing GITHUB_EVENT_PATH');
    payload=JSON.parse(await fs.readFile(eventPath,'utf8'));
  }catch(error){return {eventName:name};}
  if(!payload||typeof payload!=='object'||Array.isArray(payload))return {eventName:name};
  return {
    eventName:name,
    headCommitMessage:payload.head_commit&&typeof payload.head_commit.message==='string'?payload.head_commit.message:undefined,
    pullRequestTitle:payload.pull_request&&typeof payload.pull_request.title==='string'?payload.pull_request.title:undefined,
  };
}

export async function buildPlan({mode,files,root=repository}={}){
  if(!MODES.includes(mode))throw Error('Unsupported source-check mode: '+String(mode));
  const available=Object.freeze(files?[...files]:await enumerateTestFiles(root));
  const allFiles=Object.freeze([...new Set(available.map(assertTestPath))].sort());
  if(!allFiles.length)throw Error('No source-check test files were found');
  const missing=NATIVE_TEST_FILES.filter(file=>!allFiles.includes(file));
  if(missing.length)throw Error('Native source-check plan is stale; missing expected file(s): '+missing.join(', '));
  const omittedNative=mode==='source-only'?NATIVE_TEST_FILES:Object.freeze([]);
  const selected=Object.freeze(allFiles.filter(file=>!omittedNative.includes(file)));
  return Object.freeze({mode,groups:TEST_GROUPS,allFiles,selected,omittedNative,nativeTestFiles:NATIVE_TEST_FILES});
}

// Second guard for a future compiling fixture whose author forgot the plan
// list. It only detects direct compiler invocations, not a make target that
// compiles, so the reviewed NATIVE_TEST_FILES list remains authoritative.
export async function assertNoUnreviewedCompilers(files,root=repository){
  const offenders=[];
  for(const file of files){
    const text=await fs.readFile(path.join(root,...assertTestPath(file).split('/')),'utf8');
    if(COMPILER_INVOCATION.test(text))offenders.push(file);
  }
  if(offenders.length)throw Error('Source-only selection contains unreviewed compiler invocations: '+offenders.join(', '));
}

export function planSummary(plan){
  const lines=[`Source-check mode: ${plan.mode}`,`Existing test files: ${plan.allFiles.length}`,`Selected test files: ${plan.selected.length}`];
  for(const file of plan.selected)lines.push(`  selected ${file}`);
  if(plan.mode==='source-only'){
    lines.push('Native fixture tests omitted (NOT run, NOT passed, no native coverage):');
    for(const file of plan.omittedNative)lines.push(`  omitted ${file}`);
    lines.push('This run only checks noncompiling source contracts. Native fixture and candidate validation remain unverified.');
  }else{
    lines.push('Full plan: all existing test files, including native build fixtures, are selected.');
  }
  return lines;
}

async function writeSummary(markdown){
  if(!process.env.GITHUB_STEP_SUMMARY)return;
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,markdown.endsWith('\n')?markdown:markdown+'\n');
}

async function main(argv){
  if(argv.length===1&&argv[0]==='--detect-mode'){
    const context=await readEventContext();
    const mode=resolveMode(context);
    if(!MODES.includes(mode))throw Error('Refusing to emit an unsupported source-check mode');
    // Only an allowlisted literal reaches stdout, so the workflow can append
    // it to GITHUB_OUTPUT without ever interpolating untrusted event text.
    process.stdout.write(`mode=${mode}\n`);
    process.stderr.write(`Source-check mode selected from the CI event (${context.eventName==='push'||context.eventName==='pull_request'?context.eventName:'other'}): ${mode}\n`);
    await writeSummary(`Source-check mode selected from the CI event: ${mode}\n`);
    return 0;
  }
  if(argv.length===2&&argv[0]==='--mode'){
    const plan=await buildPlan({mode:argv[1]});
    if(plan.mode==='source-only')await assertNoUnreviewedCompilers(plan.selected);
    const summary=planSummary(plan);
    for(const line of summary)console.log(line);
    await writeSummary(summary.join('\n')+'\n');
    const result=spawnSync(process.execPath,['--test',...plan.selected],{cwd:repository,stdio:'inherit'});
    if(result.error)throw result.error;
    return result.status??1;
  }
  throw Error('Usage: source-check-plan.mjs --detect-mode | --mode full|source-only');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{process.exitCode=await main(process.argv.slice(2));}
  catch(error){console.error('::error::'+error.message);process.exitCode=1;}
}
