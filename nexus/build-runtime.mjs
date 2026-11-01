// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import {project,repository,run,readJson,sha256,verifyInputs,verifySourceGraph} from './inputs.mjs';
import {verifyAuxiliary} from './auxiliary.mjs';
import {sdkConfigureArgs,sdkContainerOption,sdkBuildJobs,sdkBuildPlan,verifySdkResumeMakefile} from './sdk-build-plan.mjs';
import {assembleRuntime} from './assemble-runtime.mjs';
import {requireShaderVersion} from './shader-version.mjs';
import {targetArgument} from './target.mjs';
import {llvmMingwPin} from './llvm-mingw.mjs';
import {prepareFexSource,verifyPreparedFex} from './fex-source.mjs';
import {collectRuntimeDependencySources} from './runtime-dependency-sources.mjs';
if(process.env.GITHUB_REF&&process.env.GITHUB_REF!=='refs/heads/main')throw Error('Distribution builds are main-only');
const {target,args}=targetArgument(process.argv.slice(2));
const [auxArg,workArg,outputArg,resumeArg]=args;
if(!auxArg||!workArg||!outputArg||args.length>4||resumeArg&&resumeArg!=='--resume')throw Error('Usage: build-runtime.mjs [--arch x86_64|arm64] AUXILIARY NEW_WORK NEW_OUTPUT [--resume]');
const aux=await fs.realpath(auxArg),work=path.resolve(workArg),output=path.resolve(outputArg),resume=resumeArg==='--resume';
const {inputs}=await verifyInputs(),lockHash=sha256(await fs.readFile(path.join(project,'inputs.lock.json'))),sdk=inputs[target.sdk];
const verifiedAux=await verifyAuxiliary(aux,inputs,target),auxiliary=verifiedAux.manifest;
if(target.name==='arm64'&&llvmMingwPin().sha256!==auxiliary.toolchain.sha256)throw Error('Auxiliary toolchain differs from the workflow pin');
const engine=sdkContainerOption(process.env.NEXUS_CONTAINER_ENGINE).split('=')[1],jobs=sdkBuildJobs(process.env.NEXUS_BUILD_JOBS);
const source=repository,wine=path.join(source,'wine'),shader=path.join(source,'vkd3d'),fex=path.join(source,'FEX');
const stateFile=path.join(work,'prepared.json'),build=path.join(work,'sdk-build');
let graph,name,epoch;
if(!resume){
  ({graph}=await verifySourceGraph({full:true,main:true}));
  await fs.mkdir(work,{recursive:false});
  name='nexus-runtime-11.0-experimental'+target.suffix+'-g'+graph.proton.slice(0,8);
  epoch=run('git',['log','-1','--format=%ct'],source,{capture:true}).trim();
  const configure=await fs.readFile(path.join(shader,'configure.ac'),'utf8');
  requireShaderVersion(configure,inputs.shader.version);
  run('git',['apply','--check',path.join(project,inputs.shader.file)],shader);
  run('git',['apply',path.join(project,inputs.shader.file)],shader);
  await prepareFexSource(fex,inputs.fex);
  await fs.mkdir(path.join(wine,'include/nghttp2'));
  for(const header of Object.keys(auxiliary.headers))await fs.copyFile(path.join(aux,'components/nghttp2',header),path.join(wine,'include/nghttp2',header),fs.constants.COPYFILE_EXCL);
  await fs.mkdir(build);
  run(path.join(source,'configure.sh'),sdkConfigureArgs({name,engine,sdk,arch:target.name}),build);
  await fs.writeFile(stateFile,JSON.stringify({schema:1,graph,name,epoch,engine,arch:target.name,source,inputsSha256:lockHash,...verifiedAux},null,2)+'\n',{flag:'wx'});
}else{
  const state=await readJson(stateFile);
  ({graph,name,epoch}=state);
  if(state.schema!==1||state.source!==source||state.engine!==engine||(state.arch??'x86_64')!==target.name||state.inputsSha256!==lockHash||state.manifestSha256!==verifiedAux.manifestSha256||state.mediaSha256!==verifiedAux.mediaSha256)throw Error('Resume input mismatch');
  if(run('git',['rev-parse','HEAD'],source,{capture:true}).trim()!==graph.proton||run('git',['rev-parse','refs/remotes/origin/main'],source,{capture:true}).trim()!==graph.proton)throw Error('Resume requires the exact selected main source');
  verifySdkResumeMakefile(await fs.readFile(path.join(build,'Makefile'),'utf8'),{source,name,sdk,engine,arch:target.name});
}
// Reject edits even on resume. Only the exact checksum-verified shader/FEX
// patches and nghttp2 headers may differ from the pinned source graph.
for(const [directory,expected]of [[source,graph.proton],[wine,graph.wine],[path.join(wine,'dlls/xgameruntime'),graph.xgameruntime]]){
  if(run('git',['rev-parse','HEAD'],directory,{capture:true}).trim()!==expected||run('git',['diff','--ignore-submodules=all','HEAD'],directory,{capture:true}).trim())throw Error('Prepared fork source changed');
}
for(const [module,expected]of Object.entries(graph.modules))if(run('git',['rev-parse','HEAD'],path.join(source,module),{capture:true}).trim()!==expected)throw Error('Prepared graphics source changed');
for(const entry of graph.submodules){
  const match=/^ ([a-f0-9]{40}) (\S+)/.exec(entry);
  if(!match)throw Error('Malformed prepared source graph');
  const directory=path.join(source,match[2]);
  if(run('git',['rev-parse','HEAD'],directory,{capture:true}).trim()!==match[1])throw Error('Prepared dependency checkout changed: '+match[2]);
  if(!['vkd3d','FEX'].includes(match[2])&&run('git',['diff','--ignore-submodules=all','HEAD'],directory,{capture:true}).trim())throw Error('Prepared dependency source changed: '+match[2]);
}
await verifyPreparedFex(fex,inputs.fex);
const changed=run('git',['diff','--name-only','HEAD'],shader,{capture:true}).trim().split('\n').filter(Boolean).sort();
if(changed.join(',')!==Object.keys(inputs.shader.expectedSources).sort().join(','))throw Error('Unexpected shader changes');
for(const [file,expected]of Object.entries(inputs.shader.expectedSources))if(sha256(await fs.readFile(path.join(shader,file)))!==expected)throw Error('Shader source checksum mismatch');
for(const [file,expected]of Object.entries(auxiliary.headers))if(sha256(await fs.readFile(path.join(wine,'include/nghttp2',file)))!==expected)throw Error('Prepared HTTP header mismatch');
try{await fs.lstat(output);throw Error('Output already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
const redist=path.join(build,'redist-'+graph.proton.slice(0,8));
for(const stage of sdkBuildPlan(build,epoch,jobs,redist,target.hostTools)){console.log(stage.name);run('make',stage.args,build,{timeout:stage.timeout});}
await collectRuntimeDependencySources(path.join(redist,'files'),work);
await verifyAuxiliary(aux,inputs,target);
await assembleRuntime({work,build,redist,source,wine,aux,output,name,inputs,graph,auxiliary,lockHash,target});
