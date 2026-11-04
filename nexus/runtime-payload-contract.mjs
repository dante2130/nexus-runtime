// SPDX-License-Identifier: MIT
// Source-level contract for the upstream Proton payload that the assembled
// runtime must keep. Notice inputs and provenance records are verified by the
// source notice helper; this contract does not grant or certify legal rights.
// It verifies fail-closed payload presence, path containment and that the entry
// script still contains the official selector tokens. That is a regression guard
// for the assembled tree, not proof of runtime functional parity or of how a
// selector behaves at launch.
import fs from 'node:fs/promises';
import path from 'node:path';

const families = Object.freeze(['nexus', 'nexus-cachyos']);
const inside = (root, file) => file === root || file.startsWith(root + path.sep);
const entry = value => Object.freeze(value);
const scriptReferences = item => item.scriptReference === undefined ? [] : Array.isArray(item.scriptReference) ? item.scriptReference : [item.scriptReference];

// Shared payload. The selectors and path fragments are checked against the
// assembled `proton` script, so a fork that removes an official capability
// fails closed instead of silently falling back to a reduced feature set.
function commonEntries() {
  const list = [
    entry({arch: 'any', path: 'proton', kind: 'file', feature: 'upstream-entry', executable: true}),
    entry({arch: 'any', path: 'version', kind: 'file', feature: 'upstream-entry'}),
    entry({arch: 'any', path: 'files/share/doc/nexus-runtime', kind: 'directory', feature: 'notices'}),
    entry({arch: 'any', path: 'files/share/openxr/wineopenxr64.json', kind: 'file', feature: 'openxr', scriptReference: 'share/openxr/wineopenxr64.json'}),
    entry({arch: 'x86_64', path: 'files/bin/wine', kind: 'file', feature: 'wine-engine', executable: true}),
    entry({arch: 'x86_64', path: 'files/bin/wineserver', kind: 'file', feature: 'wine-engine', executable: true}),
    entry({arch: 'x86_64', path: 'files/share/default_pfx/drive_c/windows/system32', kind: 'directory', feature: 'default-prefix'}),
    entry({arch: 'x86_64', path: 'files/share/wine/mono/wine-mono', kind: 'symlink', feature: 'wine-mono'}),
    entry({arch: 'x86_64', path: 'files/share/xalia/SDL3.dll', kind: 'symlink', feature: 'controller-sdl'}),
    entry({arch: 'x86_64', path: 'files/share/xodus-nexus/compat', kind: 'directory', feature: 'nexus-compat'}),
    entry({arch: 'x86_64', path: 'files/share/xodus-nexus/compat/PlayFabGameSave.dll', kind: 'file', feature: 'nexus-cloud-saves'}),
    entry({arch: 'x86_64', path: 'files/share/xodus-nexus/compat/gaming-services-version.exe', kind: 'file', feature: 'nexus-compat'}),
    entry({arch: 'x86_64', path: 'files/share/xodus-nexus/compat/package-registration.exe', kind: 'file', feature: 'nexus-package-registration'}),
    entry({arch: 'x86_64', path: 'files/lib/wine/x86_64-windows/umu.exe', kind: 'file', feature: 'non-steam-umu'}),
    entry({arch: 'x86_64', path: 'files/lib/wine/i386-windows/umu.exe', kind: 'file', feature: 'non-steam-umu'}),
    entry({arch: 'x86_64', path: 'files/share/default_pfx/drive_c/windows/system32/umu.exe', kind: 'file', feature: 'non-steam-umu'}),
    entry({arch: 'x86_64', path: 'files/share/default_pfx/drive_c/windows/syswow64/umu.exe', kind: 'file', feature: 'non-steam-umu'}),
  ];
  for (const arch of ['x86_64', 'i386']) {
    list.push(
      entry({arch: 'x86_64', path: `files/lib/wine/${arch}-windows/kernel32.dll`, kind: 'file', feature: 'wine-engine'}),
      entry({arch: 'x86_64', path: `files/lib/wine/${arch}-windows/ntdll.dll`, kind: 'file', feature: 'wine-engine'}),
      entry({arch: 'x86_64', path: `files/lib/wine/${arch}-unix/winevulkan.so`, kind: 'file', feature: 'vulkan'}),
      entry({arch: 'x86_64', path: `files/lib/wine/${arch}-unix/winex11.so`, kind: 'file', feature: 'x11'}),
      entry({arch: 'x86_64', path: `files/lib/wine/${arch}-unix/winepulse.so`, kind: 'file', feature: 'audio-pulse'}),
      entry({arch: 'x86_64', path: `files/lib/wine/${arch}-unix/winealsa.so`, kind: 'file', feature: 'audio-alsa'}),
      entry({arch: 'x86_64', path: `files/lib/wine/${arch}-unix/winegstreamer.so`, kind: 'file', feature: 'media-gstreamer'}),
      entry({arch: 'x86_64', path: `files/lib/wine/${arch}-windows/winegstreamer.dll`, kind: 'file', feature: 'media-gstreamer'}),
      entry({arch: 'x86_64', path: `files/lib/wine/${arch}-unix/wineopenxr.so`, kind: 'file', feature: 'openxr'}),
      entry({arch: 'x86_64', path: `files/lib/wine/${arch}-windows/wineopenxr.dll`, kind: 'file', feature: 'openxr'}),
      entry({arch: 'x86_64', path: `files/lib/wine/dxvk/${arch}-windows/dxgi.dll`, kind: 'file', feature: 'dxvk', scriptReference: 'wine/dxvk'}),
      entry({arch: 'x86_64', path: `files/lib/wine/dxvk/${arch}-windows/d3d11.dll`, kind: 'file', feature: 'dxvk'}),
      entry({arch: 'x86_64', path: `files/lib/wine/dxvk/${arch}-windows/d3d9.dll`, kind: 'file', feature: 'dxvk'}),
      entry({arch: 'x86_64', path: `files/lib/wine/dxvk/${arch}-windows/d3d10core.dll`, kind: 'file', feature: 'dxvk'}),
      entry({arch: 'x86_64', path: `files/lib/wine/vkd3d-proton/${arch}-windows/d3d12.dll`, kind: 'file', feature: 'vkd3d-proton', scriptReference: ['wine/vkd3d-proton', 'vkd3d-proton/']}),
      entry({arch: 'x86_64', path: `files/lib/wine/vkd3d-proton/${arch}-windows/d3d12core.dll`, kind: 'file', feature: 'vkd3d-proton'}),
      entry({arch: 'x86_64', path: `files/lib/vkd3d/${arch}-windows/libvkd3d-shader-1.dll`, kind: 'file', feature: 'vkd3d-shader'}),
      entry({arch: 'x86_64', path: `files/lib/wine/icu/${arch}-windows/icuuc68.dll`, kind: 'file', feature: 'wine-icu', scriptReference: 'wine/icu'}),
    );
    for (const name of arch === 'x86_64' ? ['nvapi64.dll', 'nvofapi64.dll'] : ['nvapi.dll']) {
      list.push(entry({arch: 'x86_64', path: `files/lib/wine/nvapi/${arch}-windows/${name}`, kind: 'file', feature: 'dxvk-nvapi', scriptReference: 'wine/nvapi'}));
    }
  }
  list.push(entry({arch: 'x86_64', path: 'files/lib/wine/igdext/x86_64-windows/igdext64.dll', kind: 'file', feature: 'intel-gdext', scriptReference: 'wine/igdext'}));
  return list;
}

