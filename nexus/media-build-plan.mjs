// SPDX-License-Identifier: MIT
export function mediaBuildTargets(arch) {
  const targets = {
    x64: [
      {triplet: 'x86_64-linux-gnu', machine: 'Advanced Micro Devices X86-64', options: []},
      {triplet: 'i386-linux-gnu', machine: 'Intel 80386', options: ['--cc=gcc -m32', '--arch=x86', '--cpu=i686']},
    ],
    arm64: [{triplet: 'aarch64-linux-gnu', machine: 'AArch64', options: []}],
  };
  if (!Object.hasOwn(targets, arch)) throw Error('Unsupported media build host.');
  return targets[arch];
}

export function mediaRuntimeArchitectures(target) {
  return target.name === 'x86_64' ? ['x86_64-linux-gnu', 'i386-linux-gnu'] : ['aarch64-linux-gnu'];
}
