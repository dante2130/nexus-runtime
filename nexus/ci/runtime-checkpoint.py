#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Transfer an unvalidated runtime between build and validation jobs at the same SHA."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tarfile


def digest(p):
    with p.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def read(p):
    return json.loads(p.read_text())


def context():
    sha = os.environ.get('GITHUB_SHA', '')
    if (os.environ.get('GITHUB_REPOSITORY') != 'domsvoboda/nexus-runtime'
            or os.environ.get('GITHUB_REF') != 'refs/heads/main'
            or not re.fullmatch('[0-9a-f]{40}', sha)):
        raise ValueError('Checkpoint requires the exact main workflow context')
    return sha


def write_new(p, value):
    with p.open('x') as f:
        json.dump(value, f, indent=2)
        f.write('\n')


def pack(root, target, members):
    subprocess.run(['tar', '--exclude=.git', '--exclude=./contrib',
                    '-I', 'zstd -T0 -3', '-cf', str(target), '-C', str(root), *members], check=True)


def safe_member(member, destination):
    parts = PurePosixPath(member.name).parts
    if member.name.startswith('/') or '..' in parts or '.git' in parts:
        raise ValueError('Unsafe checkpoint member')
    # Only the standard Wine DOS root link may point outside the archive.
    # No archived descendant may be extracted through it.
    if 'z:' in parts:
        if parts[-1] != 'z:':
            raise ValueError('Checkpoint entry below DOS root link')
        if (member.issym() and member.linkname == '/'
                and re.search(r'/files/share/default_pfx(?:_arm64)?/dosdevices/z:$', member.name)):
            return member
    filtered = tarfile.data_filter(member, destination)
    if member.issym() or member.islnk():
        base = Path(destination) / member.name if member.issym() else Path(destination) / 'entry'
        target = (base.parent / member.linkname).resolve()
        if '.git' in target.parts:
            raise ValueError('Checkpoint link targets Git metadata')
    # Preserve executable bits and directory modes for exact runtime tree checks.
    return filtered.replace(mode=member.mode & 0o777)


def unpack(archive, destination):
    process = subprocess.Popen(['zstd', '-dc', str(archive)], stdout=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=process.stdout, mode='r|') as source:
            source.extractall(destination, filter=safe_member)
        if process.wait() != 0:
            raise ValueError('Checkpoint decompression failed')
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.terminate()
            process.wait()


def create(output, fixtures, checkpoint):
    sha = context()
    built = read(output / 'built.json')
    source = Path(os.environ['GITHUB_WORKSPACE']).resolve()
    temp = Path(os.environ['RUNNER_TEMP']).resolve()
    if (built['graph']['proton'] != sha or Path(built['source']).resolve() != source
            or Path(built['runtime']).parent != output
            or Path(built['aux']) != temp / 'nexus-auxiliary'
            or Path(built['prepared']) != temp / 'nexus-work'
            or output != temp / 'nexus-output' or fixtures != temp / 'nexus-fixtures'):
        raise ValueError('Checkpoint source or path mismatch')
    proof = read(fixtures / 'fixtures.json')
    if proof['sourceGraph'] != built['graph']:
        raise ValueError('Checkpoint fixtures differ from runtime')
    if (output / 'candidate.json').exists():
        raise ValueError('Checkpoint is for unvalidated builds only')
    checkpoint.mkdir()
    pack(source, checkpoint / 'source.tar.zst', ['.'])
    pack(output, checkpoint / 'output.tar.zst', ['.'])
    pack(fixtures, checkpoint / 'fixtures.tar.zst', ['.'])
    media = read(temp / 'nexus-auxiliary/media/media-manifest.json')
    if not re.fullmatch(r'\d+\.\d+\.\d+', media['version']):
        raise ValueError('Invalid media source version')
    pack(temp, checkpoint / 'support.tar.zst', [
        'nexus-auxiliary/auxiliary.json', 'nexus-auxiliary/components', 'nexus-auxiliary/nghttp2-src',
        'nexus-auxiliary/media/media-manifest.json', 'nexus-auxiliary/media/stage',
        'nexus-auxiliary/media/ffmpeg-' + media['version'] + '.tar.xz',
        'nexus-work/prepared.json', 'nexus-work/runtime-dependency-sources'])
    write_new(checkpoint / 'checkpoint.json', {
        'schema': 1, 'kind': 'unvalidated-runtime-checkpoint', 'commit': sha,
        'architecture': built['metadata'].get('targetArchitecture', 'x86_64'),
        'sourceGraph': built['graph'], 'originalSource': str(source), 'originalTemp': str(temp),
        'builtSha256': digest(output / 'built.json'), 'fixturesSha256': digest(fixtures / 'fixtures.json'),
        'archives': {name: digest(checkpoint / name) for name in
                     ['source.tar.zst', 'output.tar.zst', 'fixtures.tar.zst', 'support.tar.zst']},
        'validated': False, 'published': False})


