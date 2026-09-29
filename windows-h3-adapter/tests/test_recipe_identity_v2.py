"""Actual identity helpers with synthetic code/model data; no Comfy/GPU/network."""
from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import recipe_identity as v1
import recipe_identity_v2 as v2


class RecipeV2(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="recipe-v2-test-")
        self.root = Path(self.temporary.name).resolve()
        self.api = self.root / "api"
        (self.api / "workbench").mkdir(parents=True)
        (self.api / "local_h3").mkdir()
        (self.api / "local_h3" / "__init__.py").write_bytes(b"")
        (self.api / "local_h3" / "comfy.py").write_bytes(b"# synthetic graph dependency\n")
        self.graph = {"2": {"inputs": {"prompt": "fixed buyer"}}, "13": {"inputs": {"noise_seed": 1}},
            "100": {"inputs": {"image": "identity/first.png"}},
            "27": {"inputs": {"filename_prefix": "identity/output", "frame_rate": 24}}}
        for node, frame in (("201", 0), ("203", 119), ("205", 123)):
            self.graph[node] = {"inputs": {"filename_prefix": "identity/output_frame%04d" % frame}}
        self.models = {"unet": ("11", "UNETLoader", "unet_name", "diffusion_models"),
            "clip": ("12", "CLIPLoader", "clip_name", "text_encoders"),
            "videoVae": ("3", "VAELoader", "vae_name", "vae"),
            "audioVae": ("4", "VAELoader", "vae_name", "vae"),
            "lora": ("31", "LoraLoaderBypassModelOnly", "lora_name", "loras")}
        for role, (node, klass, field, category) in self.models.items():
            self.graph[node] = {"class_type": klass, "inputs": {field: role + ".safetensors"}}
        source = "SPECS = {'E_light4_sage': None}\ndef build(*args, **kwargs):\n    return " + repr(self.graph) + ", {}\n"
        (self.api / "workbench" / "graphs.py").write_text(source, encoding="utf-8")
        self.devices = {}
        for name in ("A", "B"):
            comfy = self.root / name / "Comfy"
            pool = self.root / name / "owner-private-pool"
            comfy.mkdir(parents=True)
            source_dir = comfy / "source"
            source_dir.mkdir()
            paths = {}
            for role in v2.CODE_ROLES:
                file = source_dir / (role + ".py")
                file.write_text("# synthetic identical " + role + "\n", encoding="utf-8")
                paths[role] = file
            paths.update(identity=ROOT / "recipe_identity.py", identityV2=ROOT / "recipe_identity_v2.py",
                         graphBuilder=self.api / "workbench" / "graphs.py", comfyGraph=self.api / "local_h3" / "comfy.py")
            for role, (_, _, _, category) in self.models.items():
                folder = pool / category
                folder.mkdir(parents=True, exist_ok=True)
                (folder / (role + ".safetensors")).write_bytes(("synthetic fixed model " + role).encode())
            yaml = comfy / "extra_model_paths.yaml"
            yaml.write_text("native:\n  base_path: " + str(pool) + "\n  diffusion_models: diffusion_models\n"
                            "  text_encoders: text_encoders\n  vae: vae\n  loras: loras\n", encoding="utf-8")
            paths["comfyExtraModelPaths"] = yaml
            self.devices[name] = (comfy, pool, paths)

    def tearDown(self):
        sys.modules.pop("local_h3.comfy", None)
        sys.modules.pop("local_h3", None)
        self.temporary.cleanup()

    def build(self, name="A"):
        comfy, _, paths = self.devices[name]
        return v2.build_identity_v2(self.api, comfy, paths, force_hash=True)

    def test_actual_same_code_and_five_models_share_public_recipe_across_private_paths(self):
        a, b = self.build("A"), self.build("B")
        public_a, public_b = a.identity_for("a" * 64, "b" * 64), b.identity_for("a" * 64, "b" * 64)
        for key in ("executionRecipeSha256", "modelSha256", "modelSetSha256", "firstFrameSha256"):
            self.assertEqual(public_a[key], public_b[key])
        self.assertEqual(a.source_sha256, b.source_sha256)
        self.assertNotEqual(a.local_config_sha256, b.local_config_sha256)
        legacy_a = v1._source_digest(self.devices["A"][2], force_hash=True)
        legacy_b = v1._source_digest(self.devices["B"][2], force_hash=True)
        self.assertNotEqual(legacy_a, legacy_b)
        self.assertNotEqual(public_a["executionRecipeSha256"],
            v1.RecipeIdentity(a.graph_sha256, a.model_sha256, a.model_set_sha256, a.source_sha256,
                              a.model_asset_sha256, a.model_asset_mtime_ns).identity_for("a" * 64, "b" * 64)["executionRecipeSha256"])

    def test_actual_model_bytes_and_code_changes_change_public_recipe(self):
        first = self.build()
        _, pool, paths = self.devices["A"]
        (pool / "vae" / "audioVae.safetensors").write_bytes(b"changed synthetic audio weight")
        second = self.build()
        self.assertNotEqual(first.model_sha256, second.model_sha256)
        paths["comfyExecution"].write_bytes(b"# changed executing source\n")
        third = self.build()
        self.assertNotEqual(second.source_sha256, third.source_sha256)

    def test_identical_named_model_in_another_physical_root_is_ambiguous(self):
        comfy, pool, _ = self.devices["A"]
        folder = comfy / "models" / "vae"
        folder.mkdir(parents=True)
        (folder / "audioVae.safetensors").write_bytes((pool / "vae" / "audioVae.safetensors").read_bytes())
        with self.assertRaises(v1.RecipeIdentityError): self.build()

    def test_optional_yaml_changes_private_identity_but_not_equivalent_public_recipe(self):
        before = self.build()
        comfy, pool, paths = self.devices["A"]
        for role, (_, _, _, category) in self.models.items():
            folder = comfy / "models" / category
            folder.mkdir(parents=True, exist_ok=True)
            (pool / category / (role + ".safetensors")).rename(folder / (role + ".safetensors"))
        paths.pop("comfyExtraModelPaths").unlink()
        after = self.build()
        self.assertEqual(before.identity_for("a" * 64, "b" * 64)["executionRecipeSha256"],
                         after.identity_for("a" * 64, "b" * 64)["executionRecipeSha256"])
        self.assertNotEqual(before.local_config_sha256, after.local_config_sha256)

    def test_yaml_alias_duplicates_unknown_fields_and_wrong_types_are_rejected(self):
        invalid = (b"x: &anchor {base_path: /tmp}\ny: *anchor\n", b"x:\n  vae: a\n  vae: b\n",
            b"x:\n  command: execute\n", b"x:\n  is_default: 1\n", b"x:\n  base_path: 42\n",
            b"x:\n  vae: [a,b]\n", b"x:\n  base_path: ''\n", b"x: null\n", b"x:\n  <<: {}\n")
        yaml = self.devices["A"][2]["comfyExtraModelPaths"]
        for data in invalid:
            with self.subTest(data=data):
                yaml.write_bytes(data)
                with self.assertRaises(v1.RecipeIdentityError): self.build()

    def test_yaml_priority_boolean_multiline_paths_and_legacy_alias_names_are_explicit(self):
        before = self.build()
        comfy, pool, paths = self.devices["A"]
        paths["comfyExtraModelPaths"].write_text("x:\n  base_path: " + str(pool) +
            "\n  is_default: true\n  unet: diffusion_models\n  clip: |\n    text_encoders\n  vae: vae\n  loras: loras\n")
        after = self.build()
        self.assertEqual(before.source_sha256, after.source_sha256)
        self.assertEqual(before.model_sha256, after.model_sha256)
        self.assertNotEqual(before.local_config_sha256, after.local_config_sha256)

    def test_yaml_file_bounds_symlink_and_snapshot_roles_are_rejected(self):
        comfy, _, paths = self.devices["A"]
        yaml = paths["comfyExtraModelPaths"]
        for data in (b"", b" " * (v2.YAML_LIMIT + 1)):
            yaml.write_bytes(data)
            with self.assertRaises(v1.RecipeIdentityError): self.build()
        yaml.unlink()
        foreign = self.root / "foreign.yaml"; foreign.write_bytes(b"x: {vae: vae}\n")
        yaml.symlink_to(foreign)
        with self.assertRaises(v1.RecipeIdentityError): self.build()
        yaml.unlink()
        with self.assertRaises(v1.RecipeIdentityError): self.build()
        paths.pop("comfyExtraModelPaths")
        paths.pop("comfyExecution")
        with self.assertRaises(v1.RecipeIdentityError): self.build()

    def test_optional_yaml_snapshot_rejects_new_deleted_changed_and_postboot_config(self):
        comfy, _, paths = self.devices["A"]
        yaml = paths["comfyExtraModelPaths"]
        original = yaml.read_bytes()
        snapshot = v2.freeze_model_config(comfy)
        snapshot.assert_current(time.time_ns() + 1)
        boot = yaml.stat().st_mtime_ns - 1
        with self.assertRaises(v1.RecipeIdentityError): snapshot.assert_current(boot)
        yaml.write_bytes(original + b"# changed\n")
        with self.assertRaises(v1.RecipeIdentityError): snapshot.assert_current(time.time_ns() + 1)
        yaml.unlink()
        with self.assertRaises(v1.RecipeIdentityError): snapshot.assert_current(time.time_ns() + 1)
        absent = v2.freeze_model_config(comfy)
        absent.assert_current(time.time_ns() + 1)
        yaml.write_bytes(original)
        with self.assertRaises(v1.RecipeIdentityError): absent.assert_current(time.time_ns() + 1)

    def test_same_byte_yaml_replacement_cannot_reuse_the_loaded_snapshot(self):
        comfy, _, paths = self.devices["A"]
        yaml = paths["comfyExtraModelPaths"]
        snapshot = v2.freeze_model_config(comfy)
        replacement = comfy / "replacement.yaml"
        replacement.write_bytes(yaml.read_bytes())
        replacement.replace(yaml)
        with self.assertRaises(v1.RecipeIdentityError): snapshot.assert_current(time.time_ns() + 1)


if __name__ == "__main__": unittest.main()
