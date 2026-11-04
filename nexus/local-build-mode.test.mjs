import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const entry=new URL('./build-runtime.mjs',import.meta.url);
const source=fs.readFileSync(entry,'utf8');
const markerLine=()=>{const line=source.split('\n').find(text=>text.includes("'LOCAL_ONLY.json'"));assert.ok(line,'LOCAL_ONLY.json marker is missing');return line;};
const cleanEnv=()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GITHUB_')));
test('local mode cannot be used in a GitHub workflow',()=>{const r=spawnSync(process.execPath,[entry.pathname,'--local'],{encoding:'utf8',env:{...process.env,GITHUB_ACTIONS:'true'}});assert.notEqual(r.status,0);assert.match(r.stderr,/Local builds cannot run in GitHub workflows/);});
test('distribution mode still rejects non-main GitHub refs',()=>{const r=spawnSync(process.execPath,[entry.pathname],{encoding:'utf8',env:{...process.env,GITHUB_REF:'refs/heads/feature/example'}});assert.notEqual(r.status,0);assert.match(r.stderr,/Distribution builds are main-only/);});
test('the local-only marker is written only after a successful assembly',()=>{
  const assembly=source.indexOf('await assembleRuntime('),marker=source.indexOf("'LOCAL_ONLY.json'");
  assert.ok(assembly>0,'assembly call is missing');
  assert.ok(marker>assembly,'the marker must follow the assembly call');
  const line=markerLine();
  assert.ok(line.startsWith('if(localBuild)await fs.writeFile('),'the marker must require an explicit local build');
  for(const part of ["path.join(output,'LOCAL_ONLY.json')",'schema:1','localBuild:true','publishable:false','sourceGraph:graph',"{flag:'wx'}"])assert.ok(line.includes(part),part);
});
test('the production marker statement writes only the local-only payload',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-local-build-marker-'));
  try{
    const fixture=path.join(directory,'marker.mjs'),output=path.join(directory,'output'),target=path.join(output,'LOCAL_ONLY.json');
    fs.writeFileSync(fixture,["import fs from 'node:fs/promises';","import path from 'node:path';","const output=process.argv[2],localBuild=process.argv[3]==='1',graph={proton:'a'.repeat(40),wine:'b'.repeat(40)};","try{await fs.mkdir(output);}catch(error){if(error.code!=='EEXIST')throw error;}",markerLine(),''].join('\n'));
    const run=local=>spawnSync(process.execPath,[fixture,output,local?'1':'0'],{encoding:'utf8',env:cleanEnv()});
    const local=run(true);
    assert.equal(local.status,0,local.stderr);
    const text=fs.readFileSync(target,'utf8');
    assert.deepEqual(JSON.parse(text),{schema:1,localBuild:true,publishable:false,sourceGraph:{proton:'a'.repeat(40),wine:'b'.repeat(40)}});
    assert.ok(text.endsWith('}\n'),'the marker must be a newline terminated JSON document');
    assert.notEqual(run(true).status,0,'an existing marker must not be overwritten');
    fs.rmSync(target);
    const distribution=run(false);
    assert.equal(distribution.status,0,distribution.stderr);
    assert.equal(fs.existsSync(target),false,'ordinary distribution mode must not write the marker');
  }finally{fs.rmSync(directory,{recursive:true,force:true});}
});
test('local mode keeps its distribution, source and resume guards',()=>{
  assert.ok(source.includes("if(localBuild&&Object.keys(process.env).some(key=>key.startsWith('GITHUB_')))throw Error('Local builds cannot run in GitHub workflows');"));
  assert.ok(source.includes("if(!localBuild&&process.env.GITHUB_REF&&process.env.GITHUB_REF!=='refs/heads/main')throw Error('Distribution builds are main-only');"));
  assert.ok(source.includes('verifySourceGraph({full:true,main:!localBuild})'));
  assert.ok(source.includes("if(Boolean(state.localBuild)!==localBuild)throw Error('Resume build mode mismatch');"));
});
