"""Independent V2-upgrade source/byte-validator tests, not Windows execution.

Uses the actual fixed adapter and identity modules; remaining role bytes are
explicit synthetic compiler inputs. The production canonical manifest is still
blocked until all measured Comfy source hashes have been reviewed.
"""
from pathlib import Path
import base64
import copy
import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("offline_v2_upgrade", ROOT / "tests/validate_v2_upgrade.py")
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


class UpgradeValidation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory(prefix="v2-upgrade-target-") as folder:
            path = Path(folder) / "workbench/workbench_node.py"
            path.parent.mkdir()
            path.write_bytes((ROOT / "fixtures/v1-installed/workbench_node.py").read_bytes())
            subprocess.run(["git", "apply", "--check", str(ROOT / "workbench_node.v2.patch")], cwd=folder, check=True, capture_output=True)
            subprocess.run(["git", "apply", str(ROOT / "workbench_node.v2.patch")], cwd=folder, check=True, capture_output=True)
            cls.target = path.read_bytes()
        cls.baseline = (ROOT / "fixtures/v1-installed/workbench_node.py").read_bytes()

    def packet(self, phase="target"):
        known = {"adapter": self.target if phase == "target" else self.baseline,
                 "identity": (ROOT / "recipe_identity.py").read_bytes(),
                 "identityV2": (ROOT / "recipe_identity_v2.py").read_bytes(),
                 "runtimeAttestation": (ROOT / "runtime_attestation.py").read_bytes()}
        records = []
        for role, (domain, path) in validator.EXPECTED_PATHS.items():
            data = known.get(role, ("raise RuntimeError('this source must compile without import: " + role + "')\n").encode())
            records.append({"role": role, "root": domain, "path": path,
                            "sha256": hashlib.sha256(data).hexdigest(), "base64": base64.b64encode(data).decode()})
        return {"schema": "qianshou.h3-v2-install-validation.v1", "phase": phase, "records": records}

    def replace(self, packet, role, data, *, repin=True):
        row = next(x for x in packet["records"] if x["role"] == role)
        row["base64"] = base64.b64encode(data).decode()
        if repin: row["sha256"] = hashlib.sha256(data).hexdigest()

    def test_target_compiles20_imports_actual3_and_never_imports_service_roles(self):
        result = validator.validate(self.packet())
        self.assertEqual(result["compiledRoles"], 20)
        self.assertEqual(result["importedIdentityModules"], 3)
        self.assertFalse(result["servicesStarted"])
        self.assertFalse(result["gpuExecuted"])

    def test_baseline_is_not_implicitly_promoted(self):
        self.assertEqual(validator.validate(self.packet("baseline"))["phase"], "baseline")
        packet = self.packet("baseline"); packet["phase"] = "target"
        with self.assertRaisesRegex(ValueError, "V2 route/schema"): validator.validate(packet)

    def test_actual_manifest_matches_original_upgrade_pins(self):
        install = json.loads((ROOT / "adapter-v2.install.manifest.json").read_text())
        original = json.loads((ROOT / "adapter-v2.manifest.json").read_text())
        self.assertEqual(len(install["sourceRoles"]), 20)
        self.assertEqual(install["baselineAdapterSha256"], hashlib.sha256(self.baseline).hexdigest())
        self.assertEqual(install["targetAdapterSha256"], hashlib.sha256(self.target).hexdigest())
        self.assertEqual(install["patchSha256"], original["patch"]["sha256"])
        self.assertEqual(set(x["role"] for x in install["sourceRoles"]), validator.ROLES)
        self.assertEqual([(r["root"], r["path"]) for r in install["sourceRoles"]], list(validator.EXPECTED_PATHS.values()))

    def test_missing_role_cannot_compile_or_import(self):
        packet = self.packet(); packet["records"].pop()
        with self.assertRaisesRegex(ValueError, "twenty"): validator.validate(packet)

    def test_duplicate_role_cannot_replace_another_measured_role(self):
        packet = self.packet(); packet["records"][-1] = copy.deepcopy(packet["records"][0])
        with self.assertRaisesRegex(ValueError, "duplicate"): validator.validate(packet)

    def test_missing_canonical_pin_is_rejected(self):
        packet = self.packet(); packet["records"][0]["sha256"] = None
        with self.assertRaisesRegex(ValueError, "unpinned"): validator.validate(packet)

    def test_changed_bytes_cannot_match_frozen_source(self):
        packet = self.packet(); self.replace(packet, "comfyMain", b"# external changed bytes\n", repin=False)
        with self.assertRaisesRegex(ValueError, "no longer match"): validator.validate(packet)

    def test_redirected_path_rejected_before_import(self):
        packet = self.packet(); packet["records"][0]["path"] = "../outside.py"
        with self.assertRaisesRegex(ValueError, "redirected"): validator.validate(packet)

    def test_cross_domain_role_rejected(self):
        packet = self.packet(); packet["records"][0]["root"] = "comfy"
        with self.assertRaisesRegex(ValueError, "redirected"): validator.validate(packet)

    def test_crlf_runtime_bytes_do_not_create_different_public_recipe(self):
        packet = self.packet(); self.replace(packet, "identityV2", (ROOT / "recipe_identity_v2.py").read_bytes().replace(b"\n", b"\r\n"))
        with self.assertRaisesRegex(ValueError, "LF bytes"): validator.validate(packet)

    def test_syntax_error_in_comfy_package_fails_before_mutation(self):
        packet = self.packet(); self.replace(packet, "dualClockCore", b"def broken(:\n")
        with self.assertRaises(SyntaxError): validator.validate(packet)

    def test_source_size_bound(self):
        packet = self.packet(); self.replace(packet, "comfyMain", b"#" * (4 * 1024 * 1024 + 1))
        with self.assertRaisesRegex(ValueError, "bounded"): validator.validate(packet)

    def test_new_helper_wrong_schema_does_not_upgrade_v1(self):
        packet = self.packet()
        self.replace(packet, "identityV2", (ROOT / "recipe_identity_v2.py").read_bytes().replace(b'qs.h3.recipe-identity.v2', b'qs.h3.recipe-identity.v1'))
        with self.assertRaisesRegex(ValueError, "V2 identity"): validator.validate(packet)

    def test_legacy_schema_stays_v1(self):
        packet = self.packet()
        self.replace(packet, "identity", (ROOT / "recipe_identity.py").read_bytes().replace(b'qs.h3.recipe-identity.v1', b'qs.h3.recipe-identity.v2'))
        with self.assertRaisesRegex(ValueError, "V1 schema"): validator.validate(packet)

    def test_module_imports_leave_original_process_namespace(self):
        before = {name: sys.modules.get(name) for name in ("recipe_identity", "recipe_identity_v2", "runtime_attestation")}
        validator.validate(self.packet())
        for name, value in before.items(): self.assertIs(sys.modules.get(name), value)

    def test_installer_pins_validator_and_manifest_exact_bytes(self):
        script = (ROOT / "Install-Windows-H3Adapter-V2.ps1").read_text(encoding="utf-8-sig")
        for path in (ROOT / "adapter-v2.install.manifest.json", ROOT / "tests/validate_v2_upgrade.py"):
            self.assertIn(hashlib.sha256(path.read_bytes()).hexdigest(), script)
        self.assertTrue((ROOT / "Install-Windows-H3Adapter-V2.ps1").read_bytes().startswith(b"\xef\xbb\xbf"))
        self.assertIn('#Requires -Version 5.1', script)

    def test_canonical_placeholders_block_before_roots_stage_or_live_writes(self):
        manifest = json.loads((ROOT / "adapter-v2.install.manifest.json").read_text())
        self.assertEqual(sum(r["sha256"] is None for r in manifest["sourceRoles"]), 10)
        script = (ROOT / "Install-Windows-H3Adapter-V2.ps1").read_text(encoding="utf-8-sig")
        self.assertLess(script.index('if ($missingPins.Count -gt 0)'), script.index('$roots ='))
        self.assertLess(script.index('if ($missingPins.Count -gt 0)'), script.index('$backup = New-PrivateBackupDirectory'))

    def test_missing_full_canonical_closure_cannot_become_ready_from20_role_pins(self):
        manifest = json.loads((ROOT / "adapter-v2.install.manifest.json").read_text())
        self.assertFalse(manifest["canonicalSoftwareClosure"]["complete"])
        self.assertEqual(manifest["canonicalSoftwareClosure"]["files"], [])
        script = (ROOT / "Install-Windows-H3Adapter-V2.ps1").read_text(encoding="utf-8-sig")
        self.assertLess(script.index("-not $manifest.canonicalSoftwareClosure.complete"), script.index("$roots ="))
        self.assertIn("if (-not $expected.ContainsKey($key))", script)
        self.assertIn("if ($seen.ContainsKey($key))", script)
        self.assertLess(script.index("    Assert-CanonicalSoftwareClosure\n"), script.index("    Invoke-OfflineValidation $("))

    def test_active_or_unobservable_8790_refuses_before_live_snapshot(self):
        script = (ROOT / "Install-Windows-H3Adapter-V2.ps1").read_text(encoding="utf-8-sig")
        self.assertIn("Get-NetTCPConnection -State Listen -ErrorAction Stop", script)
        self.assertNotIn("Get-NetTCPConnection -State Listen -LocalPort 8790 -ErrorAction SilentlyContinue", script)
        self.assertLess(script.index("    Assert-AdapterStopped\n    $roots"), script.index("    $workbench ="))
        self.assertLess(script.index("    Assert-AdapterStopped\n    # Other eighteen"), script.index("    Set-PinnedCas $nodePath"))

    def test_installer_uses_binary_stdin_and_no_path_cleanup_or_pyc(self):
        script = (ROOT / "Install-Windows-H3Adapter-V2.ps1").read_text(encoding="utf-8-sig")
        self.assertIn('StandardInput.BaseStream.WriteAsync', script)
        self.assertIn("apply --check --whitespace=nowarn -- -", script)
        self.assertIn('QianshouH3V2NativeFileHandle]::Delete($stream)', script)
        for unsafe in ('Remove-Item', 'py_compile', '.pyc', 'Start-Process', 'owner_self_test.py'):
            self.assertNotIn(unsafe, script)

    def test_live_mutation_and_rollback_compare_exclusive_same_handle(self):
        script = (ROOT / "Install-Windows-H3Adapter-V2.ps1").read_text(encoding="utf-8-sig")
        start = script.index('function Set-PinnedCas')
        end = script.index('function Remove-PinnedCas')
        cas = script[start:end]
        self.assertIn('::OpenReadWrite($Path, $Physical)', cas)
        self.assertIn('(Get-BytesSha256 $previous) -ne $Before', cas)
        self.assertIn('Write-StreamBytes $stream $AfterBytes', cas)
        self.assertIn('Write-StreamBytes $stream $previous', cas)
        self.assertIn('AssertPhysicalPath($stream, $Physical)', cas)
        self.assertIn("$sourceSnapshots['adapter'] = $finalNode", script)
        self.assertLess(script.index('Write-NewPinned $helperPath'), script.index('Set-PinnedCas $nodePath'))


if __name__ == "__main__":
    unittest.main()
