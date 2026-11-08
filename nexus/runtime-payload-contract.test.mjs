// SPDX-License-Identifier: MIT
// Source-only payload parity contracts. They exercise the production copy and
// verification entry points on small synthetic redistributions, and bind the
// required selectors and producers to the checked-in source. They never build,
// compile, download or run Wine.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {payloadContract, payloadIdentityStamps, payloadProducers, payloadRuntimeInputs, verifyRuntimePayload} from './runtime-payload-contract.mjs';
import {copySdkRedistribution, makeSdkLinksPortable} from './runtime-copy.mjs';

const project = path.dirname(fileURLToPath(import.meta.url));
const repository = path.dirname(project);
const sourceFamily = JSON.parse(String(readFileSync(path.join(project, 'inputs.lock.json')))).variant?.family ?? 'nexus';
const sourceInputs = JSON.parse(String(readFileSync(path.join(project, 'inputs.lock.json'))));
const sourcePin = sourceFamily === 'nexus-cachyos'
  ? sourceInputs.variant.cachyosProton
  : execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repository, encoding: 'utf8'}).trim();
const familyOfSource = async () => sourceFamily;
const read = relative => fs.readFile(path.join(repository, relative), 'utf8');
const protonfixesSource = process.env.NEXUS_PROTONFIXES_SOURCE;
const protonfixesApplicable = sourceFamily === 'nexus-cachyos';

const lowLatencyManifest = 'files/share/low_latency_layer/implicit_layer.d/low_latency_layer.json';
const layerLibraries = {
  [lowLatencyManifest]: '../../../lib/x86_64-linux-gnu/libVkLayer_KORTHOS_LowLatency.so',
  'files/share/vkbasalt/implicit_layer.d/vkBasalt.json': 'libvkbasalt.so',
  'files/share/pyroveil/implicit_layer.d/VkLayer_pyroveil_64.json': 'libVkLayer_pyroveil_64.so',
  'files/share/dxvk-nvapi-vkreflex-layer/implicit_layer.d/VkLayer_DXVK_NVAPI_reflex.json': 'libdxvk_nvapi_vkreflex_layer.so',
};
const referencesOf = item => item.scriptReference === undefined ? [] : Array.isArray(item.scriptReference) ? item.scriptReference : [item.scriptReference];

async function buildFixture(root, {family = 'nexus-cachyos', arch = 'x86_64', omitSelector, omitReference} = {}) {
  const contract = payloadContract(family, {arch});
  const lines = ['#!/usr/bin/env python3'];
  for (const item of contract.entries) {
    if (item.selector && item.selector !== omitSelector) lines.push(`check_environment("${item.selector}", "fixture")`);
    for (const reference of referencesOf(item)) if (!(omitReference && reference.includes(omitReference))) lines.push(`# ${reference}`);
  }
  for (const item of contract.entries) {
    if (item.path === 'proton') continue;
    const file = path.join(root, ...item.path.split('/'));
    if (item.kind === 'directory') {
      await fs.mkdir(file, {recursive: true});
      continue;
    }
    await fs.mkdir(path.dirname(file), {recursive: true});
    if (item.kind === 'symlink') {
      try {
        await fs.symlink(item.path === 'files/share/wine/mono/wine-mono' ? 'wine-mono-11.3.0' : '../wine/mono/wine-mono/lib/x86_64/SDL3.dll', file);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      continue;
    }
    if (item.kind === 'layer-manifest') {
      const library = layerLibraries[item.path];
      await fs.writeFile(file, JSON.stringify({file_format_version: '1.1.2', layer: {name: 'VK_LAYER_FIXTURE', type: 'GLOBAL', library_path: library}}, null, 2) + '\n');
      continue;
    }
    await fs.writeFile(file, `fixture:${item.path}\n`);
  }
  const mono = path.join(root, 'files/share/wine/mono/wine-mono-11.3.0/lib/x86_64');
  await fs.mkdir(mono, {recursive: true});
  await fs.writeFile(path.join(mono, 'SDL3.dll'), 'fixture:sdl3');
  await fs.mkdir(path.join(root, 'files/share/pyroveil/hacks'), {recursive: true});
  await fs.writeFile(path.join(root, 'files/share/pyroveil/hacks/fixture.json'), '{}\n');
  await fs.writeFile(path.join(root, 'proton'), lines.join('\n') + '\n', {mode: 0o755});
  for (const item of contract.entries) if (item.executable) await fs.chmod(path.join(root, ...item.path.split('/')), 0o755);
  return contract;
}

async function withFixture(name, options, run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `nexus-payload-${name}-`));
  try {
    await buildFixture(path.join(root, 'runtime'), options);
    await run(path.join(root, 'runtime'), root);
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
}

