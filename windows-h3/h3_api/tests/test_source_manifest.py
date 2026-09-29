"""No-network, no-GPU negative controls for the canonical source gate."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
import uuid


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "workbench"))
from source_manifest import FrozenBinary, FrozenOptionalFile, RuntimeSourceManifest, SourceManifestError


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


class ManifestControls(unittest.TestCase):
    def setUp(self):
        base = os.environ.get("H3_CANONICAL_TEST_ROOT")
        if not base or not Path(base).is_absolute() or not sys.dont_write_bytecode:
            self.fail("Set an explicit absolute H3_CANONICAL_TEST_ROOT and run Python -B")
        self.root = Path(base) / ("source-manifest-" + uuid.uuid4().hex)
        self.root.mkdir(parents=True)
        self.api = self.root / "api"
        self.comfy = self.root / "comfy"
        self.api.mkdir()
        self.comfy.mkdir()
        (self.api / "unit.py").write_bytes(b"VALUE = 1\n")
        (self.comfy / "main.py").write_bytes(b"VALUE = 2\n")
        formats = self.comfy / "custom_nodes/ComfyUI-VideoHelperSuite/video_formats"
        formats.mkdir(parents=True)
        (formats / "h264-mp4.json").write_bytes(b"{}\n")
        self.manifest = self.api / "canonical-manifest.json"
        document = {
            "schemaVersion": 1,
            "runtimeSourceFiles": [
                self._entry("h3_api", "unit.py", self.api / "unit.py"),
                self._entry("comfy", "main.py", self.comfy / "main.py"),
            ],
            "runtimeAuxiliaryFiles": [self._entry(
                "comfy", "custom_nodes/ComfyUI-VideoHelperSuite/video_formats/h264-mp4.json",
                formats / "h264-mp4.json")],
            "runtimeInventoryRoots": [
                {"area": area, "relativeDir": ".", "extension": ".py", "recursive": True}
                for area in ("h3_api", "comfy")],
            "runtimeInventoryExcludeDirs": [
                {"area": "comfy", "relativeDir": name} for name in sorted({
                    ".git", "custom_nodes/ComfyUI-KJNodes/.git",
                    "custom_nodes/ComfyUI_LayerStyle/.git",
                    "custom_nodes/ComfyUI-VideoHelperSuite/.git",
                    "models", "input", "output", "temp", "user"})],
            "runtimeAuxiliaryInventoryDirs": [
                {"area": "comfy", "relativeDir": "custom_nodes/ComfyUI-VideoHelperSuite/video_formats",
                 "extension": ".json", "recursive": False}],
            "requiredGraphClassTypes": ["BasicGuider"],
        }
        self.manifest.write_text(json.dumps(document, sort_keys=True, separators=(",", ":")),
                                 encoding="utf-8")

    @staticmethod
    def _entry(area, relative, path):
        raw = path.read_bytes()
        return {"area": area, "path": relative, "origin": "synthetic-test",
                "size": len(raw), "rawSha256": sha(raw)}

    def test_startup_and_inventory_change(self):
        guard = RuntimeSourceManifest(self.api, self.comfy, self.manifest)
        self.assertEqual(guard.check(), sha(self.manifest.read_bytes()))
        (self.comfy / "added.py").write_bytes(b"VALUE = 3\n")
        with self.assertRaises(SourceManifestError):
            guard.check()

    def test_auxiliary_change(self):
        guard = RuntimeSourceManifest(self.api, self.comfy, self.manifest)
        format_file = self.comfy / "custom_nodes/ComfyUI-VideoHelperSuite/video_formats/h264-mp4.json"
        format_file.write_bytes(b'{"changed":true}\n')
        with self.assertRaises(SourceManifestError):
            guard.check()

    def test_hardlink_refused(self):
        os.link(self.api / "unit.py", self.root / "outside-hardlink.py")
        with self.assertRaises(SourceManifestError):
            RuntimeSourceManifest(self.api, self.comfy, self.manifest)

    def test_binary_generation(self):
        encoder = self.root / "encoder.exe"
        encoder.write_bytes(b"synthetic-encoder")
        guard = FrozenBinary(encoder)
        self.assertEqual(guard.check(), sha(b"synthetic-encoder"))
        if os.name == "nt":
            with self.assertRaises(OSError):
                encoder.write_bytes(b"tampered")

    def test_manifest_read_handle_shared_across_two_processes(self):
        guard = RuntimeSourceManifest(self.api, self.comfy, self.manifest)
        module_root = Path(__file__).resolve().parents[1] / "workbench"
        program = ("import hashlib,sys;sys.path.insert(0,sys.argv[1]);"
                   "from source_manifest import _HeldFile;from pathlib import Path;"
                   "held=_HeldFile(Path(sys.argv[2]));print(hashlib.sha256(held.read()[0]).hexdigest())")
        child = subprocess.run([sys.executable, "-B", "-c", program,
                                str(module_root), str(self.manifest)],
                               check=True, capture_output=True, text=True, timeout=10)
        self.assertEqual(child.stdout.strip(), guard.sha256)
        self.assertEqual(guard.check(), guard.sha256)

    def test_four_boundary_checks_fail_closed_before_delivery(self):
        guard = RuntimeSourceManifest(self.api, self.comfy, self.manifest)
        for stage in ("startup", "submit", "before_gpu"):
            with self.subTest(stage=stage):
                self.assertEqual(guard.check(), guard.sha256)
        format_file = self.comfy / "custom_nodes/ComfyUI-VideoHelperSuite/video_formats/h264-mp4.json"
        format_file.write_bytes(b'{"changed":true}\n')
        with self.assertRaises(SourceManifestError):
            guard.check()  # final delivery cannot be marked attested

    def test_absent_private_model_paths_remain_absent(self):
        optional = self.comfy / "extra_model_paths.yaml"
        guard = FrozenOptionalFile(optional)
        self.assertIsNone(guard.check())
        optional.write_bytes(b"synthetic: {}\n")
        with self.assertRaises(SourceManifestError):
            guard.check()


if __name__ == "__main__":
    unittest.main()
