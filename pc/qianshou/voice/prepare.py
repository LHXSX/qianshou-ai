#!/usr/bin/env python3
"""Prepare pinned local ASR in an explicit private directory; no global configuration writes."""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request


def digest(path):
    """Hash one file without retaining model weights in memory."""
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def private_directory(path):
    """Reject symbolic-link ancestors before writing installer-owned files."""
    for parent in (path, *path.parents):
        if parent.is_symlink():
            raise ValueError('Resource root must not contain symbolic links')
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
        raise ValueError('Resource directories must be owned by this user with mode 0700')
    return path


def fetch_locked(asset, destination):
    """Publish only exact locked bytes; incomplete downloads never replace a resource."""
    private_directory(destination.parent)
    if destination.is_symlink():
        raise ValueError('Refusing symbolic-link resource')
    if destination.exists():
        if destination.stat().st_size == asset['bytes'] and digest(destination) == asset['sha256']:
            return destination
        raise ValueError('Existing resource differs from lock; inspect it without automatic deletion')
    if not asset['url'].startswith('https://'):
        raise ValueError('Resource URL must use HTTPS')
    descriptor, temporary = tempfile.mkstemp(prefix='.download-', dir=destination.parent)
    try:
        checksum = hashlib.sha256()
        total = 0
        with os.fdopen(descriptor, 'wb') as output:
            request = urllib.request.Request(asset['url'], headers={'User-Agent': 'QianshouVoicePrepare/1'})
            with urllib.request.urlopen(request, timeout=60) as response:
                if not response.url.startswith('https://'):
                    raise ValueError('Resource redirect must use HTTPS')
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > asset['bytes']:
                        raise ValueError('Download exceeds locked byte count')
                    checksum.update(chunk)
                    output.write(chunk)
            if total != asset['bytes'] or checksum.hexdigest() != asset['sha256']:
                raise ValueError('Download bytes or SHA-256 differ from lock')
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, destination)
        return destination
    finally:
        Path(temporary).unlink(missing_ok=True)


def extract(archive, parent, revision):
    """Extract verified regular files into a fresh private root and publish atomically."""
    destination = parent / ('whisper.cpp-' + revision)
    if destination.exists():
        raise ValueError('Source already exists without a completed manifest; use another explicit root')
    staging = Path(tempfile.mkdtemp(prefix='.source-', dir=parent))
    try:
        with tarfile.open(archive, 'r:gz') as bundle:
            members = bundle.getmembers()
            if len(members) > 10000 or sum(member.size for member in members) > 256 * 1024 * 1024:
                raise ValueError('Source archive exceeds extraction limits')
            for member in members:
                path = Path(member.name)
                if path.is_absolute() or '..' in path.parts or not (member.isdir() or member.isfile()):
                    raise ValueError('Source archive contains an unsafe entry')
            bundle.extractall(staging, members=members, filter='data')
        os.rename(staging / destination.name, destination)
        return destination
    finally:
        shutil.rmtree(staging)


def prepare(args):
    """Build one immutable local ASR installation and write a resource manifest."""
    if sys.version_info < (3, 12):
        raise ValueError('Python 3.12 or later is required')
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise ValueError('This preparation recipe currently supports macOS arm64 only')
    cmake = shutil.which('cmake')
    if cmake is None:
        raise ValueError('CMake must already be installed')
    subprocess.run(['xcode-select', '-p'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
    root = Path(args.root)
    if not root.is_absolute():
        raise ValueError('--root must be an absolute private output directory')
    if args.check:
        print('Prerequisites available; no resource or configuration files written.')
        return
    private_directory(root)
    lock_path = root / '.prepare.lock'
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as install_lock:
        fcntl.flock(install_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        lock = json.loads((Path(__file__).parent / 'asr.lock.json').read_text())
        manifest_path = root / 'manifest.json'
        if manifest_path.is_symlink():
            raise ValueError('Refusing symbolic-link manifest')
        if manifest_path.exists():
            manifest = json.loads(manifest_path.read_text())
            binary = root / 'build/bin/whisper-cli'
            model = root / 'cache/ggml-small-q5_1.bin'
            if manifest['resources'] != lock or digest(binary) != manifest['binarySha256'] or digest(model) != lock['model']['sha256']:
                raise ValueError('Existing installation changed; inspect it without automatic replacement')
            print('Existing pinned local ASR installation verified.')
            return
        cache = private_directory(root / 'cache')
        archive = fetch_locked(lock['source'], cache / 'whisper.cpp.tar.gz')
        print('Source bytes and SHA-256 verified.', flush=True)
        model = fetch_locked(lock['model'], cache / 'ggml-small-q5_1.bin')
        print('Model bytes and SHA-256 verified.', flush=True)
        source = extract(archive, root, lock['source']['revision'])
        build = root / 'build'
        environment = {'PATH': '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', 'LANG': 'en_US.UTF-8'}
        with (root / 'build.log').open('x') as log:
            subprocess.run([cmake, '-S', str(source), '-B', str(build), '-DCMAKE_BUILD_TYPE=Release',
                            '-DGGML_METAL=ON', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_EXAMPLES=ON'],
                           env=environment, stdout=log, stderr=log, check=True)
            subprocess.run([cmake, '--build', str(build), '--config', 'Release', '--parallel', str(args.jobs),
                            '--target', 'whisper-cli'], env=environment, stdout=log, stderr=log, check=True)
        binary = build / 'bin/whisper-cli'
        licenses = private_directory(root / 'licenses')
        for license_file in (Path(__file__).parent / 'licenses').iterdir():
            if license_file.is_file():
                shutil.copyfile(license_file, licenses / license_file.name)
        manifest = {'installedAt': datetime.now(timezone.utc).isoformat(), 'platform': platform.system(),
                    'architecture': platform.machine(), 'resources': lock, 'binaryPath': str(binary),
                    'binarySha256': digest(binary), 'modelPath': str(model), 'modelBytes': model.stat().st_size,
                    'modelSha256': digest(model), 'scope': 'explicit private directory; microphone unverified'}
        with manifest_path.open('x') as output:
            json.dump(manifest, output, ensure_ascii=False, indent=2)
            output.write('\n')
        print('Local ASR built; manifest.json contains explicit Host resource paths.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--jobs', type=int, choices=range(1, 33), default=4)
    try:
        prepare(parser.parse_args())
    except Exception as error:
        print(f'ASR preparation failed: {type(error).__name__}: {error}', file=sys.stderr)
        sys.exit(1)
