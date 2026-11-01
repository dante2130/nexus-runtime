// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {project,verifyInputs} from '../inputs.mjs';
import {verifyAuxiliary} from '../auxiliary.mjs';
import {targets} from '../target.mjs';
import {fileHash} from './provenance.mjs';

export async function auxiliaryCacheKey(root,arch,imageVersion,toolchain={}) {
  if(!['x86_64','arm64'].includes(arch)||!imageVersion)throw Error('Exact architecture and runner image required');
  // Hash the whole recipe, including transitive helpers and all input locks.
  // Validation-only changes in ci/ cannot invalidate compiled dependencies.
  const hash=createHash('sha256');
  async function visit(dir) {
    for(const entry of (await fs.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      if(['ci','tests','runtime-tests'].includes(entry.name)||entry.name.endsWith('.test.mjs'))continue;
      const file=path.join(dir,entry.name);
      if(entry.isDirectory())await visit(file);
      else if(entry.isFile()){hash.update(path.relative(root,file)+'\0');hash.update(await fs.readFile(file));}
    }
  }
  await visit(root);
  hash.update(JSON.stringify({arch,imageVersion,toolchain}));
  return 'nexus-auxiliary-v1-'+arch+'-'+hash.digest('hex');
}
export async function verifyCachedAuxiliary(directory,inputs,target) {
  const result=await verifyAuxiliary(directory,inputs,target);
  const media=JSON.parse(await fs.readFile(path.join(directory,'media/media-manifest.json'),'utf8'));
  if(await fileHash(path.join(directory,'media','ffmpeg-'+media.version+'.tar.xz'))!==media.sourceSha256)throw Error('Cached corresponding media source changed');
  return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [mode,arch,directory]=process.argv.slice(2);
  if(!targets[arch])throw Error('Unsupported auxiliary architecture');
  const {inputs}=await verifyInputs();
  if(mode==='plan'&&!directory) {
    const toolchain=arch==='arm64'?{url:process.env.NEXUS_LLVM_MINGW_URL,sha256:process.env.NEXUS_LLVM_MINGW_SHA256}:{};
    const key=await auxiliaryCacheKey(project,arch,process.env.ImageVersion,toolchain);
    if(!process.env.GITHUB_OUTPUT)throw Error('GitHub output required');
    await fs.appendFile(process.env.GITHUB_OUTPUT,'key='+key+'\n');
  } else if(mode==='verify'&&directory)await verifyCachedAuxiliary(directory,inputs,targets[arch]);
  else throw Error('Usage: auxiliary-cache.mjs plan ARCH | verify ARCH DIRECTORY');
}