// The CachyOS feature layer. The pinned upstream source enables these build
// namespaces by default; the payload contract keeps them required so a reduced
// "OptiScaler only" or otherwise stripped build cannot be assembled silently.
function cachyosEntries() {
  const list = [];
  // The pinned CachyOS entry script imports protonfixes unconditionally, so the
  // runtime cannot start without this tree. The published release payload ships
  // it as a top-level directory next to `files/`. Standard has neither the
  // import nor the build rule and must not require it.
  list.push(entry({arch: 'x86_64', path: 'protonfixes', kind: 'directory', feature: 'protonfixes', scriptReference: 'import protonfixes'}));
  const addRenderer = (name, archs, extra = {}) => {
    for (const arch of archs) {
      list.push(entry({arch: 'x86_64', path: `files/lib/wine/${name}/${arch}-windows/dxgi.dll`, kind: 'file', feature: name, ...extra}));
      list.push(entry({arch: 'x86_64', path: `files/lib/wine/${name}/${arch}-windows/d3d11.dll`, kind: 'file', feature: name}));
    }
    list.push(entry({arch: 'x86_64', path: `files/lib/wine/${name}/version`, kind: 'file', feature: name}));
  };
  addRenderer('dxvk-sarek', ['x86_64', 'i386'], {selector: 'PROTON_DXVK_SAREK', scriptReference: 'wine/dxvk-sarek'});
  addRenderer('dxvk-low-latency', ['x86_64', 'i386'], {selector: 'PROTON_DXVK_LOWLATENCY', scriptReference: 'wine/dxvk-low-latency'});
  for (const arch of ['x86_64', 'i386']) {
    list.push(
      entry({arch: 'x86_64', path: `files/lib/wine/${arch}-unix/winewayland.so`, kind: 'file', feature: 'wayland', selector: 'PROTON_ENABLE_WAYLAND'}),
      entry({arch: 'x86_64', path: `files/lib/wine/${arch}-windows/winewayland.drv`, kind: 'file', feature: 'wayland'}),
      entry({arch: 'x86_64', path: `files/lib/wine/${arch}-unix/winepipewire.so`, kind: 'file', feature: 'audio-pipewire', selector: 'PROTON_USE_PIPEWIRE'}),
    );
  }
  list.push(
    entry({arch: 'x86_64', path: 'files/share/xalia/SDL3.dll', kind: 'symlink', feature: 'controller-sdl', selector: 'PROTON_PREFER_SDL'}),
    entry({arch: 'x86_64', path: 'files/lib/wine/d7vk/i386-windows/ddraw.dll', kind: 'file', feature: 'd7vk', selector: 'PROTON_D7VK_DDRAW', scriptReference: 'd7vk/'}),
    entry({arch: 'x86_64', path: 'files/lib/wine/d7vk/version', kind: 'file', feature: 'd7vk'}),
    entry({arch: 'x86_64', path: 'files/lib/wine/vkd3d-low-latency/x86_64-windows/d3d12.dll', kind: 'file', feature: 'vkd3d-low-latency', selector: 'PROTON_VKD3D_LOWLATENCY', scriptReference: 'wine/vkd3d-low-latency'}),
    entry({arch: 'x86_64', path: 'files/lib/wine/vkd3d-low-latency/i386-windows/d3d12.dll', kind: 'file', feature: 'vkd3d-low-latency'}),
    entry({arch: 'x86_64', path: 'files/lib/wine/vkd3d-low-latency/version', kind: 'file', feature: 'vkd3d-low-latency'}),
    entry({arch: 'x86_64', path: 'files/lib/wine/discord-rpc-bridge/bridge.exe', kind: 'file', feature: 'discord-rpc-bridge', scriptReference: 'wine/discord-rpc-bridge/bridge.exe'}),
  );
  for (const arch of ['x86_64', 'i386']) {
    list.push(
      entry({arch: 'x86_64', path: `files/lib/wine/nvidia-libs/nvcuda/${arch}-windows/nvcuda.dll.so`, kind: 'file', feature: 'nvidia-nvcuda', selector: 'PROTON_NVIDIA_NVCUDA', scriptReference: 'wine/nvidia-libs/nvcuda'}),
      entry({arch: 'x86_64', path: `files/lib/wine/nvidia-libs/nvenc/${arch}-windows/nvcuvid.dll.so`, kind: 'file', feature: 'nvidia-nvenc', selector: 'PROTON_NVIDIA_NVENC', scriptReference: 'wine/nvidia-libs/nvenc'}),
    );
  }
  list.push(
    entry({arch: 'x86_64', path: 'files/lib/wine/nvidia-libs/nvenc/x86_64-windows/nvencodeapi64.dll.so', kind: 'file', feature: 'nvidia-nvenc'}),
    entry({arch: 'x86_64', path: 'files/lib/wine/nvidia-libs/nvenc/i386-windows/nvencodeapi.dll.so', kind: 'file', feature: 'nvidia-nvenc'}),
    entry({arch: 'x86_64', path: 'files/lib/wine/nvidia-libs/nvenc/version', kind: 'file', feature: 'nvidia-nvenc'}),
    entry({arch: 'x86_64', path: 'files/lib/wine/nvidia-libs/nvcuda/version', kind: 'file', feature: 'nvidia-nvcuda'}),
    entry({arch: 'x86_64', path: 'files/lib/wine/nvidia-libs/nvml/wine/x86_64-windows/nvml.dll', kind: 'file', feature: 'nvidia-nvml', selector: 'PROTON_NVIDIA_NVML', scriptReference: 'wine/nvidia-libs/nvml'}),
    entry({arch: 'x86_64', path: 'files/lib/wine/nvidia-libs/nvml/wine/x86_64-unix/nvml.so', kind: 'file', feature: 'nvidia-nvml'}),
    entry({arch: 'x86_64', path: 'files/lib/wine/nvidia-libs/nvml/version', kind: 'file', feature: 'nvidia-nvml'}),
    entry({arch: 'x86_64', path: 'files/lib/wine/nvidia-libs/nvoptix/x86_64-windows/nvoptix.dll.so', kind: 'file', feature: 'nvidia-nvoptix', selector: 'PROTON_NVIDIA_NVOPTIX', scriptReference: 'wine/nvidia-libs/nvoptix'}),
    entry({arch: 'x86_64', path: 'files/lib/wine/nvidia-libs/nvoptix/version', kind: 'file', feature: 'nvidia-nvoptix'}),
    entry({arch: 'x86_64', path: 'files/share/dxvk-nvapi-vkreflex-layer/implicit_layer.d/VkLayer_DXVK_NVAPI_reflex.json', kind: 'layer-manifest', feature: 'vulkan-reflex', selector: 'DXVK_NVAPI_VKREFLEX', scriptReference: 'share/dxvk-nvapi-vkreflex-layer/implicit_layer.d'}),
    entry({arch: 'x86_64', path: 'files/share/low_latency_layer/implicit_layer.d/low_latency_layer.json', kind: 'layer-manifest', feature: 'vulkan-low-latency', selector: 'LOW_LATENCY_LAYER', scriptReference: 'share/low_latency_layer/implicit_layer.d'}),
    entry({arch: 'x86_64', path: 'files/share/vkbasalt/implicit_layer.d/vkBasalt.json', kind: 'layer-manifest', feature: 'vulkan-vkbasalt', selector: 'ENABLE_VKBASALT', scriptReference: 'share/vkbasalt/implicit_layer.d'}),
    entry({arch: 'x86_64', path: 'files/share/pyroveil/implicit_layer.d/VkLayer_pyroveil_64.json', kind: 'layer-manifest', feature: 'vulkan-pyroveil', selector: 'PYROVEIL', scriptReference: 'share/pyroveil/implicit_layer.d'}),
    entry({arch: 'x86_64', path: 'files/share/pyroveil/hacks', kind: 'directory', feature: 'vulkan-pyroveil', scriptReference: 'share/pyroveil/hacks'}),
    entry({arch: 'x86_64', path: 'files/lib/x86_64-linux-gnu/libdxvk_nvapi_vkreflex_layer.so', kind: 'file', feature: 'vulkan-reflex'}),
    entry({arch: 'x86_64', path: 'files/lib/x86_64-linux-gnu/libVkLayer_KORTHOS_LowLatency.so', kind: 'file', feature: 'vulkan-low-latency'}),
    entry({arch: 'x86_64', path: 'files/lib/x86_64-linux-gnu/libvkbasalt.so', kind: 'file', feature: 'vulkan-vkbasalt'}),
    entry({arch: 'x86_64', path: 'files/lib/i386-linux-gnu/libvkbasalt.so', kind: 'file', feature: 'vulkan-vkbasalt'}),
    entry({arch: 'x86_64', path: 'files/lib/x86_64-linux-gnu/libVkLayer_pyroveil_64.so', kind: 'file', feature: 'vulkan-pyroveil'}),
  );
  return list;
}

