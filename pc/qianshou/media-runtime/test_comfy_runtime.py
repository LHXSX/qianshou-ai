"""CPU contract fixtures: no GPU, production credentials or qualification claims."""
import copy
import datetime as dt
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import uuid

SOURCE = Path(__file__).parent / 'comfy_runtime.py'
spec = importlib.util.spec_from_file_location('comfy_runtime', SOURCE)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
PNG = b'\x89PNG\r\n\x1a\nCPU contract only'
MP4 = b'\x00\x00\x00\x18ftypmp42CPU contract only'


class Upstream:
    def __init__(self):
        self.posts = []
        self.reads = []
        self.uploads = []
        self.drop_post = False
        self.history = {}
        self.output = PNG
        self.drop_download = False

    def json(self, method, path, body=None):
        if method == 'POST':
            self.posts.append(copy.deepcopy(body))
            if self.drop_post:
                raise TimeoutError('lost response')
            return {'prompt_id': body['prompt_id'], 'node_errors': {}}
        if path == '/system_stats':
            return {'devices': [{'name': 'CPU fixture'}]}
        if path.startswith('/object_info/'):
            return {path.removeprefix('/object_info/'): {}}
        self.reads.append(path)
        return self.history

    def bytes(self, method, path, maximum):
        assert method == 'GET' and path.startswith('/view?')
        if self.drop_download:
            raise TimeoutError('delivery failure')
        return self.output

    def upload(self, name, value, content_type):
        self.uploads.append((name, value, content_type))
        return name


