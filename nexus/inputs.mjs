// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export const project=path.dirname(fileURLToPath(import.meta.url));
export const repository=path.dirname(project);
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export const readJson=async file=>JSON.parse(await fs.readFile(file,'utf8'));
export function sourceEnvironment(input=process.env){
    const env={...input,GIT_TERMINAL_PROMPT:'0'};
    for(const key of Object.keys(env))if(/^(?:WINE|WINEDLL|XODUS_|XUSER_|XGAMERUNTIME_|NEXUS_|STEAM_COMPAT_|SteamAppId$|SteamGameId$|LD_LIBRARY_PATH$|LD_PRELOAD$|CPATH$|LIBRARY_PATH$)/.test(key))delete env[key];
    return env;
}
export function run(command,args,cwd,{capture=false,input,timeout=30*60*1000,env=sourceEnvironment()}={}){
    return execFileSync(command,args,{cwd,env,input,encoding:'utf8',stdio:capture?['pipe','pipe','pipe']:input?['pipe','inherit','inherit']:'inherit',timeout,maxBuffer:32*1024*1024});
}
const hash40=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
const hash64=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function validateInputs(inputs){
    if(inputs.schema!==1||inputs.status!=='development'||inputs.channel!=='experimental')throw Error('Only development Experimental inputs are accepted');
    if(!hash64(inputs.verifiedAuxiliaryManifestSha256))throw Error('Missing verified auxiliary manifest pin');
    if(!/^registry\.gitlab\.steamos\.cloud\/proton\/steamrt4\/sdk\/x86_64@sha256:[a-f0-9]{64}$/.test(inputs.sdk))throw Error('SDK must be pinned by digest');
    if(!/^registry\.gitlab\.steamos\.cloud\/proton\/steamrt4\/sdk\/arm64-llvm@sha256:[a-f0-9]{64}$/.test(inputs.sdkArm64))throw Error('ARM64 SDK must be pinned by digest');
    for(const name of ['proton','wine','xgameruntime'])if(!hash40(inputs.upstream?.[name]))throw Error('Unpinned upstream '+name);
    if(Object.keys(inputs.modules||{}).sort().join(',')!=='dxvk,vkd3d,vkd3d-proton')throw Error('Missing graphics source pins');
    for(const value of Object.values(inputs.modules))if(!hash40(value))throw Error('Unpinned graphics source');
    if(inputs.nghttp2?.url!=='https://github.com/nghttp2/nghttp2.git'||!hash40(inputs.nghttp2.commit)||!/^\d+\.\d+\.\d+$/.test(inputs.nghttp2.version))throw Error('Unpinned nghttp2 source');
    if(inputs.shader?.file!=='patches/wine-hlsl-state-keywords.patch'||!hash64(inputs.shader.sha256)||!/^\d+\.\d+$/.test(inputs.shader.version))throw Error('Unpinned shader integration');
    if(!inputs.shader.expectedSources||!Object.keys(inputs.shader.expectedSources).length)throw Error('Missing shader result checksums');
    for(const [name,value]of Object.entries(inputs.shader.expectedSources))if(!/^libs\/vkd3d-shader\/[a-z0-9.-]+$/.test(name)||!hash64(value))throw Error('Unsafe shader result input');
    if(inputs.fex?.file!=='patches/fex-overcommit-release-order.patch'||!hash40(inputs.fex.commit)||![inputs.fex.sha256,inputs.fex.originalSha256,inputs.fex.resultSha256].every(hash64))throw Error('Unpinned FEX source correction');
    const files=inputs.compatibilitySources;
    if(!files||Object.keys(files).length!==7)throw Error('Missing compatibility sources');
    for(const [file,value]of Object.entries(files))if(!/^runtime-compat\/[a-z0-9.-]+$/.test(file)||!hash64(value))throw Error('Unsafe compatibility source');
    for(const value of [inputs.requiresBackendVersion,inputs.requiresLauncherVersion])if(!/^\d+\.\d+\.\d+$/.test(value))throw Error('Missing component version requirement');
}
export async function verifyInputs(){
    const inputs=await readJson(path.join(project,'inputs.lock.json'));
    validateInputs(inputs);
    for(const [file,expected]of Object.entries(inputs.compatibilitySources))if(sha256(await fs.readFile(path.join(project,file)))!==expected)throw Error('Compatibility source mismatch: '+file);
    if(sha256(await fs.readFile(path.join(project,inputs.shader.file)))!==inputs.shader.sha256)throw Error('Shader patch mismatch');
    if(sha256(await fs.readFile(path.join(project,inputs.fex.file)))!==inputs.fex.sha256)throw Error('FEX patch mismatch');
    return {inputs};
}
function git(cwd,args){return run('git',args,cwd,{capture:true}).trim();}
function gitlink(cwd,name){
    const line=git(cwd,['ls-tree','HEAD','--',name]);
    const result=/^160000 commit ([a-f0-9]{40})\t/.exec(line);
    if(!result)throw Error('Missing source gitlink: '+name);
    return result[1];
}
export async function verifySourceGraph({full=false,main=false}={}){
    const {inputs}=await verifyInputs();
    const head=git(repository,['rev-parse','HEAD']);
    if(main&&head!==git(repository,['rev-parse','refs/remotes/origin/main']))throw Error('Distribution builds require the exact origin/main source');
    if(main&&process.env.GITHUB_REF&&process.env.GITHUB_REF!=='refs/heads/main')throw Error('Distribution builds are main-only');
    if(git(repository,['status','--porcelain','--untracked-files=all']))throw Error('Proton source must be clean before preparation');
    const url=git(repository,['config','-f','.gitmodules','--get','submodule.wine.url']);
    if(url!=='https://github.com/domsvoboda/nexus-wine.git')throw Error('Wrong Wine fork');
    const graph={proton:head,wine:gitlink(repository,'wine'),fex:gitlink(repository,'FEX'),modules:{...inputs.modules}};
    if(graph.fex!==inputs.fex.commit)throw Error('FEX source mismatch');
    for(const [name,expected]of Object.entries(inputs.modules))if(gitlink(repository,name)!==expected)throw Error('Graphics source mismatch: '+name);
    if(full){
        const lines=run('git',['submodule','status','--recursive'],repository,{capture:true}).trimEnd().split('\n');
        if(lines.length<20||lines.some(line=>!/^ [a-f0-9]{40} /.test(line)))throw Error('Complete exact recursive submodules are required');
        const wine=path.join(repository,'wine');
        if(git(wine,['rev-parse','HEAD'])!==graph.wine)throw Error('Wine checkout mismatch');
        if(git(wine,['config','-f','.gitmodules','--get','submodule.dlls/xgameruntime.url'])!=='https://github.com/domsvoboda/nexus-xgameruntime.git')throw Error('Wrong C++ runtime fork');
        graph.xgameruntime=gitlink(wine,'dlls/xgameruntime');
        if(git(path.join(wine,'dlls/xgameruntime'),['rev-parse','HEAD'])!==graph.xgameruntime)throw Error('C++ runtime checkout mismatch');
        for(const [directory,base]of [[repository,inputs.upstream.proton],[wine,inputs.upstream.wine],[path.join(wine,'dlls/xgameruntime'),inputs.upstream.xgameruntime]])run('git',['merge-base','--is-ancestor',base,'HEAD'],directory);
        graph.submodules=lines;
    }
    return {inputs,graph};
}
export async function checkout(source,target){
    await fs.mkdir(target,{recursive:false});
    run('git',['init','--quiet'],target);
    run('git',['remote','add','origin',source.url],target);
    run('git',['fetch','--depth','1','--no-tags','origin',source.commit],target);
    run('git',['checkout','--quiet','--detach','FETCH_HEAD'],target);
    if(git(target,['rev-parse','HEAD'])!==source.commit||git(target,['status','--porcelain']))throw Error('Checkout does not match pinned source');
}
