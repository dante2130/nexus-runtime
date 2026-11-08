import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {moduleCapabilities} from './module-capabilities.mjs';
test('offline identity is advertised only by the exact module manifest', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-module-cap-'));
  try {
    assert.deepEqual(await moduleCapabilities(root), []);
    const file = path.join(root, 'nexus-capabilities.json');
    await fs.writeFile(file, JSON.stringify({schema:1, features:['xuser-offline-identity-v2']}));
    const first = await moduleCapabilities(root); first.length = 0;
    assert.deepEqual(await moduleCapabilities(root), ['xuser-offline-identity-v2']);
    await fs.writeFile(file, JSON.stringify({schema:1, features:['xuser-offline-identity-v2','xgame-invitations-v1']}));
    assert.deepEqual(await moduleCapabilities(root), ['xuser-offline-identity-v2','xgame-invitations-v1']);
    await fs.writeFile(file, JSON.stringify({schema:1, features:['achievement-notify-v1']}));
    assert.deepEqual(await moduleCapabilities(root), ['achievement-notify-v1']);
    for (const invalid of [{schema:2,features:[]}, {schema:1,features:['invented']}, {schema:1,features:['xuser-offline-identity-v2','xuser-offline-identity-v2']}, {schema:1,features:[],extra:true}, null]) {
      await fs.writeFile(file, JSON.stringify(invalid));
      await assert.rejects(moduleCapabilities(root));
    }
  } finally { await fs.rm(root, {recursive:true,force:true}); }
});
