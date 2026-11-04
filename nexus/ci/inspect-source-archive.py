#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Read-only bounded inspection of declared members in a corresponding source archive.

The tool never extracts anything and writes no file. It streams the xz compressed
tar through the standard library and reads only the records it needs, so a
hardlink entry is never silently turned into a regular file and the declared
payload reads stay bounded:

* every declared member must be a regular tar entry, not a link, directory or
  device
* every declared member is size bounded per entry and in total, and only the
  bytes described by its own header are read, in fixed chunks
* the actual archived bytes are hashed and compared with the expected digest
* a declared member must occur exactly once
* any non-directory entry that is an ancestor of a declared member is rejected

The guarantee is bounded declared payload reads plus a member count limit, not a
general purpose sandbox against arbitrary archive metadata. The standard tar
parser still allocates per member headers, and the spawn call has a wall clock
timeout, so the tool must only ever run on an archive this pipeline produced.

Usage: python3 -I inspect-source-archive.py < request.json
The request is {"archive": absolute path, "expected": [{"name", "sha256"}]}.
The response is {"ok": true, "members": n, "bytes": n} or
{"ok": false, "error": message}. The exit status is non-zero on failure.
"""
import hashlib
import json
import sys
import tarfile

MAX_MEMBER = 2 * 1024 * 1024
MAX_TOTAL = 8 * 1024 * 1024
MAX_MEMBERS = 200000
CHUNK = 65536


def fail(message):
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(1)


def is_safe_name(name):
    if not isinstance(name, str) or not name or name.startswith("/") or "\\" in name:
        return False
    return all(part not in ("", ".", "..") for part in name.split("/"))


def main():
    try:
        request = json.load(sys.stdin)
    except ValueError as error:
        fail("invalid request json: %s" % error)
    archive = request.get("archive")
    declared = request.get("expected")
    if not isinstance(archive, str) or not archive or not isinstance(declared, list) or not declared:
        fail("an absolute archive path and a non-empty expected list are required")
    expected = {}
    for item in declared:
        if not isinstance(item, dict):
            fail("invalid expected entry")
        name = item.get("name")
        digest = item.get("sha256")
        if not is_safe_name(name) or not isinstance(digest, str) or len(digest) != 64:
            fail("invalid expected entry: %r" % (name,))
        if name in expected and expected[name] != digest:
            fail("conflicting expected hashes for %s" % name)
        expected[name] = digest
    ancestors = set()
    for name in expected:
        parts = name.split("/")
        for index in range(1, len(parts)):
            ancestors.add("/".join(parts[:index]))
    seen = {}
    total = 0
    members = 0
    try:
        tar = tarfile.open(archive, mode="r|xz")
    except (tarfile.TarError, OSError) as error:
        fail("cannot read archive %s: %s" % (archive, error))
    with tar:
        for member in tar:
            members += 1
            if members > MAX_MEMBERS:
                fail("archive has too many members")
            name = member.name
            if not is_safe_name(name):
                fail("unsafe member name in archive: %s" % name)
            if name in expected:
                if not member.isreg():
                    fail("declared member is not a regular tar entry: %s" % name)
                if member.size > MAX_MEMBER:
                    fail("declared member exceeds the %d byte limit: %s" % (MAX_MEMBER, name))
                total += member.size
                if total > MAX_TOTAL:
                    fail("declared members exceed the %d byte total limit" % MAX_TOTAL)
                data = tar.extractfile(member)
                if data is None:
                    fail("declared member has no readable data: %s" % name)
                digest = hashlib.sha256()
                remaining = member.size
                while remaining > 0:
                    chunk = data.read(min(CHUNK, remaining))
                    if not chunk:
                        fail("declared member is truncated: %s" % name)
                    digest.update(chunk)
                    remaining -= len(chunk)
                if data.read(1):
                    fail("declared member is longer than its header: %s" % name)
                if digest.hexdigest() != expected[name]:
                    fail("archived bytes do not match the declared sha256: %s" % name)
                seen[name] = seen.get(name, 0) + 1
                if seen[name] > 1:
                    fail("archive repeats a declared member: %s" % name)
            elif name in ancestors:
                if not member.isdir():
                    fail("archive stores a non-directory entry for an ancestor of a declared member: %s" % name)
    missing = [name for name in expected if name not in seen]
    if missing:
        fail("archive omits declared members: %s" % ", ".join(sorted(missing)))
    print(json.dumps({"ok": True, "members": len(expected), "bytes": total}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
