"""Account + current authenticated worker WS + one-use Ed25519 possession proof.

Enrolling a device key never issues review, installed state or market approval.
"""
from __future__ import annotations
import hashlib
import secrets
import time
from uuid import UUID, uuid4
from sqlalchemy import Uuid
from sqlalchemy import Column, Integer, String, JSON, MetaData, Table, insert, select, update
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from platform_v8.protocol.native_h3 import canonical
from platform_v8.protocol.native_h3_review import raw
from . import task_adapter_publications as pubs
from .native_h3_bindings import _worker, current_connection_id
from platform_v8.storage.repo import task_adapter_publisher_keys_t as author_keys

_UUID_TEXT = Uuid(as_uuid=False).with_variant(String(36), "sqlite")
metadata = MetaData()
challenges_t = Table('we_native_h3_key_challenges', metadata,
    Column('id', String(36), primary_key=True), Column('owner_id',Integer,nullable=False),
    Column('device_id', _UUID_TEXT,nullable=False), Column('payload',JSON,nullable=False),
    Column('connection_id',String(36)),Column('signature',String(86)),
    Column('expires_at',Integer,nullable=False),Column('consumed_at',Integer))
keys_t = Table('we_native_h3_device_keys',metadata,
    Column('owner_id',Integer,primary_key=True),Column('device_id', _UUID_TEXT,primary_key=True),
    Column('key_id',String(64),primary_key=True),Column('public_key',String(43),nullable=False),
    Column('created_at',Integer,nullable=False),Column('revoked_at',Integer))
SCHEMA = 'qianshou.native-h3-device-enrollment.v1'
PURPOSE = 'qianshou:native-h3-device-key-enrollment'


def _online(s, owner_id, worker_id):
    row = _worker(s,owner_id,worker_id)
    if row['status'] not in ('ONLINE','BUSY') or not current_connection_id(worker_id,owner_id=owner_id):
        raise pubs.PublicationConflict('请先连接本人接单设备')
    return row


def challenge(s, *, owner_id, worker_id, key_id, public_key):
    _online(s,owner_id,worker_id)
    public = raw(public_key,32)
    if key_id != 'native-h3-device-' + hashlib.sha256(public).hexdigest()[:24]:
        raise pubs.PublicationError('设备密钥编号与公钥不匹配')
    if s.execute(select(author_keys.c.key_id).where(author_keys.c.public_key == public_key)).first():
        raise pubs.PublicationError('设备签名不得复用作者签名密钥')
    now = int(time.time())
    pending = s.execute(select(challenges_t.c.id).where(challenges_t.c.owner_id==owner_id,
        challenges_t.c.device_id==worker_id,challenges_t.c.expires_at>now,
        challenges_t.c.consumed_at.is_(None))).first()
    if pending:
        raise pubs.PublicationConflict('该设备已有登记挑战，请完成或等待过期')
    p = {'schema':SCHEMA,'purpose':PURPOSE,'owner_id':owner_id,'device_id':worker_id,
         'key_id':key_id,'public_key':public_key,'challenge_id':str(uuid4()),
         'nonce':secrets.token_urlsafe(32),'issued_at':now,'expires_at':now+300}
    s.execute(insert(challenges_t).values(id=p['challenge_id'],owner_id=owner_id,device_id=worker_id,
        payload=p,expires_at=p['expires_at']))
    return p


def _verify(s, *, owner_id, worker_id, challenge_id, signature):
    try:
        if str(UUID(challenge_id)) != challenge_id:
            raise ValueError('challenge id')
        c=s.execute(select(challenges_t).where(challenges_t.c.id==challenge_id).with_for_update()).mappings().first()
        if (not c or c['owner_id']!=owner_id or c['device_id']!=worker_id
                or c['consumed_at'] is not None or c['expires_at']<=int(time.time())):
            raise ValueError('stale challenge')
        Ed25519PublicKey.from_public_bytes(raw(c['payload']['public_key'],32)).verify(
            raw(signature,64),canonical(c['payload']))
        return c
    except Exception as exc:
        raise pubs.PublicationError('设备私钥持有证明无效或挑战已过期') from exc


def witness(s, *, owner_id, worker_id, connection_id, payload):
    """Only called by the authenticated worker WS loop, never an HTTP owner claim."""
    if not isinstance(payload,dict) or set(payload)!={'challenge_id','signature'}:
        raise pubs.PublicationError('设备登记WS帧无效')
    c=_verify(s,owner_id=owner_id,worker_id=worker_id,**payload)
    if c['connection_id'] is not None:
        raise pubs.PublicationConflict('设备登记挑战已观察')
    s.execute(update(challenges_t).where(challenges_t.c.id==c['id'],challenges_t.c.connection_id.is_(None))
        .values(connection_id=connection_id,signature=payload['signature']))


def register(s, *, owner_id, worker_id, challenge_id, signature):
    _online(s,owner_id,worker_id)
    c=_verify(s,owner_id=owner_id,worker_id=worker_id,challenge_id=challenge_id,signature=signature)
    if current_connection_id(worker_id,owner_id=owner_id) != c['connection_id'] or c['signature']!=signature:
        raise pubs.PublicationConflict('请先由已连接的本人设备返回登记证明')
    p=c['payload']
    exists=s.execute(select(keys_t).where(keys_t.c.owner_id==owner_id,
        keys_t.c.device_id==worker_id,keys_t.c.key_id==p['key_id'])).mappings().first()
    if exists and (exists['revoked_at'] is not None or exists['public_key']!=p['public_key']):
        raise pubs.PublicationConflict('设备密钥已撤销或不一致')
    if not exists:
        active=s.execute(select(keys_t.c.key_id).where(keys_t.c.owner_id==owner_id,
            keys_t.c.device_id==worker_id,keys_t.c.revoked_at.is_(None))).all()
        if len(active)>=4:
            raise pubs.PublicationConflict('设备活动密钥已达上限')
        s.execute(insert(keys_t).values(owner_id=owner_id,device_id=worker_id,key_id=p['key_id'],
            public_key=p['public_key'],created_at=int(time.time())))
    changed=s.execute(update(challenges_t).where(challenges_t.c.id==challenge_id,
        challenges_t.c.consumed_at.is_(None)).values(consumed_at=int(time.time())))
    if changed.rowcount!=1:
        raise pubs.PublicationConflict('设备挑战已被使用')
    return active_key(s,owner_id=owner_id,worker_id=worker_id,key_id=p['key_id'])


def active_key(s, *, owner_id, worker_id, key_id):
    _worker(s,owner_id,worker_id)
    k=s.execute(select(keys_t).where(keys_t.c.owner_id==owner_id,keys_t.c.device_id==worker_id,
        keys_t.c.key_id==key_id,keys_t.c.revoked_at.is_(None))).mappings().first()
    if not k:
        raise pubs.PublicationNotFound('原生设备密钥未登记或已撤销')
    return {'schema':'qianshou.native-h3-device-key.v1','owner_id':owner_id,
        'device_id':worker_id,'key_id':key_id,'public_key':k['public_key'],'status':'active'}
