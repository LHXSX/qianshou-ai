"""No-service synthetic checks for the canonical Comfy source witness."""

from __future__ import annotations

import hashlib
import functools
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import types
import unittest
from unittest import mock


HERE = Path(__file__).resolve().parents[1]
SOURCE = HERE / "custom_nodes" / "qs_h3_source_attestor" / "attestor.py"
spec = importlib.util.spec_from_file_location("qs_h3_attestor_test", SOURCE)
attestor = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = attestor
spec.loader.exec_module(attestor)

FORMATS = sorted(attestor._VHS_FORMATS)
EXCLUDES = [
    ".git", "custom_nodes/ComfyUI-KJNodes/.git",
    "custom_nodes/ComfyUI_LayerStyle/.git",
    "custom_nodes/ComfyUI-VideoHelperSuite/.git",
    "models", "input", "output", "temp", "user",
]
NODE_BYTES = b"""class CLIPLoader:
    FUNCTION = 'load_clip'
    def load_clip(self):
        return None

class VideoCombine:
    FUNCTION = 'combine_video'
    def combine_video(self):
        return None
"""
SERVER_BYTES = b"""def make_prompt_handler():
    qs_h3_prompt_guard = lambda token: None
    async def post_prompt(request):
        token = 'qs_h3_expected_process_token'
        guard = qs_h3_prompt_guard
        code = 'qs_h3_source_identity_changed'
        return token, guard, code
    return post_prompt
"""
V3_NAMES = ("BasicGuider", "ImageFromBatch", "MiniMaxH3ImageToVideo",
            "RandomNoise", "SamplerCustomAdvanced", "VAEDecodeAudio")
V3_FRAMEWORK = b"""class classproperty:
    def __init__(self, function):
        self.f = function
    def __get__(self, instance, owner):
        return self.f(owner)

class _ComfyNodeBaseInternal:
    @classproperty
    def FUNCTION(cls):
        return 'EXECUTE_NORMALIZED'
    @classmethod
    def EXECUTE_NORMALIZED(cls):
        return cls.execute()

class ComfyNode(_ComfyNodeBaseInternal):
    pass
"""


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


