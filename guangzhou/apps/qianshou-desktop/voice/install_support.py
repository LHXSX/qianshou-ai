"""Private, verified resource writes for the explicitly invoked voice installer."""
import hashlib
import json
import os
from pathlib import Path
import tarfile
import tempfile
import urllib.request


def digest(path):
    """Hash a file without retaining model weights in memory."""
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def private_directory(path):
    """Create installer directories; reject symlinks in the destination ancestry."""
    path = Path(os.path.abspath(path))
    for parent in (path, *path.parents):
        if parent.is_symlink():
            raise ValueError(f'Refusing symlink destination: {parent}')
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def fetch_locked(asset, destination, opener=urllib.request.urlopen):
    """Stream one pinned HTTPS resource; only verified complete bytes become visible."""
    private_directory(destination.parent)
    if destination.is_symlink():
        raise ValueError(f'Refusing symlink resource: {destination}')
    if destination.exists():
        if destination.stat().st_size == asset['bytes'] and digest(destination) == asset['sha256']:
            return destination
        raise ValueError(f'Existing resource differs from the lock; preserve and inspect it: {destination}')
    if not asset['url'].startswith('https://'):
        raise ValueError('Locked downloads require HTTPS')
    descriptor, temporary = tempfile.mkstemp(prefix='.download-', dir=destination.parent)
    try:
        checksum = hashlib.sha256()
        total = 0
        with os.fdopen(descriptor, 'wb') as output:
            request = urllib.request.Request(asset['url'], headers={'User-Agent': 'QianshouVoiceInstaller/0.2.0'})
            with opener(request, timeout=60) as response:
                while chunk := response.read(1024 * 1024):
                    total += len(chunk)
                    if total > asset['bytes']:
                        raise ValueError('Download exceeds the locked resource size')
                    checksum.update(chunk)
                    output.write(chunk)
            if total != asset['bytes'] or checksum.hexdigest() != asset['sha256']:
                raise ValueError('Download size or SHA-256 differs from the lock')
            output.flush()
            os.fsync(output.fileno())
        # An exclusive link also protects a file created while the request was pending.
        os.link(temporary, destination)
        return destination
    finally:
        Path(temporary).unlink(missing_ok=True)


def extract_source(archive, destination):
    """Extract a verified source archive without links, devices, or paths outside its root."""
    private_directory(destination)
    with tarfile.open(archive, 'r:gz') as source:
        members = source.getmembers()
        for member in members:
            path = Path(member.name)
            if path.is_absolute() or '..' in path.parts or not (member.isdir() or member.isfile()):
                raise ValueError(f'Unsafe source archive entry: {member.name}')
        source.extractall(destination, members=members, filter='data')


def read_settings(path):
    """Read the current versioned overlay without accepting symlink or oversized data."""
    if path.is_symlink():
        raise ValueError('Refusing a symlink voice-settings.json')
    if not path.exists():
        return None, {'version': 1}
    if path.stat().st_size > 65536:
        raise ValueError('voice-settings.json exceeds 64 KiB')
    original = path.read_bytes()
    data = json.loads(original)
    if not isinstance(data, dict) or data.get('version') != 1:
        raise ValueError('voice-settings.json must be a version 1 object')
    return original, data


def write_settings(path, changes, original):
    """Merge selected families, preserving all other settings and refusing concurrent edits."""
    current, settings = read_settings(path)
    if current != original:
        raise ValueError('voice-settings.json changed during installation; rerun to merge it safely')
    settings.update(changes)
    private_directory(path.parent)
    descriptor, temporary = tempfile.mkstemp(prefix='.settings-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as output:
            json.dump(settings, output, ensure_ascii=False, indent=2)
            output.write('\n')
            output.flush()
            os.fsync(output.fileno())
        if original is not None:
            backup_fd, backup = tempfile.mkstemp(prefix='voice-settings.backup-', suffix='.json', dir=path.parent)
            with os.fdopen(backup_fd, 'wb') as output:
                output.write(original)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)
