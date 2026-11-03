import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const entry=new URL('./build-runtime.mjs',import.meta.url);
test('local mode cannot be used in a GitHub workflow',()=>{const r=spawnSync(process.execPath,[entry.pathname,'--local'],{encoding:'utf8',env:{...process.env,GITHUB_ACTIONS:'true'}});assert.notEqual(r.status,0);assert.match(r.stderr,/Local builds cannot run in GitHub workflows/);});
test('distribution mode still rejects non-main GitHub refs',()=>{const r=spawnSync(process.execPath,[entry.pathname],{encoding:'utf8',env:{...process.env,GITHUB_REF:'refs/heads/feature/example'}});assert.notEqual(r.status,0);assert.match(r.stderr,/Distribution builds are main-only/);});
