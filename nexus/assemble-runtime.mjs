// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import {project,readJson,sha256} from './inputs.mjs';
import {copySdkRedistribution,makeSdkLinksPortable} from './runtime-copy.mjs';
import {targets} from './target.mjs';
import {moduleCapabilities} from './module-capabilities.mjs';
import {buildPackageRegistration} from './package-registration.mjs';
import {verifyRuntimeDependencies} from './runtime-dependency-sources.mjs';
export async function assembleRuntime({work,build,redist,source,wine,aux,output,name,inputs,graph,auxiliary,lockHash,target=targets.x86_64}){
const proton={requiresBackendVersion:inputs.requiresBackendVersion};
await fs.mkdir(output,{recursive:false});
const runtime=path.join(output,name);
await copySdkRedistribution(redist,runtime);
const files=path.join(runtime,'files'),components={};
for(const [arch,hash] of Object.entries(auxiliary.libraries)){
  if(!target.peArchitectures.includes(arch))throw Error('Unexpected architecture');
  const bytes=await fs.readFile(path.join(aux,'components',arch,'libnghttp2.dll'));
  if(sha256(bytes)!==hash)throw Error('nghttp2 checksum mismatch');
  await fs.writeFile(path.join(files,'lib/wine',arch+'-windows/libnghttp2.dll'),bytes,{flag:'wx'});
}
const compat=path.join(files,'share/xodus-nexus/compat');await fs.mkdir(compat,{recursive:true});
for(const name of ['PlayFabGameSave.dll','gaming-services-version.exe','wine-launcher']){
  const bytes=await fs.readFile(path.join(aux,'components',name));
  if(sha256(bytes)!==auxiliary.compatibility[name])throw Error('Compatibility checksum mismatch');
  if(name==='wine-launcher'){
    await fs.rename(path.join(files,target.bin,'wine'),path.join(files,target.bin,'wine.nexus-original'));
    await fs.writeFile(path.join(files,target.bin,'wine'),bytes,{flag:'wx',mode:0o755});
  }else await fs.writeFile(path.join(compat,name),bytes,{flag:'wx'});
}
const registrationSha256=await buildPackageRegistration(wine,path.join(compat,'package-registration.exe'));
// Every target ships the pinned vkd3d shader DLL (ARM64X on ARM64). The HLSL
// keyword feature stays x86_64-only until ARM64 runs its contract probe.
const prefixComponents=['kernelbase.dll','xgameruntime.dll','winhttp.dll','mscoree.dll','windows.web.dll','twinapi.appcore.dll','libnghttp2.dll','libvkd3d-shader-1.dll','d3d8.dll','d3d9.dll','d3d10core.dll','d3d11.dll','dxgi.dll'];
for(const name of prefixComponents){
  const sub=name==='libvkd3d-shader-1.dll'?'vkd3d':['d3d8.dll','d3d9.dll','d3d10core.dll','d3d11.dll','dxgi.dll'].includes(name)?'wine/dxvk':'wine';
  const file=path.join(files,'lib',sub,target.primaryPe+'-windows',name),bytes=await fs.readFile(file);
  components[name]=sha256(bytes);
  const dest=path.join(files,'share',target.prefix,'drive_c/windows/system32',name);
  const temporary=dest+'.nexus-runtime';await fs.writeFile(temporary,bytes,{flag:'wx'});await fs.rename(temporary,dest);
}
// Keep portable media separate from the SDK-built Wine. Existing libraries are
// never silently replaced by the auxiliary bundle.
const media=await readJson(path.join(aux,'media/media-manifest.json'));
for(const [triplet,architecture]of Object.entries(media.architectures)){
const libdir=path.join(files,'lib',triplet);
for(const [soname,item] of Object.entries(architecture.libraries)){
  try{await fs.access(path.join(libdir,soname));continue;}catch(e){if(e.code!=='ENOENT')throw e;}
  const bytes=await fs.readFile(path.join(aux,'media/stage/usr/lib',triplet,item.filename));
  if(sha256(bytes)!==item.sha256)throw Error('Media checksum mismatch');
  await fs.writeFile(path.join(libdir,item.filename),bytes,{flag:'wx'});
  if(soname!==item.filename)await fs.symlink(item.filename,path.join(libdir,soname));
}
}
const notices=path.join(files,'share/doc/nexus-runtime');await fs.mkdir(notices,{recursive:true});
// Keep the emulator's pinned upstream notice with the binary redistribution.
await fs.copyFile(path.join(source,'FEX/LICENSE'),path.join(notices,'FEX-LICENSE'),fs.constants.COPYFILE_EXCL);
for(const [name,sourceFile] of [['runtime-compat-LICENSE',path.join(project,'LICENSE')],['NOTICE',path.join(project,'NOTICE')],['nghttp2-LICENSE',path.join(aux,'components/nghttp2-LICENSE')],['Wine-LICENSE',path.join(wine,'COPYING.LIB')],['TomCrypt-LICENSE',path.join(wine,'libs/tomcrypt/LICENSE')],['xgameruntime-LICENSE',path.join(wine,'dlls/xgameruntime/LICENSE')],['DXVK-LICENSE',path.join(source,'dxvk/LICENSE')],['VKD3D-LICENSE',path.join(source,'vkd3d/COPYING')],['FFmpeg-COPYING.LGPLv2.1',path.join(aux,'media/ffmpeg-'+media.version+'/COPYING.LGPLv2.1')]])await fs.copyFile(sourceFile,path.join(notices,name));
const metadata={schema:1,status:'experimental',description:'Independent Nexus runtime built from pinned official Proton Experimental sources.',baseProtonCommit:inputs.upstream.proton,patchState:graph.proton,sourceLockSha256:lockHash,requiresBackendVersion:proton.requiresBackendVersion,components,runtimeCompatibility:auxiliary.compatibility,features:['cloud-saves-pr28','xodus-tcp-bridge-v1','package-locale','xuser-contract-v1','xuser-windows-account-metadata-v1','wine-winhttp-http2-v1','nghttp2-v1','winrt-json-v1','xasync-provider-contract-v1','xtaskqueue-lifecycle-v1','playfab-package-save-folder-v1','xstore-entitlements-v1','xstore-durable-license-v1','xstore-related-discovery-v1','xpackage-content-v1','xstore-package-license-v1','hlsl-state-keywords-v1','appmodel-package-identity-v1','appstate-registration-v1','appconstrained-registration-v1','xtaskqueue-repeat-termination-v1','xgame-relaunch-current-user-v1','dxvk-constant-compare-v1'].filter(feature=>target.primaryPe==='x86_64'||feature!=='hlsl-state-keywords-v1')};
metadata.sourceGraph=graph;
metadata.packageRegistration={schema:1,sha256:registrationSha256,provider:'WineVerifiedXvd-v1'};
metadata.runtimeDependencies=await verifyRuntimeDependencies(files,inputs[target.sdk]);
metadata.features.push('verified-package-registration-v1');
metadata.features.push(...await moduleCapabilities(path.join(wine,'dlls/xgameruntime')));
// `components` are the primary PE directory's checksums; arm64 launchers look
// them up by PE directory, so a non-x86_64 target names its directory too.
if(target.name!=='x86_64')Object.assign(metadata,{targetArchitecture:target.name,binDirectory:target.bin,defaultPrefix:target.prefix,auxiliaryToolchain:auxiliary.toolchain,componentsByArch:{[target.primaryPe+'-windows']:components}});
metadata.requiresLauncherVersion=inputs.requiresLauncherVersion;
metadata.componentsByArchitecture={};
for(const arch of target.peArchitectures){
  const module=await fs.readFile(path.join(files,'lib/wine',arch+'-windows/xgameruntime.dll'));
  const marker=Buffer.alloc(32);marker.write('Wine builtin DLL');
  if(!module.subarray(64,96).equals(marker))throw Error('C++ module is not a Wine builtin: '+arch);
  metadata.componentsByArchitecture[arch]={'xgameruntime.dll':sha256(module)};
}
metadata.realGameTest=false;metadata.stableApproved=false;
metadata.baseWineSha256=sha256(await fs.readFile(path.join(files,target.bin,'wine.nexus-original')));
await fs.writeFile(path.join(runtime,'XODUS_NEXUS_PATCH.json'),JSON.stringify(metadata,null,2)+'\n',{flag:'wx'});
const links=await makeSdkLinksPortable(runtime,build);
await fs.writeFile(path.join(output,'built.json'),JSON.stringify({schema:1,name,runtime,metadata,inputs,graph,source,prepared:work,aux,links},null,2)+'\n',{flag:'wx'});
console.log('Built an isolated Experimental candidate. Native validation is still required.');


}