// Reviewed layer manifest to library mapping. The basename is required to match
// and the resolved library must be a regular file inside the runtime. A bare
// basename is not accepted merely because some library exists with another name.
const layerLibraries = Object.freeze({
  'files/share/dxvk-nvapi-vkreflex-layer/implicit_layer.d/VkLayer_DXVK_NVAPI_reflex.json': Object.freeze({
    library: 'libdxvk_nvapi_vkreflex_layer.so',
    directories: Object.freeze(['files/lib/x86_64-linux-gnu']),
  }),
  'files/share/low_latency_layer/implicit_layer.d/low_latency_layer.json': Object.freeze({
    library: 'libVkLayer_KORTHOS_LowLatency.so',
    directories: Object.freeze(['files/lib/x86_64-linux-gnu']),
  }),
  'files/share/vkbasalt/implicit_layer.d/vkBasalt.json': Object.freeze({
    library: 'libvkbasalt.so',
    directories: Object.freeze(['files/lib/x86_64-linux-gnu']),
  }),
  'files/share/pyroveil/implicit_layer.d/VkLayer_pyroveil_64.json': Object.freeze({
    library: 'libVkLayer_pyroveil_64.so',
    directories: Object.freeze(['files/lib/x86_64-linux-gnu']),
  }),
});

const layerManifests = Object.freeze(Object.keys(layerLibraries));