class Contracts(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.account = Path(self.temporary.name) / 'account'
        self.bundle = self.account / 'bundles' / ('b' * 64)
        self.bundle.mkdir(parents=True)
        shutil.copyfile(SOURCE, self.bundle / 'comfy_runtime.py')
        self.upstream = Upstream()
        self.instances = []
        self.graph = {'1': {'class_type': 'Fixture', 'inputs': {'prompt': '', 'negative': '', 'image': ''}},
                      '2': {'class_type': 'SaveImage', 'inputs': {}}}
        graph_bytes = runtime.canonical(self.graph)
        (self.bundle / 'graph.json').write_bytes(graph_bytes)
        self.capability = {'profile_id': 'fixture.v1', 'profile_version': 1, 'model_sha256': 'a'*64,
                           'workflow_sha256': runtime.sha(graph_bytes), 'validation_receipt_sha256': 'c'*64}
        self.media = {'capability': 'image', 'mode': 'text_to_image', 'quality': 'fast',
                      'orientation': 'square', 'seconds': None}
        self.bindings = {'prompt': ['1', 'prompt'], 'negative_prompt': ['1', 'negative']}

    def tearDown(self):
        for instance in self.instances:
            instance.close()
        self.temporary.cleanup()

    def create(self):
        recipe = {'capability': self.capability, 'media': self.media, 'graph': 'graph.json',
                  'bindings': self.bindings, 'output': {'node': '2', 'collection': 'images' if self.media['capability'] == 'image' else 'videos'}}
        (self.bundle / 'recipes.json').write_bytes(runtime.canonical(
            {'schema': 'qianshou.comfy-recipes.v1', 'comfy_origin': 'http://127.0.0.1:8188', 'recipes': [recipe]}))
        instance = runtime.Runtime(self.bundle, str(uuid.uuid4()), [self.capability], 'b'*64, self.upstream)
        self.instances.append(instance)
        return instance

    def request(self):
        attempt, asset = str(uuid.uuid4()), str(uuid.uuid4())
        suffix = 'png' if self.media['capability'] == 'image' else 'mp4'
        output = self.account / 'attempts' / attempt / 'result' / asset / ('result.' + suffix)
        output.parent.mkdir(parents=True)
        plan_hash = 'd'*64
        return {'schema': 'qianshou.media-runtime-submit.v1', 'idempotencyKey': attempt,
                'taskId': str(uuid.uuid4()), 'attemptId': attempt, 'leaseEpoch': 1, 'assetId': asset,
                'leaseExpiresAt': (dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=5)).isoformat(),
                'deviceId': str(uuid.uuid4()), 'accountId': 7, 'plan_sha256': plan_hash,
                'plan': {**self.capability, **self.media, 'plan_sha256': plan_hash},
                'spec': {'task_type': self.media['capability'] + '_generate', 'input_kind': 'params_only',
                         'media_input': {**self.media, 'profile_id': self.capability['profile_id'], 'profile_version': 1,
                                         'prompt': 'owner description', 'negative_prompt': '', 'assets': []}},
                'outputPath': str(output), 'assets': []}

    def completed(self, request, extension='png'):
        self.upstream.history = {request['attemptId']: {'status': {'completed': True, 'status_str': 'success'},
                                                       'outputs': {'2': {'images' if extension == 'png' else 'videos':
                                                                         [{'filename': 'original.'+extension, 'type': 'output', 'subfolder': ''}]}}}}

    def test_lost_post_response_and_cold_restart_read_only_original(self):
        first = self.create()
        request = self.request()
        self.upstream.drop_post = True
        self.assertEqual(first.submit(request)['status'], 'unknown')
        self.assertEqual(first.submit(request)['status'], 'unknown')
        self.assertEqual(len(self.upstream.posts), 1)
        first.close()
        self.instances.remove(first)
        second = self.create()
        self.completed(request)
        result = second.get(request['attemptId'])
        self.assertEqual(result['status'], 'succeeded')
        self.assertEqual(result['result']['sha256'], runtime.sha(PNG))
        self.assertEqual(Path(request['outputPath']).read_bytes(), PNG)
        self.assertEqual(len(self.upstream.posts), 1)
        self.assertEqual(self.upstream.reads, ['/history/' + request['attemptId']])

    def test_conflicting_repeat_and_unknown_slot_never_generate_again(self):
        instance = self.create()
        request = self.request()
        self.upstream.drop_post = True
        instance.submit(request)
        modified = copy.deepcopy(request)
        modified['spec']['media_input']['prompt'] = 'changed'
        with self.assertRaisesRegex(runtime.Invalid, 'IDEMPOTENCY_CONFLICT'):
            instance.submit(modified)
        with self.assertRaisesRegex(runtime.Invalid, 'RUNTIME_BUSY'):
            instance.submit(self.request())
        self.assertEqual(len(self.upstream.posts), 1)

    def test_download_failure_is_delivery_only_and_original_png_returns(self):
        instance = self.create()
        request = self.request()
        instance.submit(request)
        self.completed(request)
        self.upstream.drop_download = True
        self.assertEqual(instance.get(request['attemptId'])['status'], 'running')
        self.upstream.drop_download = False
        self.assertEqual(instance.get(request['attemptId'])['status'], 'succeeded')
        self.assertEqual(instance.submit(request)['status'], 'succeeded')
        self.assertEqual(len(self.upstream.posts), 1)

    def test_cold_truncated_partial_resumes_original_delivery_without_gpu_post(self):
        first = self.create()
        request = self.request()
        first.submit(request)
        self.completed(request)
        partial = Path(request['outputPath'] + '.runtime-part')
        partial.write_bytes(PNG[:5])
        partial.chmod(0o600)
        first.close()
        self.instances.remove(first)
        second = self.create()
        self.assertEqual(second.get(request['attemptId'])['status'], 'succeeded')
        self.assertEqual(Path(request['outputPath']).read_bytes(), PNG)
        self.assertFalse(partial.exists())
        self.assertEqual(len(self.upstream.posts), 1)

    def test_directory_sync_failure_does_not_persist_success_or_repeat_gpu(self):
        from unittest.mock import patch
        import os
        import stat
        instance = self.create()
        request = self.request()
        instance.submit(request)
        self.completed(request)
        original_sync = runtime.os.fsync

        def fail_directory(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                raise OSError('fixture directory sync failure')
            return original_sync(fd)

        with patch.object(runtime.os, 'fsync', fail_directory):
            self.assertEqual(instance.get(request['attemptId'])['status'], 'running')
        self.assertEqual(instance.get(request['attemptId'])['status'], 'succeeded')
        self.assertEqual(len(self.upstream.posts), 1)

    def test_bound_first_frame_is_uploaded_once_and_fixed_video_graph_returns_mp4(self):
        self.media = {'capability': 'video', 'mode': 'image_to_video', 'quality': 'fast',
                      'orientation': 'landscape', 'seconds': 5}
        self.bindings['first_frame'] = ['1', 'image']
        self.upstream.output = MP4
        instance = self.create()
        request = self.request()
        asset = str(uuid.uuid4())
        path = self.account / 'attempts' / request['attemptId'] / 'assets' / (asset + '.png')
        path.parent.mkdir()
        path.write_bytes(PNG)
        request['spec']['media_input']['assets'] = [{'asset_id': asset, 'role': 'first_frame', 'sha256': runtime.sha(PNG)}]
        request['assets'] = [{'assetId': asset, 'role': 'first_frame', 'sha256': runtime.sha(PNG), 'path': str(path)}]
        instance.submit(request)
        self.completed(request, 'mp4')
        self.assertEqual(instance.get(request['attemptId'])['result']['content_type'], 'video/mp4')
        self.assertEqual(len(self.upstream.uploads), 1)
        self.assertEqual(self.upstream.posts[0]['prompt']['1']['inputs']['prompt'], 'owner description')
        self.assertEqual(self.upstream.posts[0]['prompt']['1']['inputs']['image'], self.upstream.uploads[0][0])

    def test_expired_lease_and_arbitrary_output_or_profile_refuse_before_post(self):
        instance = self.create()
        request = self.request()
        request['leaseExpiresAt'] = '2020-01-01T00:00:00Z'
        with self.assertRaisesRegex(runtime.Invalid, 'LEASE_EXPIRED'):
            instance.submit(request)
        request = self.request()
        request['outputPath'] = str(Path(self.temporary.name) / 'outside.png')
        with self.assertRaisesRegex(runtime.Invalid, 'PATH_INVALID'):
            instance.submit(request)
        request = self.request()
        request['plan']['workflow_sha256'] = 'f'*64
        with self.assertRaisesRegex(runtime.Invalid, 'PROFILE_INVALID'):
            instance.submit(request)
        self.assertEqual(self.upstream.posts, [])

    def test_symlink_output_parent_and_traversal_upstream_artifact_refuse(self):
        instance = self.create()
        request = self.request()
        parent = Path(request['outputPath']).parent
        parent.rmdir()
        parent.symlink_to(self.account)
        with self.assertRaisesRegex(runtime.Invalid, 'PATH_INVALID'):
            instance.submit(request)
        request = self.request()
        instance.submit(request)
        self.completed(request)
        self.upstream.history[request['attemptId']]['outputs']['2']['images'][0]['subfolder'] = '../private'
        self.assertEqual(instance.get(request['attemptId'])['status'], 'running')
        self.assertFalse(Path(request['outputPath']).exists())
        self.assertEqual(len(self.upstream.posts), 1)

    def test_workflow_byte_substitution_and_redirect_origin_rejected(self):
        self.create()
        (self.bundle / 'graph.json').write_text('{}')
        with self.assertRaisesRegex(runtime.Invalid, 'WORKFLOW_INVALID'):
            self.create()
        for origin in ('https://example.com', 'http://127.0.0.1:8188/evil', 'http://user:secret@127.0.0.1:8188', 'http://localhost:8188'):
            with self.assertRaises(runtime.Invalid):
                runtime.Comfy(origin)

    def test_upstream_truncated_http_body_is_never_accepted_as_original_file(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        class Truncated(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                self.send_response(200)
                self.send_header('Content-Length', str(len(PNG) + 100))
                self.end_headers()
                self.wfile.write(PNG)
                self.close_connection = True

        server = ThreadingHTTPServer(('127.0.0.1', 0), Truncated)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        upstream = runtime.Comfy('http://127.0.0.1:' + str(server.server_port))
        try:
            with self.assertRaises(runtime.Invalid):
                upstream.bytes('GET', '/view?filename=original.png', maximum=1024)
        finally:
            server.shutdown()
            server.server_close()
            worker.join(2)

    def test_authenticated_http_abi_refuses_anonymous_submit_and_stops_exact_server(self):
        instance = self.create()
        request = self.request()
        token = 'cpu-fixture-private-credential'
        # Use the same real Handler/HTTP transport as the installed entrypoint.
        import socket
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        worker = threading.Thread(target=runtime.serve, args=(instance, token, '127.0.0.1', port), daemon=True)
        worker.start()
        origin = 'http://127.0.0.1:' + str(port)
        import time
        deadline = time.monotonic() + 3
        while True:
            try:
                with urllib.request.urlopen(origin + '/health', timeout=1):
                    self.fail('anonymous health unexpectedly accepted')
            except urllib.error.HTTPError as error:
                self.assertEqual(error.code, 401)
                error.close()
                break
            except urllib.error.URLError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(0.01)
        headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
        try:
            with urllib.request.urlopen(urllib.request.Request(origin + '/v1/media/jobs',
                    data=runtime.canonical(request), headers={'Content-Type': 'application/json'})) as reply:
                self.fail('anonymous job unexpectedly accepted')
        except urllib.error.HTTPError as error:
            self.assertEqual(error.code, 401)
            error.close()
        self.assertEqual(self.upstream.posts, [])
        with urllib.request.urlopen(urllib.request.Request(origin + '/health', headers=headers)) as reply:
            health = json.load(reply)
            self.assertEqual(health['schema'], 'qianshou.media-runtime.v1')
            self.assertEqual(health['profiles'], [self.capability])
        with urllib.request.urlopen(urllib.request.Request(origin + '/v1/media/jobs',
                data=runtime.canonical(request), headers=headers)) as reply:
            self.assertEqual(reply.status, 202)
            self.assertEqual(json.load(reply)['status'], 'running')
        with urllib.request.urlopen(urllib.request.Request(origin + '/shutdown', data=b'{}', headers=headers)) as reply:
            self.assertTrue(json.load(reply)['ok'])
        worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(self.upstream.posts), 1)


if __name__ == '__main__':
    unittest.main()
