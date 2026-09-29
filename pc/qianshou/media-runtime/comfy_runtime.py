#!/usr/bin/env python3
"""Private media-runtime ABI over reviewed, fixed local ComfyUI graphs.

This adapter is not a device qualification or price certificate. It neither
downloads models nor executes client-supplied graphs. Publication requires an
independently reviewed install package and exact capability receipts.
"""
from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BYTES = 64 * 1024 * 1024
CAP_KEYS = ('profile_id', 'profile_version', 'model_sha256', 'workflow_sha256', 'validation_receipt_sha256')
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
HASH = re.compile(r'^[0-9a-f]{64}$')


class Invalid(ValueError):
    """Bounded public error; never includes endpoints, paths or upstream text."""


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def integer(value, minimum=1):
    return type(value) is int and minimum <= value <= 2**53 - 1


def secure_path(root: Path, path: Path, missing_leaf=False):
    """Reject symlink components; caller writes only a predetermined attempt path."""
    if not path.is_absolute() or '..' in path.parts:
        raise Invalid('PATH_INVALID')
    try:
        relative = path.relative_to(root)
    except ValueError:
        raise Invalid('PATH_INVALID') from None
    current = root
    for index, part in enumerate(('', *relative.parts)):
        if part:
            current /= part
        try:
            info = current.lstat()
        except FileNotFoundError:
            if missing_leaf and index == len(relative.parts):
                return path
            raise Invalid('PATH_INVALID') from None
        if stat.S_ISLNK(info.st_mode) or (index < len(relative.parts) and not stat.S_ISDIR(info.st_mode)):
            raise Invalid('PATH_INVALID')
    return path


def read_file(path, maximum):
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size < 1 or info.st_size > maximum:
            raise Invalid('FILE_INVALID')
        value = stream.read(maximum + 1)
        if len(value) != info.st_size:
            raise Invalid('FILE_INVALID')
        return value


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args):
        raise Invalid('UPSTREAM_REDIRECT')


class Comfy:
    """Fixed loopback origin with no proxy, redirects or ambient credentials."""
    def __init__(self, origin):
        parsed = urllib.parse.urlsplit(origin)
        if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or not parsed.port or parsed.path \
                or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise Invalid('CONFIG_INVALID')
        self.origin = origin
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def bytes(self, method, path, body=None, content_type=None, maximum=1024*1024):
        headers = {'Content-Type': content_type} if content_type else {}
        request = urllib.request.Request(self.origin + path, data=body, method=method, headers=headers)
        with self.opener.open(request, timeout=20) as response:
            length = response.headers.get('Content-Length')
            if length is None or not length.isdecimal() or not 0 < int(length) <= maximum:
                raise Invalid('UPSTREAM_INVALID')
            value = response.read(maximum + 1)
            if len(value) != int(length) or len(value) > maximum:
                raise Invalid('UPSTREAM_INVALID')
            return value

    def json(self, method, path, body=None):
        return json.loads(self.bytes(method, path, canonical(body) if body is not None else None,
                                     'application/json' if body is not None else None))

    def upload(self, name, value, content_type):
        boundary = 'qs_' + uuid.uuid4().hex
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{name}"\r\n'
                f'Content-Type: {content_type}\r\n\r\n').encode() + value + (
            f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\ninput'
            f'\r\n--{boundary}--\r\n').encode()
        reply = json.loads(self.bytes('POST', '/upload/image', body, 'multipart/form-data; boundary=' + boundary))
        if reply.get('name') != name or reply.get('subfolder', '') != '' or reply.get('type') != 'input':
            raise Invalid('UPSTREAM_INVALID')
        return name