// Upstream writes `git submodule status -- <path>` into a `version` file for each
// built module, and the published CachyOS 11.0 release payload carries the same
// stamps. A stamp is build-written provenance text, not a cryptographic digest of
// the payload bytes. This check rejects a parsed commit that differs from the
// prepared pin and rejects an unclean Git marker (modified, uninitialized or
// conflicted submodule state). An absent stamp, a Git-less stamp or an inspection
// without pins is recorded as unverifiable and is not proof of source identity.
export const payloadIdentityStamps = Object.freeze({
  'files/lib/wine/dxvk/version': 'dxvk',
  'files/lib/wine/nvapi/version': 'dxvk-nvapi',
  'files/lib/wine/igdext/version': 'dxvk-igdext',
  'files/lib/vkd3d/version': 'vkd3d',
  'files/lib/wine/vkd3d-proton/version': 'vkd3d-proton',
  'files/lib/wine/d7vk/version': 'extras/d7vk',
  'files/lib/wine/dxvk-sarek/version': 'extras/dxvk-sarek',
  'files/lib/wine/dxvk-low-latency/version': 'extras/dxvk-low-latency',
  'files/lib/wine/vkd3d-low-latency/version': 'extras/vkd3d-low-latency',
  'files/lib/wine/nvidia-libs/nvcuda/version': 'nvidia-libs/nvcuda',
  'files/lib/wine/nvidia-libs/nvcuda/version-i386': 'nvidia-libs/nvcuda32',
  'files/lib/wine/nvidia-libs/nvenc/version': 'nvidia-libs/nvenc',
  'files/lib/wine/nvidia-libs/nvenc/version-i386': 'nvidia-libs/nvenc32',
  'files/lib/wine/nvidia-libs/nvml/version': 'nvidia-libs/wine-nvml',
  'files/lib/wine/nvidia-libs/nvoptix/version': 'nvidia-libs/wine-nvoptix',
});

// `git submodule status` prefixes the commit with a marker; only a clean
// checkout (the recorded commit, one leading space) is usable as an identity.
const stampPattern = /^([ +\-U]?)([a-f0-9]{40})\s+(\S+)/;
const stampMarkers = Object.freeze({' ': 'clean', '+': 'modified', '-': 'uninitialized', U: 'conflict'});

// `pins` is a Map or a plain object of module path to the reviewed commit. The
// stamps of modules outside that set are recorded but cannot be compared.
async function verifyPayloadIdentity(root, pins) {
  const lookup = pins instanceof Map
    ? modulePathValue => pins.get(modulePathValue)
    : pins && typeof pins === 'object'
      ? modulePathValue => pins[modulePathValue]
      : () => undefined;
  const hasPins = pins instanceof Map ? pins.size > 0 : Boolean(pins && typeof pins === 'object' && Object.keys(pins).length);
  const identity = [];
  for (const [stampPath, modulePath] of Object.entries(payloadIdentityStamps)) {
    const label = `payload identity: ${stampPath}`;
    const file = await containedFileIfPresent(root, path.join(root, ...stampPath.split('/')), label);
    if (!file) {
      identity.push(Object.freeze({path: stampPath, module: modulePath, status: 'absent'}));
      continue;
    }
    const match = stampPattern.exec((await fs.readFile(file, 'utf8')).trimEnd());
    if (!match) {
      identity.push(Object.freeze({path: stampPath, module: modulePath, status: 'unverifiable'}));
      continue;
    }
    const [, marker, commit, stampedModule] = match;
    if (stampedModule !== modulePath) throw Error(`Payload identity stamp names ${stampedModule}, expected ${modulePath}: ${stampPath}`);
    if (marker !== ' ' && marker !== '') {
      if (hasPins) throw Error(`Payload identity stamp reports a ${stampMarkers[marker] ?? 'unclean'} module state: ${stampPath}`);
      identity.push(Object.freeze({path: stampPath, module: modulePath, status: 'unverifiable', commit, marker}));
      continue;
    }
    const pin = lookup(modulePath);
    if (pin === undefined) {
      identity.push(Object.freeze({path: stampPath, module: modulePath, status: 'unpinned', commit}));
      continue;
    }
    if (pin !== commit) throw Error(`Payload identity stamp names another commit for ${modulePath} (stamp ${commit}, pin ${pin}): ${stampPath}`);
    identity.push(Object.freeze({path: stampPath, module: modulePath, status: 'matched', commit}));
  }
  return Object.freeze(identity);
}

