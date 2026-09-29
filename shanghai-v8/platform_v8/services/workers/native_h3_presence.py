"""Renew approved immutable native bindings using a fresh authenticated WS witness.

This never renders media or creates approval. A stored independent two-sample
receipt and the current platform review must remain bound to the same tuple.
"""
from __future__ import annotations
import hashlib
import time
from uuid import UUID
from sqlalchemy import Uuid
from sqlalchemy import Column,Integer,String,JSON,MetaData,Table,insert,select,update
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from platform_v8.protocol.native_h3 import canonical
from platform_v8.protocol.native_h3_review import TUPLE,signed,sign,raw,fresh
from . import task_adapter_publications as pubs, publication_lifecycle as lifecycle
from . import native_h3_device_keys as device_keys
from .native_h3_bindings import binding_metadata,deposit,current_connection_id
from .native_h3_review_samples import service,_roots,verified_device_sample

PLAN_SCHEMA='qianshou.native-h3-presence-challenge.v1'
PLAN_PURPOSE='qianshou:native-h3-presence-challenge'
PRESENCE_SCHEMA='qianshou.native-h3-device-presence.v1'
PRESENCE_PURPOSE='qianshou:native-h3-device-presence'
FIELDS={'schema','purpose',*TUPLE,'challenge_nonce','native_binding','sample_receipt_sha256',
    'review_fingerprint','connection_id','device_key_id','issued_at','expires_at'}
_UUID_TEXT = Uuid(as_uuid=False).with_variant(String(36), "sqlite")
metadata=MetaData()
presence_t=Table('we_native_h3_presence',metadata,
    Column('nonce',String(43),primary_key=True),Column('publication_id',String(36),nullable=False),
    Column('owner_id',Integer,nullable=False),Column('device_id', _UUID_TEXT,nullable=False),
    Column('plan',JSON,nullable=False),Column('expires_at',Integer,nullable=False),
    Column('signature',String(86)),Column('observed_at',Integer),Column('proof',JSON))


def approved_context(s,*,publication_id,worker_id):
    row=pubs._get(s,publication_id)
    if (row['status']!='approved' or not lifecycle.active(s,publication_id)
        or pubs._issues(s,row,row['review_evidence'] or {},reviewer_id=row['reviewer_id'],require_runtime_pin=True)):
        raise pubs.PublicationConflict('当前制品没有真实有效审核批准')
    device_keys._online(s,row['owner_id'],worker_id)
    connection_id=current_connection_id(worker_id,owner_id=row['owner_id'])
    if connection_id is None:
        raise pubs.PublicationConflict('当前设备连接身份不可核验')
    result=binding_metadata(row,worker_id=worker_id)
    evidence=row['review_evidence'];sample=evidence.get('sample');review=evidence.get('review')
    if not isinstance(sample,dict) or not isinstance(review,dict) or row.get('reviewed_at') is None:
        raise pubs.PublicationConflict('缺少当前制品独立样单或审核凭据')
    device_sample,device_key_id=verified_device_sample(s,row=row,worker_id=worker_id)
    result['sample_receipt_sha256']=hashlib.sha256(canonical(device_sample)).hexdigest()
    result['sample_device_key_id']=device_key_id
    # Deliberately exclude update/poll timestamps. Only a changed review/tuple invalidates presence.
    result['review_fingerprint']=hashlib.sha256(canonical({
        'tuple':{k:result[k] for k in TUPLE},'native_binding':result['native_binding'],
        'sample':sample,'device_sample':device_sample,'review':review,'reviewer_id':row['reviewer_id'],
        'reviewed_at':row['reviewed_at'].isoformat()})).hexdigest()
    result['connection_id']=connection_id
    return result


def challenge(s,*,publication_id,owner_id,worker_id,key_id):
    # A missing-sample response applies only to this already enrolled owner/device key.
    device_keys.active_key(s,owner_id=owner_id,worker_id=worker_id,key_id=key_id)
    c=approved_context(s,publication_id=publication_id,worker_id=worker_id)
    if c['owner_id']!=owner_id:raise pubs.PublicationNotFound('投稿不属于当前账号')
    if key_id!=c['sample_device_key_id']:
        raise pubs.PublicationConflict('当前接单私钥还没有对应独立双样例')
    device_keys.active_key(s,owner_id=owner_id,worker_id=worker_id,key_id=key_id)
    now=int(time.time())
    pending=s.execute(select(presence_t.c.nonce).where(presence_t.c.publication_id==publication_id,
        presence_t.c.device_id==worker_id,presence_t.c.expires_at>now,presence_t.c.proof.is_(None))).first()
    if pending:raise pubs.PublicationConflict('当前设备已有待完成续签挑战')
    envelope=service('/native-h3/presence/challenge',{'schema':'qianshou.native-h3-presence-start.v1',
        'publication_id':publication_id,'device_id':worker_id,'device_key_id':key_id})
    p=signed(envelope,_roots(),FIELDS);fresh(p,now=now,ttl=120)
    if (p['schema']!=PLAN_SCHEMA or p['purpose']!=PLAN_PURPOSE or p['device_key_id']!=key_id
        or any(p[k]!=c[k] for k in (*TUPLE,'native_binding','sample_receipt_sha256','review_fingerprint','connection_id'))):
        raise pubs.PublicationError('独立续签挑战未绑定当前审核及连接')
    raw(p['challenge_nonce'],32)
    s.execute(insert(presence_t).values(nonce=p['challenge_nonce'],publication_id=publication_id,
        owner_id=owner_id,device_id=worker_id,plan=envelope,expires_at=p['expires_at']))
    return envelope


