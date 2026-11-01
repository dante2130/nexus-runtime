// SPDX-License-Identifier: MIT
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {collectRuntimeDependencySources, dscSources, verifyRuntimeDependencies} from './runtime-dependency-sources.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const archive = Buffer.from('closed fixture corresponding source archive');
const name = 'codec_1.0.orig.tar.xz';
const descriptor = `-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA256\n\nSource: codec\nVersion: 1.0-1\nChecksums-Sha256:\n ${sha(archive)} ${archive.length} ${name}\n-----BEGIN PGP SIGNATURE-----\nparser-fixture-only\n`;
const sdk = 'registry.gitlab.steamos.cloud/proton/steamrt4/sdk/x86_64@sha256:' + '1'.repeat(64);
const pin = {version: '1.0-1', url: 'https://deb.debian.org/debian/pool/main/c/codec/codec_1.0-1.dsc', sha256: sha(descriptor)};
const sourceLock = {sdkImages: [sdk], sources: {codec: pin}};

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-codec-source-'));
  const files = path.join(root, 'files'), work = path.join(root, 'work');
  const metadata = path.join(files, 'share/xodus-nexus/media-dependencies/manifest.json');
  await fs.mkdir(path.dirname(metadata), {recursive: true});
  await fs.mkdir(work);
  await fs.writeFile(metadata, JSON.stringify({schema: 1, sdk, sources: {codec: pin}}));
  return {root, files, work, metadata, close: () => fs.rm(root, {recursive: true, force: true})};
}

test('source descriptor keeps the exact SDK identity and rejects unsafe or duplicate archive names', () => {
  assert.deepEqual(dscSources(descriptor, 'codec', '1.0-1'), [{sha256: sha(archive), bytes: archive.length, filename: name}]);
  for (const input of [descriptor.replace(name, '../escape.tar.xz'), descriptor.replace(` ${archive.length} `, ' 0 '), descriptor.replace(` ${archive.length} `, ' 134217729 '), descriptor.replace('Source: codec', 'Source: other')]) {
    assert.throws(() => dscSources(input, 'codec', '1.0-1'));
  }
  assert.throws(() => dscSources(descriptor.replace('-----BEGIN PGP SIGNATURE-----', ` ${sha(archive)} ${archive.length} ${name}\n-----BEGIN PGP SIGNATURE-----`), 'codec', '1.0-1'));
});

test('corresponding sources verify descriptor and archive bytes and safely reuse an exact cache', async () => {
  const f = await fixture();
  try {
    const requests = [];
    const execute = (command, args) => {
      assert.equal(command, 'curl');
      assert.ok(args.includes('--proto') && args.includes('=https'));
      const url = args.at(-1); requests.push(url);
      assert.ok([pin.url, new URL(name, pin.url).href].includes(url));
      syncFs.writeFileSync(args[args.indexOf('--output') + 1], url.endsWith('.dsc') ? descriptor : archive);
    };
    const result = await collectRuntimeDependencySources(f.files, f.work, {execute, sourceLock});
    assert.equal(result.sources[0].archives[0].sha256, sha(archive));
    assert.equal(await fs.readFile(path.join(f.work, 'runtime-dependency-sources', name), 'utf8'), archive.toString());
    assert.equal(requests.length, 2);
    await collectRuntimeDependencySources(f.files, f.work, {execute() { throw Error('must use verified cache'); }, sourceLock});
    assert.equal((await fs.readdir(path.join(f.work, 'runtime-dependency-sources'))).some(name => name.startsWith('.fetch-')), false);
  } finally { await f.close(); }
});

test('bad archive hashes fail without installing the file or erasing an existing source', async () => {
  const f = await fixture();
  try {
    const execute = (_command, args) => syncFs.writeFileSync(args[args.indexOf('--output') + 1], args.at(-1).endsWith('.dsc') ? descriptor : Buffer.alloc(archive.length, 0));
    await assert.rejects(collectRuntimeDependencySources(f.files, f.work, {execute, sourceLock}), /checksum/);
    const file = path.join(f.work, 'runtime-dependency-sources', name);
    await assert.rejects(fs.access(file));
    await fs.writeFile(file, 'preserve mismatched cached source');
    await assert.rejects(collectRuntimeDependencySources(f.files, f.work, {execute, sourceLock}), /Cached.*checksum/);
    assert.equal(await fs.readFile(file, 'utf8'), 'preserve mismatched cached source');
  } finally { await f.close(); }
});

test('a dependency manifest cannot substitute another SDK or a new source checksum', async () => {
  const f = await fixture();
  try {
    for (const change of [{sdk: sdk.replace(/1$/, '2')}, {sources: {codec: {...pin, sha256: '0'.repeat(64)}}}]) {
      await fs.writeFile(f.metadata, JSON.stringify({schema: 1, sdk, sources: {codec: pin}, ...change}));
      await assert.rejects(collectRuntimeDependencySources(f.files, f.work, {execute() { throw Error('network must not be reached'); }, sourceLock}), /manifest|checked lock/);
    }
  } finally { await f.close(); }
});

test('runtime assembly verifies copied library bytes, aliases and retained notices', async () => {
  const f = await fixture();
  try {
    const directory = path.join(f.files, 'lib/x86_64-linux-gnu');
    const library = path.join(directory, 'libcodec.so.1.0');
    await fs.mkdir(directory, {recursive: true});
    await fs.writeFile(library, 'synthetic library bytes, ELF checked inside the SDK');
    await fs.symlink('libcodec.so.1.0', path.join(directory, 'libcodec.so.1'));
    const notice = path.join(path.dirname(f.metadata), 'licenses/codec.copyright');
    await fs.mkdir(path.dirname(notice));
    await fs.writeFile(notice, 'retained corresponding license');
    const item = {architecture: 'x86_64-linux-gnu', filename: 'libcodec.so.1.0', soname: 'libcodec.so.1', sha256: sha(await fs.readFile(library)), copyright: 'licenses/codec.copyright', copyrightSha256: sha(await fs.readFile(notice))};
    await fs.writeFile(f.metadata, JSON.stringify({schema: 1, sdk, libraries: [item]}));
    assert.equal((await verifyRuntimeDependencies(f.files, sdk)).libraries, 1);
    await fs.writeFile(library, 'modified library');
    await assert.rejects(verifyRuntimeDependencies(f.files, sdk), /checksum/);
    await fs.writeFile(f.metadata, JSON.stringify({schema: 1, sdk, libraries: [{...item, filename: '../escape'}]}));
    await assert.rejects(verifyRuntimeDependencies(f.files, sdk), /path/);
  } finally { await f.close(); }
});
