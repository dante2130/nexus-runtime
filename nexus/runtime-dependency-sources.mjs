// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const safeName = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9+._~-]*$/.test(value) && !value.includes('..');

export async function verifyRuntimeDependencies(files, sdk) {
  const directory = path.join(files, 'share/xodus-nexus/media-dependencies');
  const bytes = await fs.readFile(path.join(directory, 'manifest.json'));
  const manifest = JSON.parse(bytes);
  if (manifest.schema !== 1 || manifest.sdk !== sdk || !Array.isArray(manifest.libraries) || manifest.libraries.length > 64) throw Error('Invalid runtime dependency manifest');
  const seen = new Set();
  for (const item of manifest.libraries) {
    if (!['x86_64-linux-gnu', 'i386-linux-gnu', 'aarch64-linux-gnu'].includes(item.architecture) || !safeName(item.filename) || !safeName(item.soname) || !/^licenses\/[a-z0-9+.-]+\.copyright$/.test(item.copyright)) throw Error('Unsafe runtime dependency path');
    const key = item.architecture + '/' + item.soname;
    if (seen.has(key)) throw Error('Duplicate runtime dependency');
    seen.add(key);
    const library = path.join(files, 'lib', item.architecture, item.filename);
    const alias = path.join(files, 'lib', item.architecture, item.soname);
    if ((await fs.lstat(library)).isSymbolicLink() || await fs.realpath(alias) !== library || sha(await fs.readFile(library)) !== item.sha256) throw Error('Runtime dependency checksum mismatch');
    if (sha(await fs.readFile(path.join(directory, item.copyright))) !== item.copyrightSha256) throw Error('Runtime dependency notice checksum mismatch');
  }
  return {sha256: sha(bytes), libraries: manifest.libraries.length};
}

export function dscSources(text, source, version) {
  if (text.length > 1024 * 1024 || !text.startsWith('-----BEGIN PGP SIGNED MESSAGE-----\n')) throw Error('Invalid pinned source descriptor');
  const body = text.split('-----BEGIN PGP SIGNATURE-----')[0];
  if (!body.includes(`\nSource: ${source}\n`) || !body.includes(`\nVersion: ${version}\n`)) throw Error('SDK source identity mismatch');
  const section = /\nChecksums-Sha256:\n((?: [^\n]+\n)+)/.exec(body)?.[1];
  if (!section) throw Error('Missing source archive checksums');
  const files = section.trimEnd().split('\n').map(line => {
    const match = /^ ([a-f0-9]{64}) ([0-9]+) ([^\s]+)$/.exec(line);
    if (!match || !safeName(match[3]) || !/\.(?:tar\.(?:xz|gz|bz2)|diff\.gz)$/.test(match[3]) || Number(match[2]) <= 0 || Number(match[2]) > 128 * 1024 * 1024) throw Error('Unsafe corresponding source archive');
    return {sha256: match[1], bytes: Number(match[2]), filename: match[3]};
  });
  if (!files.length || files.length > 8 || new Set(files.map(file => file.filename)).size !== files.length) throw Error('Invalid corresponding source set');
  return files;
}

export async function collectRuntimeDependencySources(files, work, {execute = execFileSync, sourceLock} = {}) {
  sourceLock ??= JSON.parse(await fs.readFile(new URL('./runtime-dependencies.lock.json', import.meta.url), 'utf8'));
  const dependencyBytes = await fs.readFile(path.join(files, 'share/xodus-nexus/media-dependencies/manifest.json'));
  const dependencies = JSON.parse(dependencyBytes);
  if (dependencies.schema !== 1 || !sourceLock.sdkImages.includes(dependencies.sdk) || !dependencies.sources || Object.keys(dependencies.sources).length > 16) throw Error('Invalid SDK dependency manifest');
  const output = path.join(work, 'runtime-dependency-sources');
  await fs.mkdir(output, {recursive: true});
  const entries = [];
  const download = async (url, destination, expected, size) => {
    try {
      const cached = await fs.readFile(destination);
      if (sha(cached) !== expected || size !== undefined && cached.length !== size) throw Error('Cached corresponding source checksum mismatch');
      return;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const scratch = await fs.mkdtemp(path.join(output, '.fetch-'));
    try {
      const file = path.join(scratch, 'source');
      execute('curl', ['--proto', '=https', '--proto-redir', '=https', '--tlsv1.2', '--fail', '--location', '--silent', '--show-error', '--connect-timeout', '15', '--max-time', '120', '--max-filesize', String(size ?? 1024 * 1024), '--output', file, url], {stdio: 'inherit', timeout: 135000});
      const bytes = await fs.readFile(file);
      if (sha(bytes) !== expected || size !== undefined && bytes.length !== size) throw Error('Corresponding source checksum mismatch');
      await fs.copyFile(file, destination, fs.constants.COPYFILE_EXCL);
    } finally { await fs.rm(scratch, {recursive: true, force: true}); }
  };
  for (const [source, pin] of Object.entries(dependencies.sources)) {
    const expected = sourceLock.sources[source];
    if (!expected || ['version', 'url', 'sha256'].some(key => pin[key] !== expected[key])) throw Error('SDK source differs from the checked lock');
    if (!/^[a-z0-9][a-z0-9+.-]*$/.test(source) || !/^[0-9][a-zA-Z0-9+.:~-]*$/.test(pin.version) || !/^[a-f0-9]{64}$/.test(pin.sha256)) throw Error('Invalid pinned SDK source');
    const prefix = source.startsWith('lib') ? source.slice(0, 4) : source[0];
    const filename = `${source}_${pin.version.replace(/^[0-9]+:/, '')}.dsc`;
    const base = `https://deb.debian.org/debian/pool/main/${prefix}/${source}/`;
    if (pin.url !== base + filename || !safeName(filename)) throw Error('Unexpected SDK source URL');
    const descriptor = path.join(output, filename);
    await download(pin.url, descriptor, pin.sha256);
    const archives = dscSources(await fs.readFile(descriptor, 'utf8'), source, pin.version);
    for (const archive of archives) await download(base + archive.filename, path.join(output, archive.filename), archive.sha256, archive.bytes);
    entries.push({source, version: pin.version, descriptor: filename, sha256: pin.sha256, archives});
  }
  const manifest = {schema: 1, dependencyManifestSha256: sha(dependencyBytes), sources: entries};
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
