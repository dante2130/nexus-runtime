// SPDX-License-Identifier: MIT
import fs from 'node:fs/promises';
import path from 'node:path';
import {project,run,sha256} from './inputs.mjs';
import {peMachine} from './pe.mjs';
export async function buildPackageRegistration(wine, output) {
  // This source and all verifier headers are part of the checked source graph.
  // Like gaming-services-version.exe, the x64 helper also runs through FEX on ARM64.
  const source=path.join(project,'runtime-compat/package-registration.c');
  const headers=path.join(wine,'dlls/windows.applicationmodel');
  run('x86_64-w64-mingw32-gcc',['-O2','-Wall','-Wextra','-Werror','-municode',
    '-Wl,--no-insert-timestamp','-I',headers,source,'-ladvapi32','-lbcrypt','-o',output],project);
  const bytes=await fs.readFile(output);
  if(peMachine(bytes)!=='x86_64')throw Error('Wrong package registrar architecture');
  return sha256(bytes);
}