def restore(checkpoint, architecture):
    sha = context()
    info = read(checkpoint / 'checkpoint.json')
    names = ['source.tar.zst', 'output.tar.zst', 'fixtures.tar.zst', 'support.tar.zst']
    if (info.get('schema') != 1 or info.get('kind') != 'unvalidated-runtime-checkpoint'
            or info.get('commit') != sha or info.get('architecture') != architecture
            or info.get('validated') is not False or info.get('published') is not False
            or set(info.get('archives', {})) != set(names)
            or any(digest(checkpoint / n) != info['archives'][n] for n in names)):
        raise ValueError('Wrong or changed checkpoint')
    source = Path(os.environ['GITHUB_WORKSPACE']).resolve()
    temp = Path(os.environ['RUNNER_TEMP']).resolve()
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=source, text=True).strip()
    if head != sha or subprocess.check_output(['git', 'status', '--porcelain'], cwd=source, text=True).strip():
        raise ValueError('Restore requires a clean checkout at the exact workflow SHA')
    output, fixtures = temp / 'nexus-output', temp / 'nexus-fixtures'
    for p in [output, fixtures, temp / 'nexus-auxiliary', temp / 'nexus-work']:
        if p.exists():
            raise ValueError('Do not overwrite build work')
    output.mkdir()
    fixtures.mkdir()
    unpack(checkpoint / 'source.tar.zst', source)
    unpack(checkpoint / 'output.tar.zst', output)
    unpack(checkpoint / 'fixtures.tar.zst', fixtures)
    unpack(checkpoint / 'support.tar.zst', temp)
    if digest(output / 'built.json') != info['builtSha256'] or digest(fixtures / 'fixtures.json') != info['fixturesSha256']:
        raise ValueError('Restored metadata changed')
    built = read(output / 'built.json')
    if built['graph'] != info['sourceGraph'] or built['graph']['proton'] != sha:
        raise ValueError('Restored source graph mismatch')
    # Relocate paths only; source graph, SDK pins and every binary remain unchanged.
    name = built['name']
    if '/' in name or name in ['', '.', '..']:
        raise ValueError('Invalid runtime directory name')
    built.update(source=str(source), runtime=str(output / name), aux=str(temp / 'nexus-auxiliary'),
                 prepared=str(temp / 'nexus-work'))
    with (output / 'built.json').open('w') as f:
        json.dump(built, f, indent=2)
        f.write('\n')
    write_new(output / 'checkpoint-restored.json', {'commit': sha, 'validated': False,
              'checkpointSha256': digest(checkpoint / 'checkpoint.json'),
              'originalBuiltSha256': info['builtSha256'], 'relocatedBuiltSha256': digest(output / 'built.json')})


if __name__ == '__main__':
    if len(sys.argv) == 5 and sys.argv[1] == 'create':
        create(*(Path(p).resolve() for p in sys.argv[2:]))
    elif len(sys.argv) == 4 and sys.argv[1] == 'restore' and sys.argv[3] in ['x86_64', 'arm64']:
        restore(Path(sys.argv[2]).resolve(), sys.argv[3])
    else:
        raise SystemExit('Usage: runtime-checkpoint.py create OUTPUT FIXTURES NEW_CHECKPOINT | restore CHECKPOINT ARCH')
