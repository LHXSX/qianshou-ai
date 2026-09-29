"""No GPU or external service: exercise the fixed loopback H3 ABI and portable owner paths."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import subprocess
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1] / 'runtime' / 'h3-v2'
def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
runtime = load('h3_runtime')
entry = load('video_generate')
owner = load('owner_self_test')
SHA = 'a' * 64
MODEL = 'b' * 64
FRAME_BYTES = b'\x89PNG\r\n\x1a\nlocal-frame'
EXPECTED = {'executionRecipeSha256': SHA, 'modelSha256': MODEL,
            'firstFrameSha256': hashlib.sha256(FRAME_BYTES).hexdigest(), 'localConfigSha256': 'c' * 64}

class Protocol(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='h3-protocol-')
        self.root = Path(self.temp.name).resolve()
        self.work = self.root / 'workspace'
        self.work.mkdir()
        self.output = self.root / 'another-drive-layout'
        self.output.mkdir()
        self.first = self.root / 'first.png'
        self.first.write_bytes(b'\x89PNG\r\n\x1a\nlocal-frame')
        self.env = dict(H3_ADAPTER_BASE='http://127.0.0.1:8790', EC_OUTPUT_DIR=str(self.work),
                        H3_ADAPTER_OUTPUT_ROOT=str(self.output), H3_EXPECTED_EXECUTION_RECIPE_SHA256=SHA,
                        H3_EXPECTED_MODEL_SHA256=MODEL, H3_EXPECTED_FIRST_FRAME_SHA256=EXPECTED['firstFrameSha256'],
                        H3_EXPECTED_LOCAL_CONFIG_SHA256=EXPECTED['localConfigSha256'], H3_FFMPEG=str(self.root / 'ffmpeg'))
        self.params = dict(prompt='让小白猫站起来奔跑', seconds=5, workflow='qs_new4', image_path=str(self.first), seed=1)
    def tearDown(self):
        self.temp.cleanup()
    def identity(self):
        return dict(schemaVersion='qs.h3.recipe-identity.v2', workflow='qs_new4', recipeVersion='v1',
                    graphTemplateSha256=SHA, builderSourceSha256=SHA,
                    negativeSha256=hashlib.sha256(runtime.NEG.encode()).hexdigest(), **EXPECTED,
                    modelSetSha256=MODEL, weightSha256ByRole={role: SHA for role in runtime.ROLES})
    def done(self):
        return dict(status='done', recipe_identity=dict(schemaVersion='qs.h3.job-identity.v2', expected=dict(schemaVersion='qs.h3.execution-expected.v2', **EXPECTED),
                    actual=dict(**EXPECTED, modelSetSha256=MODEL, graphInstanceSha256=SHA), attested=True))
    def test_configured_output_directory_works_without_any_original_machine_path(self):
        folder = self.output / 'portable_job_001'
        folder.mkdir()
        video = folder / 'result.mp4'
        video.write_bytes(b'\0\0\0\x18ftyp' + b'video')
        self.assertEqual(runtime.cell_output(str(self.output), 'portable_job_001')[0], video.resolve())
        for bad in ('../portable_job_001', '/portable_job_001', 'job/path', ''):
            with self.subTest(bad=bad), self.assertRaises(runtime.H3RuntimeError):
                runtime.cell_output(str(self.output), bad)
    def test_output_symlink_and_foreign_root_are_refused(self):
        foreign = self.root / 'foreign'
        foreign.mkdir()
        (foreign / 'result.mp4').write_bytes(b'ftyp')
        (self.output / 'job').symlink_to(foreign, target_is_directory=True)
        with self.assertRaises(runtime.H3RuntimeError):
            runtime.cell_output(str(self.output), 'job')
        alias = self.root / 'alias'
        alias.symlink_to(self.output, target_is_directory=True)
        with self.assertRaises(runtime.H3RuntimeError):
            runtime.cell_output(str(alias), 'job')
    def test_bound_reads_refuse_empty_oversized_and_symbolic_files(self):
        source = self.root / 'source'
        source.write_bytes(b'1234')
        self.assertEqual(runtime.regular(source, 4), b'1234')
        with self.assertRaises(runtime.H3RuntimeError): runtime.regular(source, 3)
        alias = self.root / 'alias'
        alias.symlink_to(source)
        with self.assertRaises(runtime.H3RuntimeError): runtime.regular(alias)
        source.write_bytes(b'')
        with self.assertRaises(runtime.H3RuntimeError): runtime.regular(source)
    def test_fixed_recipe_uses_actual_frame_and_negative_bytes(self):
        with patch.object(runtime, 'http_json', return_value=self.identity()) as call:
            self.assertEqual(runtime.recipe_identity(self.env['H3_ADAPTER_BASE'], 'qs_new4', self.first.read_bytes()), EXPECTED)
            url = call.call_args.args[1]
            self.assertIn(hashlib.sha256(self.first.read_bytes()).hexdigest(), url)
            self.assertIn(hashlib.sha256(runtime.NEG.encode()).hexdigest(), url)
        for field in ('firstFrameSha256', 'negativeSha256', 'modelSetSha256', 'schemaVersion', 'workflow'):
            bad = self.identity(); bad[field] = 'c' * 64
            with self.subTest(field=field), patch.object(runtime, 'http_json', return_value=bad), self.assertRaises(runtime.H3RuntimeError):
                runtime.recipe_identity(self.env['H3_ADAPTER_BASE'], 'qs_new4', self.first.read_bytes())
        for mutate in (lambda row: row.update(extra=True), lambda row: row['weightSha256ByRole'].pop('clip')):
            bad = self.identity(); mutate(bad)
            with patch.object(runtime, 'http_json', return_value=bad), self.assertRaises(runtime.H3RuntimeError):
                runtime.recipe_identity(self.env['H3_ADAPTER_BASE'], 'qs_new4', self.first.read_bytes())
    def test_a_done_flag_does_not_substitute_for_this_job_identity(self):
        self.assertEqual(runtime.job_identity(self.done(), EXPECTED), EXPECTED)
        for mutate in (lambda row: row.pop('recipe_identity'), lambda row: row['recipe_identity'].update(attested=False),
                       lambda row: row['recipe_identity']['actual'].update(modelSha256='c' * 64),
                       lambda row: row['recipe_identity']['expected'].update(modelSha256='c' * 64),
                       lambda row: row['recipe_identity']['actual'].update(extra='x'), lambda row: row.update(status='running')):
            # Do not mutate the independently expected tuple through aliases.
            bad = json.loads(json.dumps(self.done())); mutate(bad)
            with self.subTest(row=bad), self.assertRaises(runtime.H3RuntimeError): runtime.job_identity(bad, EXPECTED)
    def test_real_generation_protocol_uses_expected_tuple_and_own_paths(self):
        folder = self.output / 'portable_job'
        folder.mkdir()
        (folder / 'result.mp4').write_bytes(b'\0\0\0\x18ftypvideo')
        def local_encoder(command, **kwargs):
            self.assertTrue(kwargs['check'])
            self.assertEqual(command[0], self.env['H3_FFMPEG'])
            Path(command[-1]).write_bytes(b'\0\0\0\x18ftypencoded')
        with patch.object(runtime, 'http_json', side_effect=[dict(ok=True, workflows=['qs_new4']), self.identity(),
                    dict(id='portable_job'), self.done(), self.identity()]) as calls, patch.object(runtime.subprocess, 'run', side_effect=local_encoder):
            result = runtime.generate(self.params, self.env)
            self.assertEqual(result['execution_identity'], EXPECTED)
            self.assertTrue(Path(result['video_path']).is_relative_to(self.work))
            submitted = calls.call_args_list[2].args[2]
            self.assertEqual(submitted['expected'], dict(schemaVersion='qs.h3.execution-expected.v2', **EXPECTED))
            self.assertEqual(calls.call_args_list[2].args[1], '/v2/jobs')
            self.assertEqual(calls.call_args_list[3].args[1], '/v2/jobs/portable_job')
            self.assertEqual(submitted['seconds'], 5)
            self.assertEqual(submitted['steps'], 4)
            self.assertEqual(submitted['ref_images'][0]['role'], 'first')
    def test_adapter_output_replacement_cannot_change_encoding_source(self):
        folder = self.output / 'portable_job'
        folder.mkdir()
        shared = folder / 'result.mp4'
        original = b'\0\0\0\x18ftyporiginal'
        shared.write_bytes(original)
        def local_encoder(command, **kwargs):
            shared.write_bytes(b'\0\0\0\x18ftypreplacement')
            private = Path(command[command.index('-i') + 1])
            self.assertNotEqual(private, shared)
            self.assertEqual(private.read_bytes(), original)
            self.assertEqual(private.stat().st_mode & 0o777, 0o600)
            Path(command[-1]).write_bytes(b'\0\0\0\x18ftypencoded')
        with patch.object(runtime, 'http_json', side_effect=[dict(ok=True, workflows=['qs_new4']), self.identity(),
                    dict(id='portable_job'), self.done(), self.identity()]), patch.object(runtime.subprocess, 'run', side_effect=local_encoder):
            result = runtime.generate(self.params, self.env)
            self.assertEqual(result['status'], 'ok')
        self.assertEqual(list(self.work.glob('h3_input_*')), [])
    def test_missing_owner_output_root_and_wrong_actual_recipe_never_submit_a_gpu_job(self):
        bad_env = dict(self.env, H3_ADAPTER_OUTPUT_ROOT='')
        with patch.object(runtime, 'http_json') as call, self.assertRaises(runtime.H3RuntimeError): runtime.generate(self.params, bad_env)
        call.assert_not_called()
        bad = self.identity(); bad['executionRecipeSha256'] = 'c' * 64
        with patch.object(runtime, 'http_json', side_effect=[dict(ok=True, workflows=['qs_new4']), bad]) as call, self.assertRaises(runtime.H3RuntimeError):
            runtime.generate(self.params, self.env)
        self.assertEqual(call.call_count, 2)
    def test_buyer_cannot_override_machine_config_or_use_developer_escape(self):
        environment = dict(H3_FIRST_FRAME_PATH=str(self.first), H3_WORKFLOW='qs_new4', H3_ADAPTER_BASE=self.env['H3_ADAPTER_BASE'])
        self.assertEqual(entry.prepare_node_request(dict(seconds=5), '中文任务', environment)['prompt'], '中文任务')
        for key in ('image_path', 'workflow', 'adapter', '_developer_escape'):
            with self.subTest(key=key), self.assertRaises(entry.H3NodeInputError): entry.prepare_node_request({key: 'x'}, '中文任务', environment)
    def test_local_entry_forwards_only_matching_job_identity(self):
        video = self.work / 'result.mp4'
        video.write_bytes(b'\0\0\0\x18ftypvideo')
        with patch.dict(os.environ, self.env):
            actual = entry.local_generation_result(dict(schema_version='v2', video_path=str(video), execution_identity=EXPECTED), str(self.work))
            self.assertEqual(actual['execution_identity'], EXPECTED)
            self.assertEqual(actual['local_output']['sha256'], hashlib.sha256(video.read_bytes()).hexdigest())
            with self.assertRaises(entry.H3NodeInputError): entry.local_generation_result(dict(video_path=str(video)), str(self.work))
    def test_loopback_http_is_bounded_and_refuses_redirects_and_remote_endpoints(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == '/redirect':
                    self.send_response(302); self.send_header('Location', 'http://example.invalid/'); self.end_headers(); return
                self.send_response(200); self.end_headers()
                self.wfile.write(b' ' * 65537 if self.path == '/large' else b'{"ok":true}')
            def log_message(self, *args): pass
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
        base = 'http://127.0.0.1:' + str(server.server_port)
        try:
            self.assertEqual(runtime.http_json(base, '/ok'), {'ok': True})
            for endpoint in ('/redirect', '/large'):
                with self.subTest(endpoint=endpoint), self.assertRaises(runtime.H3RuntimeError): runtime.http_json(base, endpoint)
            for bad in ('https://127.0.0.1', 'http://example.invalid', 'http://127.0.0.1/private', 'http://user@127.0.0.1'):
                with self.subTest(base=bad), self.assertRaises(runtime.H3RuntimeError): runtime.http_json(bad, '/ok')
        finally:
            server.shutdown(); server.server_close(); worker.join(timeout=2)
    def test_self_test_is_pinned_to_real_runtime_bytes(self):
        self.assertEqual(owner.ENTRY_SHA, hashlib.sha256((ROOT / 'video_generate.py').read_bytes()).hexdigest())
        self.assertEqual(owner.RUNTIME_SHA, hashlib.sha256((ROOT / 'h3_runtime.py').read_bytes()).hexdigest())
        self.assertIn('outputRoot', owner.KEYS)
        self.assertEqual(len(owner.KEYS), 13)

    def test_v1_reader_job_and_entry_results_cannot_be_upgraded(self):
        old = self.identity(); old['schemaVersion'] = 'qs.h3.recipe-identity.v1'
        with patch.object(runtime, 'http_json', return_value=old), self.assertRaises(runtime.H3RuntimeError):
            runtime.recipe_identity(self.env['H3_ADAPTER_BASE'], 'qs_new4', self.first.read_bytes())
        old = self.done(); old['recipe_identity']['schemaVersion'] = 'qs.h3.job-identity.v1'
        with self.assertRaises(runtime.H3RuntimeError): runtime.job_identity(old, EXPECTED)
        video = self.work / 'result.mp4'; video.write_bytes(b'\0\0\0\x18ftypvideo')
        with patch.dict(os.environ, self.env), self.assertRaises(entry.H3NodeInputError):
            entry.local_generation_result(dict(schema_version='v1', video_path=str(video), execution_identity=EXPECTED), str(self.work))

    def test_private_config_or_frame_changed_never_submits_gpu(self):
        for field in ('firstFrameSha256', 'localConfigSha256'):
            bad = self.identity(); bad[field] = 'd' * 64
            with self.subTest(field=field), patch.object(runtime, 'http_json', side_effect=[dict(ok=True, workflows=['qs_new4']), bad]) as call, self.assertRaises(runtime.H3RuntimeError):
                runtime.generate(self.params, self.env)
            self.assertEqual(call.call_count, 2)
        for key in ('H3_EXPECTED_FIRST_FRAME_SHA256', 'H3_EXPECTED_LOCAL_CONFIG_SHA256'):
            with patch.object(runtime, 'http_json') as call, self.assertRaises(runtime.H3RuntimeError):
                runtime.generate(self.params, dict(self.env, **{key: ''}))
            call.assert_not_called()

    def owner_config(self):
        for name in ('python', 'ffmpeg', 'ffprobe'):
            file = self.root / name
            file.write_bytes(b'#!/bin/sh\nexit 1\n')
            file.chmod(0o700)
        workflow = self.root / 'workflow.json'; workflow.write_bytes(b'{}')
        model = self.root / 'synthetic-model'; model.write_bytes(b'not-real-model-weights')
        value = dict(schema='qianshou.h3-owner.v2', pythonPath=str(self.root / 'python'),
            ffmpegPath=str(self.root / 'ffmpeg'), ffprobePath=str(self.root / 'ffprobe'),
            entryPath=str(ROOT / 'video_generate.py'), runtimePath=str(ROOT / 'h3_runtime.py'),
            firstFramePath=str(self.first), workflowPath=str(workflow), modelPath=str(model),
            workflow='qs_new4', adapterBase=self.env['H3_ADAPTER_BASE'], outputRoot=str(self.output),
            selfTestReceiptPath=str(self.root / 'new-v2-receipt.json'))
        file = self.root / 'owner.json'; file.write_text(json.dumps(value))
        return file, value

    def test_owner_trial_emits_new_public_binding_and_separate_private_config_digest(self):
        config, values = self.owner_config()
        video = self.work / 'synthetic-result.mp4'; video.write_bytes(b'\0\0\0\x18ftypunit-video')
        executed = []
        def external_process(command, **kwargs):
            if command[0] == values['pythonPath']:
                executed.append(command)
                self.assertEqual(kwargs['env']['H3_EXPECTED_LOCAL_CONFIG_SHA256'], EXPECTED['localConfigSha256'])
                result = dict(status='ok', schema_version='v2', delivery_state='pending_node_upload',
                    execution_identity=EXPECTED, video_path=str(video),
                    local_output=dict(size_bytes=video.stat().st_size, sha256=hashlib.sha256(video.read_bytes()).hexdigest()))
            else:
                self.assertEqual(command[0], values['ffprobePath'])
                result = dict(format=dict(duration='5'), streams=[dict(codec_type='video', codec_name='h264', width=640, height=480)])
            return subprocess.CompletedProcess(command, 0, json.dumps(result).encode(), b'')
        responses = [dict(ok=True, workflows=['qs_new4']), self.identity(), self.identity()]
        def external_http(*args, **kwargs):
            return io.BytesIO(json.dumps(responses.pop(0)).encode())
        with patch.object(owner.subprocess, 'run', side_effect=external_process), patch('urllib.request.OpenerDirector.open', side_effect=external_http):
            receipt = owner.trial(str(config), '仅测试生成端口，不是真GPU', str(self.work))
        self.assertEqual(len(executed), 1)
        self.assertEqual(set(receipt), {'schema', 'generationExecuted', 'ownerIdentity', 'nativeBinding',
            'localOwnerConfigDigest', 'videoPath', 'bytes', 'sha256'})
        self.assertEqual(receipt['schema'], 'qianshou.h3-self-test.v2')
        self.assertEqual(receipt['nativeBinding']['runtimeAbi'], 'qianshou.order-runtime.native-h3.v2')
        self.assertEqual(set(receipt['nativeBinding']), {'schema', 'runtimeAbi', 'runtime',
            'executionRecipeSha256', 'modelSha256', 'firstFrameSha256'})
        private = dict(ownerIdentity=receipt['ownerIdentity'], **EXPECTED)
        digest = hashlib.sha256(json.dumps(private, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
        self.assertEqual(receipt['localOwnerConfigDigest'], 'sha256:' + digest)
        self.assertEqual(json.loads(Path(values['selfTestReceiptPath']).read_text()), receipt)

    def test_v1_owner_configuration_cannot_create_v2_trial_receipt(self):
        config, values = self.owner_config()
        values['schema'] = 'qianshou.h3-owner.v1'; config.write_text(json.dumps(values))
        with patch.object(owner.subprocess, 'run') as call, self.assertRaisesRegex(ValueError, 'H3_OWNER_CONFIG_INVALID'):
            owner.trial(str(config), '旧配置不能升级', str(self.work))
        call.assert_not_called()
        self.assertFalse(Path(values['selfTestReceiptPath']).exists())

if __name__ == '__main__': unittest.main()