test('the CachyOS contract requires the official feature payload and records non-shipped capabilities', () => {
  const contract = payloadContract('nexus-cachyos');
  const paths = new Set(contract.entries.map(item => item.path));
  for (const required of [
    'files/lib/wine/dxvk-sarek/x86_64-windows/dxgi.dll',
    'files/lib/wine/dxvk-low-latency/x86_64-windows/dxgi.dll',
    'files/lib/wine/vkd3d-low-latency/x86_64-windows/d3d12.dll',
    'files/lib/wine/d7vk/i386-windows/ddraw.dll',
    'files/lib/wine/nvidia-libs/nvcuda/x86_64-windows/nvcuda.dll.so',
    'files/lib/wine/nvidia-libs/nvml/wine/x86_64-windows/nvml.dll',
    'files/lib/wine/nvidia-libs/nvml/wine/x86_64-unix/nvml.so',
    'files/lib/wine/nvidia-libs/nvoptix/x86_64-windows/nvoptix.dll.so',
    'files/lib/wine/discord-rpc-bridge/bridge.exe',
    'files/share/low_latency_layer/implicit_layer.d/low_latency_layer.json',
    'files/share/vkbasalt/implicit_layer.d/vkBasalt.json',
    'files/share/pyroveil/implicit_layer.d/VkLayer_pyroveil_64.json',
    'files/lib/x86_64-linux-gnu/libvkbasalt.so',
    'files/lib/wine/x86_64-unix/winewayland.so',
    'files/lib/wine/x86_64-unix/winepipewire.so',
    'files/lib/wine/x86_64-unix/winegstreamer.so',
    'protonfixes',
  ]) assert.ok(paths.has(required), required);
  const protonfixesEntry = contract.entries.find(item => item.path === 'protonfixes');
  assert.equal(protonfixesEntry.kind, 'directory');
  assert.equal(protonfixesEntry.scriptReference, 'import protonfixes');
  assert.ok(contract.entries.some(item => item.selector === 'PROTON_DXVK_SAREK'));
  assert.ok(contract.entries.some(item => item.selector === 'PROTON_NVIDIA_NVOPTIX'));
  assert.ok(contract.entries.some(item => item.selector === 'PROTON_ENABLE_WAYLAND'));
  assert.ok(contract.entries.some(item => item.selector === 'PROTON_USE_PIPEWIRE'));
  assert.ok(contract.entries.some(item => item.feature === 'non-steam-umu'));
  assert.deepEqual(contract.defaultDisabled.map(item => item.feature).sort(), ['steam-audio', 'zluda']);
  assert.ok(contract.runtimeProvided.some(item => item.feature === 'optiscaler'));
  assert.ok(contract.runtimeProvided.some(item => item.feature === 'streamline'));
  assert.ok(contract.runtimeProvided.some(item => item.env === 'PROTON_MLFG_UPGRADE') === false);
  assert.deepEqual(contract.architectureLimits.map(item => item.arch), ['arm64']);
  assert.ok(!JSON.stringify(contract.entries).match(/steam-audio|zluda|optiscaler/i), 'optional or downloaded assets must not be required payload');
  for (const item of contract.entries) {
    assert.ok(!path.isAbsolute(item.path));
    assert.ok(!item.path.split('/').some(part => part === '..' || part === '.' || !part));
  }
});

