#!/usr/bin/env python3
"""Stage existing companion releases for authenticated coordinator downloads."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def tree_digest(root):
    h = hashlib.sha256()
    for path in sorted(root.rglob('*')):
        if path.is_dir() and not path.is_symlink():
            continue
        content = os.readlink(path) if path.is_symlink() else digest(path)
        h.update(f'{path.relative_to(root)}\0{path.lstat().st_mode}\0{content}\n'.encode())
    return h.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path(os.environ.get('DSH_HOME', Path.home() / '.deepseek-harness')) / 'qianshou' / 'companion-downloads')
    args = parser.parse_args()
    app = Path(__file__).resolve().parents[1]
    version = json.loads((app / 'package.json').read_text())['version']
    output = args.output.expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    portable = json.loads((app / 'dist/portable/RELEASE_MANIFEST.json').read_text())
    sources = []
    for item in portable['targets']:
        platform = item['platform'] + '-' + item['arch']
        if platform not in ('win32-x64', 'linux-x64') or item['appVersion'] != version:
            raise SystemExit('Unexpected portable release version or platform')
        archive = Path(item['archive']['path'])
        if not archive.is_file() or digest(archive) != item['archive']['sha256']:
            raise SystemExit('Portable release checksum mismatch')
        sources.append((platform, archive, 'packaged-only'))
    mac = app / 'dist/千手协作端.app'
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(mac)], check=True)
    mac_digest = tree_digest(mac)
    mac_name = f'qianshou-companion-{version}-darwin-arm64.zip'
    needed = sum(path.stat().st_size for _, path, _ in sources) + 300 * 1024 * 1024
    if shutil.disk_usage(output).free - needed < 4 * 1024**3:
        raise SystemExit('Staging requires at least 4 GiB of free disk space afterwards')
    with tempfile.TemporaryDirectory(prefix='.stage-', dir=output) as temporary:
        temp = Path(temporary)
        zipped = temp / mac_name
        existing_mac = output / mac_name
        if existing_mac.exists():
            old = json.loads((output / 'manifest.json').read_text())
            entry = next(x for x in old['releases'] if x['id'] == 'darwin-arm64')
            if digest(existing_mac) != entry['sha256'] or old.get('sourceMacTreeSha256') != mac_digest:
                raise SystemExit('Existing Mac archive differs; stage a new directory for review')
            zipped = existing_mac
        else:
            subprocess.run(['ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(mac), str(zipped)], check=True)
            subprocess.run(['unzip', '-tq', str(zipped)], check=True, stdout=subprocess.DEVNULL)
        sources.insert(0, ('darwin-arm64', zipped, 'local-mac-verified'))
        releases = []
        for platform, source, validation in sources:
            filename = f'qianshou-companion-{version}-{platform}.' + ('tar.gz' if platform == 'linux-x64' else 'zip')
            sha = digest(source)
            destination = output / filename
            if destination.exists():
                if digest(destination) != sha:
                    raise SystemExit('Existing release differs; stage a new directory for review')
            else:
                staged = temp / ('copy-' + filename)
                shutil.copyfile(source, staged)
                staged.chmod(0o600)
                staged.replace(destination)
            releases.append(dict(id=platform, version=version, filename=filename, bytes=destination.stat().st_size, sha256=sha, validation=validation))
        manifest = temp / 'manifest.json'
        manifest.write_text(json.dumps(dict(version=1, sourceMacTreeSha256=mac_digest, releases=releases), ensure_ascii=False, indent=2) + '\n')
        manifest.chmod(0o600)
        manifest.replace(output / 'manifest.json')
    print(json.dumps(dict(directory=str(output), releases=releases), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
