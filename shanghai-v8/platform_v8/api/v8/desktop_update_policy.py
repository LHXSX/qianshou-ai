"""Qianshou desktop policy only; updater artifacts, task drain and installation stay in the PC Host."""
from __future__ import annotations
import base64
import json
import os
from pathlib import Path
import re
import stat
from urllib.parse import urlsplit
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from platform_v8.api.v8.admin_v2 import require_admin

router = APIRouter(tags=['desktop-update-policy'])
SCHEMA = 'qianshou.desktop-update-policy.v1'
POLICIES = 'qianshou.desktop-update-policy-set.v1'
NO_STORE = {'Cache-Control': 'no-store, max-age=0', 'Pragma': 'no-cache', 'Expires': '0', 'Surrogate-Control': 'no-store'}
IDENTITY = ('x-client-platform', 'x-client-version', 'x-client-bundle-id', 'x-client-locale',
            'x-client-arch', 'x-client-update-channel', 'x-client-bundled-dsh-version')
SEMVER = re.compile(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?\Z')
BUNDLE = re.compile(r'[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\Z')
LOCALE = re.compile(r'[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}\Z')
ORIGIN = 'https://qianshousuanli.com'


def exact(value, fields):
    if not isinstance(value, dict) or set(value) != set(fields): raise ValueError()
    return value


def pairs(values):
    result = {}
    for key, value in values:
        if key in result: raise ValueError()
        result[key] = value
    return result


def semver(value):
    match = SEMVER.fullmatch(value) if isinstance(value, str) and len(value) <= 96 else None
    if match is None: raise ValueError()
    core = tuple(int(match[i]) for i in (1, 2, 3))
    if any(n > 9007199254740991 for n in core): raise ValueError()
    pre = None if match[4] is None else tuple(match[4].split('.'))
    if pre and any(p.isdigit() and len(p) > 1 and p[0] == '0' for p in pre): raise ValueError()
    return core, pre


def compare(left, right):
    a, b = semver(left), semver(right)
    if a[0] != b[0]: return 1 if a[0] > b[0] else -1
    if a[1] == b[1]: return 0
    if a[1] is None: return 1
    if b[1] is None: return -1
    for x, y in zip(a[1], b[1]):
        if x == y: continue
        if x.isdigit() and y.isdigit(): return 1 if int(x) > int(y) else -1
        if x.isdigit() != y.isdigit(): return -1 if x.isdigit() else 1
        return 1 if x > y else -1
    return 1 if len(a[1]) > len(b[1]) else -1


def feed_url(platform, arch, channel):
    if platform == 'desktop-win' and arch == 'x64': target, suffix = 'win-x64', ''
    elif platform == 'desktop-mac' and arch in ('x64', 'arm64'): target, suffix = 'mac-' + arch, '-mac'
    else: raise ValueError()
    name = {'nightly': 'nightly', 'beta': 'beta', 'stable': 'latest'}[channel]
    return ORIGIN + '/qianshou-desktop/feeds/' + target + '/' + name + suffix + '.yml'


def identity(request):
    headers = request.headers
    if any(len(headers.getlist(name)) != 1 for name in IDENTITY): raise ValueError()
    protocol = headers.getlist('x-client-update-protocol')
    if len(protocol) > 1 or protocol and protocol[0] != SCHEMA: raise ValueError()
    values = {name: headers[name] for name in IDENTITY}
    semver(values['x-client-version']); semver(values['x-client-bundled-dsh-version'])
    bundle, locale = values['x-client-bundle-id'], values['x-client-locale']
    if (len(bundle) > 128 or BUNDLE.fullmatch(bundle) is None or len(locale) > 35 or LOCALE.fullmatch(locale) is None): raise ValueError()
    feed = feed_url(values['x-client-platform'], values['x-client-arch'], values['x-client-update-channel'])
    return values, bool(protocol), feed


def validate_rule(rule):
    exact(rule, ('bundleId', 'platform', 'arch', 'channel', 'minimumVersion', 'targetVersion', 'feedUrl', 'release', 'title', 'detail', 'pageUrl'))
    if not isinstance(rule['bundleId'], str) or len(rule['bundleId']) > 128 or BUNDLE.fullmatch(rule['bundleId']) is None: raise ValueError()
    if 'qianshou' not in rule['bundleId'].lower(): raise ValueError()
    if rule['feedUrl'] != feed_url(rule['platform'], rule['arch'], rule['channel']): raise ValueError()
    if compare(rule['targetVersion'], rule['minimumVersion']) < 0: raise ValueError()
    for key, limit in (('title', 256), ('detail', 16384), ('pageUrl', 2048)):
        if not isinstance(rule[key], str) or not rule[key].strip() or len(rule[key]) > limit: raise ValueError()
    page = urlsplit(rule['pageUrl'])
    if page.scheme != 'https' or page.netloc != 'qianshousuanli.com' or page.username or page.password or page.fragment: raise ValueError()
    release = exact(rule['release'], ('version', 'bundleId', 'platform', 'arch', 'channel', 'feedUrl', 'sha512', 'size', 'published', 'signed', 'installTested'))
    if release['version'] != rule['targetVersion'] or any(release[k] != rule[k] for k in ('bundleId', 'platform', 'arch', 'channel', 'feedUrl')): raise ValueError()
    if type(release['size']) is not int or not 1 <= release['size'] <= 4294967296: raise ValueError()
    raw = base64.b64decode(release['sha512'], validate=True)
    if len(raw) != 64 or base64.b64encode(raw).decode() != release['sha512']: raise ValueError()
    if any(type(release[k]) is not bool for k in ('published', 'signed', 'installTested')): raise ValueError()
    return rule


def policies():
    configured = os.getenv('V8_DESKTOP_UPDATE_POLICY_FILE')
    if not configured: return None
    path = Path(configured)
    if not path.is_absolute(): raise ValueError()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_size > 131072): raise ValueError()
        raw = stream.read(131073)
    if len(raw) > 131072: raise ValueError()
    value = exact(json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _v: (_ for _ in ()).throw(ValueError())), ('schema', 'revision', 'rules'))
    if value['schema'] != POLICIES or type(value['revision']) is not int or value['revision'] < 1 or not isinstance(value['rules'], list) or len(value['rules']) > 32: raise ValueError()
    unique = set()
    for rule in value['rules']:
        validate_rule(rule)
        key = tuple(rule[k] for k in ('bundleId', 'platform', 'arch', 'channel'))
        if key in unique: raise ValueError()
        unique.add(key)
    return value


