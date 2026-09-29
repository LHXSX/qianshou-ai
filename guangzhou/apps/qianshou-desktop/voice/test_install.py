"""Offline installer tests; no user resources, package installation, or model execution."""
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import install
from install_support import extract_source, fetch_locked, private_directory, read_settings, write_settings


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()

    def test_download_exposes_only_size_and_hash_verified_bytes(self):
        contents = b'locked model'
        asset = {'url': 'https://example.invalid/model', 'bytes': len(contents),
                 'sha256': hashlib.sha256(contents).hexdigest()}
        target = self.root / 'model.bin'
        calls = []

        def open_bytes(request, timeout):
            calls.append(request.full_url)
            return io.BytesIO(contents)

        self.assertEqual(fetch_locked(asset, target, open_bytes), target)
        self.assertEqual(target.read_bytes(), contents)
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        fetch_locked(asset, target, open_bytes)
        self.assertEqual(len(calls), 1)

    def test_failed_download_leaves_no_partial_or_final_file(self):
        asset = {'url': 'https://example.invalid/model', 'bytes': 4, 'sha256': '0' * 64}
        for contents in (b'same', b'oversized', b'no'):
            with self.assertRaises(ValueError):
                fetch_locked(asset, self.root / 'model.bin', lambda *args, **kwargs: io.BytesIO(contents))
            self.assertEqual(list(self.root.iterdir()), [])

    def test_existing_modified_resource_is_preserved(self):
        target = self.root / 'model.bin'
        target.write_bytes(b'user content')
        with self.assertRaisesRegex(ValueError, 'preserve'):
            fetch_locked({'url': 'https://example.invalid', 'bytes': 1, 'sha256': '0' * 64}, target)
        self.assertEqual(target.read_bytes(), b'user content')

    def test_archive_rejects_traversal_links_and_devices_before_extracting(self):
        for name, kind in (('../outside', tarfile.REGTYPE), ('/absolute', tarfile.REGTYPE),
                           ('link', tarfile.SYMTYPE), ('hardlink', tarfile.LNKTYPE), ('device', tarfile.CHRTYPE)):
            archive = self.root / 'source.tar.gz'
            with tarfile.open(archive, 'w:gz') as output:
                member = tarfile.TarInfo(name)
                member.type = kind
                member.linkname = '../outside'
                output.addfile(member)
            with self.assertRaisesRegex(ValueError, 'Unsafe'):
                extract_source(archive, self.root / 'source')
            self.assertEqual(list((self.root / 'source').iterdir()), [])

    def test_normal_source_archive_extracts(self):
        archive = self.root / 'source.tar.gz'
        with tarfile.open(archive, 'w:gz') as output:
            member = tarfile.TarInfo('source/CMakeLists.txt')
            member.size = 4
            output.addfile(member, io.BytesIO(b'test'))
        extract_source(archive, self.root / 'source')
        self.assertEqual((self.root / 'source/source/CMakeLists.txt').read_bytes(), b'test')

    def test_settings_merge_preserves_unselected_voice_and_unknown_fields(self):
        path = self.root / 'voice-settings.json'
        original = {'version': 1, 'tts': {'python': '/current/python', 'worker': '/current/worker', 'model': '/current/model'},
                    'future': {'keep': True}}
        path.write_text(json.dumps(original))
        before, _ = read_settings(path)
        write_settings(path, {'asr': {'binary': '/new/whisper', 'model': '/new/model'}}, before)
        actual = json.loads(path.read_text())
        self.assertEqual(actual['tts'], original['tts'])
        self.assertEqual(actual['future'], original['future'])
        self.assertEqual(actual['asr']['binary'], '/new/whisper')
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        backup, = list(self.root.glob('voice-settings.backup-*.json'))
        self.assertEqual(backup.read_bytes(), before)

    def test_concurrent_edit_and_invalid_settings_are_never_replaced(self):
        path = self.root / 'voice-settings.json'
        path.write_text('{"version": 1, "userChange": true}')
        with self.assertRaisesRegex(ValueError, 'changed during'):
            write_settings(path, {'tts': {}}, None)
        self.assertTrue(json.loads(path.read_text())['userChange'])
        path.write_text('{"version": 2}')
        with self.assertRaisesRegex(ValueError, 'version 1'):
            read_settings(path)

    def test_symlink_destination_does_not_modify_target(self):
        real = self.root / 'real'
        real.mkdir()
        (self.root / 'link').symlink_to(real, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            private_directory(self.root / 'link/new')
        self.assertEqual(list(real.iterdir()), [])

    def test_check_does_not_download_or_create_resources(self):
        destination = self.root / 'resources'
        with patch('sys.argv', ['install.py', '--asr', '--check', '--root', str(destination)]), \
             patch.object(install, 'prerequisites', return_value=[]), \
             patch.object(install, 'install_asr') as install_asr:
            self.assertEqual(install.main(), 0)
        self.assertFalse(destination.exists())
        install_asr.assert_not_called()

    def test_unsupported_platform_stops_before_writing(self):
        destination = self.root / 'resources'
        with patch('sys.argv', ['install.py', '--tts', '--root', str(destination)]), \
             patch.object(install.platform, 'system', return_value='Linux'), \
             patch.object(install.platform, 'machine', return_value='x86_64'):
            self.assertEqual(install.main(), 1)
        self.assertFalse(destination.exists())

    def test_bundled_worker_matches_lock_without_importing_model_code(self):
        worker = install.PACKAGE / 'worker.py'
        actual = hashlib.sha256(worker.read_bytes()).hexdigest()
        self.assertEqual(actual, install.read_lock('worker.lock.json')['sha256'])
        compile(worker.read_text(), str(worker), 'exec')


if __name__ == '__main__':
    unittest.main()
