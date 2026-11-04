# Nexus runtime build

This is an independent, unofficial integration of Proton Experimental, Wine and
the C++ XGameRuntime. It is not an official Valve or Xodus distribution.

Source dependencies are exact recursive Git submodules. The SDK, supplementary
libraries and the shader patch are pinned in `inputs.lock.json`. Keep the
submodules at their recorded revisions.

Run source checks with Node.js 22 or newer:

```sh
node nexus/check-source.mjs
node --test nexus/*.test.mjs nexus/tests/*.test.mjs nexus/runtime-compat/*.test.mjs
```

Source tests require CMake, GNU Make, rsync, GCC and both MinGW architectures.
The complete build additionally requires the pinned Proton SDK and Docker or
rootless Podman. Auxiliary native libraries must target glibc 2.35 or older.

Assembly verifies the shared upstream payload after the copy: the Wine engine and
DXVK/VKD3D-Proton renderers, DXVK-NVAPI, ICU, Intel GDExt, wine-mono, Xalia, the
OpenXR loader, the non-Steam umu helper, the default prefix and the Nexus
compatibility modules. A missing payload output or entry-script reference fails
closed. `node --test nexus/runtime-payload-contract.test.mjs` checks that
contract on synthetic redistributions.

The same pass verifies the declared source notice inputs before the output
directory exists and stages only the verified bytes. The shared manifest covers
the DXVK renderer with its directx, SPIRV-Headers, Vulkan-Headers, dxbc-spirv,
spirv_headers and libdisplay-info build inputs, plus Intel GDExt, VKD3D,
VKD3D-Proton and DXVK-NVAPI. When the prepared source graph supplies the module
pins, a payload `version` stamp that names another commit is rejected; an absent
or Git-less stamp is recorded as unverifiable and is not proof of source
identity.

From a clean `main` checkout with all recursive submodules initialized:

```sh
node nexus/build-auxiliary.mjs --work /absolute/new-auxiliary-directory
node nexus/build-runtime.mjs /absolute/auxiliary-directory /absolute/new-work-directory /absolute/new-output-directory
```

Set `NEXUS_CONTAINER_ENGINE=podman` for rootless Podman and
`NEXUS_BUILD_JOBS=16` to select a bounded worker count. Add `--resume` to the
same build command only when resuming its exact existing SDK configuration.
Work and output directories must be isolated from games and installed runtimes.

Build output is an unvalidated Experimental candidate, not an installation or
release. Native tests and game validation are separate. Keep corresponding
sources and all applicable licenses with any redistributed binaries.

## Retrying CI validation

The x86_64 and ARM64 candidate workflows keep compilation and native validation
in separate jobs. After a validation failure, use **Re-run failed jobs** to reuse
the compiled runtime and fixtures from the same workflow commit. Checkpoint
artifacts are retained for seven days and are unvalidated until all native gates
pass. A different source commit requires a new build.

Auxiliary dependencies are cached by their recipe, input locks, architecture and
runner image. Restored dependencies are verified before use.