def _verify(s,*,owner_id,worker_id,nonce,signature):
    raw(nonce,32)
    saved=s.execute(select(presence_t).where(presence_t.c.nonce==nonce)).mappings().first()
    if not saved or saved['owner_id']!=owner_id or saved['device_id']!=worker_id:
        raise pubs.PublicationNotFound('续签挑战不属于当前账号设备')
    p=signed(saved['plan'],_roots(),FIELDS);fresh(p,now=int(time.time()),ttl=120)
    c=approved_context(s,publication_id=saved['publication_id'],worker_id=worker_id)
    if any(c[k]!=p[k] for k in (*TUPLE,'native_binding','sample_receipt_sha256','review_fingerprint','connection_id')):
        raise pubs.PublicationConflict('审核、配置或当前连接已变更，请重新自检')
    key=device_keys.active_key(s,owner_id=owner_id,worker_id=worker_id,key_id=p['device_key_id'])
    presence={**p,'schema':PRESENCE_SCHEMA,'purpose':PRESENCE_PURPOSE}
    try:
        Ed25519PublicKey.from_public_bytes(raw(key['public_key'],32)).verify(raw(signature,64),canonical(presence))
    except Exception as exc:
        raise pubs.PublicationError('当前设备续签私钥证明无效') from exc
    envelope={'key_id':p['device_key_id'],'payload':presence,'signature':signature}
    return saved,c,envelope


def witness(s,*,owner_id,worker_id,connection_id,payload):
    if not isinstance(payload,dict) or set(payload)!={'challenge_nonce','signature'}:
        raise pubs.PublicationError('续签WS帧无效')
    saved,c,envelope=_verify(s,owner_id=owner_id,worker_id=worker_id,
        nonce=payload['challenge_nonce'],signature=payload['signature'])
    if c['connection_id']!=connection_id or saved['proof'] is not None:
        raise pubs.PublicationConflict('续签帧未来自当前连接或挑战已结束')
    if saved['signature'] is not None and saved['signature']!=payload['signature']:
        raise pubs.PublicationConflict('续签挑战已有另一签名')
    s.execute(update(presence_t).where(presence_t.c.nonce==saved['nonce'],presence_t.c.proof.is_(None))
        .values(signature=payload['signature'],observed_at=int(time.time())))


def observation(s,*,nonce):
    saved=s.execute(select(presence_t).where(presence_t.c.nonce==nonce)).mappings().first()
    if not saved or saved['signature'] is None:raise pubs.PublicationNotFound('当前连接尚未观察续签签名')
    saved,c,envelope=_verify(s,owner_id=saved['owner_id'],worker_id=saved['device_id'],nonce=nonce,signature=saved['signature'])
    return {'schema':'qianshou.native-h3-presence-observation.v1','owner_id':saved['owner_id'],
        'device_id':saved['device_id'],'connection_id':c['connection_id'],'challenge_nonce':nonce,
        'presence_sha256':hashlib.sha256(canonical(envelope)).hexdigest(),'observed_at':saved['observed_at']}


def report(s,*,publication_id,owner_id,worker_id,challenge_nonce,signature):
    saved,c,envelope=_verify(s,owner_id=owner_id,worker_id=worker_id,nonce=challenge_nonce,signature=signature)
    if saved['publication_id']!=publication_id or saved['signature']!=signature or saved['observed_at'] is None:
        raise pubs.PublicationConflict('请先由当前连接返回续签证明')
    if saved['proof'] is not None:proof=saved['proof']
    else:
        proof=service('/native-h3/presence/report',{'schema':'qianshou.native-h3-presence-report.v1','presence':envelope})
        # Do not hold a row lock across the verifier's read-only WS observation callback.
        _verify(s,owner_id=owner_id,worker_id=worker_id,nonce=challenge_nonce,signature=signature)
        deposit(s,publication_id=publication_id,receipt=proof)
        s.execute(update(presence_t).where(presence_t.c.nonce==challenge_nonce,presence_t.c.proof.is_(None)).values(proof=proof))
    return {'schema':'qianshou.native-h3-device-presence-result.v1','publication_id':publication_id,
        'worker_id':worker_id,'device_proof':proof}


def public_trust():
    """Project three distinct configured signing purposes from the authenticated core origin."""
    import base64
    from platform_v8.services import artifact_issuance_receipt
    from .native_h3_bindings import purpose_roots
    try:
        configured=artifact_issuance_receipt._signer()
        if configured is None:raise ValueError('issuance signer unavailable')
        groups={'challenge_keys':_roots(),'device_attestor_keys':purpose_roots(),
            'upload_issuance_keys':{configured[0]:configured[1].public_key()}}
        seen=set();result={'schema':'qianshou.native-h3-proof-trust.v1'}
        for name,roots in groups.items():
            if not 1<=len(roots)<=8:raise ValueError('purpose roots unavailable')
            result[name]={}
            for key_id,key in roots.items():
                binary=key.public_bytes_raw()
                if binary in seen:raise ValueError('signing purposes overlap')
                seen.add(binary)
                result[name][key_id]=base64.urlsafe_b64encode(binary).rstrip(b'=').decode()
        return result
    except Exception as exc:
        raise pubs.PublicationConflict('原生H3各用途信任根未完整配置') from exc
