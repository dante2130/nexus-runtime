// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import {hasCompleteHttpCoverage} from './http-coverage.mjs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {project,readJson,sourceEnvironment} from '../inputs.mjs';
import {fileHash,treeHash,assertPortable,validateGateResults} from './provenance.mjs';
import {prepareValidationTools,validationProcessOutput} from './validation-tools.mjs';
const [outputArg,fixturesArg,validationArg]=process.argv.slice(2);
if(process.argv.length!==5)throw Error('BUILD_OUTPUT FIXTURES NEW_VALIDATION required');
const output=await fs.realpath(outputArg),fixtures=await fs.realpath(fixturesArg),work=path.resolve(validationArg);
const built=await readJson(output+'/built.json'),runtime=await fs.realpath(built.runtime),files=runtime+'/files',engine=files+'/bin/wine';
if(path.dirname(runtime)!==output||built.metadata.stableApproved!==false)throw Error('Invalid isolated runtime');
await fs.mkdir(work,{recursive:false});await fs.chmod(work,0o700);
const fixtureProof=await readJson(fixtures+'/fixtures.json');
if(fixtureProof.sdk!==built.inputs.sdk||JSON.stringify(fixtureProof.sourceGraph)!==JSON.stringify(built.graph))throw Error('Test fixtures do not match the selected SDK/source graph');
for(const [file,expected]of Object.entries(fixtureProof.hashes))if(await fileHash(fixtures+'/'+file)!==expected)throw Error('Changed test fixture');
// Preserve the exact required SDK notices before the immutable runtime binding.
for(const name of ['GCC-runtime-copyright','MinGW-runtime-copyright','libxml2-COPYING']){
  const source=project+'/licenses/'+name,target=files+'/share/doc/nexus-runtime/'+name;
  try{await fs.copyFile(source,target,fs.constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST'||await fileHash(target)!==await fileHash(source))throw e;}
}
await assertPortable(runtime);
const proof={schema:1,scope:'exact coherent runtime, synthetic offline gates only',realGameTest:false,realAccountTest:false,realCloudTest:false,stableApproved:false,graph:built.graph,runtime,builtSha256:await fileHash(output+'/built.json'),treeSha256:await treeHash(runtime),fixtureProofSha256:await fileHash(fixtures+'/fixtures.json'),results:[],bindings:{}};
const tools=await prepareValidationTools(files,work+'/candidate-tools');
const env={...sourceEnvironment(),PATH:tools+':'+files+'/bin:'+process.env.PATH,LD_LIBRARY_PATH:files+'/lib/x86_64-linux-gnu:'+files+'/lib/i386-linux-gnu:'+files+'/lib',PYTHONDONTWRITEBYTECODE:'1'};
let passed=false;
async function execute(name,command,args){
  const r=spawnSync(command,args,{cwd:work,env,encoding:'utf8',timeout:600000,maxBuffer:8*1024*1024});
  const log=work+'/'+name+'.log';await fs.writeFile(log,validationProcessOutput(r),{flag:'wx',mode:0o600});
  proof.results.push({name,status:r.status,signal:r.signal,error:r.error?.message,log,sha256:await fileHash(log)});
  if(r.status!==0||r.signal||r.error)throw Error('Candidate gate failed: '+name+'; '+log);
  console.log(name+' PASS');
}
try{
  const cpp=built.source+'/wine/dlls/xgameruntime',scripts=work+'/scripts';await fs.mkdir(scripts);
  for(const gate of ['component','authentication','user-contracts','store']){
    let text=await fs.readFile(cpp+'/scripts/test-'+gate+'.mjs','utf8');
    text=text.replaceAll('xgameruntime=n','xgameruntime=b').replaceAll("base+'/lib64:'+base+'/lib'","base+'/lib/x86_64-linux-gnu:'+base+'/lib/i386-linux-gnu:'+base+'/lib'").replaceAll("path.join(base,'lib64')+':'+path.join(base,'lib')","path.join(base,'lib','x86_64-linux-gnu')+':'+path.join(base,'lib','i386-linux-gnu')+':'+path.join(base,'lib')");
    await fs.writeFile(scripts+'/test-'+gate+'.mjs',text,{flag:'wx'});
  }
  for(const [abi,arch]of [['win64','x86_64'],['win32','i386']]){
    const directory=work+'/'+abi,bin=directory+'/bin';await fs.mkdir(bin,{recursive:true});
    for(const name of await fs.readdir(fixtures+'/'+abi+'/bin'))if(name.endsWith('.exe'))await fs.copyFile(fixtures+'/'+abi+'/bin/'+name,bin+'/'+name,fs.constants.COPYFILE_EXCL);
    await fs.copyFile(cpp+'/tests/Nexus/MicrosoftGame.config',bin+'/MicrosoftGame.config',fs.constants.COPYFILE_EXCL);
    const dll=files+'/lib/wine/'+arch+'-windows/xgameruntime.dll';
    if(await fileHash(dll)!==built.metadata.componentsByArchitecture[arch]['xgameruntime.dll'])throw Error('Coherent C++ module differs');
    await fs.copyFile(dll,bin+'/xgameruntime.dll',fs.constants.COPYFILE_EXCL);
    for(const gate of ['component','authentication','user-contracts','store'])await execute(abi+'-'+gate,process.execPath,[scripts+'/test-'+gate+'.mjs',directory,...(gate==='component'?[]:[engine])]);
  }
  await execute('wine-native-contracts',process.execPath,[project+'/ci/wine-contracts.mjs',runtime,fixtures+'/native',work]);
  for(const [name,script,args]of [['http','run-http2-suite.mjs',[runtime,work]],['media','run-media-suite.mjs',[runtime,work+'/media']],['graphics','run-dxvk-suite.mjs',[runtime,work]]]){
    await execute(name,process.execPath,[project+'/runtime-tests/'+script,...args]);
    if(name==='http'){
      const directories=(await fs.readdir(work)).filter(x=>x.startsWith('runtime-http2-'));
      if(directories.length!==1)throw Error('Ambiguous HTTP fixture');
      const r=spawnSync(files+'/bin/wineserver',['-w'],{env:{...env,WINEPREFIX:work+'/'+directories[0]+'/pfx'},timeout:30000,stdio:'ignore'});
      if(r.status!==0||r.error||r.signal)throw Error('Synthetic HTTP prefix failed to drain');
    }
  }
  validateGateResults(proof.results);
  if(await fileHash(output+'/built.json')!==proof.builtSha256||await treeHash(runtime)!==proof.treeSha256)throw Error('Runtime changed during validation');
  async function bind(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true})){
    const file=path.join(directory,entry.name);if(entry.isDirectory()&&entry.name!=='pfx')await bind(file);else if(entry.isFile()&&(entry.name==='results.json'||entry.name==='result.json'))proof.bindings[path.relative(work,file)]=await fileHash(file);
  }}
  await bind(work);
  // Recheck exact result thresholds independently of each runner's exit status.
  const dirs=await fs.readdir(work),single=async(prefix,name)=>{const d=dirs.filter(x=>x.startsWith(prefix));if(d.length!==1)throw Error('Missing result group');return readJson(work+'/'+d[0]+'/'+name);};
  const wine=await single('wine-contract-','results.json'),http=await single('runtime-http2-','results.json'),graphics=await single('runtime-dxvk-','result.json'),media=await readJson(work+'/media/results.json');
  if(!wine.passed||wine.results.length!==22||wine.results.some(r=>!r.passed)||![64,32].every(bits=>wine.results.some(r=>r.name==='package-id-'+bits&&r.checks.length===3&&r.checks.every((n,i)=>n>=[2478,6,24][i]))&&wine.results.some(r=>r.name==='applicationdata-'+bits&&r.checks.length===3&&r.checks.every((n,i)=>n>=[45,7,25][i])))||!hasCompleteHttpCoverage(http)||graphics.code!==0||graphics.timeout||!graphics.summary.some(x=>/^DXVK COMPUTE CHECKS 40 FAILURES 0\s*$/.test(x))||!media.h264||!media.aac||!media.bundledLibraries)throw Error('Native result coverage incomplete');
  passed=true;
}finally{
  proof.passed=passed;await fs.writeFile(work+'/results.json',JSON.stringify(proof,null,2)+'\n',{flag:'wx',mode:0o600});console.log('VALIDATION_RESULT '+work+'/results.json');
}
if(!passed)process.exitCode=1;
