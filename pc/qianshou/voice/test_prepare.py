"""Resource-integrity checks without network, model weights or global configuration."""
import hashlib
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import prepare


class Response(io.BytesIO):
    url = 'https://official.example/asset'


class ResourceIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='qianshou-asr-prepare-test-')
        self.root = Path(self.temporary.name).resolve()

    def tearDown(self):
        self.temporary.cleanup()

    def asset(self, data=b'pinned bytes'):
        return {'url': 'https://official.example/asset', 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

    def test_verified_resource_is_reused_without_network(self):
        destination = self.root / 'cache' / 'asset'
        with patch.object(prepare.urllib.request, 'urlopen', return_value=Response(b'pinned bytes')) as opener:
            self.assertEqual(prepare.fetch_locked(self.asset(), destination), destination)
            self.assertEqual(prepare.fetch_locked(self.asset(), destination), destination)
            self.assertEqual(opener.call_count, 1)
        self.assertEqual(destination.stat().st_mode & 0o777, 0o600)

    def test_truncated_oversized_and_wrong_hash_never_become_resources(self):
        for data in [b'pinned', b'pinned bytes and extra', b'other bytes!']:
            destination = self.root / 'cache' / 'asset'
            with patch.object(prepare.urllib.request, 'urlopen', return_value=Response(data)):
                with self.assertRaises(ValueError):
                    prepare.fetch_locked(self.asset(), destination)
            self.assertFalse(destination.exists())
            self.assertEqual(list(destination.parent.iterdir()), [])

    def test_existing_mismatched_resource_is_preserved(self):
        destination = self.root / 'asset'
        destination.write_bytes(b'existing owner file')
        with self.assertRaises(ValueError):
            prepare.fetch_locked(self.asset(), destination)
        self.assertEqual(destination.read_bytes(), b'existing owner file')

    def test_symlinks_and_non_private_destination_are_refused(self):
        alias = self.root / 'alias'
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            prepare.private_directory(alias / 'child')
        public = self.root / 'public'
        public.mkdir(mode=0o755)
        with self.assertRaises(ValueError):
            prepare.private_directory(public)

    def test_archive_traversal_and_symlinks_are_refused_without_extraction(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('whisper.cpp-test/link', tarfile.SYMTYPE)]:
            archive = self.root / 'source.tar.gz'
            with tarfile.open(archive, 'w:gz') as output:
                entry = tarfile.TarInfo(name)
                entry.type = kind
                entry.linkname = '/outside' if kind == tarfile.SYMTYPE else ''
                output.addfile(entry)
            with self.assertRaises(ValueError):
                prepare.extract(archive, self.root, 'test')
            self.assertFalse((self.root / 'whisper.cpp-test').exists())
            self.assertFalse(list(self.root.glob('.source-*')))


if __name__ == '__main__':
    unittest.main()
