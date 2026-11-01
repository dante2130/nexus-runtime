// SPDX-License-Identifier: MIT
import path from 'node:path';
export function sourceArchiveArgs(archive,source,auxiliary,prepared,mediaVersion) {
  if([archive,source,auxiliary,prepared].some(p=>!path.isAbsolute(p))||!/^\d+\.\d+\.\d+$/.test(mediaVersion))throw Error('Exact source archive inputs required');
  return ['--exclude=.git','--exclude=./contrib','--transform=s,^\\./,source/,','-cJf',archive,'-C',source,'.','-C',auxiliary,'nghttp2-src','auxiliary.json','media/ffmpeg-'+mediaVersion+'.tar.xz','media/media-manifest.json','-C',prepared,'prepared.json','runtime-dependency-sources'];
}
