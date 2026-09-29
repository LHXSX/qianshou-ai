"""Pure no-GPU owner-runtime witness contract tests."""
from __future__ import annotations

import json
import hashlib
import io
import os
from pathlib import Path
import shutil
import subprocess
import sys
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from uuid import uuid4
import psutil


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "workbench"))
from recipe_identity import RecipeIdentityError
from runtime_attestation import (ComfyRuntimeError, measure_comfy_runtime,
                                 parse_pyvenv_base_executable, python_runtime_sha256,
                                 verify_comfy_interpreter, verify_prepared_venv_receipt)
from workbench_node import (owner_runtime_identity, verify_owner_config_binding,
                            verify_owner_runtime_witness, verify_required_object_info,
                            REQUIRED_COMFY_CLASSES)
from source_manifest import FrozenBinary


class OwnerRuntimeIdentity(unittest.TestCase):
    def setUp(self):
        self.api_process = {"bootNonce": "private-api-nonce", "pid": 123,
                            "bootNs": 456}
        self.attestation = {
            "processToken": "private-comfy-token",
            "queueAdmissionGuardVersion": 1,
            "sourceManifestSha256": "c" * 64,
            "classOriginSha256": "d" * 64,
            "comfyFfmpegSha256": "e" * 64,
            "deliveryFfmpegSha256": "f" * 64,
            "pythonRuntimeSha256": "7" * 64,
        }

    def identity(self, **changes):
        params = {"config_sha": "a" * 64,
                  "model_paths_sha": "b" * 64,
                  "api_process_private": self.api_process,
                  "comfy_runtime_token": "1" * 64,
                  "source_attestation": self.attestation}
        params.update(changes)
        return owner_runtime_identity(**params)

    def test_response_contains_only_digests_and_binds_each_input(self):
        baseline = self.identity()
        self.assertEqual(set(baseline), {
            "schemaVersion", "ownerConfigDigest", "apiProcessWitnessSha256",
            "comfyProcessWitnessSha256", "sourceManifestSha256", "classOriginSha256",
            "comfyFfmpegSha256", "deliveryFfmpegSha256",
            "queueAdmissionGuardVersion", "ownerRuntimeWitnessSha256",
        })
        for private in ("private-api-nonce", "private-comfy-token"):
            self.assertNotIn(private, repr(baseline))
        self.assertEqual(baseline["queueAdmissionGuardVersion"], 1)
        verify_owner_runtime_witness(baseline["ownerRuntimeWitnessSha256"], baseline)
        alternatives = (
            {"config_sha": "2" * 64},
            {"model_paths_sha": "3" * 64},
            {"api_process_private": {**self.api_process, "bootNonce": "new-process"}},
            {"comfy_runtime_token": "4" * 64},
            {"source_attestation": {**self.attestation,
                                     "processToken": "new-comfy-process"}},
            {"source_attestation": {**self.attestation,
                                     "comfyFfmpegSha256": "5" * 64}},
            {"source_attestation": {**self.attestation,
                                     "deliveryFfmpegSha256": "6" * 64}},
            {"source_attestation": {**self.attestation,
                                     "pythonRuntimeSha256": "8" * 64}},
        )
        for changed in alternatives:
            with self.subTest(changed=tuple(changed)):
                actual = self.identity(**changed)
                self.assertNotEqual(actual["ownerRuntimeWitnessSha256"],
                                    baseline["ownerRuntimeWitnessSha256"])
                with self.assertRaisesRegex(RecipeIdentityError,
                                            "H3_OWNER_RUNTIME_WITNESS_MISMATCH"):
                    verify_owner_runtime_witness(baseline["ownerRuntimeWitnessSha256"],
                                                 actual)
        with self.assertRaisesRegex(RecipeIdentityError, "queue admission guard"):
            self.identity(source_attestation={**self.attestation,
                                              "queueAdmissionGuardVersion": 0})

    def test_private_config_binding_rejects_different_runtime(self):
        existing = Path(__file__).resolve().parent
        config = {"schemaVersion": 1, "scope": "qs_new4/E_light4_sage",
                  "comfyPort": 8190, "machineLabel": "synthetic-node",
                  "apiRoot": str(existing)}
        raw = json.dumps(config).encode("utf-8")
        verify_owner_config_binding(raw, {"apiRoot": existing}, {"comfyPort": 8190,
                                              "machineLabel": "synthetic-node"})
        with self.assertRaises(RecipeIdentityError):
            verify_owner_config_binding(raw, {"apiRoot": existing.parent}, {})
        with self.assertRaises(RecipeIdentityError):
            verify_owner_config_binding(raw, {}, {"comfyPort": 8188})
        with self.assertRaises(RecipeIdentityError):
            verify_owner_config_binding(b"{}", {}, {})

    def test_configured_comfy_interpreter_requires_same_physical_file(self):
        configured = Path(sys.executable).resolve(strict=True)
        info = configured.stat()
        generation = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
        process = SimpleNamespace(exe=lambda: str(configured))
        self.assertEqual(verify_comfy_interpreter(process, [str(configured), "-B"],
                                                  configured, generation,
                                                  configured, generation),
                         os.path.normcase(str(configured)))
        root = Path(os.environ["H3_CANONICAL_TEST_ROOT"])
        self.assertTrue(root.is_absolute() and root.is_dir())
        test_dir = root / ("interpreter-identity-" + uuid4().hex)
        test_dir.mkdir()
        same_bytes_other_file = test_dir / configured.name
        shutil.copyfile(configured, same_bytes_other_file)
        self.assertEqual(hashlib.sha256(configured.read_bytes()).digest(),
                         hashlib.sha256(same_bytes_other_file.read_bytes()).digest())
        self.assertFalse(os.path.samefile(configured, same_bytes_other_file))
        with self.assertRaisesRegex(ComfyRuntimeError, "different Python interpreter"):
            verify_comfy_interpreter(SimpleNamespace(exe=lambda: str(same_bytes_other_file)),
                                     [str(configured), "-B"], configured, generation,
                                     configured, generation)
        with self.assertRaisesRegex(ComfyRuntimeError, "different Python interpreter"):
            verify_comfy_interpreter(process, [str(same_bytes_other_file), "-B"],
                                     configured, generation, configured, generation)
        stale = (generation[0], generation[1], generation[2], generation[3] - 1)
        with self.assertRaisesRegex(ComfyRuntimeError, "generation changed"):
            verify_comfy_interpreter(process, [str(configured), "-B"], configured,
                                     generation, configured, stale)

    def test_only_three_exact_object_info_routes_are_checked(self):
        routes = []

        def fetch(base, route):
            self.assertEqual(base, "http://127.0.0.1:8190")
            routes.append(route)
            name = route.removeprefix("/object_info/")
            return {name: {"input": {}}}

        verify_required_object_info("http://127.0.0.1:8190", fetch)
        self.assertEqual(routes, ["/object_info/" + name for name in REQUIRED_COMFY_CLASSES])
        self.assertNotIn("/object_info", routes)
        with self.assertRaisesRegex(RuntimeError, "node schema is unavailable"):
            verify_required_object_info("http://127.0.0.1:8190", lambda _base, _route: {})

    def test_runtime_measurement_rejects_another_listeners_interpreter(self):
        root = Path(os.environ["H3_CANONICAL_TEST_ROOT"])
        self.assertTrue(root.is_absolute() and root.is_dir())
        test_dir = root / ("interpreter-runtime-" + uuid4().hex)
        test_dir.mkdir()
        model_root = test_dir / "comfy"
        model_root.mkdir()
        main = model_root / "main.py"
        main.write_text("# synthetic Comfy entry\n", encoding="utf-8")
        input_root, output_root = test_dir / "input", test_dir / "output"
        input_root.mkdir(); output_root.mkdir()
        configured = Path(sys.executable).resolve(strict=True)
        same_bytes_other_file = test_dir / configured.name
        shutil.copyfile(configured, same_bytes_other_file)
        info = configured.stat()
        generation = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)
        source_sha = hashlib.sha256(configured.read_bytes()).hexdigest()
        argv = [str(main), "--cache-none", "--input-directory", str(input_root),
                "--output-directory", str(output_root)]
        cmdline = [str(configured), "-B", *argv]
        listener = SimpleNamespace(status="LISTEN", laddr=SimpleNamespace(
            port=8190, ip="127.0.0.1"), pid=43210)
        process = SimpleNamespace(pid=43210, cwd=lambda: str(test_dir),
                                  cmdline=lambda: cmdline, exe=lambda: str(configured),
                                  create_time=lambda: 1234.5)
        stats = json.dumps({"system": {"argv": argv}}).encode("utf-8")
        with (patch("runtime_attestation.psutil.net_connections", return_value=[listener]),
              patch("runtime_attestation.psutil.Process", return_value=process),
              patch("runtime_attestation.urlopen", return_value=io.BytesIO(stats))):
            token, boot_ns = measure_comfy_runtime(
                "http://127.0.0.1:8190", model_root, input_root, output_root,
                configured, generation, source_sha, configured, generation, source_sha)
        self.assertEqual(len(token), 64)
        self.assertEqual(boot_ns, 1234500000000)
        alien = SimpleNamespace(pid=process.pid, cwd=process.cwd, cmdline=process.cmdline,
                                exe=lambda: str(same_bytes_other_file),
                                create_time=process.create_time)
        with (patch("runtime_attestation.psutil.net_connections", return_value=[listener]),
              patch("runtime_attestation.psutil.Process", return_value=alien)):
            with self.assertRaisesRegex(ComfyRuntimeError, "different Python interpreter"):
                measure_comfy_runtime("http://127.0.0.1:8190", model_root,
                                      input_root, output_root, configured, generation, source_sha,
                                      configured, generation, source_sha)

    def test_real_prepared_windows_venv_bindings_when_provided(self):
        """Opt-in test against the prepared cross-drive venv; no Comfy work."""
        value = os.environ.get("H3_TEST_PREPARED_COMFY_PYTHON")
        if not value:
            self.skipTest("prepared interpreter path was not supplied privately")
        venv_path = Path(value)
        cfg_path = venv_path.parent.parent / "pyvenv.cfg"
        base_path = parse_pyvenv_base_executable(cfg_path.read_bytes())
        self.assertFalse(os.path.samefile(venv_path, base_path))
        venv = FrozenBinary(venv_path)
        cfg = FrozenBinary(cfg_path)
        base = FrozenBinary(base_path)
        expected = python_runtime_sha256(
            venv.path, venv.first_generation, venv.sha256,
            cfg.path, cfg.first_generation, cfg.sha256,
            base.path, base.first_generation, base.sha256)
        source = Path(__file__).resolve().parents[2] / "comfy" / "custom_nodes" / \
            "qs_h3_source_attestor" / "attestor.py"
        child_code = ("import importlib.util,sys; "
                      "s=importlib.util.spec_from_file_location('h3_python_probe',sys.argv[1]); "
                      "m=importlib.util.module_from_spec(s); sys.modules[s.name]=m; "
                      "s.loader.exec_module(m); p=m.PythonProcessIdentity(); print(p.check()); p.close()")
        actual = subprocess.check_output([str(venv_path), "-B", "-I", "-c", child_code,
                                          str(source)], text=True, timeout=30).strip()
        self.assertEqual(actual, expected)
        receipt_value = os.environ.get("H3_TEST_PREPARED_RECEIPT")
        if receipt_value:
            verify_prepared_venv_receipt(Path(receipt_value).read_bytes(), venv.path,
                                         venv.sha256, venv.first_generation[2],
                                         cfg.sha256, cfg.first_generation[2])
        pid_value = os.environ.get("H3_TEST_COMFY_PID")
        if pid_value:
            process = psutil.Process(int(pid_value))
            self.assertEqual(verify_comfy_interpreter(
                process, process.cmdline(), venv.path, venv.first_generation,
                base.path, base.first_generation),
                os.path.normcase(str(base.path.resolve(strict=True))))
            with self.assertRaisesRegex(ComfyRuntimeError, "different Python interpreter"):
                verify_comfy_interpreter(process, process.cmdline(), venv.path,
                                         venv.first_generation, venv.path,
                                         venv.first_generation)
        # A byte-for-byte copied venv launcher is still a different file/venv.
        root = Path(os.environ["H3_CANONICAL_TEST_ROOT"])
        other = root / ("foreign-venv-" + uuid4().hex)
        (other / "Scripts").mkdir(parents=True)
        copied = other / "Scripts" / "python.exe"
        shutil.copyfile(venv.path, copied)
        copied_cfg = other / "pyvenv.cfg"
        shutil.copyfile(cfg.path, copied_cfg)
        foreign = FrozenBinary(copied)
        foreign_cfg = FrozenBinary(copied_cfg)
        self.assertNotEqual(python_runtime_sha256(
            foreign.path, foreign.first_generation, foreign.sha256,
            foreign_cfg.path, foreign_cfg.first_generation, foreign_cfg.sha256,
            base.path, base.first_generation, base.sha256), expected)


if __name__ == "__main__":
    unittest.main()
