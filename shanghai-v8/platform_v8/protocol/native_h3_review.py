"""Purpose-separated native review metadata; contains no video bytes or paths."""
from __future__ import annotations
import base64
import hashlib
import re
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from .native_h3 import canonical, validate_order

TUPLE = ('publication_id', 'owner_id', 'device_id', 'task_type', 'capability_id',
         'contract_version', 'contract_sha256', 'artifact_digest', 'source_digest', 'config_digest')
CHALLENGE_SCHEMA = 'qianshou.native-h3-review-challenge.v1'
CHALLENGE_PURPOSE = 'qianshou:native-h3-review-challenge'
EXECUTION_SCHEMA = 'qianshou.native-h3-review-execution.v1'
EXECUTION_PURPOSE = 'qianshou:native-h3-review-execution'
CHALLENGE_FIELDS = {'schema', 'purpose', *TUPLE, 'challenge_nonce', 'challenge_input',
                    'challenge_input_sha256', 'issued_at', 'expires_at'}
EXECUTION_FIELDS = {'schema', 'purpose', *TUPLE, 'challenge_nonce', 'challenge_input_sha256',
                    'challenge_result_sha256', 'artifact', 'issued_at', 'expires_at'}
ARTIFACT_FIELDS = {'schema', 'object_key', 'object_version_id', 'filename', 'size_bytes',
                   'content_type', 'sha256', 'result_id'}


def raw(value, size):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', value):
        raise ValueError('noncanonical signature encoding')
    binary = base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))
    if len(binary) != size or base64.urlsafe_b64encode(binary).rstrip(b'=').decode() != value:
        raise ValueError('noncanonical signature size')
    return binary


def sign(payload, key_id, signer):
    return {'key_id': key_id, 'payload': payload,
            'signature': base64.urlsafe_b64encode(signer.sign(canonical(payload))).rstrip(b'=').decode()}


def signed(envelope, roots, fields):
    if (not isinstance(envelope, dict) or set(envelope) != {'key_id','payload','signature'}
            or envelope['key_id'] not in roots or not isinstance(envelope['payload'], dict)
            or set(envelope['payload']) != fields or len(canonical(envelope)) > 48 * 1024):
        raise ValueError('untrusted purpose envelope')
    roots[envelope['key_id']].verify(raw(envelope['signature'],64), canonical(envelope['payload']))
    return envelope['payload']


def fresh(payload, *, now, ttl=900):
    if (type(payload['issued_at']) is not int or type(payload['expires_at']) is not int
            or payload['issued_at'] > now + 60 or payload['expires_at'] <= now
            or not 0 < payload['expires_at'] - payload['issued_at'] <= ttl):
        raise ValueError('expired purpose envelope')


def challenge(envelope, expected, roots, *, now):
    p = signed(envelope, roots, CHALLENGE_FIELDS)
    fresh(p, now=now)
    if (p['schema'] != CHALLENGE_SCHEMA or p['purpose'] != CHALLENGE_PURPOSE
            or any(p[k] != expected[k] for k in TUPLE)
            or not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', p['challenge_nonce'])):
        raise ValueError('challenge binding mismatch')
    recipe = p['challenge_input']
    if not isinstance(recipe, dict) or set(recipe) - {'prompt','seconds','seed'} or 'prompt' not in recipe:
        raise ValueError('challenge input invalid')
    validated = validate_order(input_kind='inline', inline_input=recipe['prompt'], params={k:v for k,v in recipe.items() if k != 'prompt'})
    if validated != recipe or p['challenge_input_sha256'] != hashlib.sha256(canonical(recipe)).hexdigest():
        raise ValueError('challenge input digest mismatch')
    return p


def execution(envelope, plan, roots, *, now):
    p = signed(envelope, roots, EXECUTION_FIELDS)
    fresh(p, now=now)
    if (p['schema'] != EXECUTION_SCHEMA or p['purpose'] != EXECUTION_PURPOSE
            or any(p[k] != plan[k] for k in (*TUPLE,'challenge_nonce','challenge_input_sha256'))
            or p['expires_at'] > plan['expires_at'] or p['issued_at'] < plan['issued_at'] - 60
            or not isinstance(p['artifact'],dict) or set(p['artifact']) != ARTIFACT_FIELDS
            or p['artifact']['filename'] != 'result.mp4'
            or p['challenge_result_sha256'] != hashlib.sha256(canonical(p['artifact'])).hexdigest()):
        raise ValueError('execution binding mismatch')
    return p
