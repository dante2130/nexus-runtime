// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {sourceEnvironment} from '../inputs.mjs';
import {runAppmodelAliases} from '../runtime-tests/run-appmodel-alias-controls.mjs';
import {fileHash} from './provenance.mjs';
const [runtimeArg,testsArg,parentArg]=process.argv.slice(2);
if(process.argv.length!==5)throw Error('RUNTIME FIXTURES PRIVATE_PARENT required');
const runtime=await fs.realpath(runtimeArg),tests=await fs.realpath(testsArg),parent=await fs.realpath(parentArg);
for(const name of ['wine','wine64','wineserver','wineserver64','xodus-cli','xodus-service']){
  try{execFileSync('pgrep',['-x',name],{stdio:'ignore'});throw Error('Another Wine/account operation is active');}catch(e){if(e.status!==1)throw e;}
}
const root=await fs.mkdtemp(path.join(parent,'wine-contract-'));await fs.chmod(root,0o700);
const prefix=root+'/pfx',files=runtime+'/files',engine=files+'/bin/wine',server=files+'/bin/wineserver';
const env={...sourceEnvironment(),WINEPREFIX:prefix,WINEARCH:'win64',WINEDEBUG:'-all,err+all',LD_LIBRARY_PATH:files+'/lib/x86_64-linux-gnu:'+files+'/lib/i386-linux-gnu:'+files+'/lib',WINEDLLPATH:files+'/lib/vkd3d:'+files+'/lib/wine',WINEDLLOVERRIDES:'winemenubuilder.exe=d;mscoree,mshtml=d;xgameruntime=b;winhttp=b;libnghttp2=n',PYTHONDONTWRITEBYTECODE:'1'};
const binaries={};for(const arch of ['x86_64','i386'])for(const name of ['xgameruntime.dll','concrt140.dll','kernelbase.dll'])binaries[arch+'/'+name]=await fileHash(files+'/lib/wine/'+arch+'-windows/'+name);
let passed=false;const results=[];
async function execute(name,exe,args=[],overrides={},minimum=1){
  const r=spawnSync(engine,[exe,...args],{cwd:root,env:{...env,...overrides},encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
  const output=(r.stdout||'')+(r.stderr||'');await fs.writeFile(root+'/'+name+'.log',output,{flag:'wx',mode:0o600});
  const summaries=[...output.matchAll(/(?:^|\n)CHECKS (\d+) FAILURES (\d+)/g),...output.matchAll(/(?:^|\n)CHECKS (?:appstate|appstate-source|appconstrained|appconstrained-source|appmodel-(?:32|64)) checks=(\d+) failures=(\d+)/g),...output.matchAll(/(?:^|\n)(?:PACKAGE_ID|APPDATA_CACHE) checks=(\d+) failures=(\d+)/g)];
  const packageComplete=!name.startsWith('package-id-')||(summaries.length===3&&summaries.every((m,i)=>+m[1]>=[2478,6,24][i]));
  const dataComplete=!name.startsWith('applicationdata-')||(summaries.length===3&&summaries.every((m,i)=>+m[1]>=[45,7,25][i]));
  const ok=r.status===0&&!r.error&&!r.signal&&packageComplete&&dataComplete&&summaries.length>0&&summaries.every(m=>+m[1]>=minimum&&+m[2]===0)&&!/^FAIL /m.test(output);
  results.push({name,status:r.status,signal:r.signal,checks:summaries.map(x=>+x[1]),passed:ok});
  if(!ok)throw Error('Native contract failed: '+name+'; '+root);
  console.log(name+' PASS');
}
try{
  const boot=spawnSync(engine,['wineboot','--init'],{env,encoding:'utf8',timeout:60000});
  await fs.writeFile(root+'/boot.log',(boot.stdout||'')+(boot.stderr||''),{flag:'wx',mode:0o600});
  if(boot.status!==0||boot.signal||boot.error)throw Error('Synthetic Wine initialization failed');
  for(const [name,min]of [['appstate',191215],['appstate-source',191231],['appconstrained',191215],['appconstrained-source',191231],['hlsl-state-keywords',320],['winrt-json',9]])await execute(name,tests+'/'+name+'-probe.exe',[],{},min);
  for(const [kind,min]of [['vector',22209],['queue',201483],['yield',1014]])for(const bits of [64,32])await execute('concrt-'+kind+'-'+bits,tests+'/concrt-'+kind+'-'+bits+'-probe.exe',[],{},min);
  for(const bits of [64,32]){
    await execute('pending-shutdown-'+bits,tests+'/pending-shutdown-'+bits+'-probe.exe',[],{},113);
    await execute('crypto-'+bits,tests+'/crypto-'+bits+'-probe.exe',[],{},40);
    await execute('appmodel-'+bits,tests+'/appmodel-'+bits+'-probe.exe',[],{},42);
    await execute('package-id-'+bits,tests+'/package-id-'+bits+'-probe.exe');
    await execute('applicationdata-'+bits,tests+'/applicationdata-'+bits+'-probe.exe');
    const run=async(exe,args,timeout=60000,overrides={})=>{const r=spawnSync(exe,args,{cwd:root,env:{...env,...overrides},encoding:'utf8',timeout,maxBuffer:1024*1024});return {code:r.status,timedOut:!!r.error||!!r.signal,output:(r.stdout||'')+(r.stderr||'')};};
    const aliases=await runAppmodelAliases({wine:engine,tests,root,bits,run});
    await fs.writeFile(root+'/appmodel-'+bits+'-aliases.log',aliases.output,{flag:'wx',mode:0o600});
    if(aliases.code||aliases.timedOut)throw Error('Package alias controls failed');
  }
  const folder=root+'/playfab-folder';await fs.mkdir(folder);
  for(const name of ['playfab-folder-probe.exe','xgameruntime.dll','nexus_pgs_native.dll'])await fs.copyFile(tests+'/playfab-folder/'+name,folder+'/'+name,fs.constants.COPYFILE_EXCL);
  const proxy=files+'/share/xodus-nexus/compat/PlayFabGameSave.dll';
  await fs.copyFile(proxy,folder+'/PlayFabGameSave.dll',fs.constants.COPYFILE_EXCL);
  if(await fileHash(proxy)!==await fileHash(folder+'/PlayFabGameSave.dll'))throw Error('PlayFab candidate proxy differs');
  await execute('playfab-folder',folder+'/playfab-folder-probe.exe',[],{WINEDLLOVERRIDES:env.WINEDLLOVERRIDES+';xgameruntime=n;playfabgamesave=n;nexus_pgs_native=n'},21);
  await execute('playfab-session',tests+'/playfab-session/playfab-session-probe.exe',[],{WINEDLLOVERRIDES:env.WINEDLLOVERRIDES+';playfabcore=n;playfabgamesave=n;nexus_pgs_native=n'},132);
  for(const [key,expected]of Object.entries(binaries)){const [arch,name]=key.split('/');if(await fileHash(files+'/lib/wine/'+arch+'-windows/'+name)!==expected)throw Error('Candidate changed');}
  passed=true;
}finally{
  const stop=spawnSync(server,['-k'],{env,timeout:10000,stdio:'ignore'}),drain=spawnSync(server,['-w'],{env,timeout:60000,stdio:'ignore'});
  if(stop.error||drain.error||drain.status!==0)passed=false;
  if(passed&&await fs.realpath(prefix)===prefix)await fs.rm(prefix,{recursive:true});
  await fs.writeFile(root+'/results.json',JSON.stringify({schema:1,scope:'synthetic Wine and compatibility contracts only',passed,realAccounts:false,realCloud:false,binaries,results},null,2)+'\n',{flag:'wx',mode:0o600});
  console.log('WINE_CONTRACT_RESULTS '+root+'/results.json');
}
if(!passed)process.exitCode=1;