class SourceWitnessTests(unittest.TestCase):
    def setUp(self):
        test_root_value = os.environ.get("H3_CANONICAL_TEST_ROOT", "")
        test_root = Path(test_root_value)
        if (not test_root_value or not test_root.is_absolute() or
                not test_root.is_dir() or test_root.is_symlink() or
                getattr(test_root, "is_junction", lambda: False)()):
            self.fail("Set H3_CANONICAL_TEST_ROOT to an existing physical test-work directory")
        # Keep each unique synthetic tree for inspection. A path-based recursive
        # cleanup after handles close could follow a concurrent junction swap.
        base = Path(tempfile.mkdtemp(prefix="h3-attestor-", dir=test_root))
        self.test_dir = base
        self.root = base / "comfy"
        self.root.mkdir()
        self.nodes = self.root / "nodes.py"
        self.nodes.write_bytes(NODE_BYTES)
        self.server_source = self.root / "server.py"
        self.server_source.write_bytes(SERVER_BYTES)
        namespace = {}
        exec(compile(SERVER_BYTES, str(self.server_source), "exec", dont_inherit=True), namespace)
        self.prompt_handler = namespace["make_prompt_handler"]()
        self.custom = self.root / "custom_nodes"
        formats = self.custom / "ComfyUI-VideoHelperSuite" / "video_formats"
        formats.mkdir(parents=True)
        for name in FORMATS:
            (formats / name).write_bytes(b"{}\n")
        self.ffmpeg = base / "ffmpeg.exe"
        self.ffmpeg.write_bytes(b"synthetic encoder bytes\n")
        self.module_name = "qs_h3_synthetic_nodes_" + str(id(self))
        self.module = types.ModuleType(self.module_name)
        self.module.__file__ = str(self.nodes)
        self.module.ffmpeg_path = str(self.ffmpeg)
        sys.modules[self.module_name] = self.module
        self.addCleanup(lambda: sys.modules.pop(self.module_name, None))
        exec(compile(NODE_BYTES, str(self.nodes), "exec", dont_inherit=True),
             self.module.__dict__)
        self.classes = {"CLIPLoader": self.module.CLIPLoader,
                        "VHS_VideoCombine": self.module.VideoCombine}
        files = [{
            "area": "comfy", "path": "nodes.py", "origin": "synthetic@fixed",
            "size": len(NODE_BYTES), "rawSha256": _sha(NODE_BYTES),
        }, {
            "area": "comfy", "path": "server.py", "origin": "synthetic@fixed",
            "size": len(SERVER_BYTES), "rawSha256": _sha(SERVER_BYTES),
        }]
        aux = []
        for name in FORMATS:
            raw = (formats / name).read_bytes()
            aux.append({
                "area": "comfy",
                "path": "custom_nodes/ComfyUI-VideoHelperSuite/video_formats/" + name,
                "origin": "synthetic@fixed", "size": len(raw), "rawSha256": _sha(raw),
            })
        manifest = {
            "runtimeSourceFiles": files,
            "runtimeAuxiliaryFiles": aux,
            "runtimeInventoryRoots": [{
                "area": "comfy", "relativeDir": ".", "extension": ".py",
                "recursive": True,
            }],
            "runtimeInventoryExcludeDirs": [{"area": "comfy", "relativeDir": name}
                                            for name in EXCLUDES],
            "runtimeAuxiliaryInventoryDirs": [{
                "area": "comfy", "relativeDir":
                "custom_nodes/ComfyUI-VideoHelperSuite/video_formats",
                "extension": ".json", "recursive": False,
            }],
            "requiredGraphClassTypes": sorted(self.classes),
        }
        self.manifest = base / "manifest.json"
        self.manifest.write_bytes(json.dumps(manifest, ensure_ascii=False,
                                             sort_keys=True).encode("utf-8"))

    def _start(self):
        private_python = types.SimpleNamespace(check=lambda: "a" * 64, close=lambda: None)
        witness = attestor.SourceAttestor(self.root, self.manifest, self.classes,
                                          python_runtime=private_python)
        self.addCleanup(witness.close)
        witness.verify_custom_node_roots([str(self.custom)])
        return witness

    def _request(self, witness):
        return {
            "schemaVersion": 1,
            "classTypes": sorted(self.classes),
            "sourceManifestSha256": witness.manifest_sha256,
        }

    def _install_v3_fixture(self, *, bad_v1=False):
        framework = self.root / "comfy_api" / "latest" / "_io.py"
        framework.parent.mkdir(parents=True)
        framework.write_bytes(V3_FRAMEWORK)
        module_name = "comfy_api.latest._io"
        module = types.ModuleType(module_name)
        module.__file__ = str(framework)
        sys.modules[module_name] = module
        self.addCleanup(lambda: sys.modules.pop(module_name, None))
        exec(compile(V3_FRAMEWORK, str(framework), "exec", dont_inherit=True), module.__dict__)
        self.module.ComfyNode = module.ComfyNode
        source = "\n".join(
            f"class {name}(ComfyNode):\n"
            "    @classmethod\n"
            "    def execute(cls):\n"
            f"        return '{name}'\n" for name in V3_NAMES)
        source += "\nclass VideoCombine:\n    FUNCTION = 'combine_video'\n"
        source += "    def combine_video(self):\n        return None\n"
        if bad_v1:
            source += ("\nclass CLIPLoader:\n    FUNCTION = 'EXECUTE_NORMALIZED'\n"
                       "    EXECUTE_NORMALIZED = ComfyNode.EXECUTE_NORMALIZED\n")
        encoded = source.encode("utf-8")
        self.nodes.write_bytes(encoded)
        exec(compile(encoded, str(self.nodes), "exec", dont_inherit=True), self.module.__dict__)
        self.classes = ({"CLIPLoader": self.module.CLIPLoader} if bad_v1 else
                        {**{name: getattr(self.module, name) for name in V3_NAMES},
                         "VHS_VideoCombine": self.module.VideoCombine})
        manifest = json.loads(self.manifest.read_text(encoding="utf-8"))
        for row in manifest["runtimeSourceFiles"]:
            if row["path"] == "nodes.py":
                row.update(size=len(encoded), rawSha256=_sha(encoded))
        manifest["runtimeSourceFiles"].append({
            "area": "comfy", "path": "comfy_api/latest/_io.py", "origin": "synthetic@fixed",
            "size": len(V3_FRAMEWORK), "rawSha256": _sha(V3_FRAMEWORK),
        })
        manifest["requiredGraphClassTypes"] = sorted(self.classes)
        self.manifest.write_bytes(json.dumps(manifest, ensure_ascii=False,
                                             sort_keys=True).encode("utf-8"))
        return framework

    def test_six_v3_normalized_wrappers_are_pinned_with_own_execute(self):
        framework = self._install_v3_fixture()
        witness = self._start()
        result = witness.attest(self._request(witness))
        rows = {row["classType"]: row for row in result["classOrigins"]}
        self.assertEqual(set(rows), set(V3_NAMES) | {"VHS_VideoCombine"})
        for name in V3_NAMES:
            self.assertEqual(rows[name]["moduleRelativePath"], "nodes.py")
            self.assertEqual(rows[name]["methodRelativePath"], "comfy_api/latest/_io.py")
            self.assertEqual(rows[name]["methodSourceRawSha256"], _sha(V3_FRAMEWORK))
        self.assertEqual(rows["VHS_VideoCombine"]["methodRelativePath"], "nodes.py")
        self.assertNotIn(str(self.root), json.dumps(result))
        framework.write_bytes(V3_FRAMEWORK + b"# changed after boot\n")
        with self.assertRaises(attestor.SourceIdentityError):
            witness.attest(self._request(witness))

    def test_v1_cannot_claim_v3_framework_wrapper(self):
        self._install_v3_fixture(bad_v1=True)
        witness = self._start()
        with self.assertRaisesRegex(attestor.SourceIdentityError,
                                    "method differs from supported recipe"):
            witness.attest(self._request(witness))

    @staticmethod
    def _forged_wrapped_method(original, filename):
        namespace = {}
        exec(compile("def injected(*args, **kwargs):\n    return None\n",
                     str(filename), "exec", dont_inherit=True), namespace)
        return functools.wraps(original)(namespace["injected"])

    def test_v1_pre_attestation_forged_same_filename_code_is_rejected(self):
        original_cls = self.module.CLIPLoader
        forged_source = b"class CLIPLoader:\n    def load_clip(self):\n        return 'forged'\n"
        exec(compile(forged_source, str(self.nodes), "exec", dont_inherit=True),
             self.module.__dict__)
        forged = self.module.CLIPLoader.load_clip
        self.module.CLIPLoader = original_cls
        original_cls.load_clip = forged
        witness = self._start()
        with self.assertRaisesRegex(attestor.SourceIdentityError,
                                    "loaded method differs from pinned class source"):
            witness.attest(self._request(witness))

    def test_wrapped_callable_cannot_hide_behind_original_code(self):
        original = self.module.CLIPLoader.load_clip
        wrapped = self._forged_wrapped_method(original, self.nodes)
        self.assertIs(wrapped.__wrapped__, original)
        self.module.CLIPLoader.load_clip = wrapped
        witness = self._start()
        with self.assertRaises(attestor.SourceIdentityError):
            witness.attest(self._request(witness))

        framework = self._install_v3_fixture()
        cls = self.classes["BasicGuider"]
        original_execute = cls.__dict__["execute"]
        wrapped_execute = self._forged_wrapped_method(original_execute.__func__, self.nodes)
        cls.execute = classmethod(wrapped_execute)
        v3_witness = self._start()
        with self.assertRaises(attestor.SourceIdentityError):
            v3_witness.attest(self._request(v3_witness))
        cls.execute = original_execute

        core = self.module.ComfyNode.__mro__[1]
        original_normalized = core.__dict__["EXECUTE_NORMALIZED"]
        wrapped_normalized = self._forged_wrapped_method(
            original_normalized.__func__, framework)
        core.EXECUTE_NORMALIZED = classmethod(wrapped_normalized)
        v3_witness_2 = self._start()
        with self.assertRaises(attestor.SourceIdentityError):
            v3_witness_2.attest(self._request(v3_witness_2))

    def test_v3_function_selector_flip_before_first_attestation_is_rejected(self):
        self._install_v3_fixture()
        self.classes["BasicGuider"].FUNCTION = "execute"
        witness = self._start()
        with self.assertRaisesRegex(attestor.SourceIdentityError,
                                    "method differs from supported recipe"):
            witness.attest(self._request(witness))

    def test_python_process_identity_rejects_another_same_byte_venv(self):
        base = Path(sys.executable).resolve(strict=True)
        venv = self.test_dir / "prepared-venv"
        scripts = venv / "Scripts"
        scripts.mkdir(parents=True)
        launcher = scripts / "python.exe"
        shutil.copyfile(base, launcher)
        (venv / "pyvenv.cfg").write_text("executable = " + str(base) + "\n",
                                              encoding="utf-8")
        with (mock.patch.object(sys, "executable", str(launcher)),
              mock.patch.object(sys, "prefix", str(venv)),
              mock.patch.object(sys, "_base_executable", str(base), create=True)):
            identity = attestor.PythonProcessIdentity()
            self.addCleanup(identity.close)
            original = identity.check()
            self.assertEqual(len(original), 64)
            foreign = self.test_dir / "foreign-venv"
            (foreign / "Scripts").mkdir(parents=True)
            copied = foreign / "Scripts" / "python.exe"
            shutil.copyfile(launcher, copied)
            shutil.copyfile(venv / "pyvenv.cfg", foreign / "pyvenv.cfg")
            self.assertEqual(_sha(copied.read_bytes()), _sha(launcher.read_bytes()))
            with mock.patch.object(sys, "executable", str(copied)):
                with self.assertRaisesRegex(attestor.SourceIdentityError,
                                            "loaded Python runtime identity changed"):
                    identity.check()
            (venv / "pyvenv.cfg").write_text("executable = " + str(base) + "\n# edit\n",
                                                  encoding="utf-8")
            with self.assertRaises(attestor.SourceIdentityError):
                identity.check()

    def test_exact_class_origin_and_stable_process_token(self):
        witness = self._start()
        first = witness.attest(self._request(witness))
        second = witness.attest(self._request(witness))
        self.assertEqual(first, second)
        self.assertEqual(first["ffmpegSha256"], _sha(self.ffmpeg.read_bytes()))
        self.assertEqual(first["pythonRuntimeSha256"], "a" * 64)
        self.assertEqual([row["classType"] for row in first["classOrigins"]],
                         sorted(self.classes))
        self.assertEqual(first["classOriginSha256"], attestor._json_sha256(first["classOrigins"]))
        self.assertEqual({row["moduleRelativePath"] for row in first["classOrigins"]},
                         {"nodes.py"})
        self.assertNotIn(str(self.root), json.dumps(first))

    def test_queue_admission_requires_same_process_and_rechecks_source(self):
        witness = self._start()
        token = witness.attest(self._request(witness))["processToken"]
        witness.guard_submission(token)
        for invalid in (None, "", "0" * 64, token.upper()):
            with self.subTest(invalid=invalid), self.assertRaises(attestor.SourceIdentityError):
                witness.guard_submission(invalid)
        self.server_source.write_bytes(SERVER_BYTES + b"# changed after boot\n")
        with self.assertRaises(attestor.SourceIdentityError):
            witness.guard_submission(token)

    def test_registered_prompt_handler_requires_loaded_core_capability(self):
        witness = self._start()
        route = types.SimpleNamespace(method="POST", path="/prompt", handler=self.prompt_handler)
        sentinel = object()
        server = types.SimpleNamespace(qs_h3_prompt_guard_required_v1=True, routes=[route],
                                       qs_h3_prompt_guard_is=lambda guard: guard is sentinel)
        witness.verify_prompt_handler(server)
        witness.verify_prompt_handler(server, sentinel)
        with self.assertRaises(attestor.SourceIdentityError):
            witness.verify_prompt_handler(server, object())
        server.qs_h3_prompt_guard_required_v1 = False
        with self.assertRaises(attestor.SourceIdentityError):
            witness.verify_prompt_handler(server)
        server.qs_h3_prompt_guard_required_v1 = True
        route.handler = lambda request: None
        with self.assertRaises(attestor.SourceIdentityError):
            witness.verify_prompt_handler(server)

    def test_rewrite_then_restore_bytes_is_rejected(self):
        witness = self._start()
        witness.attest(self._request(witness))
        old = self.nodes.stat()
        time.sleep(0.03)
        self.nodes.write_bytes(NODE_BYTES + b"# transient change\n")
        self.nodes.write_bytes(NODE_BYTES)
        os.utime(self.nodes, ns=(old.st_atime_ns, old.st_mtime_ns))
        with self.assertRaises(attestor.SourceIdentityError):
            witness.attest(self._request(witness))

    def test_posix_same_bytes_size_mtime_but_changed_ctime_is_rejected(self):
        raw = self.nodes.read_bytes()
        info = self.nodes.stat()
        fields = ("st_dev", "st_ino", "st_mtime_ns", "st_ctime_ns", "st_size", "st_nlink")
        values = {field: getattr(info, field) for field in fields}
        before = types.SimpleNamespace(**values)
        after = types.SimpleNamespace(**{**values, "st_ctime_ns": values["st_ctime_ns"] + 1})
        self.assertEqual(attestor._posix_witness(before, before, raw).raw_sha256, _sha(raw))
        self.assertEqual(before.st_mtime_ns, after.st_mtime_ns)
        self.assertEqual(before.st_size, after.st_size)
        with self.assertRaises(attestor.SourceIdentityError):
            attestor._posix_witness(before, after, raw)

    @unittest.skipIf(os.name == "nt", "POSIX metadata integration check")
    def test_posix_metadata_only_change_is_rejected_by_attestation(self):
        witness = self._start()
        witness.attest(self._request(witness))
        before = self.nodes.stat()
        time.sleep(0.03)
        os.chmod(self.nodes, stat.S_IMODE(before.st_mode) ^ stat.S_IXUSR)
        os.utime(self.nodes, ns=(before.st_atime_ns, before.st_mtime_ns))
        after = self.nodes.stat()
        self.assertEqual(after.st_size, before.st_size)
        self.assertEqual(after.st_mtime_ns, before.st_mtime_ns)
        if after.st_ctime_ns == before.st_ctime_ns:
            self.skipTest("filesystem ctime resolution did not record metadata change")
        with self.assertRaises(attestor.SourceIdentityError):
            witness.attest(self._request(witness))

    def test_registry_remap_and_method_monkeypatch_are_rejected(self):
        witness = self._start()
        witness.attest(self._request(witness))
        original = self.classes["CLIPLoader"]
        self.classes["CLIPLoader"] = self.module.VideoCombine
        with self.assertRaises(attestor.SourceIdentityError):
            witness.attest(self._request(witness))
        self.classes["CLIPLoader"] = original
        original.load_clip = lambda self: None
        with self.assertRaises(attestor.SourceIdentityError):
            witness.attest(self._request(witness))

    def test_auxiliary_addition_and_encoder_replacement_are_rejected(self):
        witness = self._start()
        witness.attest(self._request(witness))
        extra = self.custom / "ComfyUI-VideoHelperSuite" / "video_formats" / "new.json"
        extra.write_bytes(b"{}")
        with self.assertRaises(attestor.SourceIdentityError):
            witness.attest(self._request(witness))
        extra.unlink()
        time.sleep(0.03)
        self.ffmpeg.write_bytes(b"different synthetic encoder\n")
        with self.assertRaises(attestor.SourceIdentityError):
            witness.attest(self._request(witness))

    def test_manifest_generation_extra_root_and_loopback(self):
        witness = self._start()
        witness.attest(self._request(witness))
        with self.assertRaises(attestor.SourceIdentityError):
            witness.verify_custom_node_roots([str(self.custom), str(self.root)])
        self.assertTrue(attestor.loopback_request_ok("127.0.0.1", "127.0.0.1", "127.0.0.1"))
        self.assertFalse(attestor.loopback_request_ok("0.0.0.0", "127.0.0.1", "127.0.0.1"))
        self.manifest.write_bytes(self.manifest.read_bytes() + b" ")
        with self.assertRaises(attestor.SourceIdentityError):
            witness.attest(self._request(witness))

    def test_hardlink_is_rejected(self):
        duplicate = self.root / "duplicate.py"
        try:
            os.link(self.nodes, duplicate)
        except OSError as error:
            self.skipTest(f"filesystem cannot create a hardlink: {error.winerror if os.name == 'nt' else error.errno}")
        with self.assertRaises(attestor.SourceIdentityError):
            self._start()

    def test_old_python_bytecode_is_rejected(self):
        cache = self.root / "__pycache__"
        cache.mkdir()
        (cache / "nodes.cpython.pyc").write_bytes(b"synthetic old bytecode")
        with self.assertRaises(attestor.SourceIdentityError):
            self._start()

    def test_parent_reparse_is_rejected_when_available(self):
        alias = self.test_dir / "alias"
        try:
            os.symlink(self.root, alias, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"directory symlink unavailable: {error.winerror if os.name == 'nt' else error.errno}")
        with self.assertRaises(attestor.SourceIdentityError):
            attestor.SourceAttestor(alias, self.manifest, self.classes)

    @unittest.skipUnless(os.name == "nt", "Windows junction check")
    def test_parent_junction_swap_after_path_check_keeps_external_bytes(self):
        witness = self._start()
        witness.attest(self._request(witness))
        relative = "custom_nodes/ComfyUI-VideoHelperSuite/video_formats/h264-mp4.json"
        target = self.root.joinpath(*relative.split("/"))
        format_dir = target.parent
        base = self.test_dir
        outside = base / "outside-formats"
        archived = base / "archived-formats"
        outside.mkdir()
        outside_hashes = {}
        for child in format_dir.iterdir():
            raw = child.read_bytes()
            (outside / child.name).write_bytes(raw)
            outside_hashes[child.name] = _sha(raw)
        physical_base = base.resolve(strict=True)
        self.assertTrue(all(path.resolve(strict=False).is_relative_to(physical_base)
                            for path in (format_dir, outside, archived)))
        original_open = attestor._open_windows
        swapped = False

        def open_after_swap(path, directory=False, shared_read=False):
            nonlocal swapped
            if not swapped and Path(path) == target and not directory:
                format_dir.rename(archived)
                result = subprocess.run(
                    ["cmd", "/c", "mklink", "/J", str(format_dir), str(outside)],
                    capture_output=True, text=True, timeout=10, check=False,
                )
                if result.returncode != 0:
                    archived.rename(format_dir)
                    self.skipTest("Windows junction creation unavailable")
                swapped = True
            return original_open(path, directory=directory, shared_read=shared_read)

        try:
            with mock.patch.object(attestor, "_open_windows", side_effect=open_after_swap):
                with self.assertRaises(attestor.SourceIdentityError):
                    witness._reader.probe(relative)
            self.assertTrue(swapped)
            with self.assertRaises(attestor.SourceIdentityError):
                witness.attest(self._request(witness))
            for name, expected in outside_hashes.items():
                self.assertEqual(_sha((outside / name).read_bytes()), expected)
        finally:
            if swapped:
                os.rmdir(format_dir)  # removes only the synthetic junction
                archived.rename(format_dir)

    def test_more_than_900_files_uses_short_handles(self):
        manifest = json.loads(self.manifest.read_text(encoding="utf-8"))
        for index in range(910):
            name = f"extra_{index:04}.py"
            data = b"# synthetic source\n"
            (self.root / name).write_bytes(data)
            manifest["runtimeSourceFiles"].append({
                "area": "comfy", "path": name, "origin": "synthetic@fixed",
                "size": len(data), "rawSha256": _sha(data),
            })
        self.manifest.write_bytes(json.dumps(manifest, sort_keys=True).encode("utf-8"))
        witness = self._start()
        self.assertEqual(len(witness._reader._held), 0)
        self.assertEqual(witness.attest(self._request(witness))["schemaVersion"], 1)

    @unittest.skipUnless(os.name == "nt", "Windows sharing check")
    def test_manifest_short_read_is_compatible_with_other_readers(self):
        witness = self._start()
        handle = attestor._open_windows(self.manifest, shared_read=True)
        try:
            self.assertEqual(witness.attest(self._request(witness))["schemaVersion"], 1)
            with self.assertRaises(attestor.SourceIdentityError):
                attestor._open_windows(self.manifest)
        finally:
            attestor._K32.CloseHandle(handle)

    @unittest.skipUnless(os.name == "nt", "Windows encoder sharing check")
    def test_encoder_attestation_coexists_with_separate_read_only_process(self):
        witness = self._start()
        child_code = """import importlib.util, pathlib, sys
spec=importlib.util.spec_from_file_location('attestor_encoder_reader', sys.argv[1])
module=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=module
spec.loader.exec_module(module)
handle=module._open_windows(pathlib.Path(sys.argv[2]), shared_read=True)
print('READY', flush=True)
sys.stdin.buffer.read(1)
module._K32.CloseHandle(handle)
"""
        child = subprocess.Popen(
            [sys.executable, "-B", "-c", child_code, str(SOURCE), str(self.ffmpeg)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True,
        )
        try:
            self.assertEqual(child.stdout.readline().strip(), "READY")
            response = witness.attest(self._request(witness))
            self.assertEqual(response["ffmpegSha256"], _sha(self.ffmpeg.read_bytes()))
            with self.assertRaises(PermissionError):
                with self.ffmpeg.open("ab") as stream:
                    stream.write(b" ")
        finally:
            if child.poll() is None:
                child.communicate(input="x", timeout=10)
            self.assertEqual(child.returncode, 0)
        self.assertEqual(witness.attest(self._request(witness))["ffmpegSha256"],
                         _sha(self.ffmpeg.read_bytes()))

    @unittest.skipUnless(os.name == "nt", "Windows sharing check")
    def test_manifest_cross_process_read_allows_attestation_denies_write(self):
        witness = self._start()
        child_code = """import importlib.util, pathlib, sys
spec=importlib.util.spec_from_file_location('attestor_child', sys.argv[1])
module=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=module
spec.loader.exec_module(module)
handle=module._open_windows(pathlib.Path(sys.argv[2]), shared_read=True)
print('READY', flush=True)
sys.stdin.buffer.read(1)
module._K32.CloseHandle(handle)
"""
        child = subprocess.Popen(
            [sys.executable, "-B", "-c", child_code, str(SOURCE), str(self.manifest)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True,
        )
        try:
            self.assertEqual(child.stdout.readline().strip(), "READY")
            self.assertEqual(witness.attest(self._request(witness))["schemaVersion"], 1)
            with self.assertRaises(PermissionError):
                with self.manifest.open("ab") as stream:
                    stream.write(b" ")
            with self.assertRaises(PermissionError):
                self.manifest.unlink()
        finally:
            if child.poll() is None:
                child.communicate(input="x", timeout=10)
            self.assertEqual(child.returncode, 0)


if __name__ == "__main__":
    unittest.main()