def no_force():
    return JSONResponse({'code': 0, 'msg': '', 'data': {'biz_code': 0, 'biz_msg': '', 'biz_data': None}}, headers=NO_STORE)


@router.get('/api/v0/check_client_update', summary='Qianshou desktop update policy')
def check_client_update(request: Request):
    try: values, capable, expected_feed = identity(request)
    except Exception: return JSONResponse({'code': 40000, 'msg': 'Invalid desktop client identity'}, status_code=400, headers=NO_STORE)
    try: value = policies()
    except Exception: return JSONResponse({'code': 50300, 'msg': 'Desktop update policy unavailable'}, status_code=503, headers=NO_STORE)
    if value is None or not capable: return no_force()
    for rule in value['rules']:
        if any(rule[key] != values[header] for key, header in (('bundleId', 'x-client-bundle-id'), ('platform', 'x-client-platform'), ('arch', 'x-client-arch'), ('channel', 'x-client-update-channel'))): continue
        if not all(rule['release'][k] for k in ('published', 'signed', 'installTested')): return no_force()
        current = values['x-client-version']
        if compare(current, rule['minimumVersion']) >= 0 or compare(current, rule['targetVersion']) >= 0: return no_force()
        binding = {'schema': SCHEMA, 'bundleId': rule['bundleId'], 'platform': rule['platform'], 'arch': rule['arch'], 'channel': rule['channel'],
                   'currentVersion': current, 'targetVersion': rule['targetVersion'], 'feedUrl': expected_feed}
        return JSONResponse({'code': 40005, 'msg': '', 'data': {'show_content': {'title': rule['title'], 'detail': rule['detail']},
                             'desktop_app_link': rule['pageUrl'], 'policy': binding}}, headers=NO_STORE)
    return no_force()


@router.get('/api/v8/admin/desktop-update-policy', summary='Read-only configured desktop policy status')
def configured_policy(_admin=Depends(require_admin)):
    try: value = policies()
    except Exception: return JSONResponse({'ok': False, 'code': 'DESKTOP_UPDATE_POLICY_UNAVAILABLE'}, status_code=503, headers=NO_STORE)
    return JSONResponse({'ok': True, 'configured': value is not None, 'revision': None if value is None else value['revision'],
                         'ruleCount': 0 if value is None else len(value['rules']), 'writeAuthority': 'server_release_configuration'}, headers=NO_STORE)
