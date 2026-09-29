#!/usr/bin/env python3
"""Install optional pinned local voice resources on macOS arm64, only on explicit invocation."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import uuid

from install_support import digest, extract_source, fetch_locked, private_directory, read_settings, write_settings

PACKAGE = Path(__file__).resolve().parent
DEFAULT_ROOT = Path.home() / '.local/share/qianshou-agent/voice'


def read_lock(name):
    return json.loads((PACKAGE / name).read_text())


def prerequisites(asr, tts):
    """Report prerequisites without installing software or changing application state."""
    issues = []
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        issues.append('This installer supports Apple Silicon macOS only; do not run it under Rosetta.')
    if sys.version_info[:2] != (3, 13):
        issues.append('Use native Python 3.13: brew install python@3.13')
    if platform.system() == 'Darwin' and int(platform.mac_ver()[0].split('.')[0]) < 15:
        issues.append('This installer supports macOS 15 or newer.')
    if asr:
        if not shutil.which('cmake'):
            issues.append('Install CMake: brew install cmake')
        result = subprocess.run(['/usr/bin/xcode-select', '-p'], capture_output=True) if platform.system() == 'Darwin' else None
        if result is None or result.returncode:
            issues.append('Install Apple Command Line Tools: xcode-select --install')
    if tts and not os.access('/opt/homebrew/bin/ffmpeg', os.X_OK):
        issues.append('Install the arm64 Homebrew ffmpeg used by the Host: brew install ffmpeg')
    return issues


def run(command, environment=None):
    """Run only installer-selected tools, without a shell or user Python path overrides."""
    print('Running:', ' '.join(str(part) for part in command), flush=True)
    subprocess.run([str(part) for part in command], check=True, env=environment)


def install_asr(root, cache):
    lock = read_lock('asr.lock.json')
    archive = fetch_locked(lock['source'], cache / 'whisper-source.tar.gz')
    extract_source(archive, root / 'source')
    source = root / 'source' / ('whisper.cpp-' + lock['source']['revision'])
    build = root / 'build'
    run([shutil.which('cmake'), '-S', source, '-B', build, '-DCMAKE_BUILD_TYPE=Release',
         '-DGGML_METAL=ON', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_EXAMPLES=ON'])
    run([shutil.which('cmake'), '--build', build, '--config', 'Release', '--parallel', str(min(4, os.cpu_count() or 1))])
    binary = build / 'bin/whisper-cli'
    if not os.access(binary, os.X_OK):
        raise RuntimeError('The whisper-cli build did not produce an executable')
    model = fetch_locked(lock['model'], cache / 'ggml-small-q5_1.bin')
    run([binary, '--help'])
    return {'binary': str(binary), 'model': str(model)}


def install_tts(root, cache):
    private_directory(root)
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith(('PYTHON', 'PIP_', 'HF_', 'HUGGING_FACE'))}
    environment.update({'PIP_CONFIG_FILE': os.devnull, 'PIP_DISABLE_PIP_VERSION_CHECK': '1'})
    run([sys.executable, '-m', 'venv', root / 'venv'], environment)
    python = root / 'venv/bin/python'
    run([python, '-m', 'pip', '--isolated', 'install', '--index-url', 'https://pypi.org/simple',
         '--only-binary=:all:', '--require-hashes', '--no-deps', '-r', PACKAGE / 'requirements.lock.txt'], environment)
    run([python, '-m', 'pip', '--isolated', 'check'], environment)
    model_lock = read_lock('tts-model.lock.json')
    model = cache / 'Qwen3-TTS-12Hz-1.7B-CustomVoice-4bit'
    for entry in model_lock['files']:
        filename = Path(entry['path'])
        if filename.is_absolute() or '..' in filename.parts:
            raise ValueError('Invalid model path in package lock')
        asset = {**entry, 'url': f"https://huggingface.co/{model_lock['repository']}/resolve/{model_lock['revision']}/{entry['path']}"}
        print('Verifying model:', entry['path'], flush=True)
        fetch_locked(asset, model / filename)
    worker = root / 'worker.py'
    worker_lock = read_lock('worker.lock.json')
    if digest(PACKAGE / 'worker.py') != worker_lock['sha256']:
        raise ValueError('The bundled worker differs from its recorded SHA-256')
    shutil.copyfile(PACKAGE / 'worker.py', worker)
    worker.chmod(0o600)
    run([python, '-c', 'import mlx.core, mlx_audio, numpy, scipy; print("Local voice dependencies loaded")'], environment)
    return {'python': str(python), 'worker': str(worker), 'model': str(model)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--asr', action='store_true', help='Install local Chinese recognition (~190 MB model + native build)')
    parser.add_argument('--tts', action='store_true', help='Install optional Serena/Vivian neural speech (~2.32 GB model + Python wheels)')
    parser.add_argument('--check', action='store_true', help='Check prerequisites only; no downloads, writes, or restarts')
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT, help='Resource root; the packaged app auto-reads only the default root')
    args = parser.parse_args()
    if not (args.asr or args.tts):
        parser.error('Choose --asr, --tts, or both; add --check for a read-only prerequisite check')
    issues = prerequisites(args.asr, args.tts)
    if issues:
        for issue in issues:
            print('Required:', issue, file=sys.stderr)
        print('See the bundled README.zh.md / README.md, then rerun this command.', file=sys.stderr)
        return 1
    if args.check:
        print('Prerequisites available. No resources installed or settings changed.')
        return 0
    root = private_directory(args.root.expanduser())
    settings_path = root / 'voice-settings.json'
    lock_path = root / '.install.lock'
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another local voice installation is running') from None
        original, _ = read_settings(settings_path)
        # Every invocation owns a new build/venv, leaving previously configured assets untouched.
        release = private_directory(root / 'releases' / ('0.2.0-' + uuid.uuid4().hex[:12]))
        cache = private_directory(root / 'downloads' / '0.2.0')
        changes = {}
        if args.asr:
            changes['asr'] = install_asr(release / 'asr', cache / 'asr')
        if args.tts:
            changes['tts'] = install_tts(release / 'tts', cache / 'tts')
        write_settings(settings_path, changes, original)
    print(f'Installed resources; settings written to {settings_path}')
    print('Finish active tasks, then quit and reopen Qianshou to load these settings. The installer does not restart it.')
    print('Choose a system voice or Serena/Vivian, play a sample, then enable the microphone when ready.')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f'Installation stopped: {error}', file=sys.stderr)
        print('Existing application settings and previously installed resources remain intact. Fix the reported issue and rerun.', file=sys.stderr)
        sys.exit(1)