test('family metadata does not leak CachyOS claims into Standard', () => {
  const cachy = payloadContract('nexus-cachyos');
  const standard = payloadContract('nexus');
  assert.deepEqual(cachy.defaultDisabled.map(item => item.feature).sort(), ['steam-audio', 'zluda']);
  assert.deepEqual(standard.defaultDisabled, []);
  assert.deepEqual(standard.runtimeProvided, []);
  assert.deepEqual(standard.documentedOnly, []);
  assert.deepEqual(standard.architectureLimits, []);
  const standardDiscord = standard.nativeCapabilities.find(item => item.env === 'PROTON_DISCORD_BRIDGE');
  assert.ok(standardDiscord, 'missing Standard native helper capability');
  assert.deepEqual(standardDiscord.sourceFiles, ['umu_helper/umu.c']);
  assert.equal('payload' in standardDiscord, false);
  assert.ok(standardDiscord.payloadDetection);
  assert.ok(!standardDiscord.payloadDetection.includes('The pinned proton auto-detects'));
  assert.ok(standardDiscord.payloadDetection.includes('no bridge payload detection'));
  assert.ok(standardDiscord.servicePath.includes('discord\\bridge.exe --service'));
  assert.ok(!standard.entries.some(item => item.path.includes('discord-rpc-bridge')));
  assert.equal(standard.scope, 'x86_64-full');
  assert.ok(standard.entries.some(item => item.path === 'files/lib/wine/dxvk/x86_64-windows/dxgi.dll'));
  assert.ok(!standard.entries.some(item => item.feature === 'dxvk-sarek' || item.path.includes('nvidia-libs')));
  assert.ok(!standard.entries.some(item => item.path === 'protonfixes'), 'Standard has no protonfixes tree or import');
  assert.deepEqual(standard.layerManifests, []);
  for (const env of ['PROTON_USE_OPTISCALER', 'PROTON_OPTISCALER_STREAMLINE', 'PROTON_OPTISCALER_NAME', 'PROTON_OPTISCALER_CONFIG', 'PROTON_DLSS_UPGRADE', 'PROTON_XESS_UPGRADE', 'PROTON_FSR4_UPGRADE', 'PROTON_FFX3_UPGRADE', 'PROTON_FFX4_UPGRADE', 'PROTON_LOCAL_SHADER_CACHE']) {
    assert.ok(cachy.runtimeProvided.some(item => item.env === env), 'missing runtime-provided env ' + env);
  }
  assert.deepEqual(cachy.documentedOnly.map(item => item.env).sort(), ['PROTON_MLFG_UPGRADE']);
  assert.ok(cachy.documentedOnly.every(item => item.absentAtPin === true));
  const cachyDiscord = cachy.nativeCapabilities.find(item => item.env === 'PROTON_DISCORD_BRIDGE');
  assert.ok(cachyDiscord, 'missing CachyOS native helper capability');
  assert.deepEqual(cachyDiscord.sourceFiles, ['umu_helper/umu.c', 'steam_helper/steam.c']);
  assert.equal(cachyDiscord.payload, 'files/lib/wine/discord-rpc-bridge/bridge.exe');
  assert.ok(cachyDiscord.payloadDetection);
  assert.ok(cachy.entries.some(item => item.path === 'files/lib/wine/discord-rpc-bridge/bridge.exe'));
  assert.ok(!JSON.stringify(cachy.runtimeProvided).includes('PROTON_MLFG_UPGRADE'));
  assert.throws(() => payloadContract('unknown'));
  assert.throws(() => payloadContract('nexus', {arch: 'riscv64'}));
  assert.throws(() => payloadContract('nexus-cachyos', {arch: 'arm64'}), /Unreviewed CachyOS payload architecture/);
  const arm64 = payloadContract('nexus', {arch: 'arm64'});
  assert.equal(arm64.scope, 'non-x86_64-minimal');
  assert.ok(arm64.entries.every(item => item.arch === 'any'));
});

test('the CachyOS runtime-provided claims bind the exact protonfixes gitlink', {skip: sourceFamily !== 'nexus-cachyos' ? 'not the CachyOS source tree' : false}, () => {
  const line = execFileSync('git', ['ls-tree', 'HEAD', 'protonfixes'], {cwd: repository, encoding: 'utf8'}).trim();
  const match = /^160000 commit ([a-f0-9]{40})\tprotonfixes$/.exec(line);
  assert.ok(match, 'missing pinned protonfixes gitlink');
  assert.equal(match[1], payloadRuntimeInputs.pin);
  assert.equal(payloadRuntimeInputs.source, 'protonfixes/upscalers.py');
  assert.equal(payloadRuntimeInputs.manifestUrl, 'https://loathingkernel.github.io/proton-upscalers/manifest.json');
  assert.equal(payloadRuntimeInputs.cacheDirectory, '${XDG_CACHE_HOME:-~/.cache}/protonfixes/upscalers');
  assert.equal(payloadRuntimeInputs.manifestCache, '${XDG_CACHE_HOME:-~/.cache}/protonfixes/upscalers/manifest.json');
  assert.deepEqual(payloadRuntimeInputs.absentAtPin.map(item => item.env).sort(), ['PROTON_MLFG_UPGRADE']);
});

