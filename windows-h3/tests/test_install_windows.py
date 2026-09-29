"""Installer guard tests; no vendor clone, service start, or GPU operation."""

from __future__ import annotations

import importlib.util
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("canonical_install_windows", ROOT / "install_windows.py")
assert SPEC and SPEC.loader
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)
PREPARE_SPEC = importlib.util.spec_from_file_location("canonical_prepare_python", ROOT / "prepare_python_windows.py")
assert PREPARE_SPEC and PREPARE_SPEC.loader
prepare = importlib.util.module_from_spec(PREPARE_SPEC)
PREPARE_SPEC.loader.exec_module(prepare)
LAUNCH_SPEC = importlib.util.spec_from_file_location("canonical_launch_windows", ROOT / "launch_windows.py")
assert LAUNCH_SPEC and LAUNCH_SPEC.loader
launcher = importlib.util.module_from_spec(LAUNCH_SPEC)
LAUNCH_SPEC.loader.exec_module(launcher)


class InstallGuards(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        # Retain test directories for inspection; no recursive cleanup follows.
        work = ROOT.parents[2] / "canonical-install-guard-tests"
        work.mkdir(exist_ok=True)
        cls.stage = Path(tempfile.mkdtemp(prefix="guard-", dir=work))

    def test_new_root_refuses_existing_directory(self) -> None:
        existing = self.stage / "existing"
        existing.mkdir()
        with self.assertRaisesRegex(RuntimeError, "已存在"):
            installer.check_new_root(existing)

    def test_slot_initializes_once_and_never_rewrites_state(self) -> None:
        directory = self.stage / "new-slot"
        directory.mkdir()
        state = directory / "gpu.json"
        self.assertEqual(installer.check_slot(state, True), state)
        installer.initialize_slot(state)
        before = state.read_bytes()
        self.assertEqual(json.loads(before)["occupant"], None)
        self.assertEqual(installer.check_slot(state, False), state)
        with self.assertRaisesRegex(RuntimeError, "已存在"):
            installer.check_slot(state, True)
        self.assertEqual(state.read_bytes(), before)

    def test_unknown_and_partial_slot_remain_untouched(self) -> None:
        directory = self.stage / "bad-slot"
        directory.mkdir()
        state = directory / "gpu.json"
        state.write_text('{"occupant":"unknown"}', encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "仅存在其一"):
            installer.check_slot(state, False)
        lock = directory / "gpu.json.lock"
        lock.write_bytes(b"\0")
        with self.assertRaisesRegex(RuntimeError, "未知"):
            installer.check_slot(state, False)
        self.assertEqual(state.read_text(encoding="utf-8"), '{"occupant":"unknown"}')

    def test_busy_port_is_rejected(self) -> None:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            with self.assertRaisesRegex(RuntimeError, "监听"):
                installer.check_port(listener.getsockname()[1])

    def test_private_model_paths_have_fixed_categories(self) -> None:
        models = self.stage / "custom-model-layout"
        models.mkdir()
        for role, (category, filename) in installer.MODEL_FILES.items():
            parent = models / ("官方版本全" if category == "vae" else category + "（固定）")
            parent.mkdir(exist_ok=True)
            (parent / filename).write_bytes(role.encode("ascii"))
        found = installer.discover_models(models)
        self.assertEqual(set(found), set(installer.MODEL_FILES))
        raw = installer.model_yaml(found)
        self.assertEqual(raw.count("canonical_models:"), 1)
        for category in ("diffusion_models", "text_encoders", "vae", "loras"):
            self.assertIn("  " + category + ": |", raw)
        self.assertIn("官方版本全", raw)
        duplicate = models / "duplicate"
        duplicate.mkdir()
        (duplicate / installer.MODEL_FILES["clip"][1]).write_bytes(b"other")
        with self.assertRaisesRegex(RuntimeError, "不唯一"):
            installer.discover_models(models)

    def test_wheelhouse_rejects_modified_bytes(self) -> None:
        directory = self.stage / "wheelhouse"
        directory.mkdir()
        name = "example-1.0-py3-none-any.whl"
        original = b"synthetic test bytes"
        wheel = directory / name
        wheel.write_bytes(original)
        locked = {"wheels": {"example==1.0": {
            "filename": name, "sha256": hashlib.sha256(original).hexdigest()}}}
        prepare.verify_wheelhouse(directory, locked)
        wheel.write_bytes(original + b"changed")
        with self.assertRaisesRegex(RuntimeError, "SHA256"):
            prepare.verify_wheelhouse(directory, locked)

    def test_git_executable_rejects_unlocked_bytes_before_execution(self) -> None:
        directory = self.stage / "fake-git" / "mingw64" / "bin"
        directory.mkdir(parents=True)
        candidate = directory / "git.exe"
        candidate.write_bytes(b"not the pinned Git engine")
        with self.assertRaisesRegex(RuntimeError, "SHA256"):
            installer.check_git_executable(candidate, {
                "observedSha256": "0" * 64, "observedVersion": "2.54.0.windows.1"})

    def test_prepared_receipt_binds_wheels_and_every_installed_file(self) -> None:
        verify = installer.receipt_function("verify_receipt")
        write = installer.receipt_function("write_receipt")
        root = self.stage / "prepared-candidate"
        wheels = root / "wheels"
        wheels.mkdir(parents=True)
        api_python = root / "api" / "Scripts" / "python.exe"
        comfy_python = root / "comfy" / "Scripts" / "python.exe"
        for python in (api_python, comfy_python):
            python.parent.mkdir(parents=True)
            python.write_bytes(b"synthetic interpreter")
        package_file = root / "comfy" / "Lib" / "site-packages" / "example.py"
        package_file.parent.mkdir(parents=True)
        package_file.write_bytes(b"synthetic installed package")
        (root / "prepare.log").write_bytes(b"offline install completed\n")
        (root / "api-requirements.txt").write_bytes(b"synthetic\n")
        (root / "comfy-requirements.txt").write_bytes(b"synthetic\n")
        locked_wheels = {}
        for index in range(128):
            name = f"wheel-{index:03d}.whl"
            content = f"synthetic wheel {index}".encode("ascii")
            (wheels / name).write_bytes(content)
            locked_wheels[f"wheel-{index:03d}==1.0"] = {
                "filename": name, "sha256": hashlib.sha256(content).hexdigest()}
        lock_dir = self.stage / "receipt-locks"
        lock_dir.mkdir()
        dependency_lock = lock_dir / "dependencies.lock.json"
        wheel_lock = lock_dir / "python-wheels.lock.json"
        dependency_lock.write_text(json.dumps({"schemaVersion": 2,
                                               "scope": installer.SCOPE}), encoding="utf-8")
        wheel_lock.write_text(json.dumps({"schemaVersion": 1,
                                         "scope": installer.SCOPE,
                                         "target": {"python": "3.12.10",
                                                    "implementation": "CPython",
                                                    "platform": "win_amd64"},
                                         "wheels": locked_wheels}), encoding="utf-8")
        receipt = write(root, dependency_lock, wheel_lock)
        receipt_sha = installer.sha256(receipt)
        self.assertEqual(verify(receipt, dependency_lock, wheel_lock,
                                api_python, comfy_python,
                                expected_sha256=receipt_sha), receipt_sha)
        with self.assertRaisesRegex(RuntimeError, "已存在"):
            write(root, dependency_lock, wheel_lock)
        with self.assertRaisesRegex(RuntimeError, "解释器"):
            verify(receipt, dependency_lock, wheel_lock,
                   comfy_python, api_python, expected_sha256=receipt_sha)
        package_file.write_bytes(b"changed installed package")
        with self.assertRaisesRegex(RuntimeError, "当前字节"):
            verify(receipt, dependency_lock, wheel_lock,
                   api_python, comfy_python, expected_sha256=receipt_sha)
        package_file.write_bytes(b"synthetic installed package")
        extra = package_file.parent / "unexpected.py"
        extra.write_bytes(b"extra")
        with self.assertRaisesRegex(RuntimeError, "当前字节"):
            verify(receipt, dependency_lock, wheel_lock,
                   api_python, comfy_python, expected_sha256=receipt_sha)
        extra.unlink()
        package_file.unlink()
        with self.assertRaisesRegex(RuntimeError, "当前字节"):
            verify(receipt, dependency_lock, wheel_lock,
                   api_python, comfy_python, expected_sha256=receipt_sha)
        package_file.write_bytes(b"synthetic installed package")
        empty = package_file.parent / "unexpected-empty-package"
        empty.mkdir()
        with self.assertRaisesRegex(RuntimeError, "当前字节"):
            verify(receipt, dependency_lock, wheel_lock,
                   api_python, comfy_python, expected_sha256=receipt_sha)
        empty.rmdir()
        os.link(api_python, api_python.with_name("python-copy.exe"))
        with self.assertRaisesRegex(RuntimeError, "链接"):
            verify(receipt, dependency_lock, wheel_lock,
                   api_python, comfy_python, expected_sha256=receipt_sha)
        api_python.with_name("python-copy.exe").unlink()
        (wheels / "wheel-000.whl").write_bytes(b"modified wheel")
        with self.assertRaisesRegex(RuntimeError, "wheelhouse"):
            verify(receipt, dependency_lock, wheel_lock,
                   api_python, comfy_python, expected_sha256=receipt_sha)
        (wheels / "wheel-000.whl").write_bytes(b"synthetic wheel 0")
        self.assertEqual(verify(receipt, dependency_lock, wheel_lock,
                                api_python, comfy_python,
                                expected_sha256=receipt_sha), receipt_sha)
        receipt.write_bytes(receipt.read_bytes() + b"\n")
        with self.assertRaisesRegex(RuntimeError, "原字节"):
            verify(receipt, dependency_lock, wheel_lock,
                   api_python, comfy_python, expected_sha256=receipt_sha)

    def test_launcher_rejects_modified_control_file(self) -> None:
        root = self.stage / "launcher-check"
        control = root / "control"
        api = root / "source" / "api"
        comfy = root / "source" / "comfy"
        private = root / "private"
        for directory in (control / "tests", control / "comfy", api, comfy, private,
                          root / "mingw64" / "bin",
                          root / "models", root / "input", root / "output",
                          root / "adapter", root / "workflows", root / "temp", root / "user"):
            directory.mkdir(parents=True, exist_ok=True)
        manifest = b'{"schemaVersion":1}'
        (api / "canonical-manifest.json").write_bytes(manifest)
        (comfy / "extra_model_paths.yaml").write_text("canonical_models: {}\n", encoding="utf-8")
        names = ("launch_windows.py", "prepared_env_receipt.py",
                 "tests/preflight_runtime.py", "dependencies.lock.json",
                 "python-wheels.lock.json", "comfy/vendor-lock.json", "manifest.json")
        for name in names:
            content = (manifest if name == "manifest.json" else
                       b"def verify_receipt(*args, **kwargs): return 'synthetic'\n"
                       if name == "prepared_env_receipt.py" else name.encode("utf-8"))
            (control / name).write_bytes(content)
        for name in ("api.exe", "comfy.exe", "ffmpeg.exe", "gpu.json"):
            (root / name).write_bytes(b"x")
        (root / "mingw64" / "bin" / "git.exe").write_bytes(b"x")
        data = {
            "schemaVersion": 1, "scope": installer.SCOPE,
            "sourceManifestSha256": hashlib.sha256(manifest).hexdigest(),
            "controlSha256": {name: installer.sha256(control / name) for name in names},
            "modelPathConfigSha256": installer.sha256(comfy / "extra_model_paths.yaml"),
            "apiRoot": str(api), "comfyRoot": str(comfy),
            "apiPython": str(root / "api.exe"), "comfyPython": str(root / "comfy.exe"),
            "preparedReceiptPath": str(root / "prepare-receipt.json"),
            "preparedReceiptSha256": "0" * 64,
            "ffmpeg": str(root / "ffmpeg.exe"),
            "gitExe": str(root / "mingw64" / "bin" / "git.exe"),
            "gpuSlotFile": str(root / "gpu.json"),
            "modelsDir": str(root / "models"), "inputRoot": str(root / "input"),
            "outputRoot": str(root / "output"), "adapterRoot": str(root / "adapter"),
            "workflowDir": str(root / "workflows"), "tempRoot": str(root / "temp"),
            "userRoot": str(root / "user"), "apiPort": 18190, "comfyPort": 18191,
        }
        config = private / "config.json"
        config.write_text(json.dumps(data), encoding="utf-8")
        with (mock.patch.object(launcher, "CONTROL", control),
              mock.patch.object(launcher, "INSTALL", root),
              mock.patch.object(launcher, "CONFIG", config)):
            self.assertEqual(launcher.config()["scope"], installer.SCOPE)
            (control / "dependencies.lock.json").write_text("changed", encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "原字节"):
                launcher.config()

    def test_utf8_help_and_pythonpath_isolation(self) -> None:
        evil = self.stage / "evil-pythonpath"
        evil.mkdir()
        marker = self.stage / "sitecustomize-ran.txt"
        (evil / "sitecustomize.py").write_text(
            "from pathlib import Path\nPath(" + repr(str(marker)) + ").write_text('ran')\n",
            encoding="utf-8",
        )
        assembly_git = self.stage / "assembly-git"
        assembly_git.mkdir()
        (assembly_git / "git.exe").write_bytes(b"synthetic; not executed")
        env = os.environ.copy()
        env.update(PYTHONPATH=str(evil), PYTHONIOENCODING="gbk")
        for script, text in (("install_windows.py", "全新"),
                             ("prepare_python_windows.py", "全新"),
                             ("launch_windows.py", "静态自检")):
            result = subprocess.run([sys.executable, "-I", "-B", str(ROOT / script), "--help"],
                                    env=env, capture_output=True, check=False)
            self.assertEqual(result.returncode, 0)
            self.assertIn(text, result.stdout.decode("utf-8"))
        self.assertFalse(marker.exists())
        with mock.patch.dict(os.environ, {"PYTHONPATH": str(evil), "PYTHONHOME": "bad",
                                              "PYTHONUSERBASE": "bad", "PYTHONSTARTUP": "bad",
                                              "PATH": str(evil), "H3_CLIP": "wrong-model.safetensors",
                                              "H3_TURBO4_MODEL": "wrong-unet.safetensors",
                                              "H3_INSTANCE": "old-v1", "CUDA_VISIBLE_DEVICES": "999",
                                              "GPU_SLOT_FILE": "old-slot.json",
                                              "VHS_FORCE_FFMPEG_PATH": "old-encoder.exe",
                                              "GIT_DIR": "old-repo", "GIT_CONFIG_GLOBAL": "old-gitconfig"}):
            for clean in (prepare.clean_python_env(), launcher.runtime_env({
                    "ffmpeg": str(self.stage / "ffmpeg.exe"),
                    "gitExe": str(self.stage / "git.exe"),
                    "apiPython": sys.executable, "comfyPython": sys.executable,
                    "comfyPort": 18191,
                    "comfyRoot": str(self.stage), "inputRoot": str(self.stage),
                    "outputRoot": str(self.stage), "adapterRoot": str(self.stage),
                    "workflowDir": str(self.stage), "machineLabel": "unit",
                    "gpuSlotFile": str(self.stage / "gpu.json")})):
                self.assertTrue(all(name not in clean for name in
                                    ("PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE", "PYTHONSTARTUP")))
            runtime = launcher.runtime_env({
                "ffmpeg": str(self.stage / "ffmpeg.exe"),
                "gitExe": str(self.stage / "git.exe"),
                "apiPython": sys.executable, "comfyPython": sys.executable,
                "comfyPort": 18191, "comfyRoot": str(self.stage),
                "inputRoot": str(self.stage), "outputRoot": str(self.stage),
                "adapterRoot": str(self.stage), "workflowDir": str(self.stage),
                "machineLabel": "unit", "gpuSlotFile": str(self.stage / "gpu.json"),
            })
            self.assertEqual(runtime["H3_INSTANCE"], "canonical-qs_new4-E_light4_sage")
            self.assertEqual(runtime["GPU_SLOT_FILE"], str(self.stage / "gpu.json"))
            self.assertEqual(runtime["VHS_FORCE_FFMPEG_PATH"], str(self.stage / "ffmpeg.exe"))
            self.assertEqual(runtime["H3_CANONICAL_GIT_EXE"], str(self.stage / "git.exe"))
            self.assertTrue(all(key not in runtime for key in
                                ("H3_CLIP", "H3_TURBO4_MODEL", "CUDA_VISIBLE_DEVICES",
                                 "GIT_DIR", "GIT_CONFIG_GLOBAL")))
            self.assertNotIn(str(evil), runtime["PATH"])
            assembly = installer.assembly_environment(
                assembly_git / "git.exe", Path(sys.executable),
                Path(sys.executable), self.stage / "ffmpeg.exe")
            self.assertEqual(assembly["PATH"].split(os.pathsep)[0], str(assembly_git))
            self.assertNotIn(str(evil), assembly["PATH"])
            self.assertNotIn("GIT_DIR", assembly)
            self.assertEqual(assembly["GIT_CONFIG_GLOBAL"], os.devnull)
            self.assertEqual(assembly["GIT_CONFIG_NOSYSTEM"], "1")
            installer.checked_process([sys.executable, "-B", "-c", "print('clean child')"])
        self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