// Capabilities that the pinned upstream source intentionally does not build, or
// that are provided outside the shipped payload. They are recorded rather than
// required, so their absence is never reported as a stripped feature.
const cachyosFacts = Object.freeze({
  defaultDisabled: Object.freeze([
    Object.freeze({feature: 'steam-audio', defaultDisabled: true, reason: 'Pinned upstream default disables it (WITHOUT_STEAM_AUDIO). It is an optional capability: an explicit build opt-in is preserved, but it is not required payload.'}),
    Object.freeze({feature: 'zluda', defaultDisabled: true, reason: 'Pinned upstream default disables it (WITHOUT_ZLUDA_LIBS). It is a native-only optional capability with heavy ROCm dependencies: opt-in is preserved, but it is not required payload.'}),
  ]),
  runtimeProvided: Object.freeze([
    Object.freeze({feature: 'optiscaler', runtimeDownload: true, env: 'PROTON_USE_OPTISCALER', source: 'protonfixes/upscalers.py', installRoot: 'drive_c/windows/system32/umu/'}),
    Object.freeze({feature: 'streamline', runtimeDownload: true, env: 'PROTON_OPTISCALER_STREAMLINE', source: 'protonfixes/upscalers.py', installRoot: 'drive_c/windows/system32/umu/streamline/'}),
    Object.freeze({feature: 'dlss-upgrade', runtimeDownload: true, env: 'PROTON_DLSS_UPGRADE', source: 'protonfixes/upscalers.py', installPaths: Object.freeze(['drive_c/windows/system32/umu/nvngx_dlss.dll', 'drive_c/windows/system32/umu/nvngx_dlssd.dll', 'drive_c/windows/system32/umu/nvngx_dlssg.dll'])}),
    Object.freeze({feature: 'xess-upgrade', runtimeDownload: true, env: 'PROTON_XESS_UPGRADE', source: 'protonfixes/upscalers.py', installPaths: Object.freeze(['drive_c/windows/system32/umu/libxess.dll', 'drive_c/windows/system32/umu/libxess_dx11.dll', 'drive_c/windows/system32/umu/libxell.dll', 'drive_c/windows/system32/umu/libxess_fg.dll'])}),
    Object.freeze({feature: 'fsr4-upgrade', runtimeDownload: true, env: 'PROTON_FSR4_UPGRADE', source: 'protonfixes/upscalers.py', installPaths: Object.freeze(['drive_c/windows/system32/amdxcffx64.dll'])}),
    Object.freeze({feature: 'ffx3-upgrade', runtimeDownload: true, env: 'PROTON_FFX3_UPGRADE', source: 'protonfixes/upscalers.py', installPaths: Object.freeze(['drive_c/windows/system32/umu/amd_fidelityfx_vk.dll', 'drive_c/windows/system32/umu/amd_fidelityfx_dx12.dll'])}),
    Object.freeze({feature: 'ffx4-upgrade', runtimeDownload: true, env: 'PROTON_FFX4_UPGRADE', source: 'protonfixes/upscalers.py', installPaths: Object.freeze(['drive_c/windows/system32/umu/amd_fidelityfx_framegeneration_dx12.dll', 'drive_c/windows/system32/umu/amd_fidelityfx_loader_dx12.dll', 'drive_c/windows/system32/umu/amd_fidelityfx_upscaler_dx12.dll'])}),
    Object.freeze({feature: 'optiscaler-name', runtimeState: true, env: 'PROTON_OPTISCALER_NAME', source: 'protonfixes/upscalers.py', reason: 'Sets WINE_OPTISCALER_NAME, default dxgi.dll. No payload is shipped.'}),
    Object.freeze({feature: 'optiscaler-config', runtimeState: true, env: 'PROTON_OPTISCALER_CONFIG', source: 'protonfixes/upscalers.py', reason: 'Updates only existing options in the downloaded OptiScaler.ini. No payload is shipped.'}),
    Object.freeze({feature: 'shader-cache', runtimeState: true, env: 'PROTON_LOCAL_SHADER_CACHE', source: 'protonfixes/utilities.py', reason: 'Sets per-game cache paths under STEAM_COMPAT_SHADER_PATH. No payload is shipped.'}),
    Object.freeze({feature: 'steam-client-integration', reason: 'Steam-specific behavior cannot be proven for a non-Steam launcher without a Steam session.'}),
  ]),
  documentedOnly: Object.freeze([
    Object.freeze({feature: 'mlfg', env: 'PROTON_MLFG_UPGRADE', absentAtPin: true, documentedIn: 'official-docs 55e9191', reason: 'Absent from pinned proton, utilities.py and pinned protonfixes upscalers.py. Documented by a newer official docs profile.'}),
  ]),
  nativeCapabilities: Object.freeze([
    Object.freeze({
      feature: 'discord-bridge-env',
      env: 'PROTON_DISCORD_BRIDGE',
      kind: 'native-helper',
      sourceFiles: Object.freeze(['umu_helper/umu.c', 'steam_helper/steam.c']),
      setupFunction: 'setup_discord_bridge_service',
      setupPattern: 'env_nonzero( "PROTON_DISCORD_BRIDGE" )',
      callPattern: 'setup_discord_bridge_service();',
      servicePattern: 'StartServiceW',
      payload: 'files/lib/wine/discord-rpc-bridge/bridge.exe',
      payloadDetection: 'The pinned proton auto-detects the bridge.exe payload. The native helpers implement the environment-controlled service setup; actual service or game behavior is not proven.',
    }),
  ]),
  architectureLimits: Object.freeze([
    Object.freeze({arch: 'arm64', reason: 'The managed CachyOS variant declares x86_64 only; ARM64 and FEX parity are outside this payload contract.'}),
  ]),
});
const standardFacts = Object.freeze({
  defaultDisabled: Object.freeze([]),
  runtimeProvided: Object.freeze([]),
  documentedOnly: Object.freeze([]),
  nativeCapabilities: Object.freeze([
    Object.freeze({
      feature: 'discord-bridge-env',
      env: 'PROTON_DISCORD_BRIDGE',
      kind: 'native-helper',
      sourceFiles: Object.freeze(['umu_helper/umu.c']),
      setupFunction: 'setup_discord_bridge_service',
      setupPattern: 'env_nonzero( "PROTON_DISCORD_BRIDGE" )',
      callPattern: 'setup_discord_bridge_service();',
      servicePattern: 'StartServiceW',
      servicePath: 'c:\\windows\\system32\\discord\\bridge.exe --service',
      payloadDetection: 'Standard proton has no bridge payload detection and Standard required payload does not include bridge.exe; the native umu helper references the service path. actual service or game behavior is not proven.',
      reason: 'Standard has the native umu helper switch only. Its pinned proton has no bridge payload detection and its required payload contract does not include bridge.exe. Actual service behavior is not proven.',
    }),
  ]),
  architectureLimits: Object.freeze([]),
});

