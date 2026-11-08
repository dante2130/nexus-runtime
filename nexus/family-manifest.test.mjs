// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {writeFamilyManifest} from './family-manifest.mjs';
import {project} from './inputs.mjs';
import {treeHash} from './ci/provenance.mjs';
const identity={family:'nexus',sourceRepository:'domsvoboda/nexus-runtime',sourceCommit:'a'.repeat(40),sourceLockSha256:'b'.repeat(64)};
async function fixture(fn){
 const root=await fs.mkdtemp(path.join(project,'../.family-fixture-'));
 try{
  const names=['proton','files/bin/wine','files/bin/wineserver','files/bin/wine.nexus-original',...['PlayFabGameSave.dll','gaming-services-version.exe','package-registration.exe'].map(n=>'files/share/xodus-nexus/compat/'+n),...['x86_64','i386'].flatMap(cpu=>['xgameruntime.dll','winhttp.dll','libnghttp2.dll'].map(n=>`files/lib/wine/${cpu}-windows/${n}`))];
  for(const name of names){const file=path.join(root,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,name,{mode:0o755});}
  await fs.mkdir(path.join(root,'files/share/default_pfx/dosdevices'),{recursive:true});
  await fs.writeFile(path.join(root,'XODUS_NEXUS_PATCH.json'),JSON.stringify({schema:1,sourceGraph:{proton:identity.sourceCommit},sourceLockSha256:identity.sourceLockSha256}));
  await fn(root);
 }finally{await fs.rm(root,{recursive:true,force:true});}
}
test('family manifest inventories actual payload and exact template mapping without activation',()=>fixture(async root=>{
 await fs.symlink('/',path.join(root,'files/share/default_pfx/dosdevices/z:'));
 await fs.symlink('wine.nexus-original',path.join(root,'files/bin/internal-link'));
 const receipt=await writeFamilyManifest(root,identity),manifest=JSON.parse(await fs.readFile(path.join(root,'nexus-family.json'),'utf8'));
 assert.equal(manifest.buildId,receipt.buildId);assert.match(receipt.manifestSha256,/^[a-f0-9]{64}$/);
 assert.equal(manifest.symlinks['files/share/default_pfx/dosdevices/z:'],'/');
 assert.equal(manifest.symlinks['files/bin/internal-link'],'wine.nexus-original');
 assert.ok(manifest.files.proton);assert.ok(!('nexus-family.json' in manifest.files));
 await assert.rejects(fs.access(path.join(root,'current.json')));
 await assert.rejects(writeFamilyManifest(root,identity),/already exists/);
}));
test('manifest creation rejects unrelated external links and missing launch components',()=>fixture(async root=>{
 await fs.symlink('/',path.join(root,'escape'));
 await assert.rejects(writeFamilyManifest(root,identity),/External/);
 await fs.unlink(path.join(root,'escape'));await fs.unlink(path.join(root,'files/bin/wineserver'));
 await assert.rejects(writeFamilyManifest(root,identity),/incomplete/);
 await assert.rejects(fs.access(path.join(root,'nexus-family.json')));
}));
test('manifest binds source metadata and refuses unexecutable or redirected launchers',()=>fixture(async root=>{
 await assert.rejects(writeFamilyManifest(root,{...identity,sourceCommit:'c'.repeat(40)}),/disagrees/);
 await fs.chmod(path.join(root,'proton'),0o644);await assert.rejects(writeFamilyManifest(root,identity));
 await fs.chmod(path.join(root,'proton'),0o755);await fs.rename(path.join(root,'proton'),path.join(root,'proton-real'));await fs.symlink('proton-real',path.join(root,'proton'));
 await assert.rejects(writeFamilyManifest(root,identity),/incomplete/);
}));

test('managed family receipt is x64-only and leaves the ARM64 experimental flow legacy', async () => {
 const source=await fs.readFile(new URL('./assemble-runtime.mjs',import.meta.url),'utf8');
 assert.match(source,/target\.name==='x86_64'\?await writeFamilyManifest/);
 assert.match(source,/legacy experimental path/);
});