test('the pinned native helpers implement the Discord bridge environment switch', async () => {
  const capability = payloadContract(sourceFamily).nativeCapabilities.find(item => item.env === 'PROTON_DISCORD_BRIDGE');
  assert.ok(capability, 'missing native helper capability');
  assert.equal(capability.kind, 'native-helper');
  const proton = await read('proton');
  if (sourceFamily === 'nexus-cachyos') {
    assert.equal(capability.payload, 'files/lib/wine/discord-rpc-bridge/bridge.exe');
    assert.ok(capability.payloadDetection);
    assert.ok(proton.includes('wine/discord-rpc-bridge/bridge.exe'));
  } else {
    assert.equal('payload' in capability, false);
    assert.ok(capability.payloadDetection);
    assert.ok(!capability.payloadDetection.includes('The pinned proton auto-detects'));
    assert.ok(capability.payloadDetection.includes('no bridge payload detection'));
    assert.ok(capability.servicePath.includes('discord\\bridge.exe --service'));
    assert.ok(!proton.includes('wine/discord-rpc-bridge/bridge.exe'));
    assert.ok(!payloadContract('nexus').entries.some(item => item.path.includes('discord-rpc-bridge')));
  }
  for (const file of capability.sourceFiles) {
    const actual = await read(file);
    for (const pattern of [capability.setupFunction, capability.setupPattern, capability.callPattern, capability.servicePattern]) {
      assert.ok(actual.includes(pattern), `${file}: ${pattern}`);
    }
    if (capability.servicePath) assert.ok(actual.includes(capability.servicePath.replaceAll('\\', '\\\\')), `${file}: ${capability.servicePath}`);
    const tree = execFileSync('git', ['ls-tree', 'HEAD', file], {cwd: repository, encoding: 'utf8'}).trim();
    assert.match(tree, new RegExp('^100644 blob [a-f0-9]{40}\\t' + file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'));
    const pinned = execFileSync('git', ['show', `${sourcePin}:${file}`], {cwd: repository, encoding: 'utf8'});
    assert.equal(actual, pinned, `${file} differs from pinned source ${sourcePin}`);
  }
  assert.ok(!payloadContract(sourceFamily).documentedOnly.some(item => item.env === 'PROTON_DISCORD_BRIDGE'));
});

test('the optional pinned protonfixes cache matches the runtime-download matrix', {skip: !protonfixesApplicable ? 'not the CachyOS source tree' : !protonfixesSource ? 'set NEXUS_PROTONFIXES_SOURCE to the exact pinned protonfixes read-only tree' : false}, async () => {
  const upscalersFile = path.join(protonfixesSource, 'upscalers.py');
  const utilitiesFile = path.join(protonfixesSource, 'utilities.py');
  for (const file of [upscalersFile, utilitiesFile]) {
    if (!(await fs.stat(file).catch(() => null))?.isFile()) throw Error('NEXUS_PROTONFIXES_SOURCE is missing required file: ' + file);
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: protonfixesSource, encoding: 'utf8'}).trim();
  assert.equal(head, payloadRuntimeInputs.pin);
  const upscalers = await fs.readFile(upscalersFile, 'utf8');
  const utilities = await fs.readFile(utilitiesFile, 'utf8');
  assert.ok(upscalers.includes(`__manifest_url = '${payloadRuntimeInputs.manifestUrl}'`));
  assert.ok(upscalers.includes("cache_dir = config.path.cache_dir.joinpath('upscalers')"));
  assert.ok(upscalers.includes("cached_manifest = cache_dir.joinpath('manifest.json')"));
  for (const component of payloadRuntimeInputs.components) {
    assert.ok(upscalers.includes(`'${component.name}'`), 'missing component ' + component.name);
    assert.ok(upscalers.includes(component.env), 'missing env ' + component.env);
    for (const target of [component.installRoot, ...(component.installPaths ?? [])].filter(Boolean)) assert.ok(upscalers.includes(target), `${component.name}: ${target}`);
  }
  for (const item of payloadRuntimeInputs.config) assert.ok(upscalers.includes(item.env), 'missing config env ' + item.env);
  for (const item of payloadRuntimeInputs.absentAtPin) {
    assert.ok(!upscalers.includes(item.env), 'absent option unexpectedly present: ' + item.env);
    assert.ok(!upscalers.toLowerCase().includes('mlfg'), 'absent option evidence found: ' + item.env);
  }
  assert.ok(utilities.includes("'localshadercache' not in compat_config"));
  assert.ok(utilities.includes("'DXVK_STATE_CACHE_PATH'"));
  assert.ok(utilities.includes("'VKD3D_SHADER_CACHE_PATH'"));
});

test('the assembled entry script still selects every payload capability required by the source family', async () => {
  const family = await familyOfSource();
  const proton = await read('proton');
  for (const item of payloadContract(family).entries) {
    if (item.selector) assert.ok(proton.includes('"' + item.selector + '"'), 'missing selector ' + item.selector);
    const references = referencesOf(item);
    if (references.length) assert.ok(references.some(reference => proton.includes(reference)), 'missing payload reference ' + references.join(' or '));
  }
  if (family === 'nexus-cachyos') {
    for (const item of payloadRuntimeInputs.absentAtPin) assert.ok(!proton.includes(item.env), 'documented-only option unexpectedly present: ' + item.env);
    // The required NVOPTIX payload keeps both upstream selectors that reach it.
    for (const env of ['PROTON_NVIDIA_NVOPTIX', 'PROTON_NVIDIA_LIBS']) assert.ok(proton.includes('"' + env + '"'), 'missing NVOPTIX selector ' + env);
    assert.ok(proton.includes('wine/nvidia-libs/nvoptix'), 'missing NVOPTIX payload reference');
  }
});

test('every required feature is mapped to a checked-in producer, not a guessed filename', async () => {
  const family = await familyOfSource();
  const features = new Set(payloadContract(family).entries.map(item => item.feature));
  const producers = payloadProducers.filter(item => features.has(item.feature));
  for (const feature of features) assert.ok(producers.some(item => item.feature === feature), 'missing producer mapping ' + feature);
  const gitmodules = await read('.gitmodules');
  for (const producer of producers) {
    if (producer.producer === 'wine-submodule') {
      assert.match(gitmodules, /\[submodule "wine"\]/);
      continue;
    }
    if (producer.producer === 'wineopenxr-submodule') {
      assert.match(gitmodules, /\[submodule "wineopenxr"\]/);
      continue;
    }
    const text = await read(producer.producer);
    for (const evidence of producer.evidence) assert.ok(text.includes(evidence), `${producer.feature}: ${evidence}`);
  }
});

test('the real copy keeps feature bytes, layer configuration and portable links', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-payload-copy-'));
  try {
    const build = path.join(root, 'build'), redist = path.join(build, 'redist-abcdef12'), runtime = path.join(root, 'output', 'candidate');
    await buildFixture(redist, {family: 'nexus-cachyos'});
    await fs.symlink(path.join(redist, 'files/lib/wine/x86_64-windows/kernel32.dll'), path.join(redist, 'files/bin/alias'));
    const files = ['files/lib/wine/dxvk-sarek/x86_64-windows/dxgi.dll', 'files/lib/wine/nvidia-libs/nvml/wine/x86_64-windows/nvml.dll', 'files/lib/wine/d7vk/i386-windows/ddraw.dll', 'files/lib/wine/discord-rpc-bridge/bridge.exe', 'files/lib/x86_64-linux-gnu/libvkbasalt.so'];
    const before = {};
    for (const file of files) before[file] = await fs.readFile(path.join(redist, file));
    const kernel = await fs.readFile(path.join(redist, 'files/lib/wine/x86_64-windows/kernel32.dll'));
    await copySdkRedistribution(redist, runtime);
    const links = await makeSdkLinksPortable(runtime, build);
    const proof = await verifyRuntimePayload(runtime, {family: 'nexus-cachyos'});
    assert.equal(proof.family, 'nexus-cachyos');
    assert.ok(proof.features.includes('dxvk-sarek'));
    assert.ok(proof.features.includes('nvidia-nvml'));
    assert.ok(proof.features.includes('vulkan-vkbasalt'));
    for (const file of files) assert.deepEqual(await fs.readFile(path.join(runtime, file)), before[file], file);
    assert.equal(await fs.readlink(path.join(runtime, 'files/share/wine/mono/wine-mono')), 'wine-mono-11.3.0');
    assert.equal(await fs.readlink(path.join(runtime, 'files/share/xalia/SDL3.dll')), '../wine/mono/wine-mono/lib/x86_64/SDL3.dll');
    assert.equal((await fs.readdir(path.join(runtime, 'files/share/pyroveil/hacks'))).length, 1);
    const manifest = JSON.parse(await fs.readFile(path.join(runtime, lowLatencyManifest), 'utf8'));
    assert.equal(manifest.layer.library_path, layerLibraries[lowLatencyManifest]);
    assert.ok(links.relative + links.materialized >= 1, 'the SDK absolute link must become portable');
    const alias = path.join(runtime, 'files/bin/alias');
    const aliasStat = await fs.lstat(alias);
    if (aliasStat.isSymbolicLink()) assert.equal(path.isAbsolute(await fs.readlink(alias)), false);
    else assert.deepEqual(await fs.readFile(alias), kernel);
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('a missing or wrongly typed feature output fails closed', async () => {
  await withFixture('missing', {family: 'nexus-cachyos'}, async runtime => {
    await fs.rm(path.join(runtime, 'files/lib/wine/dxvk-sarek/x86_64-windows/dxgi.dll'));
    await assert.rejects(() => verifyRuntimePayload(runtime, {family: 'nexus-cachyos'}), /Runtime payload missing: dxvk-sarek/);
  });
  await withFixture('wrong-kind', {family: 'nexus-cachyos'}, async runtime => {
    await fs.rm(path.join(runtime, 'files/share/pyroveil/hacks'), {recursive: true});
    await fs.writeFile(path.join(runtime, 'files/share/pyroveil/hacks'), 'not a directory');
    await assert.rejects(() => verifyRuntimePayload(runtime, {family: 'nexus-cachyos'}), /not a directory: vulkan-pyroveil/);
  });
  await withFixture('missing-nvidia', {family: 'nexus-cachyos'}, async runtime => {
    await fs.rm(path.join(runtime, 'files/lib/wine/nvidia-libs/nvml/wine/x86_64-windows/nvml.dll'));
    await assert.rejects(() => verifyRuntimePayload(runtime, {family: 'nexus-cachyos'}), /Runtime payload missing: nvidia-nvml/);
  });
  await withFixture('missing-nvoptix', {family: 'nexus-cachyos'}, async runtime => {
    await fs.rm(path.join(runtime, 'files/lib/wine/nvidia-libs/nvoptix/x86_64-windows/nvoptix.dll.so'));
    await assert.rejects(() => verifyRuntimePayload(runtime, {family: 'nexus-cachyos'}), /Runtime payload missing: nvidia-nvoptix/);
  });
});

test('external ancestor, file and layer links are rejected', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-payload-escape-'));
  try {
    const runtime = path.join(root, 'runtime'), external = path.join(root, 'external');
    await fs.mkdir(path.join(external, 'x86_64-windows'), {recursive: true});
    await fs.writeFile(path.join(external, 'x86_64-windows/dxgi.dll'), 'external dxgi');
    await fs.writeFile(path.join(external, 'libVkLayer_KORTHOS_LowLatency.so'), 'external layer');
    await fs.writeFile(path.join(external, 'low_latency_layer.json'), JSON.stringify({layer: {library_path: 'libVkLayer_KORTHOS_LowLatency.so'}}));
    await buildFixture(runtime, {family: 'nexus-cachyos'});
    const dxvkSarek = path.join(runtime, 'files/lib/wine/dxvk-sarek');
    await fs.rm(dxvkSarek, {recursive: true});
    await fs.symlink(external, dxvkSarek);
    await assert.rejects(() => verifyRuntimePayload(runtime, {family: 'nexus-cachyos'}), /external symlink|outside the runtime/);
    await fs.rm(dxvkSarek);
    await buildFixture(path.join(root, 'runtime2'), {family: 'nexus-cachyos'});
    const runtime2 = path.join(root, 'runtime2');
    const dxgi = path.join(runtime2, 'files/lib/wine/dxvk-sarek/x86_64-windows/dxgi.dll');
    await fs.rm(dxgi);
    await fs.symlink(path.join(external, 'x86_64-windows/dxgi.dll'), dxgi);
    await assert.rejects(() => verifyRuntimePayload(runtime2, {family: 'nexus-cachyos'}), /external symlink|outside the runtime/);
    await fs.rm(path.join(runtime2, lowLatencyManifest));
    await fs.symlink(path.join(external, 'low_latency_layer.json'), path.join(runtime2, lowLatencyManifest));
    await assert.rejects(() => verifyRuntimePayload(runtime2, {family: 'nexus-cachyos'}), /external symlink|outside the runtime/);
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
});

test('legit internal portable symlinks are accepted while directories are not files', async () => {
  await withFixture('internal-link', {family: 'nexus-cachyos'}, async runtime => {
    const target = path.join(runtime, 'files/share/low_latency_layer/low_latency_layer.internal.json');
    await fs.writeFile(target, JSON.stringify({layer: {library_path: 'libVkLayer_KORTHOS_LowLatency.so'}}));
    await fs.rm(path.join(runtime, lowLatencyManifest));
    await fs.symlink('../low_latency_layer.internal.json', path.join(runtime, lowLatencyManifest));
    const proof = await verifyRuntimePayload(runtime, {family: 'nexus-cachyos'});
    assert.ok(proof.features.includes('vulkan-low-latency'));
  });
  await withFixture('layer-directory', {family: 'nexus-cachyos'}, async runtime => {
    await fs.rm(path.join(runtime, lowLatencyManifest));
    await fs.mkdir(path.join(runtime, lowLatencyManifest));
    await assert.rejects(() => verifyRuntimePayload(runtime, {family: 'nexus-cachyos'}), /not a regular file: vulkan-low-latency/);
  });
});

test('layer manifests must declare the reviewed library and a real contained target', async () => {
  await withFixture('bad-basename', {family: 'nexus-cachyos'}, async runtime => {
    await fs.writeFile(path.join(runtime, lowLatencyManifest), JSON.stringify({layer: {library_path: 'nonexistent-lib.so'}}));
    await assert.rejects(() => verifyRuntimePayload(runtime, {family: 'nexus-cachyos'}), /declares an unexpected library/);
  });
  await withFixture('bare-missing', {family: 'nexus-cachyos'}, async runtime => {
    await fs.rm(path.join(runtime, 'files/lib/x86_64-linux-gnu/libvkbasalt.so'));
    await assert.rejects(() => verifyRuntimePayload(runtime, {family: 'nexus-cachyos'}), /Layer library is missing/);
  });
  await withFixture('relative-missing', {family: 'nexus-cachyos'}, async runtime => {
    await fs.rm(path.join(runtime, 'files/lib/x86_64-linux-gnu/libVkLayer_KORTHOS_LowLatency.so'));
    await assert.rejects(() => verifyRuntimePayload(runtime, {family: 'nexus-cachyos'}), /Runtime payload missing|Layer library is missing/);
  });
  await withFixture('relative-external-link', {family: 'nexus-cachyos'}, async runtime => {
    const external = path.join(runtime, '..', 'external-layer.so');
    await fs.writeFile(external, 'perfect external layer');
    const library = path.join(runtime, 'files/lib/x86_64-linux-gnu/libVkLayer_KORTHOS_LowLatency.so');
    await fs.rm(library);
    await fs.symlink(external, library);
    await assert.rejects(() => verifyRuntimePayload(runtime, {family: 'nexus-cachyos'}), /external symlink|outside the runtime/);
  });
});

test('a removed official selector or payload reference fails closed', async () => {
  await withFixture('selector', {family: 'nexus-cachyos', omitSelector: 'PROTON_DXVK_SAREK'}, async runtime => {
    await assert.rejects(() => verifyRuntimePayload(runtime, {family: 'nexus-cachyos'}), /no longer selects PROTON_DXVK_SAREK/);
  });
  await withFixture('reference', {family: 'nexus-cachyos', omitReference: 'wine/nvidia-libs/nvml'}, async runtime => {
    await assert.rejects(() => verifyRuntimePayload(runtime, {family: 'nexus-cachyos'}), /no longer references wine\/nvidia-libs\/nvml/);
  });
});

test('assembly runs the payload verifier on the final tree before metadata and manifests', async () => {
  const source = await read('nexus/assemble-runtime.mjs');
  const portable = source.indexOf('const links=await makeSdkLinksPortable(');
  const verify = source.indexOf('const payloadContract=await verifyRuntimePayload(');
  const metadataWrite = source.indexOf("path.join(runtime,'XODUS_NEXUS_PATCH.json')");
  const familyManifest = source.indexOf('writeFamilyManifest(');
  const builtWrite = source.indexOf("path.join(output,'built.json')");
  assert.ok(portable > 0, 'portable link pass is missing');
  assert.ok(verify > portable, 'payload verification must follow the portable link pass');
  assert.ok(metadataWrite > verify, 'payload verification must precede the patch metadata');
  const hasFamilyManifest = familyManifest > 0;
  if (hasFamilyManifest) assert.ok(familyManifest > metadataWrite, 'family manifest must follow the patch metadata');
  assert.ok(builtWrite > (hasFamilyManifest ? familyManifest : metadataWrite), 'built.json must be written last');
  assert.ok(source.includes('metadata.payloadContract=payloadContract'));
  assert.ok(source.includes('pins:new Map(noticeModuleInventory(graph)'), 'assembly must pass the prepared source pins to the payload identity check');
});

test('every upstream version stamp is bound to a checked-in build rule', async () => {
  // Stamp file to the module it names, and module to the checked-in rule that
  // writes the stamp. A pending CachyOS-only module is skipped on the Standard
  // tree, whose source has neither the module nor the rule.
  const ruleFiles = {
    'dxvk': 'Makefile.in',
    'dxvk-nvapi': 'Makefile.in',
    'dxvk-igdext': 'Makefile.in',
    'vkd3d': 'Makefile.in',
    'vkd3d-proton': 'Makefile.in',
    'extras/d7vk': 'extras/build-d7vk.mk',
    'extras/dxvk-sarek': 'extras/build-dxvk-sarek.mk',
    'extras/dxvk-low-latency': 'extras/build-dxvk-low-latency.mk',
    'extras/vkd3d-low-latency': 'extras/build-vkd3d-low-latency.mk',
    'nvidia-libs/nvcuda': 'nvidia-libs/build-nvcuda.mk',
    'nvidia-libs/nvcuda32': 'nvidia-libs/build-nvcuda.mk',
    'nvidia-libs/nvenc': 'nvidia-libs/build-nvenc.mk',
    'nvidia-libs/nvenc32': 'nvidia-libs/build-nvenc.mk',
    'nvidia-libs/wine-nvoptix': 'nvidia-libs/build-wine-nvoptix.mk',
  };
  const gitmodules = await read('.gitmodules');
  const shared = new Set(['dxvk', 'dxvk-nvapi', 'dxvk-igdext', 'vkd3d', 'vkd3d-proton']);
  const nvml = path.join(repository, 'nvidia-libs/build-wine-nvml.mk');
  let checked = 0;
  for (const [stampPath, modulePath] of Object.entries(payloadIdentityStamps)) {
    assert.ok(stampPath.endsWith('/version') || stampPath.endsWith('/version-i386'), stampPath);
    if (sourceFamily !== 'nexus-cachyos' && !shared.has(modulePath)) continue;
    if (modulePath === 'nvidia-libs/wine-nvml') {
      // Nexus replaced the upstream Git stamp with the verified header proof.
      const text = await read('nvidia-libs/build-wine-nvml.mk');
      assert.ok(text.includes('NVML_HEADER_PREPARE'), 'NVML version stamp must use the prepared header helper');
      assert.ok(text.includes('version --source $(SRCDIR)'), 'NVML version stamp must come from the verified proof');
      assert.ok(nvml.endsWith('build-wine-nvml.mk'));
      checked += 1;
      continue;
    }
    const rule = await read(ruleFiles[modulePath]);
    assert.ok(rule.includes('submodule status -- ' + modulePath), `version stamp for ${modulePath} is not derived from the pinned submodule`);
    assert.match(gitmodules, new RegExp(`\\[submodule "${modulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\]`), 'unstaged submodule ' + modulePath);
    checked += 1;
  }
  assert.ok(checked >= (sourceFamily === 'nexus-cachyos' ? 15 : 5), 'too few identity stamps were bound');
});

test('payload identity stamps reject another commit and never overclaim identity', async () => {
  const pinned = 'a78a467cadb22bee928904290cf8e7921b121851';
  const pins = new Map([['dxvk', pinned]]);
  await withFixture('identity', {family: 'nexus-cachyos'}, async runtime => {
    const stampFile = path.join(runtime, 'files/lib/wine/dxvk/version');
    const statusOf = async (options = {}) => {
      const proof = await verifyRuntimePayload(runtime, {family: 'nexus-cachyos', ...options});
      return proof.identity.find(item => item.path === 'files/lib/wine/dxvk/version');
    };
    assert.equal((await statusOf()).status, 'absent');
    await fs.mkdir(path.dirname(stampFile), {recursive: true});
    // A clean stamp names the pinned commit. The stamp is provenance text, not a
    // digest of the payload bytes.
    await fs.writeFile(stampFile, ` ${pinned} dxvk (v3.1.1-97-ga78a467)\n`);
    assert.deepEqual(await statusOf({pins}), {path: 'files/lib/wine/dxvk/version', module: 'dxvk', status: 'matched', commit: pinned});
    assert.equal((await statusOf({pins: new Map()})).status, 'unpinned');
    await fs.writeFile(stampFile, 'no-git-repo-info\n');
    assert.equal((await statusOf({pins})).status, 'unverifiable');
    assert.equal((await statusOf()).status, 'unverifiable');
    await fs.writeFile(stampFile, '\n');
    assert.equal((await statusOf({pins})).status, 'unverifiable');
    // A parsed commit that differs from the prepared pin fails closed.
    await fs.writeFile(stampFile, ` ${'0'.repeat(40)} dxvk (stale)\n`);
    await assert.rejects(() => statusOf({pins}), /names another commit for dxvk/);
    await fs.writeFile(stampFile, ` ${pinned} another-module\n`);
    await assert.rejects(() => statusOf({pins}), /names another-module, expected dxvk/);
    // Unclean Git markers are not accepted as source identity. With pins they
    // fail closed; without pins they stay explicitly unverifiable.
    for (const [marker, label] of [['+', 'modified'], ['-', 'uninitialized'], ['U', 'conflict']]) {
      await fs.writeFile(stampFile, `${marker}${pinned} dxvk (marker)\n`);
      await assert.rejects(() => statusOf({pins}), new RegExp('reports a ' + label + ' module state'));
      const record = await statusOf();
      assert.equal(record.status, 'unverifiable');
      assert.equal(record.marker, marker);
      assert.equal(record.commit, pinned);
    }
  });
});

test('a CachyOS payload is not required from an ordinary Standard assembly', async () => {
  await withFixture('standard', {family: 'nexus'}, async runtime => {
    const proof = await verifyRuntimePayload(runtime, {family: 'nexus'});
    assert.equal(proof.scope, 'x86_64-full');
    assert.deepEqual(proof.defaultDisabled, []);
    await assert.rejects(() => verifyRuntimePayload(runtime, {family: 'nexus-cachyos'}), /Runtime payload missing: (protonfixes|dxvk-sarek)/);
  });
});

test('the honest Standard ARM64 guard accepts only the minimal shared payload', async () => {
  await withFixture('standard-arm64', {family: 'nexus', arch: 'arm64'}, async runtime => {
    const proof = await verifyRuntimePayload(runtime, {family: 'nexus', arch: 'arm64'});
    assert.equal(proof.scope, 'non-x86_64-minimal');
    assert.deepEqual(proof.defaultDisabled, []);
    await assert.rejects(() => verifyRuntimePayload(runtime, {family: 'nexus-cachyos', arch: 'arm64'}), /Unreviewed CachyOS payload architecture/);
  });
});
