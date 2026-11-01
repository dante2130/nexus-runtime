// SPDX-License-Identifier: MIT
// Native ARM64 candidate gates on an aarch64 host: exact layout, the shipped
// ARM64 prefix, and the C++ module loaded by aarch64, x86_64 (ARM64EC/FEX) and
// i386 (WoW64/FEX) processes. Synthetic and offline; no game or account.
import fs from 'node:fs/promises';
import {hasCompleteHttpCoverage} from './http-coverage.mjs';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {project,readJson,sourceEnvironment} from '../inputs.mjs';
import {fileHash,treeHash,assertPortable} from './provenance.mjs';
import {peMachine,elfMachine} from '../pe.mjs';
import {targets} from '../target.mjs';
import {prepareValidationTools,validationProcessOutput} from './validation-tools.mjs';
const [outputArg,fixturesArg,validationArg]=process.argv.slice(2);
if(process.argv.length!==5)throw Error('Usage: validate-runtime-arm64.mjs BUILD_OUTPUT FIXTURES NEW_VALIDATION');
if(process.arch!=='arm64')throw Error('ARM64 validation requires a native aarch64 host');
const target=targets.arm64,output=await fs.realpath(outputArg),fixtures=await fs.realpath(fixturesArg),work=path.resolve(validationArg);
const built=await readJson(output+'/built.json'),runtime=await fs.realpath(built.runtime),files=runtime+'/files';
if(path.dirname(runtime)!==output||built.metadata.stableApproved!==false||built.metadata.targetArchitecture!=='arm64')throw Error('Invalid isolated ARM64 runtime');
await fs.mkdir(work,{recursive:false});await fs.chmod(work,0o700);
// The C++ runtime's own test programs, built in the same pinned ARM64 SDK.
const fixtureProof=await readJson(fixtures+'/fixtures.json');
if(fixtureProof.sdk!==built.inputs.sdkArm64||JSON.stringify(fixtureProof.sourceGraph)!==JSON.stringify(built.graph))throw Error('Test fixtures do not match the ARM64 SDK/source graph');
for(const [file,expected]of Object.entries(fixtureProof.hashes))if(await fileHash(fixtures+'/'+file)!==expected)throw Error('Changed test fixture');
for(const name of ['GCC-runtime-copyright','MinGW-runtime-copyright','libxml2-COPYING']){
  const source=project+'/licenses/'+name,file=files+'/share/doc/nexus-runtime/'+name;
  try{await fs.copyFile(source,file,fs.constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST'||await fileHash(file)!==await fileHash(source))throw e;}
}
if(await fileHash(files+'/share/doc/nexus-runtime/FEX-LICENSE')!==await fileHash(built.source+'/FEX/LICENSE'))throw Error('Pinned FEX notice missing or changed');
await assertPortable(runtime);
const proof={schema:1,arch:'arm64',scope:'exact ARM64 runtime, synthetic offline gates only',realGameTest:false,realAccountTest:false,realCloudTest:false,stableApproved:false,graph:built.graph,runtime,builtSha256:await fileHash(output+'/built.json'),treeSha256:await treeHash(runtime),fixtureProofSha256:await fileHash(fixtures+'/fixtures.json'),results:[]};
const engine=files+'/'+target.bin+'/wine';
// Per-entry snapshot so a changed runtime names the paths Wine or FEX touched.
async function entries(root){
  const result=new Map();
  async function visit(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    const file=path.join(directory,entry.name),st=await fs.lstat(file),relative=path.relative(root,file);
    if(entry.isDirectory()){result.set(relative,'d'+(st.mode&0o777));await visit(file);}
    else result.set(relative,entry.isSymbolicLink()?'l'+await fs.readlink(file):'f'+(st.mode&0o777)+':'+await fileHash(file));
  }}
  await visit(root);return result;
}
const before=await entries(runtime);
let passed=false;
async function record(name,result,check,{fatal=true}={}){
  const log=work+'/'+name+'.log',text=(result.stdout||'')+(result.stderr||'')+(result.error?'\nERROR '+result.error.message:'');
  await fs.writeFile(log,text,{flag:'wx',mode:0o600});
  proof.results.push({name,status:result.status,signal:result.signal,error:result.error?.message,log,sha256:await fileHash(log)});
  const ok=result.status===0&&!result.signal&&!result.error&&check(text);
  if(!ok&&fatal)throw Error('ARM64 gate failed: '+name+'; '+log);
  console.log(name+(ok?' PASS':' FAIL'));
  return ok;
}
try{
  // Layout: the launcher shim wraps the aarch64 loader and every PE module is a Wine builtin.
  const layout=[];
  if(elfMachine(await fs.readFile(engine))!=='aarch64'||elfMachine(await fs.readFile(engine+'.nexus-original'))!=='aarch64')throw Error('ARM64 loader is not native');
  layout.push('loader aarch64 shim and original');
  for(const arch of target.peArchitectures){
    const bytes=await fs.readFile(files+'/lib/wine/'+arch+'-windows/xgameruntime.dll');
    if(peMachine(bytes)!==arch||await fileHash(files+'/lib/wine/'+arch+'-windows/xgameruntime.dll')!==built.metadata.componentsByArchitecture[arch]['xgameruntime.dll'])throw Error('Unexpected C++ module: '+arch);
    if(peMachine(await fs.readFile(files+'/lib/wine/'+arch+'-windows/libnghttp2.dll'))!==arch)throw Error('Unexpected nghttp2 module: '+arch);
    layout.push(arch+' xgameruntime.dll and libnghttp2.dll');
  }
  for(const [name,hash]of Object.entries(built.metadata.components))if(await fileHash(files+'/share/'+target.prefix+'/drive_c/windows/system32/'+name)!==hash)throw Error('Prefix component differs: '+name);
  layout.push('default_pfx_arm64 system32 components: '+Object.keys(built.metadata.components).length);
  const byArch=built.metadata.componentsByArch;
  if(Object.keys(byArch||{}).join()!=='aarch64-windows'||JSON.stringify(byArch['aarch64-windows'])!==JSON.stringify(built.metadata.components))throw Error('Launcher component contract differs');
  for(const name of ['xgameruntime.dll','winhttp.dll','libnghttp2.dll','libvkd3d-shader-1.dll','windows.web.dll','twinapi.appcore.dll','d3d8.dll','d3d9.dll','d3d10core.dll','d3d11.dll','dxgi.dll'])if(!byArch['aarch64-windows'][name])throw Error('Launcher component missing: '+name);
  layout.push('launcher contract componentsByArch.aarch64-windows');
  for(const [soname]of Object.entries(JSON.parse(await fs.readFile(project+'/runtime-media.lock.json','utf8')).libraries))if(elfMachine(await fs.readFile(files+'/lib/'+target.unixLibrary+'/'+soname))!=='aarch64')throw Error('Media library is not aarch64: '+soname);
  layout.push('aarch64 media libraries');
  await record('arm64-layout',{status:0,stdout:layout.join('\n')+'\n'},()=>true);
  // Probes are compiled in the same pinned ARM64 SDK that built the runtime.
  const probes=work+'/probes';await fs.mkdir(probes);
  await fs.copyFile(project+'/runtime-tests/arm64-load-probe.c',probes+'/probe.c');
  const containerEngine=process.env.NEXUS_CONTAINER_ENGINE||'docker';
  if(!['docker','podman'].includes(containerEngine))throw Error('Unsupported SDK engine');
  for(const [arch,compiler]of [['aarch64','aarch64-w64-mingw32-gcc'],['x86_64','x86_64-w64-mingw32-gcc'],['i386','i686-w64-mingw32-gcc']]){
    execFileSync(containerEngine,['run','--rm','--network=none',...(containerEngine==='podman'?['--userns=keep-id']:[]),'--user',`${process.getuid()}:${process.getgid()}`,'--mount',`type=bind,src=${probes},dst=/probes`,built.inputs.sdkArm64,compiler,'-O2','-Wall','-Werror','-o','/probes/probe-'+arch+'.exe','/probes/probe.c'],{env:sourceEnvironment(),stdio:'inherit',timeout:600000});
    if(peMachine(await fs.readFile(probes+'/probe-'+arch+'.exe'))!==arch)throw Error('Wrong probe machine: '+arch);
  }
  // Seed a prefix from the shipped ARM64 template as Proton's pfx_copy does:
  // relative links to Wine builtins become absolute, other links stay verbatim.
  const prefix=work+'/pfx',template=files+'/share/'+target.prefix;
  const builtin=/\/lib\/wine\/(?:i386|x86_64|aarch64)-(?:unix|windows)$/;
  async function seed(source,destination){
    await fs.mkdir(destination);
    for(const entry of await fs.readdir(source,{withFileTypes:true})){
      const from=path.join(source,entry.name),to=path.join(destination,entry.name);
      if(entry.isDirectory())await seed(from,to);
      else if(entry.isSymbolicLink()){
        const value=await fs.readlink(from);
        await fs.symlink(builtin.test(path.dirname(value))?path.resolve(source,value):value,to);
      }else await fs.copyFile(from,to,fs.constants.COPYFILE_EXCL);
    }
  }
  await seed(template,prefix);
  // default_pfx.py removes drive links; Proton's setup_prefix recreates them.
  await fs.mkdir(prefix+'/dosdevices',{recursive:true});
  for(const [drive,value]of [['c:','../drive_c'],['z:','/']])try{await fs.symlink(value,prefix+'/dosdevices/'+drive);}catch(e){if(e.code!=='EEXIST')throw e;}
  // FEX creates AppConfig/ under its config location; keep that out of the runtime.
  const fexConfig=work+'/fex-emu';
  await fs.cp(files+'/share/fex-emu',fexConfig,{recursive:true,errorOnExist:true,force:false});
  await fs.mkdir(work+'/home',{mode:0o700});
  const env={...sourceEnvironment(),WINEPREFIX:prefix,WINEDEBUG:'-all',WINEDLLPATH:files+'/lib/vkd3d:'+files+'/lib/wine',WINEDLLOVERRIDES:'winemenubuilder.exe=d;mscoree,mshtml=d',LD_LIBRARY_PATH:files+'/lib/'+target.unixLibrary,FEX_APP_CONFIG_LOCATION:fexConfig+'/',HOME:work+'/home',PATH:files+'/'+target.bin+':'+process.env.PATH};
  const wine=(name,args,check)=>record(name,spawnSync(engine,args,{cwd:probes,env,encoding:'utf8',timeout:900000,maxBuffer:8*1024*1024}),check);
  await wine('arm64-prefix-boot',['wineboot','-u'],()=>true);
  for(const [arch,machine]of [['aarch64','0x0000'],['x86_64','0x0000'],['i386','0x014c']])
    await wine('arm64-load-'+arch,['probe-'+arch+'.exe'],text=>text.includes('MACHINE process='+machine+' native=0xaa64')&&/MODULE C:\\windows\\system32\\xgameruntime\.dll/i.test(text.replace(/syswow64/i,'system32'))&&text.includes('BUILTIN yes')&&text.includes('RESULT PASS'));
  const drain=spawnSync(files+'/'+target.bin+'/wineserver',['-w'],{env,timeout:60000,stdio:'ignore'});
  if(drain.status!==0||drain.error||drain.signal)throw Error('ARM64 prefix failed to drain');
  // The x86_64 validation's C++ runtime gates, unchanged, for both x86 ABIs:
  // win64 runs as ARM64EC and win32 as WoW64, both through FEX, against the
  // candidate's builtin modules (ARM64X for win64), exactly as games load them.
  const cpp=built.source+'/wine/dlls/xgameruntime',scripts=work+'/scripts';await fs.mkdir(scripts);
  const gates=['component','authentication','user-contracts','store'];
  for(const gate of gates){
    const text=(await fs.readFile(cpp+'/scripts/test-'+gate+'.mjs','utf8')).replaceAll('xgameruntime=n','xgameruntime=b').replaceAll("base+'/lib64:'+base+'/lib'","base+'/lib/"+target.unixLibrary+":'+base+'/lib'").replaceAll("path.join(base,'lib64')+':'+path.join(base,'lib')","path.join(base,'lib','"+target.unixLibrary+"')+':'+path.join(base,'lib')");
    await fs.writeFile(scripts+'/test-'+gate+'.mjs',text,{flag:'wx'});
  }
  const tools=await prepareValidationTools(files,work+'/candidate-tools',target.bin);
  const gateEnv={...sourceEnvironment(),PATH:tools+':'+files+'/'+target.bin+':'+process.env.PATH,LD_LIBRARY_PATH:files+'/lib/'+target.unixLibrary+':'+files+'/lib',FEX_APP_CONFIG_LOCATION:fexConfig+'/',HOME:work+'/home',PYTHONDONTWRITEBYTECODE:'1'};
  // Run every C++ gate before failing, so one run reports all of them.
  const failedGates=[];
  for(const [abi,arch]of [['win64','x86_64'],['win32','i386']]){
    const directory=work+'/'+abi,bin=directory+'/bin';await fs.mkdir(bin,{recursive:true});
    for(const name of await fs.readdir(fixtures+'/'+abi+'/bin'))if(name.endsWith('.exe'))await fs.copyFile(fixtures+'/'+abi+'/bin/'+name,bin+'/'+name,fs.constants.COPYFILE_EXCL);
    await fs.copyFile(cpp+'/tests/Nexus/MicrosoftGame.config',bin+'/MicrosoftGame.config',fs.constants.COPYFILE_EXCL);
    // The scripts inventory xgameruntime.dll beside the tests; xgameruntime=b
    // still makes Wine load the candidate's builtin module.
    const dll=files+'/lib/wine/'+arch+'-windows/xgameruntime.dll';
    if(await fileHash(dll)!==built.metadata.componentsByArchitecture[arch]['xgameruntime.dll'])throw Error('Coherent C++ module differs');
    await fs.copyFile(dll,bin+'/xgameruntime.dll',fs.constants.COPYFILE_EXCL);
    for(const gate of gates){
      const r=spawnSync(process.execPath,[scripts+'/test-'+gate+'.mjs',directory,...(gate==='component'?[]:[engine])],{cwd:work,env:gateEnv,encoding:'utf8',timeout:1800000,maxBuffer:16*1024*1024});
      if(!await record(abi+'-'+gate,{status:r.status,signal:r.signal,error:r.error,stdout:validationProcessOutput(r)},()=>true,{fatal:false}))failedGates.push(abi+'-'+gate);
    }
  }
  // The x86_64 validation's HTTP/2, media and graphics suites. The HTTP/2 and
  // DXVK clients stay x86_64 and run as ARM64EC through FEX against the ARM64X
  // winhttp/nghttp2, DXVK and vkd3d-shader; media checks the aarch64 libav.
  for(const [name,script,args]of [['http','run-http2-suite.mjs',[runtime,work]],['media','run-media-suite.mjs',[runtime,work+'/media']],['graphics','run-dxvk-suite.mjs',[runtime,work]]]){
    const r=spawnSync(process.execPath,[project+'/runtime-tests/'+script,'--arch','arm64',...args],{cwd:work,env:gateEnv,encoding:'utf8',timeout:1800000,maxBuffer:16*1024*1024});
    if(!await record('arm64-'+name,{status:r.status,signal:r.signal,error:r.error,stdout:validationProcessOutput(r)},()=>true,{fatal:false}))failedGates.push('arm64-'+name);
    if(name==='http')for(const directory of (await fs.readdir(work)).filter(x=>x.startsWith('runtime-http2-'))){
      const drained=spawnSync(files+'/'+target.bin+'/wineserver',['-w'],{env:{...gateEnv,WINEPREFIX:work+'/'+directory+'/pfx'},timeout:60000,stdio:'ignore'});
      if(drained.status!==0||drained.error||drained.signal)failedGates.push('arm64-http-drain');
    }
  }
  if(failedGates.length)throw Error('ARM64 gates failed: '+failedGates.join(', '));
  // Recheck the x86_64 thresholds independently of each runner's exit status.
  const dirs=await fs.readdir(work),single=async(prefix,name)=>{const d=dirs.filter(x=>x.startsWith(prefix));if(d.length!==1)throw Error('Missing result group: '+prefix);return readJson(work+'/'+d[0]+'/'+name);};
  const http=await single('runtime-http2-','results.json'),graphics=await single('runtime-dxvk-','result.json'),media=await readJson(work+'/media/results.json');
  if(!hasCompleteHttpCoverage(http)||graphics.code!==0||graphics.timeout||!graphics.summary.some(x=>/^DXVK COMPUTE CHECKS 40 FAILURES 0\s*$/.test(x))||!media.h264||!media.aac||!media.bundledLibraries)throw Error('ARM64 HTTP/2, media or graphics coverage incomplete');
  if(await fileHash(output+'/built.json')!==proof.builtSha256||await treeHash(runtime)!==proof.treeSha256){
    const after=await entries(runtime),changed=[...new Set([...before.keys(),...after.keys()])].filter(name=>before.get(name)!==after.get(name)).sort();
    await fs.writeFile(work+'/runtime-changes.log',changed.map(name=>name+' '+(before.get(name)??'-')+' -> '+(after.get(name)??'-')).join('\n')+'\n',{flag:'wx'});
    throw Error('Runtime changed during validation: '+changed.slice(0,20).join(', '));
  }
  passed=true;
}finally{
  proof.passed=passed;await fs.writeFile(work+'/results.json',JSON.stringify(proof,null,2)+'\n',{flag:'wx',mode:0o600});console.log('VALIDATION_RESULT '+work+'/results.json');
}
if(!passed)process.exitCode=1;
