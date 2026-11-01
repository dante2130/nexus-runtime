#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Stage missing codec dependencies from the exact Proton SDK, never the host."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess

ARCHES = {"x86_64-linux-gnu": "Advanced Micro Devices X86-64",
          "i386-linux-gnu": "Intel 80386", "aarch64-linux-gnu": "AArch64"}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inspect_library(path, soname, machine):
    def read(*args):
        return subprocess.check_output(["readelf", *args, str(path)], text=True,
                                       env={**os.environ, "LC_ALL": "C"})
    if machine not in read("-h") or f"Library soname: [{soname}]" not in read("-d"):
        raise ValueError(f"Wrong SDK library architecture or SONAME: {soname}")
    versions = [(int(a), int(b)) for a, b in re.findall(r"GLIBC_(\d+)\.(\d+)", read("--version-info"))]
    if max(versions, default=(0, 0)) > (2, 35):
        raise ValueError(f"SDK media dependency exceeds portable glibc ceiling: {soname}")


def stage(files, sdk, lock, sdk_root=Path("/usr")):
    files = files.resolve(strict=True)
    if sdk not in lock["sdkImages"] or not (files / "lib").is_dir():
        raise ValueError("Exact SDK and isolated redistribution files are required")
    output = files / "share/xodus-nexus/media-dependencies"
    output.mkdir(parents=True, exist_ok=False)
    (output / "licenses").mkdir()
    rows = []
    for arch, machine in ARCHES.items():
        destination = files / "lib" / arch
        if not (destination / "gstreamer-1.0").is_dir():
            continue
        for soname in lock["libraries"]:
            # Preserve a dependency already built by Proton. The portable-link
            # pass later validates SDK symlinks in the ordinary way.
            target = destination / soname
            if target.exists() or target.is_symlink():
                inspect_library(target, soname, machine)
                continue
            original = (sdk_root / "lib" / arch / soname).resolve(strict=True)
            if original.parent != (sdk_root / "lib" / arch).resolve() or original.stat().st_size > 32 * 1024 * 1024:
                raise ValueError(f"Unsafe SDK dependency: {soname}")
            inspect_library(original, soname, machine)
            owner = subprocess.check_output(["dpkg-query", "-S", str(original)], text=True).split(": ")[0]
            source, version, binary_version = subprocess.check_output(
                ["dpkg-query", "-W", "-f=${source:Package}\t${source:Version}\t${Version}", owner],
                text=True).split("\t")
            pin = lock["sources"].get(source)
            if not pin or pin["version"] != version:
                raise ValueError(f"Unpinned SDK source package: {source} {version}")
            package = owner.split(":")[0]
            if not re.fullmatch(r"[a-z0-9+.-]+", package):
                raise ValueError("Unsafe SDK package name")
            copyright = (sdk_root / "share/doc" / package / "copyright").resolve(strict=True)
            license_file = output / "licenses" / (package + ".copyright")
            shutil.copyfile(copyright, license_file)
            actual = destination / original.name
            if actual.exists() or actual.is_symlink():
                raise ValueError(f"Refusing conflicting library target: {actual.name}")
            shutil.copyfile(original, actual)
            if actual.name != soname:
                target.symlink_to(actual.name)
            rows.append({"architecture": arch, "soname": soname, "filename": actual.name,
                         "sha256": digest(actual), "sourcePackage": source, "sourceVersion": version,
                         "binaryPackage": owner, "binaryVersion": binary_version,
                         "copyright": "licenses/" + license_file.name,
                         "copyrightSha256": digest(license_file)})
    manifest = {"schema": 1, "sdk": sdk, "libraries": rows,
                "sources": {r["sourcePackage"]: lock["sources"][r["sourcePackage"]] for r in rows}}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", type=Path)
    parser.add_argument("--sdk", required=True)
    args = parser.parse_args()
    lock = json.loads(Path(__file__).with_name("runtime-dependencies.lock.json").read_text())
    result = stage(args.files, args.sdk, lock)
    print(f"Staged {len(result['libraries'])} pinned SDK media dependencies")
