// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileHash} from './ci/provenance.mjs';
export const sdkNoticeNames=Object.freeze(['GCC-runtime-copyright','MinGW-runtime-copyright','libxml2-COPYING']);
export async function verifySdkNotices(runtime,project){
  for(const name of sdkNoticeNames){
    const source=path.join(project,'licenses',name),target=path.join(runtime,'files/share/doc/nexus-runtime',name);
    if(!(await fs.lstat(target)).isFile()||await fileHash(target)!==await fileHash(source))throw Error('Required SDK notice missing or changed: '+name);
  }
}
export async function stageSdkNotices(runtime,project){
  const directory=path.join(runtime,'files/share/doc/nexus-runtime');await fs.mkdir(directory,{recursive:true});
  for(const name of sdkNoticeNames){
    try{await fs.copyFile(path.join(project,'licenses',name),path.join(directory,name),fs.constants.COPYFILE_EXCL);}
    catch(error){if(error.code!=='EEXIST')throw error;}
  }
  await verifySdkNotices(runtime,project);
}