// Exact runtime download inputs from the pinned protonfixes source. The
// manifest URL is downloaded at runtime, so no version is pinned here. This is
// provenance for the audit and for optional cache validation; it is not a
// download request and the default tests never need an initialized submodule.
export const payloadRuntimeInputs = Object.freeze({
  pin: '8698fcf34c233773a26aba4412295c530f881fb6',
  source: 'protonfixes/upscalers.py',
  manifestUrl: 'https://loathingkernel.github.io/proton-upscalers/manifest.json',
  cacheDirectory: '${XDG_CACHE_HOME:-~/.cache}/protonfixes/upscalers',
  manifestCache: '${XDG_CACHE_HOME:-~/.cache}/protonfixes/upscalers/manifest.json',
  components: Object.freeze([
    Object.freeze({name: 'optiscaler', env: 'PROTON_USE_OPTISCALER', installRoot: 'drive_c/windows/system32/umu/'}),
    Object.freeze({name: 'streamline', env: 'PROTON_OPTISCALER_STREAMLINE', installRoot: 'drive_c/windows/system32/umu/streamline/'}),
    Object.freeze({name: 'dlss', env: 'PROTON_DLSS_UPGRADE', installPaths: Object.freeze(['drive_c/windows/system32/umu/nvngx_dlss.dll', 'drive_c/windows/system32/umu/nvngx_dlssd.dll', 'drive_c/windows/system32/umu/nvngx_dlssg.dll'])}),
    Object.freeze({name: 'xess', env: 'PROTON_XESS_UPGRADE', installPaths: Object.freeze(['drive_c/windows/system32/umu/libxess.dll', 'drive_c/windows/system32/umu/libxess_dx11.dll', 'drive_c/windows/system32/umu/libxell.dll', 'drive_c/windows/system32/umu/libxess_fg.dll'])}),
    Object.freeze({name: 'fsr4', env: 'PROTON_FSR4_UPGRADE', installPaths: Object.freeze(['drive_c/windows/system32/amdxcffx64.dll'])}),
    Object.freeze({name: 'ffx3', env: 'PROTON_FFX3_UPGRADE', installPaths: Object.freeze(['drive_c/windows/system32/umu/amd_fidelityfx_vk.dll', 'drive_c/windows/system32/umu/amd_fidelityfx_dx12.dll'])}),
    Object.freeze({name: 'ffx4', env: 'PROTON_FFX4_UPGRADE', installPaths: Object.freeze(['drive_c/windows/system32/umu/amd_fidelityfx_framegeneration_dx12.dll', 'drive_c/windows/system32/umu/amd_fidelityfx_loader_dx12.dll', 'drive_c/windows/system32/umu/amd_fidelityfx_upscaler_dx12.dll'])}),
  ]),
  config: Object.freeze([
    Object.freeze({env: 'PROTON_OPTISCALER_NAME', effect: 'Sets WINE_OPTISCALER_NAME, default dxgi.dll'}),
    Object.freeze({env: 'PROTON_OPTISCALER_CONFIG', effect: 'Updates only existing OptiScaler.ini options'}),
  ]),
  absentAtPin: Object.freeze([
    Object.freeze({env: 'PROTON_MLFG_UPGRADE', reason: 'Absent from pinned proton, utilities.py and pinned protonfixes upscalers.py'}),
  ]),
});

