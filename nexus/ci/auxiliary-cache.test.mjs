// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {auxiliaryCacheKey} from './auxiliary-cache.mjs';

test('auxiliary cache changes with recipe, locks, architecture and toolchain, not validation scripts',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nexus-cache-plan-'));
  try {
    await fs.mkdir(root+'/ci');await fs.writeFile(root+'/inputs.lock.json','pinned');
    await fs.writeFile(root+'/build-auxiliary.mjs','recipe');
    const key=()=>auxiliaryCacheKey(root,'x86_64','20261101');
    const initial=await key();await fs.writeFile(root+'/ci/validate-runtime.mjs','new checks');
    assert.equal(await key(),initial);
    await fs.writeFile(root+'/inputs.lock.json','changed pin');assert.notEqual(await key(),initial);
    await fs.writeFile(root+'/inputs.lock.json','pinned');await fs.writeFile(root+'/build-auxiliary.mjs','changed recipe');assert.notEqual(await key(),initial);
    assert.notEqual(await auxiliaryCacheKey(root,'arm64','20261101',{sha256:'a'}),await auxiliaryCacheKey(root,'arm64','20261101',{sha256:'b'}));
    assert.notEqual(await auxiliaryCacheKey(root,'x86_64','20261101'),await auxiliaryCacheKey(root,'arm64','20261101'));
    assert.notEqual(await key(),await auxiliaryCacheKey(root,'x86_64','20261102'));
  } finally {await fs.rm(root,{recursive:true,force:true});}
});