class Runtime:
    def __init__(self, directory, instance_id, profiles, bundle_id, upstream=None):
        self.root = Path(directory).absolute()
        self.output_root = self.root.parent.parent / 'attempts'
        self.instance_id, self.bundle_id, self.profiles = instance_id, bundle_id, profiles
        self.executor_sha256 = sha(read_file(self.root / 'comfy_runtime.py', 1024*1024))
        config = json.loads(read_file(self.root / 'recipes.json', 1024*1024))
        if set(config) != {'schema', 'comfy_origin', 'recipes'} or config['schema'] != 'qianshou.comfy-recipes.v1' \
                or not isinstance(config['recipes'], list) or not 1 <= len(config['recipes']) <= 64:
            raise Invalid('CONFIG_INVALID')
        self.upstream = upstream or Comfy(config['comfy_origin'])
        self.recipes = []
        for recipe in config['recipes']:
            if set(recipe) != {'capability', 'media', 'graph', 'bindings', 'output'} \
                    or recipe['capability'] not in profiles or set(recipe['capability']) != set(CAP_KEYS):
                raise Invalid('CONFIG_INVALID')
            name = recipe['graph']
            if not isinstance(name, str) or not re.fullmatch(r'[a-zA-Z0-9_-]+\.json', name):
                raise Invalid('CONFIG_INVALID')
            graph_bytes = read_file(self.root / name, 1024*1024)
            if sha(graph_bytes) != recipe['capability']['workflow_sha256']:
                raise Invalid('WORKFLOW_INVALID')
            graph = json.loads(graph_bytes)
            if not isinstance(graph, dict) or not graph or any(not isinstance(node, dict)
                    or not re.fullmatch(r'[A-Za-z0-9_]{1,128}', str(node.get('class_type', '')))
                    or not isinstance(node.get('inputs'), dict) for node in graph.values()):
                raise Invalid('WORKFLOW_INVALID')
            media = recipe['media']
            if set(media) != {'capability', 'mode', 'quality', 'orientation', 'seconds'} \
                    or media['capability'] not in ('image', 'video'):
                raise Invalid('CONFIG_INVALID')
            bindings = recipe['bindings']
            if not isinstance(bindings, dict) or 'prompt' not in bindings \
                    or set(bindings) - {'prompt', 'negative_prompt', 'reference', 'first_frame', 'last_frame'}:
                raise Invalid('CONFIG_INVALID')
            for binding in bindings.values():
                if not isinstance(binding, list) or len(binding) != 2 or binding[0] not in graph \
                        or binding[1] not in graph[binding[0]].get('inputs', {}):
                    raise Invalid('CONFIG_INVALID')
            output = recipe['output']
            if set(output) != {'node', 'collection'} or output['node'] not in graph \
                    or output['collection'] not in ('images', 'gifs', 'videos'):
                raise Invalid('CONFIG_INVALID')
            self.recipes.append({**recipe, 'template': graph})
        if sorted(canonical(r['capability']) for r in self.recipes) != sorted(canonical(p) for p in profiles):
            raise Invalid('PROFILE_INVALID')
        self.lock = threading.RLock()
        database_path = secure_path(self.root, self.root / 'runtime-jobs.sqlite', missing_leaf=True)
        self.db = sqlite3.connect(database_path, check_same_thread=False)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, '
                        'request TEXT NOT NULL, state TEXT NOT NULL, result TEXT)')
        self.db.commit()
        os.chmod(self.root / 'runtime-jobs.sqlite', 0o600)
        self.health_at = 0

    def health(self):
        # Authenticated ABI health does not advertise a dead execution dependency.
        # Classes are taken only from fixed, hash-checked graphs, never a request.
        if time.monotonic() - self.health_at > 5:
            stats = self.upstream.json('GET', '/system_stats')
            if not isinstance(stats, dict) or not isinstance(stats.get('devices'), list) or not stats['devices']:
                raise Invalid('UPSTREAM_UNAVAILABLE')
            classes = {node['class_type'] for recipe in self.recipes for node in recipe['template'].values()}
            for name in sorted(classes):
                info = self.upstream.json('GET', '/object_info/' + name)
                if not isinstance(info, dict) or name not in info:
                    raise Invalid('UPSTREAM_UNAVAILABLE')
            self.health_at = time.monotonic()
        return {'schema': 'qianshou.media-runtime.v1', 'instance_id': self.instance_id,
                'bundle_id': self.bundle_id, 'executor_sha256': self.executor_sha256, 'profiles': self.profiles}

    def _row(self, attempt_id):
        return self.db.execute('SELECT request_hash,request,state,result FROM jobs WHERE id=?', (attempt_id,)).fetchone()

    def _state(self, attempt_id, state, result=None):
        self.db.execute('UPDATE jobs SET state=?,result=? WHERE id=?',
                        (state, json.dumps(result) if result else None, attempt_id))
        self.db.commit()

    def _reply(self, row):
        request = json.loads(row[1])
        value = {key: request[key] for key in ('taskId', 'attemptId', 'leaseEpoch', 'assetId')}
        return {**value, 'schema': 'qianshou.media-runtime-job.v1', 'status': row[2],
                **({'result': json.loads(row[3])} if row[3] else {})}

    def _validate(self, request):
        expected = {'schema', 'idempotencyKey', 'taskId', 'attemptId', 'leaseEpoch', 'assetId', 'leaseExpiresAt',
                    'deviceId', 'accountId', 'plan_sha256', 'plan', 'spec', 'outputPath', 'assets'}
        if not isinstance(request, dict) or set(request) != expected \
                or request['schema'] != 'qianshou.media-runtime-submit.v1' \
                or any(not isinstance(request[k], str) or not UUID.fullmatch(request[k])
                       for k in ('taskId', 'attemptId', 'assetId', 'deviceId')) \
                or request['idempotencyKey'] != request['attemptId'] \
                or not integer(request['leaseEpoch']) or not integer(request['accountId']) \
                or not isinstance(request['plan_sha256'], str) or not HASH.fullmatch(request['plan_sha256']):
            raise Invalid('REQUEST_INVALID')
        try:
            expires = dt.datetime.fromisoformat(request['leaseExpiresAt'].replace('Z', '+00:00'))
            if expires.tzinfo is None or expires.timestamp() <= time.time():
                raise Invalid('LEASE_EXPIRED')
        except (TypeError, ValueError):
            raise Invalid('LEASE_EXPIRED') from None
        plan, spec = request['plan'], request['spec']
        if not isinstance(plan, dict) or not isinstance(spec, dict) or not isinstance(spec.get('media_input'), dict):
            raise Invalid('REQUEST_INVALID')
        media = spec['media_input']
        recipe = next((r for r in self.recipes if all(plan.get(k) == v for k, v in r['capability'].items())
                       and all(media.get(k) == v and plan.get(k) == v for k, v in r['media'].items())), None)
        if recipe is None or plan.get('plan_sha256') != request['plan_sha256'] \
                or media.get('profile_id') != recipe['capability']['profile_id'] \
                or media.get('profile_version') != recipe['capability']['profile_version'] \
                or spec.get('task_type') != recipe['media']['capability'] + '_generate' \
                or spec.get('input_kind') != 'params_only' \
                or any(not isinstance(media.get(k), str) or len(media[k]) > 8192 or '\x00' in media[k]
                       for k in ('prompt', 'negative_prompt')):
            raise Invalid('PROFILE_INVALID')
        suffix = 'png' if recipe['media']['capability'] == 'image' else 'mp4'
        expected_path = self.output_root / request['attemptId'] / 'result' / request['assetId'] / ('result.' + suffix)
        if request['outputPath'] != str(expected_path):
            raise Invalid('PATH_INVALID')
        secure_path(self.output_root, expected_path, missing_leaf=True)
        assets = request['assets']
        if not isinstance(assets, list) or len(assets) > 8 or not isinstance(media.get('assets'), list):
            raise Invalid('ASSET_INVALID')
        declared = sorted((a.get('asset_id'), a.get('role'), a.get('sha256')) for a in media['assets'] if isinstance(a, dict))
        actual = []
        roles = set()
        for asset in assets:
            if not isinstance(asset, dict) or set(asset) != {'assetId', 'role', 'sha256', 'path'} \
                    or not UUID.fullmatch(str(asset['assetId'])) or not HASH.fullmatch(str(asset['sha256'])) \
                    or asset['role'] not in recipe['bindings'] or asset['role'] in roles:
                raise Invalid('ASSET_INVALID')
            path = Path(asset['path'])
            suffix = path.suffix
            expected_asset = self.output_root / request['attemptId'] / 'assets' / (asset['assetId'] + suffix)
            if suffix not in ('.png', '.jpg', '.webp') or path != expected_asset:
                raise Invalid('PATH_INVALID')
            value = read_file(secure_path(self.output_root, path), 16*1024*1024)
            signatures = {'.png': value.startswith(b'\x89PNG\r\n\x1a\n'), '.jpg': value.startswith(b'\xff\xd8\xff'),
                          '.webp': len(value) >= 12 and value[:4] == b'RIFF' and value[8:12] == b'WEBP'}
            if sha(value) != asset['sha256'] or not signatures[suffix]:
                raise Invalid('ASSET_INVALID')
            actual.append((asset['assetId'], asset['role'], asset['sha256']))
            roles.add(asset['role'])
        if sorted(actual) != declared or len(declared) != len(media['assets']) \
                or roles != set(recipe['bindings']) - {'prompt', 'negative_prompt'}:
            raise Invalid('ASSET_INVALID')
        return recipe

    def submit(self, request):
        with self.lock:
            if not isinstance(request, dict) or not UUID.fullmatch(str(request.get('attemptId'))):
                raise Invalid('REQUEST_INVALID')
            identity = request['attemptId']
            digest = sha(canonical(request))
            original = self._row(identity)
            if original:
                if original[0] != digest:
                    raise Invalid('IDEMPOTENCY_CONFLICT')
                return self._reply(original)
            recipe = self._validate(request)
            if self.db.execute("SELECT COUNT(*) FROM jobs WHERE state NOT IN ('succeeded','failed')").fetchone()[0]:
                raise Invalid('RUNTIME_BUSY')
            # This commit consumes the only submission right BEFORE any upload/GPU POST.
            # prompt_id is the immutable attempt UUID, so loss of the POST response can
            # still be reconciled by exact /history/<attempt>, never by another POST.
            self.db.execute('INSERT INTO jobs VALUES (?,?,?,?,NULL)',
                            (identity, digest, canonical(request).decode(), 'unknown'))
            self.db.commit()
            try:
                graph = copy.deepcopy(recipe['template'])
                media = request['spec']['media_input']
                for key in ('prompt', 'negative_prompt'):
                    if key in recipe['bindings']:
                        node, name = recipe['bindings'][key]
                        graph[node]['inputs'][name] = media[key]
                for asset in request['assets']:
                    suffix = Path(asset['path']).suffix
                    name = 'qs_' + identity + '_' + asset['assetId'] + suffix
                    value = read_file(secure_path(self.output_root, Path(asset['path'])), MAX_BYTES)
                    if sha(value) != asset['sha256']:
                        raise Invalid('ASSET_INVALID')
                    content_type = {'.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp'}[suffix]
                    uploaded = self.upstream.upload(name, value, content_type)
                    node, field = recipe['bindings'][asset['role']]
                    graph[node]['inputs'][field] = uploaded
                if dt.datetime.fromisoformat(request['leaseExpiresAt'].replace('Z', '+00:00')).timestamp() <= time.time():
                    raise Invalid('LEASE_EXPIRED')
                response = self.upstream.json('POST', '/prompt', {'prompt': graph, 'prompt_id': identity})
                if response.get('prompt_id') != identity or response.get('node_errors'):
                    raise Invalid('UPSTREAM_INVALID')
                self._state(identity, 'running')
            except Exception:
                # A transport or parsing error gives no right to retry or refund.
                pass
            return self._reply(self._row(identity))

    def get(self, identity):
        if not UUID.fullmatch(identity):
            raise Invalid('REQUEST_INVALID')
        with self.lock:
            row = self._row(identity)
            if row is None:
                return {'schema': 'qianshou.media-runtime-job.v1', 'attemptId': identity, 'status': 'not_found'}
            if row[2] in ('succeeded', 'failed'):
                return self._reply(row)
            request = json.loads(row[1])
            try:
                history = self.upstream.json('GET', '/history/' + identity)
                result = history.get(identity)
                if not isinstance(result, dict):
                    return self._reply(row)
                if result.get('status', {}).get('status_str') == 'error':
                    self._state(identity, 'failed')
                    return self._reply(self._row(identity))
                if result.get('status', {}).get('completed') is not True:
                    return self._reply(row)
                recipe = next(r for r in self.recipes if all(request['plan'].get(k) == v for k, v in r['capability'].items()))
                output = recipe['output']
                values = result.get('outputs', {}).get(output['node'], {}).get(output['collection'])
                if not isinstance(values, list) or len(values) != 1:
                    raise Invalid('OUTPUT_INVALID')
                artifact = values[0]
                if not isinstance(artifact, dict) or artifact.get('type') != 'output' \
                        or not isinstance(artifact.get('filename'), str) or not artifact['filename'] \
                        or '/' in artifact['filename'] or '\\' in artifact['filename'] \
                        or any(v in str(artifact.get('subfolder', '')).split('/') for v in ('..', '.')) \
                        or str(artifact.get('subfolder', '')).startswith('/') or '\\' in str(artifact.get('subfolder', '')):
                    raise Invalid('OUTPUT_INVALID')
                query = urllib.parse.urlencode({k: artifact.get(k, '') for k in ('filename', 'subfolder', 'type')})
                value = self.upstream.bytes('GET', '/view?' + query, maximum=MAX_BYTES)
                mime = 'image/png' if recipe['media']['capability'] == 'image' else 'video/mp4'
                if not value or (mime == 'image/png' and not value.startswith(b'\x89PNG\r\n\x1a\n')) \
                        or (mime == 'video/mp4' and (len(value) < 12 or value[4:8] != b'ftyp')):
                    raise Invalid('OUTPUT_INVALID')
                path = Path(request['outputPath'])
                secure_path(self.output_root, path, missing_leaf=True)
                partial = path.with_name(path.name + '.runtime-part')
                if partial.exists() or partial.is_symlink():
                    # Resume only our private, single-link regular file when its
                    # bytes are an exact prefix of this original GET result.
                    # A crash during write/fsync must not turn delivery into a
                    # permanent conflict or grant another GPU submission.
                    fd = os.open(partial, os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0))
                    with os.fdopen(fd, 'r+b') as stream:
                        info = os.fstat(stream.fileno())
                        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() \
                                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > len(value):
                            raise Invalid('OUTPUT_CONFLICT')
                        prefix = stream.read(len(value) + 1)
                        if not value.startswith(prefix):
                            raise Invalid('OUTPUT_CONFLICT')
                        stream.seek(len(prefix))
                        stream.write(value[len(prefix):])
                        stream.flush()
                        os.fsync(stream.fileno())
                else:
                    fd = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
                    with os.fdopen(fd, 'wb') as stream:
                        stream.write(value)
                        stream.flush()
                        os.fsync(stream.fileno())
                # Existing bytes may be a completed pre-crash delivery; compare before
                # replacing. Delivery failure never re-enters submit().
                if path.exists() and sha(read_file(path, MAX_BYTES)) != sha(value):
                    partial.unlink()
                    raise Invalid('OUTPUT_CONFLICT')
                os.replace(partial, path)
                if os.name != 'nt':
                    directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | getattr(os, 'O_NOFOLLOW', 0))
                    try:
                        os.fsync(directory_fd)
                    finally:
                        os.close(directory_fd)
                self._state(identity, 'succeeded', {'path': str(path), 'sha256': sha(value),
                                                   'size_bytes': len(value), 'content_type': mime})
            except Exception:
                pass
            return self._reply(self._row(identity))

    def close(self):
        self.db.close()


