// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('compiled checkpoints round trip without changing bytes and reject wrong or damaged inputs',()=>{
  const r=spawnSync('python3',[fileURLToPath(new URL('./runtime-checkpoint.test.py',import.meta.url))],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:60000});
  assert.equal(r.status,0,r.stdout+r.stderr);
});
