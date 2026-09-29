"""Apply the real V2 patch, then test actual adapter routes with synthetic local ports.

No GPU/network/service is started. Graph/model fixture bytes are synthetic;
production identity, request validation, middleware and load-history guards run.
"""
from pathlib import Path
import ast
import base64
import copy
import hashlib
import importlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
from uuid import uuid4

from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
V1_SHA = "0650d18bc9060efda379185944ef6841a0dcae5ce0ed3cec24076fefd512a2f2"
PNG = b"\x89PNG\r\n\x1a\nsynthetic fixed first frame"
NEGATIVE = "fixed negative fixture"


class AdapterV2(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="adapter-v2-test-")
        self.base = Path(self.temp.name).resolve()
        self.api = self.base / "api"
        self.workbench = self.api / "workbench"
        self.workbench.mkdir(parents=True)
        self.comfy_root = self.base / "comfy"
        self.node_root = self.base / "node"
        self.output = self.node_root / "output"
        (self.output / "MiniMax_H3" / "LocalAPI").mkdir(parents=True)
        (self.node_root / "input").mkdir()
        self.out = self.base / "metadata"
        self.out.mkdir()
        original = (ROOT / "fixtures/v1-installed/workbench_node.py").read_bytes()
        self.assertEqual(hashlib.sha256(original).hexdigest(), V1_SHA)
        self.adapter_file = self.workbench / "workbench_node.py"
        self.adapter_file.write_bytes(original)
        subprocess.run(["git", "apply", "--check", str(ROOT / "workbench_node.v2.patch")],
                       cwd=self.api, check=True, capture_output=True)
        subprocess.run(["git", "apply", str(ROOT / "workbench_node.v2.patch")],
                       cwd=self.api, check=True, capture_output=True)
        compile(self.adapter_file.read_bytes(), str(self.adapter_file), "exec")
        for name in ("recipe_identity.py", "recipe_identity_v2.py", "runtime_attestation.py"):
            shutil.copyfile(ROOT / name, self.workbench / name)
        self.graph = {"2": {"inputs": {"prompt": "identity buyer"}},
            "13": {"inputs": {"noise_seed": 0}}, "100": {"inputs": {"image": "identity/first.png"}},
            "27": {"inputs": {"filename_prefix": "identity/output", "frame_rate": 24}}}
        for node, frame in (("201", 0), ("203", 119), ("205", 123)):
            self.graph[node] = {"inputs": {"filename_prefix": "identity/output_frame%04d" % frame}}
        models = {"unet": ("11", "UNETLoader", "unet_name", "diffusion_models"),
                  "clip": ("12", "CLIPLoader", "clip_name", "text_encoders"),
                  "videoVae": ("3", "VAELoader", "vae_name", "vae"),
                  "audioVae": ("4", "VAELoader", "vae_name", "vae"),
                  "lora": ("31", "LoraLoaderBypassModelOnly", "lora_name", "loras")}
        for role, (node, klass, field, category) in models.items():
            self.graph[node] = {"class_type": klass, "inputs": {field: role + ".safetensors"}}
            folder = self.comfy_root / "models" / category
            folder.mkdir(parents=True, exist_ok=True)
            (folder / (role + ".safetensors")).write_bytes(("synthetic model " + role).encode())
        graphs = '''from types import SimpleNamespace
from copy import deepcopy
SPECS = {name: SimpleNamespace(steps=steps,width=1344,height=768,model="unet.safetensors",
 name=name,lora="lora.safetensors",turbo_lora=True,sampler="test",shift=6,sage=True)
 for name,steps in [("E_light4_sage",4),("F_light8_sage",8),("I_base12_sage",12),("J_base28_sage",28)]}
GRAPH = ''' + repr(self.graph) + '''
def build(api_root,spec,seed,output,first,frames=124,prompt="identity buyer",**kwargs):
 graph=deepcopy(GRAPH);graph["2"]["inputs"]["prompt"]=prompt;graph["13"]["inputs"]["noise_seed"]=seed
 graph["100"]["inputs"]["image"]=first;graph["27"]["inputs"]["filename_prefix"]=output
 for node,frame in [("201",0),("203",119),("205",123)]:
  graph[node]["inputs"]["filename_prefix"]=output+"_frame%04d"%frame
 return graph, {"synthetic":True}
'''
        (self.workbench / "graphs.py").write_text(graphs)
        for rel in ("main.py", "folder_paths.py", "execution.py", "comfy_execution/caching.py", "comfy/cli_args.py",
                    "custom_nodes/h3_benchmark_sampler/__init__.py", "custom_nodes/h3_benchmark_sampler/sampling.py",
                    "custom_nodes/h3_benchmark_sampler/core.py", "comfy_extras/nodes_minimax_h3.py",
                    "custom_nodes/ComfyUI-KJNodes/nodes/model_optimization_nodes.py"):
            path = self.comfy_root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("# synthetic fixed " + rel + "\n")
        local = self.api / "local_h3"
        local.mkdir()
        (local / "__init__.py").write_text("")
        (local / "comfy.py").write_text('''from pathlib import Path
import shutil
TURBO4_MODEL="unet.safetensors"
def comfy_queue():return {"running":[],"pending":[]}
def copy_output(src,jid,filename):
 from . import jobs
 target=jobs.JOBS_DIR/jid/filename;shutil.copyfile(src,target);return target
''')
        (local / "jobs.py").write_text('''import base64,json,os
from pathlib import Path
from uuid import uuid4
JOBS_DIR=Path(os.environ["H3_JOBS_DIR"])
def save_job(job):
 folder=JOBS_DIR/job["id"];folder.mkdir(parents=True,exist_ok=True)
 (folder/"job.json").write_text(json.dumps(job))
def load_job(jid):return json.loads((JOBS_DIR/jid/"job.json").read_text())
def list_jobs(limit=100):return [json.loads(p.read_text()) for p in sorted(JOBS_DIR.glob("*/job.json"))][:limit]
def create_job(req):
 jid=str(uuid4());first=jid+".png"
 if req.get("ref_images"):
  data=base64.b64decode(req["ref_images"][0]["url"].split(",",1)[1])
  (Path(os.environ["H3_COMFY_ROOT"])/"input"/first).write_bytes(data)
 neg=req.get("negative") or ""
 job={**req,"id":jid,"length":124 if req["seconds"]==5 else 73,"prompt_full":req["prompt"].rstrip()+("\\n\\nNegative: "+neg if neg else ""),
 "status":"queued","first_frame_rel":first}
 save_job(job);return job
''')
        (local / "schemas.py").write_text('def gateway_job_view(job,request=None):return {"id":job["id"],"status":job["status"],"video":job.get("video")}\n')
        (local / "workflows.py").write_text('# synthetic storage port\n')
        (local / "app.py").write_text('''from fastapi import FastAPI,Request
from . import comfy,jobs,workflows,schemas
app=FastAPI()
def _health_payload():return {"ok":True}
@app.get("/health")
def health():return _health_payload()
@app.post("/v1/jobs")
async def submit(request:Request):
 job=jobs.create_job(await request.json());return schemas.gateway_job_view(job,request)
@app.get("/v1/jobs/{jid}")
def status(jid:str,request:Request):return schemas.gateway_job_view(jobs.load_job(jid),request)
''')
        self.saved_path = list(sys.path)
        self.saved_modules = {k:v for k,v in sys.modules.items() if k in ("graphs", "recipe_identity", "recipe_identity_v2", "runtime_attestation") or k.startswith("local_h3")}
        for key in self.saved_modules:
            sys.modules.pop(key, None)
        sys.path.insert(0, str(self.workbench))
        spec = importlib.util.spec_from_file_location("synthetic_actual_adapter_v2", self.adapter_file)
        self.adapter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.adapter)
        self.token = "a" * 64
        self.boot = time.time_ns() + 10_000_000_000
        self.process = mock.patch.object(self.adapter, "measure_comfy_runtime", side_effect=lambda *_: (self.token, self.boot))
        self.process.start()
        self.env = mock.patch.dict(os.environ, {"H3_COMFY_BASE":"http://127.0.0.1:8189",
            "H3_COMFY_MODEL_ROOT":str(self.comfy_root), "H3_ADAPTER_OUTPUT_ROOT":str(self.output / "MiniMax_H3/LocalAPI")})
        self.env.start()
        self.create()

    def create(self):
        self.app = self.adapter.create_app(self.api, self.node_root, self.out, "synthetic-ffmpeg")
        self.gateway = sys.modules["local_h3.app"]
        # The pinned Starlette 0.36.3 TestClient has no ``client`` parameter.
        # Set the ASGI peer explicitly so loopback-only routes are exercised
        # against the same address as a real local caller.
        async def loopback_app(scope, receive, send):
            if scope["type"] in ("http", "websocket"):
                scope = {**scope, "client": ("127.0.0.1", 43123)}
            await self.app(scope, receive, send)

        self.client = TestClient(loopback_app)

    def recreate_with_yaml(self, data):
        self.client.close()
        (self.comfy_root/"extra_model_paths.yaml").write_bytes(data)
        for name in ("local_h3.comfy", "local_h3.jobs", "local_h3.workflows", "local_h3.schemas", "local_h3.app"):
            importlib.reload(sys.modules[name])
        self.create()

    def tearDown(self):
        self.client.close()
        self.env.stop();self.process.stop()
        for key in list(sys.modules):
            if key in ("graphs", "recipe_identity", "recipe_identity_v2", "runtime_attestation", "_qs_h3_recipe_identity_graphs") or key.startswith("local_h3"):
                sys.modules.pop(key, None)
        sys.modules.update(self.saved_modules)
        sys.path[:] = self.saved_path
        self.temp.cleanup()

    def identity(self, version=2):
        return self.client.get(f"/v{version}/recipes/qs_new4/identity", params={
            "firstFrameSha256":hashlib.sha256(PNG).hexdigest(),
            "negativeSha256":hashlib.sha256(NEGATIVE.encode()).hexdigest()})

    def request(self, version=2):
        identity = self.identity(version).json()
        expected = {key:identity[key] for key in ("executionRecipeSha256","modelSha256")}
        if version == 2:
            expected.update(schemaVersion="qs.h3.execution-expected.v2",firstFrameSha256=identity["firstFrameSha256"],
                            localConfigSha256=identity["localConfigSha256"])
        return {"workflow":"qs_new4","steps":4,"tier":None,"preset":"landscape_C","seconds":5,
                "prompt":"中文合成路由验收","negative":NEGATIVE,"seed":7,"expected":expected,
                "ref_images":[{"url":"data:image/png;base64,"+base64.b64encode(PNG).decode(),"role":"first","name":"test"}]}

    def submit(self, version=2):
        result = self.client.post(f"/v{version}/jobs", json=self.request(version))
        self.assertEqual(result.status_code, 200, result.text)
        return self.gateway.jobs.load_job(result.json()["id"])

    def history(self, graph, job, cached=(), during_read=None):
        accepted = copy.deepcopy(graph);accepted["27"]["inputs"]["frame_rate"]=24.0
        prompt = job["comfy_prompt_id"]
        data = {prompt:{"prompt":[0,prompt,accepted],"status":{"status_str":"success","completed":True,
            "messages":[["execution_start",{"prompt_id":prompt,"timestamp":1}],
                        ["execution_cached",{"prompt_id":prompt,"nodes":list(cached)}],
                        ["execution_success",{"prompt_id":prompt,"timestamp":2}]]}}}
        class Response:
            def __enter__(self):
                if during_read: during_read()
                return self
            def __exit__(self,*_):pass
            def read(self):return json.dumps(data).encode()
        return mock.patch.object(sys.modules["runtime_attestation"],"urlopen",return_value=Response())

    def execute_graph(self, job):
        graph = self.gateway.workflows.build_prompt_graph(job)
        job = self.gateway.jobs.load_job(job["id"])
        job["comfy_prompt_id"] = str(uuid4());self.gateway.jobs.save_job(job)
        return graph,job

    def finish(self, graph, job, cached=(), during_read=None):
        src = self.output / "synthetic-comfy-output.mp4"
        src.write_bytes(b"\x00\x00\x00\x18ftyp"+b"synthetic not decoded video")
        def ffmpeg(args,**_):
            Path(args[-1]).write_bytes(src.read_bytes())
            return subprocess.CompletedProcess(args,0)
        with self.history(graph,job,cached,during_read), mock.patch.object(self.adapter.subprocess,"run",side_effect=ffmpeg):
            path = self.gateway.comfy.copy_output(str(src),job["id"],"result.mp4")
        job = self.gateway.jobs.load_job(job["id"])
        job.update(status="done",video=str(path));self.gateway.jobs.save_job(job)
        return job

    def test_real_patch_preserves_v1_functions_and_fixture(self):
        original=(ROOT/"fixtures/v1-installed/workbench_node.py").read_bytes()
        self.assertEqual(hashlib.sha256(original).hexdigest(),V1_SHA)
        before={n.name:ast.dump(n) for n in ast.parse(original).body if isinstance(n,ast.FunctionDef)}
        after={n.name:ast.dump(n) for n in ast.parse(self.adapter_file.read_bytes()).body if isinstance(n,ast.FunctionDef)}
        for name in before.keys()-{"create_app"}:
            self.assertEqual(before[name],after[name],name)

    def test_v2_reader_exact_private12_and_v1_reader_unchanged11(self):
        new=self.identity();old=self.identity(1)
        self.assertEqual(new.status_code,200,new.text);self.assertEqual(old.status_code,200,old.text)
        self.assertEqual(len(new.json()),12);self.assertEqual(len(old.json()),11)
        self.assertEqual(new.json()["schemaVersion"],"qs.h3.recipe-identity.v2")
        self.assertEqual(old.json()["schemaVersion"],"qs.h3.recipe-identity.v1")
        self.assertNotEqual(new.json()["executionRecipeSha256"],old.json()["executionRecipeSha256"])
        self.assertEqual(new.headers["cache-control"],"no-store")

    def test_v2_submit_real_gateway_preserves_expected5_and_pending_job(self):
        job=self.submit();self.assertEqual(job["recipe_identity"]["schemaVersion"],"qs.h3.job-identity.v2")
        self.assertEqual(len(job["recipe_identity"]["expected"]),5)
        reply=self.client.get("/v2/jobs/"+job["id"])
        self.assertEqual(reply.status_code,200,reply.text)
        self.assertFalse(reply.json()["recipe_identity"]["attested"])
        self.assertIsNone(reply.json()["recipe_identity"]["actual"])

    def test_v1_job_keeps_v1_schema_and_cannot_be_polled_as_v2(self):
        job=self.submit(1)
        reply=self.client.get("/v1/jobs/"+job["id"])
        self.assertEqual(reply.status_code,200);self.assertEqual(reply.json()["recipe_identity"]["schemaVersion"],"qs.h3.job-identity.v1")
        self.assertEqual(len(reply.json()["recipe_identity"]["expected"]),2)
        self.assertEqual(self.client.get("/v2/jobs/"+job["id"]).status_code,409)

    def test_v2_job_cannot_leak_into_legacy_v1_route(self):
        job=self.submit()
        self.assertEqual(self.client.get("/v1/jobs/"+job["id"]).status_code,409)

    def test_v1_expected_never_upgrades_on_v2_and_v2_never_enters_v1(self):
        for route,body in (("/v2/jobs",self.request(1)),("/v1/jobs",self.request(2))):
            with self.subTest(route=route):
                self.assertEqual(self.client.post(route,json=body).status_code,400)
        self.assertEqual(self.gateway.jobs.list_jobs(),[])

    def test_v2_missing_mutated_identity_or_buyer_config_never_creates_job(self):
        for mutation in (lambda b:b.pop("expected"),lambda b:b["expected"].update(firstFrameSha256="f"*64),
                         lambda b:b["expected"].update(localConfigSha256="e"*64),lambda b:b.update(output_root="/buyer/path"),
                         lambda b:b.update(modelPath="/buyer/model"),lambda b:b["expected"].update(extra="ignored")):
            body=self.request();mutation(body)
            self.assertIn(self.client.post("/v2/jobs",json=body).status_code,(400,409))
        self.assertEqual(self.gateway.jobs.list_jobs(),[])

    def test_v2_reader_rejects_ambiguous_query_and_remote_origin(self):
        self.assertEqual(self.client.get("/v2/recipes/qs_new4/identity?firstFrameSha256=a&firstFrameSha256=b&negativeSha256=c").status_code,400)
        self.assertEqual(self.client.get("/v2/recipes/qs_new4/identity",headers={"Origin":"https://external.invalid"}).status_code,403)
        self.assertEqual(self.client.post("/v2/recipes/qs_new4/identity").status_code,405)

    def test_source_change_before_submit_never_reaches_gateway(self):
        body=self.request();(self.comfy_root/"execution.py").write_text("# source changed\n")
        self.assertEqual(self.client.post("/v2/jobs",json=body).status_code,503)
        self.assertEqual(self.gateway.jobs.list_jobs(),[])

    def test_source_change_inside_identity_read_is_rechecked_afterward(self):
        path=self.comfy_root/"execution.py";original=Path.read_bytes;armed=True
        def read(file):
            nonlocal armed
            data=original(file)
            if file==path and armed:
                armed=False;file.write_text("# change after first boundary\n")
            return data
        with mock.patch.object(Path,"read_bytes",read):
            result=self.identity()
        self.assertEqual(result.status_code,503);self.assertFalse(armed)

    def test_optional_yaml_creation_after_startup_is_rejected(self):
        (self.comfy_root/"extra_model_paths.yaml").write_text("native: {vae: models/vae}\n")
        self.assertEqual(self.identity().status_code,503)

    def test_existing_yaml_deletion_replacement_and_raw_edit_are_rejected(self):
        original=b"native: {vae: models/vae}\n"
        for kind in ("delete","replace","edit"):
            with self.subTest(kind=kind):
                self.recreate_with_yaml(original)
                self.assertEqual(self.identity().status_code,200)
                path=self.comfy_root/"extra_model_paths.yaml"
                if kind=="delete":path.unlink()
                elif kind=="replace":
                    replacement=path.with_suffix(".replacement");replacement.write_bytes(original);replacement.replace(path)
                else:path.write_bytes(original+b"# changed\n")
                self.assertEqual(self.identity().status_code,503)

    def test_unsupported_v2_yaml_does_not_promote_or_disable_v1(self):
        self.recreate_with_yaml(b"native: {checkpoints: models/checkpoints}\n")
        self.assertEqual(self.identity().status_code,503)
        self.assertEqual(self.identity(1).status_code,200)

    def test_yaml_modified_after_comfy_boot_is_not_ready(self):
        self.recreate_with_yaml(b"native: {vae: models/vae}\n")
        self.boot=(self.comfy_root/"extra_model_paths.yaml").stat().st_mtime_ns-1
        self.assertEqual(self.identity().status_code,503)

    def test_process_change_inside_identity_read_is_rejected(self):
        self.adapter.measure_comfy_runtime.side_effect=[("a"*64,self.boot),("b"*64,self.boot)]
        self.assertEqual(self.identity().status_code,503)

    def test_process_change_between_queue_and_identity_check_creates_no_job(self):
        body=self.request()
        self.adapter.measure_comfy_runtime.side_effect=[("a"*64,self.boot),("b"*64,self.boot),
            ("b"*64,self.boot),("b"*64,self.boot)]
        self.assertEqual(self.client.post("/v2/jobs",json=body).status_code,503)
        self.assertEqual(self.gateway.jobs.list_jobs(),[])

    def test_first_frame_change_before_comfy_submit_is_rejected(self):
        job=self.submit();(self.node_root/"input"/job["first_frame_rel"]).write_bytes(PNG+b"changed")
        with self.assertRaises(self.adapter.RecipeIdentityError):self.gateway.workflows.build_prompt_graph(job)

    def test_model_change_while_queued_is_rejected_before_comfy_submit(self):
        job=self.submit();(self.comfy_root/"models/vae/audioVae.safetensors").write_bytes(b"different model")
        with self.assertRaises(self.adapter.RecipeIdentityError):self.gateway.workflows.build_prompt_graph(job)

    def test_real_graph_and_load_history_complete_exact_v2_actual6(self):
        graph,job=self.execute_graph(self.submit());job=self.finish(graph,job)
        reply=self.client.get("/v2/jobs/"+job["id"])
        self.assertEqual(reply.status_code,200,reply.text)
        value=reply.json()["recipe_identity"]
        self.assertTrue(value["attested"]);self.assertEqual(len(value["actual"]),6)
        self.assertEqual(value["actual"]["firstFrameSha256"],hashlib.sha256(PNG).hexdigest())
        self.assertEqual(value["actual"]["localConfigSha256"],value["expected"]["localConfigSha256"])
        self.assertEqual(len(reply.json()["comfy_model_load_generation_sha256"]),64)

    def test_completed_v1_job_retains_exact_actual4(self):
        graph,job=self.execute_graph(self.submit(1));job=self.finish(graph,job)
        reply=self.client.get("/v1/jobs/"+job["id"])
        self.assertEqual(reply.status_code,200,reply.text)
        self.assertEqual(len(reply.json()["recipe_identity"]["actual"]),4)
        self.assertEqual(reply.json()["recipe_identity"]["schemaVersion"],"qs.h3.job-identity.v1")

    def test_cached_loader_cannot_become_attested(self):
        graph,job=self.execute_graph(self.submit())
        with self.assertRaises(self.adapter.ComfyRuntimeError):self.finish(graph,job,cached=["12"])
        self.assertNotIn("actualAfterComfySubmit",self.gateway.jobs.load_job(job["id"])["recipe_identity"])

    def test_first_frame_change_after_render_cannot_become_attested(self):
        graph,job=self.execute_graph(self.submit())
        (self.node_root/"input"/job["first_frame_rel"]).write_bytes(PNG+b"changed")
        with self.assertRaises(self.adapter.RecipeIdentityError):self.finish(graph,job)

    def test_source_change_during_load_history_is_rechecked_before_attestation(self):
        graph,job=self.execute_graph(self.submit())
        with self.assertRaises(self.adapter.RecipeIdentityError):
            self.finish(graph,job,during_read=lambda:(self.comfy_root/"execution.py").write_text("# changed in history\n"))
        self.assertNotIn("actualAfterComfySubmit",self.gateway.jobs.load_job(job["id"])["recipe_identity"])

    def test_process_unavailable_at_final_queue_check_does_not_create_job(self):
        body = self.request()
        self.adapter.measure_comfy_runtime.side_effect = [
            ("a" * 64, self.boot), ("a" * 64, self.boot), ("a" * 64, self.boot),
            self.adapter.RecipeIdentityError("Synthetic current process unavailable"),
        ]
        reply = self.client.post("/v2/jobs", json=body)
        self.assertEqual(reply.status_code, 503, reply.text)
        self.assertEqual(reply.json()["error"], "H3_V2_RECIPE_IDENTITY_UNAVAILABLE")
        self.assertEqual(self.gateway.jobs.list_jobs(), [])

    def test_process_change_after_load_history_cannot_reuse_old_generation(self):
        graph,job=self.execute_graph(self.submit())
        self.adapter.measure_comfy_runtime.side_effect=[("a"*64,self.boot)]*4+[("b"*64,self.boot)]*3
        with self.assertRaises(self.adapter.RecipeIdentityError):self.finish(graph,job)
        self.assertNotIn("actualAfterComfySubmit",self.gateway.jobs.load_job(job["id"])["recipe_identity"])


if __name__ == "__main__":
    unittest.main()