def serve(runtime, token, bind, port):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass  # Never log auth headers, paths, prompts or upstream exceptions.

        def respond(self, status, value):
            body = canonical(value)
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def dispatch(self):
            if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                self.respond(401, {'error': 'AUTH_REQUIRED'})
                return
            try:
                if self.command == 'GET' and self.path == '/health':
                    self.respond(200, runtime.health())
                elif self.command == 'GET' and self.path.startswith('/v1/media/jobs/'):
                    self.respond(200, runtime.get(self.path.removeprefix('/v1/media/jobs/')))
                elif self.command == 'POST' and self.path == '/v1/media/jobs':
                    length = self.headers.get('Content-Length', '')
                    if not length.isdecimal() or not 0 < int(length) <= 65536 \
                            or self.headers.get('Content-Type') != 'application/json':
                        raise Invalid('REQUEST_INVALID')
                    self.respond(202, runtime.submit(json.loads(self.rfile.read(int(length)))))
                elif self.command == 'POST' and self.path == '/shutdown':
                    self.respond(200, {'ok': True})
                    threading.Thread(target=self.server.shutdown, daemon=True).start()
                else:
                    self.respond(404, {'error': 'NOT_FOUND'})
            except Invalid as error:
                self.respond(409, {'error': str(error)})
            except Exception:
                self.respond(400, {'error': 'REQUEST_INVALID'})

        do_GET = dispatch
        do_POST = dispatch

    server = ThreadingHTTPServer((bind, port), Handler)
    server.serve_forever()
    server.server_close()


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--bind', choices=['127.0.0.1'], required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--token-file', type=Path, required=True)
    parser.add_argument('--instance-id', required=True)
    args = parser.parse_args()
    root = Path(__file__).absolute().parent
    token = read_file(args.token_file, 4096).decode().strip()
    if not token or not UUID.fullmatch(args.instance_id):
        raise Invalid('CONFIG_INVALID')
    runtime = Runtime(root, args.instance_id, json.loads(os.environ['QIANSHOU_MEDIA_PROFILES']),
                      os.environ['QIANSHOU_MEDIA_BUNDLE_ID'])
    if runtime.executor_sha256 != os.environ['QIANSHOU_MEDIA_EXECUTOR_SHA256']:
        raise Invalid('EXECUTOR_INVALID')
    try:
        serve(runtime, token, args.bind, args.port)
    finally:
        runtime.close()


if __name__ == '__main__':
    main()