// Provenance matrix: every required feature is tied to the checked-in build
// fragment or pinned submodule that actually produces it. This is deliberately
// not a list of guessed output filenames. Features produced by the pinned Wine,
// wineopenxr or assembly sources are marked with that producer.
export const payloadProducers = Object.freeze([
  Object.freeze({feature: 'upstream-entry', producer: 'Makefile.in', evidence: Object.freeze(['PROTON_PY_TARGET := $(addprefix $(DST_BASE)/,proton)'])}),
  Object.freeze({feature: 'protonfixes', producer: 'Makefile.in', evidence: Object.freeze(['$(eval $(call rules-source,protonfixes,$(SRCDIR)/protonfixes))', '$(eval $(call rules-common,protonfixes,x86_64,unix))'])}),
  Object.freeze({feature: 'notices', producer: 'nexus/assemble-runtime.mjs', evidence: Object.freeze(['share/doc/nexus-runtime'])}),
  Object.freeze({feature: 'nexus-compat', producer: 'nexus/assemble-runtime.mjs', evidence: Object.freeze(['share/xodus-nexus/compat'])}),
  Object.freeze({feature: 'nexus-cloud-saves', producer: 'nexus/assemble-runtime.mjs', evidence: Object.freeze(['PlayFabGameSave.dll'])}),
  Object.freeze({feature: 'nexus-package-registration', producer: 'nexus/assemble-runtime.mjs', evidence: Object.freeze(['package-registration.exe'])}),
  Object.freeze({feature: 'default-prefix', producer: 'Makefile.in', evidence: Object.freeze(['default_pfx: wine gst_good'])}),
  Object.freeze({feature: 'wine-engine', producer: 'wine-submodule'}),
  Object.freeze({feature: 'x11', producer: 'wine-submodule'}),
  Object.freeze({feature: 'vulkan', producer: 'wine-submodule'}),
  Object.freeze({feature: 'audio-pulse', producer: 'wine-submodule'}),
  Object.freeze({feature: 'audio-alsa', producer: 'wine-submodule'}),
  Object.freeze({feature: 'media-gstreamer', producer: 'wine-submodule'}),
  Object.freeze({feature: 'openxr', producer: 'Makefile.in', evidence: Object.freeze(['WINEOPENXR64_JSON := $(DST_DIR)/share/openxr/wineopenxr64.json'])}),
  Object.freeze({feature: 'wayland', producer: 'wine-submodule'}),
  Object.freeze({feature: 'audio-pipewire', producer: 'wine-submodule'}),
  Object.freeze({feature: 'non-steam-umu', producer: 'Makefile.in', evidence: Object.freeze(['$(eval $(call rules-makedep,umuexe,x86_64))'])}),
  Object.freeze({feature: 'wine-mono', producer: 'Makefile.in', evidence: Object.freeze(['ln -s wine-mono-$(WINEMONO_VER) $(DIST_WINEMONO_DIR)/wine-mono'])}),
  Object.freeze({feature: 'controller-sdl', producer: 'Makefile.in', evidence: Object.freeze(['ln -s ../wine/mono/wine-mono/lib/x86_64/SDL3.dll $(DIST_XALIA_DIR)/SDL3.dll'])}),
  Object.freeze({feature: 'dxvk', producer: 'Makefile.in', evidence: Object.freeze(['DXVK_x86_64_MESON_ARGS = --bindir=$(DXVK_x86_64_DST)/lib/wine/dxvk/x86_64-windows'])}),
  Object.freeze({feature: 'dxvk-nvapi', producer: 'Makefile.in', evidence: Object.freeze(['DXVK_NVAPI_x86_64_MESON_ARGS = --bindir=$(DXVK_NVAPI_x86_64_DST)/lib/wine/nvapi/x86_64-windows'])}),
  Object.freeze({feature: 'vkd3d-proton', producer: 'Makefile.in', evidence: Object.freeze(['VKD3D_PROTON_x86_64_MESON_ARGS = --bindir=$(VKD3D_PROTON_x86_64_DST)/lib/wine/vkd3d-proton/x86_64-windows'])}),
  Object.freeze({feature: 'vkd3d-shader', producer: 'Makefile.in', evidence: Object.freeze(['cp $(VKD3D_x86_64_DST)/bin/libvkd3d-shader-1.dll $(VKD3D_x86_64_LIBDIR)/vkd3d/x86_64-windows'])}),
  Object.freeze({feature: 'wine-icu', producer: 'Makefile.in', evidence: Object.freeze(['ICU_x86_64_DIST_DIR := $(DST_LIBDIR)/wine/icu/x86_64-windows'])}),
  Object.freeze({feature: 'intel-gdext', producer: 'Makefile.in', evidence: Object.freeze(['-DCMAKE_INSTALL_BINDIR=$(DXVK_IGDEXT_x86_64_DST)/lib/wine/igdext/x86_64-windows'])}),
  Object.freeze({feature: 'd7vk', producer: 'extras/build-d7vk.mk', evidence: Object.freeze(['--bindir=$(D7VK_i386_DST)/lib/wine/d7vk/i386-windows'])}),
  Object.freeze({feature: 'dxvk-sarek', producer: 'extras/build-dxvk-sarek.mk', evidence: Object.freeze(['--bindir=$(DXVK_SAREK_x86_64_DST)/lib/wine/dxvk-sarek/x86_64-windows'])}),
  Object.freeze({feature: 'dxvk-low-latency', producer: 'extras/build-dxvk-low-latency.mk', evidence: Object.freeze(['--bindir=$(DXVK_LOW_LATENCY_x86_64_DST)/lib/wine/dxvk-low-latency/x86_64-windows'])}),
  Object.freeze({feature: 'vkd3d-low-latency', producer: 'extras/build-vkd3d-low-latency.mk', evidence: Object.freeze(['--bindir=$(VKD3D_LOW_LATENCY_x86_64_DST)/lib/wine/vkd3d-low-latency/x86_64-windows'])}),
  Object.freeze({feature: 'discord-rpc-bridge', producer: 'extras/build-discord-rpc-bridge.mk', evidence: Object.freeze(['$(DST_DIR)/lib/wine/discord-rpc-bridge'])}),
  Object.freeze({feature: 'nvidia-nvcuda', producer: 'nvidia-libs/build-nvcuda.mk', evidence: Object.freeze(['--libdir=lib/wine/nvidia-libs/nvcuda/x86_64-windows'])}),
  Object.freeze({feature: 'nvidia-nvenc', producer: 'nvidia-libs/build-nvenc.mk', evidence: Object.freeze(['--libdir=lib/wine/nvidia-libs/nvenc/x86_64-windows'])}),
  Object.freeze({feature: 'nvidia-nvml', producer: 'nvidia-libs/build-wine-nvml.mk', evidence: Object.freeze(['--libdir=lib/wine/nvidia-libs/nvml', '> $(DST_LIBDIR)/wine/nvidia-libs/nvml/version'])}),
  Object.freeze({feature: 'nvidia-nvoptix', producer: 'nvidia-libs/build-wine-nvoptix.mk', evidence: Object.freeze(['--libdir=lib/wine/nvidia-libs/nvoptix/x86_64-windows'])}),
  Object.freeze({feature: 'vulkan-reflex', producer: 'vklayers/build-dxvk-nvapi-vkreflex-layer.mk', evidence: Object.freeze(['-Dabsolute_library_path=false', '$(DST_DIR)/share/dxvk-nvapi-vkreflex-layer/implicit_layer.d/'])}),
  Object.freeze({feature: 'vulkan-low-latency', producer: 'vklayers/build-low_latency_layer.mk', evidence: Object.freeze(['$(DST_DIR)/share/low_latency_layer/implicit_layer.d/'])}),
  Object.freeze({feature: 'vulkan-vkbasalt', producer: 'vklayers/build-vkbasalt.mk', evidence: Object.freeze(['$(DST_DIR)/share/vkbasalt/implicit_layer.d/'])}),
  Object.freeze({feature: 'vulkan-pyroveil', producer: 'vklayers/build-pyroveil.mk', evidence: Object.freeze(['$(DST_DIR)/share/pyroveil/implicit_layer.d/', 'rsync --delete -arx $(PYROVEIL_SRC)/hacks $(DST_DIR)/share/pyroveil/'])}),
]);

export function payloadContract(family = 'nexus', {arch = 'x86_64'} = {}) {
  if (!families.includes(family)) throw Error('Unsupported runtime family');
  if (arch !== 'x86_64' && arch !== 'arm64') throw Error('Unsupported payload contract architecture');
  if (family === 'nexus-cachyos' && arch !== 'x86_64') throw Error('Unreviewed CachyOS payload architecture');
  const all = family === 'nexus-cachyos' ? [...commonEntries(), ...cachyosEntries()] : commonEntries();
  const entries = (arch === 'x86_64' ? all : all.filter(item => item.arch === 'any')).map(item => Object.freeze({...item}));
  const facts = family === 'nexus-cachyos' ? cachyosFacts : standardFacts;
  return Object.freeze({
    schema: 1,
    family,
    arch,
    scope: arch === 'x86_64' ? 'x86_64-full' : 'non-x86_64-minimal',
    entries: Object.freeze(entries),
    layerManifests: arch === 'x86_64' && family === 'nexus-cachyos' ? layerManifests : Object.freeze([]),
    defaultDisabled: facts.defaultDisabled,
    runtimeProvided: facts.runtimeProvided,
    documentedOnly: facts.documentedOnly,
    nativeCapabilities: facts.nativeCapabilities,
    architectureLimits: facts.architectureLimits,
  });
}

function safePayloadPath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\')) throw Error('Unsafe payload path: ' + relative);
  const parts = relative.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw Error('Unsafe payload path: ' + relative);
  const file = path.join(root, ...parts);
  if (!inside(root, file) || file === root) throw Error('Unsafe payload path: ' + relative);
  return file;
}

// Resolve a runtime path and reject any ancestor or final symlink whose real
// target leaves the runtime. Legit portable relative links inside the runtime
// remain accepted.
async function containedEntry(root, file, label, kind) {
  const relative = path.relative(root, file);
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep).some(part => !part || part === '.' || part === '..')) throw Error('Unsafe payload path: ' + label);
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') throw Error('Runtime payload missing: ' + label);
      throw error;
    }
    if (stat.isSymbolicLink()) {
      let resolved;
      try {
        resolved = await fs.realpath(current);
      } catch (error) {
        if (error.code === 'ENOENT') throw Error('Runtime payload missing: ' + label);
        throw error;
      }
      if (!inside(root, resolved)) throw Error('Runtime payload crosses an external symlink: ' + label);
    }
  }
  const real = await fs.realpath(file);
  if (!inside(root, real)) throw Error('Runtime payload resolves outside the runtime: ' + label);
  const stat = await fs.stat(real);
  if (kind === 'file' && !stat.isFile()) throw Error('Runtime payload is not a regular file: ' + label);
  if (kind === 'directory' && !stat.isDirectory()) throw Error('Runtime payload is not a directory: ' + label);
  return real;
}

async function containedFileIfPresent(root, file, label) {
  try {
    return await containedEntry(root, file, label, 'file');
  } catch (error) {
    if (error.code === 'ENOENT' || error.message.startsWith('Runtime payload missing: ')) return null;
    throw error;
  }
}

async function verifyLayerManifest(root, realFile, relative) {
  const mapping = layerLibraries[relative];
  if (!mapping) throw Error('No reviewed library mapping for layer manifest: ' + relative);
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(realFile, 'utf8'));
  } catch (error) {
    throw Error(`Invalid runtime layer manifest (${relative}): ${error.message}`);
  }
  const library = manifest?.layer?.library_path;
  if (typeof library !== 'string' || !library) throw Error('Layer manifest has no library_path: ' + relative);
  if (path.isAbsolute(library)) throw Error('Layer manifest library_path must be relative: ' + relative);
  if (library.includes('\\')) throw Error('Layer manifest library_path must be a Linux path: ' + relative);
  const base = path.posix.basename(library);
  if (base !== mapping.library) throw Error(`Layer manifest declares an unexpected library (${relative}): ${library}`);
  if (library.includes('/')) {
    const target = path.resolve(path.dirname(realFile), library);
    if (!inside(root, target)) throw Error('Layer manifest library_path escapes the runtime: ' + relative);
    await containedEntry(root, target, `${relative} -> ${library}`, 'file');
    return;
  }
  for (const directory of mapping.directories) {
    const candidate = path.join(root, ...directory.split('/'), base);
    if (await containedFileIfPresent(root, candidate, `${relative} -> ${directory}/${base}`)) return;
  }
  throw Error(`Layer library is missing (${relative}): ${base}`);
}

// Verify the copied payload on the assembled runtime. This runs after the
// portable-link pass so every check describes the final bytes and links.
export async function verifyRuntimePayload(runtime, {family = 'nexus', arch = 'x86_64', pins} = {}) {
  const contract = payloadContract(family, {arch});
  const root = await fs.realpath(runtime);
  const protonFile = await containedFileIfPresent(root, path.join(root, 'proton'), 'upstream-entry: proton');
  if (!protonFile) throw Error('Assembled runtime has no upstream entry script');
  const proton = await fs.readFile(protonFile, 'utf8');
  const verified = [];
  for (const item of contract.entries) {
    const file = safePayloadPath(root, item.path);
    const label = `${item.feature}: ${item.path}`;
    const real = await containedEntry(root, file, label, item.kind === 'directory' ? 'directory' : item.kind === 'symlink' ? 'any' : 'file');
    if (item.kind === 'symlink') {
      const stat = await fs.lstat(file);
      if (!stat.isSymbolicLink()) throw Error('Runtime payload is not a symlink: ' + label);
    }
    if (item.kind === 'layer-manifest') await verifyLayerManifest(root, real, item.path);
    if (item.executable) await fs.access(real, fs.constants.X_OK);
    if (item.selector && !proton.includes('"' + item.selector + '"')) throw Error(`Upstream entry script no longer selects ${item.selector} (${item.feature})`);
    const references = scriptReferences(item);
    if (references.length && !references.some(reference => proton.includes(reference))) throw Error(`Upstream entry script no longer references ${references.join(' or ')} (${item.feature})`);
    verified.push(Object.freeze({path: item.path, kind: item.kind, feature: item.feature, ...(item.selector ? {selector: item.selector} : {})}));
  }
  return Object.freeze({
    schema: 1,
    family,
    arch,
    scope: contract.scope,
    entries: Object.freeze(verified),
    layerManifests: contract.layerManifests,
    identity: await verifyPayloadIdentity(root, pins),
    features: Object.freeze([...new Set(verified.map(item => item.feature))]),
    defaultDisabled: contract.defaultDisabled,
    runtimeProvided: contract.runtimeProvided,
    documentedOnly: contract.documentedOnly,
    nativeCapabilities: contract.nativeCapabilities,
    architectureLimits: contract.architectureLimits,
  });
}
