"""Owner-triggered native review leases: metadata only and zero-budget quarantine.

Every nonce is a real independently signed sample plan; these jobs never enter
ordinary buyer dispatch, settlement, approval or general worker challenge queues.
"""
from __future__ import annotations
import hashlib
import json
import os
import secrets
import time
from decimal import Decimal
from uuid import UUID
from urllib.parse import urlsplit
from sqlalchemy import Uuid
from sqlalchemy import Column,Integer,String,JSON,MetaData,Table,insert,select,update
import httpx
from platform_v8.core import Workload,WorkloadSpec,WorkloadStatus,Shard,ShardStatus
from platform_v8.storage.repo import WorkloadRepo,ShardRepo
from platform_v8.protocol.artifact import build_object_key
from platform_v8.protocol.native_h3 import canonical,validate_definition
from platform_v8.protocol.native_h3_review import TUPLE,challenge,execution,raw
from platform_v8.services import artifact_issuance_receipt
from . import task_adapter_publications as pubs, task_adapter_evidence_storage as storage
from . import native_h3_device_keys as device_keys
from .native_h3_bindings import binding_metadata,purpose_roots
from .task_adapter_review_samples import _archive

_UUID_TEXT = Uuid(as_uuid=False).with_variant(String(36), "sqlite")
metadata=MetaData()
jobs_t=Table('we_native_h3_review_samples',metadata,
    Column('nonce',String(43),primary_key=True),Column('publication_id',String(36),nullable=False),
    Column('owner_id',Integer,nullable=False),Column('device_id', _UUID_TEXT,nullable=False),
    Column('device_key_id',String(64),nullable=False),Column('workload_id', _UUID_TEXT,nullable=False),
    Column('shard_id', _UUID_TEXT,nullable=False),Column('plan',JSON,nullable=False),
    Column('expires_at',Integer,nullable=False),Column('status',String(24),nullable=False),
    Column('issuance',JSON),Column('execution',JSON),Column('decoded_report',JSON),
    Column('sample_receipt',JSON),Column('sample_verified_at',Integer))


def service(path, body):
    """Only bounded metadata goes to the authenticated Guangzhou origin."""
    origin=os.getenv('V8_NATIVE_H3_REVIEW_SERVICE_ORIGIN','').rstrip('/')
    token=os.getenv('V8_NATIVE_H3_REVIEW_SERVICE_TOKEN','')
    parsed=urlsplit(origin)
    if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or not 32<=len(token)<=2048:
        raise pubs.PublicationConflict('原生H3独立审核服务尚未配置')
    try:
        with httpx.Client(timeout=90,follow_redirects=False,trust_env=False) as client:
            with client.stream('POST',origin+path,json=body,headers={'Authorization':'Bearer '+token}) as response:
                data=bytearray()
                for chunk in response.iter_bytes():
                    data.extend(chunk)
                    if len(data)>96*1024:
                        raise ValueError('metadata response too large')
                if response.status_code!=200:
                    raise ValueError('independent service rejected metadata')
                return json.loads(data)
    except Exception as exc:
        raise pubs.PublicationConflict('原生H3独立审核暂不可用，未产生通过回执') from exc


def _roots():
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    values=json.loads(os.getenv('V8_NATIVE_H3_REVIEW_CHALLENGE_PUBLIC_KEYS','{}'))
    forbidden={k.public_bytes_raw() for k in purpose_roots().values()}
    if not isinstance(values,dict) or not 1<=len(values)<=8:
        raise pubs.PublicationConflict('原生H3挑战信任根未登记')
    result={k:Ed25519PublicKey.from_public_bytes(raw(v,32)) for k,v in values.items()}
    if any(k.public_bytes_raw() in forbidden for k in result.values()):
        raise pubs.PublicationError('挑战与接单设备证明必须分用途签名')
    return result


def _row(s, publication_id, owner_id):
    from . import publication_lifecycle as lifecycle
    row=pubs._get(s,publication_id,lock=True)
    if row['owner_id']!=owner_id:
        raise pubs.PublicationNotFound('投稿不属于当前账号')
    if row['status'] not in ('review','approved') or not lifecycle.active(s,publication_id):
        raise pubs.PublicationConflict('仅当前待审核或已审核制品可执行隔离样单')
    validate_definition(row)
    _archive(s,row)
    pkg=(row['review_evidence'] or {}).get('package')
    if pubs._approved_receipt_issue('package',pkg,row,reviewer_id=None,now=int(time.time()),roots=pubs._roots()):
        raise pubs.PublicationConflict('请先完成真正签名的四文件独立验包')
    if not pubs._definition_in_signed_manifest(row,s.execute(select(pubs.author_manifests_t).where(
            pubs.author_manifests_t.c.publication_id==publication_id)).mappings().first()):
        raise pubs.PublicationConflict('作者任务定义未绑定当前签名清单')
    return row


def start(s, *, publication_id,owner_id,worker_id,key_id):
    device_keys._online(s,owner_id,worker_id)
    key=device_keys.active_key(s,owner_id=owner_id,worker_id=worker_id,key_id=key_id)
    row=_row(s,publication_id,owner_id); b=binding_metadata(row,worker_id=worker_id)
    current=s.execute(select(jobs_t).where(jobs_t.c.publication_id==publication_id,
        jobs_t.c.device_id==worker_id,jobs_t.c.expires_at>int(time.time()))).mappings().all()
    if current:
        if len(current)!=2 or any(j['device_key_id']!=key_id or any(j['plan']['payload'][k]!=b[k] for k in TUPLE) for j in current):
            raise pubs.PublicationConflict('该设备已有另一隔离样单，请等待完成或过期')
        return _session(publication_id,worker_id,current)
    roots=_roots(); jobs=[]
    for _ in range(2):
        nonce=secrets.token_urlsafe(32)
        plan=service('/native-h3/review/start',{'schema':'qianshou.native-h3-review-start.v1',
            'binding':{k:b[k] for k in TUPLE},'task_definition':row['task_definition'],
            'package_receipt':row['review_evidence']['package'],'device_key_id':key_id,'challenge_nonce':nonce})
        p=challenge(plan,b,roots,now=int(time.time()))
        if p['challenge_nonce']!=nonce:
            raise pubs.PublicationError('独立样单没有绑定当前保留随机数')
        recipe=p['challenge_input']
        workload=Workload(owner_id=owner_id,name='H3独立审核样单',spec=WorkloadSpec(task_type=row['task_type'],
            input_kind='inline',inline_input=recipe['prompt'],params={k:v for k,v in recipe.items() if k!='prompt'},
            max_shards=1,verification_policy='quarantine',timeout_s=900),status=WorkloadStatus.QUARANTINED,
            budget=Decimal('0'),total_shards=1)
        WorkloadRepo.create(s,workload)
        shard=Shard(workload_id=workload.id,index=0,total=1,status=ShardStatus.PENDING,
            metadata={'native_review_sample_only':True,'challenge_nonce':nonce})
        ShardRepo.create_batch(s,[shard])
        job={'nonce':nonce,'publication_id':publication_id,'owner_id':owner_id,'device_id':worker_id,
            'device_key_id':key_id,'workload_id':str(workload.id),'shard_id':str(shard.id),
            'plan':plan,'expires_at':p['expires_at'],'status':'issued'}
        s.execute(insert(jobs_t).values(**job));jobs.append(job)
    return _session(publication_id,worker_id,jobs)


def _session(publication_id,worker_id,jobs):
    return {'schema':'qianshou.native-h3-review-session.v1','publication_id':publication_id,
        'worker_id':worker_id,'challenges':[j['plan'] for j in jobs]}


def pending(s, *,owner_id,worker_id):
    device_keys._online(s,owner_id,worker_id)
    jobs=s.execute(select(jobs_t).where(jobs_t.c.owner_id==owner_id,jobs_t.c.device_id==worker_id,
        jobs_t.c.expires_at>int(time.time()),jobs_t.c.status.in_(['issued','upload_issued']))).mappings().all()
    active=[]
    for j in jobs:
        try:
            row=_row(s,j['publication_id'],owner_id);b=binding_metadata(row,worker_id=worker_id)
            if all(j['plan']['payload'][k]==b[k] for k in TUPLE):
                active.append({'publication_id':j['publication_id'],'challenge':j['plan'],'status':j['status']})
        except pubs.PublicationError:
            continue
    return {'schema':'qianshou.native-h3-review-pending.v1','worker_id':worker_id,'items':active}


def _job(s, *,publication_id,owner_id,nonce):
    row=_row(s,publication_id,owner_id)
    j=s.execute(select(jobs_t).where(jobs_t.c.nonce==nonce,jobs_t.c.publication_id==publication_id,
        jobs_t.c.owner_id==owner_id).with_for_update()).mappings().first()
    if not j or j['expires_at']<=int(time.time()):
        raise pubs.PublicationConflict('当前原生审核样单已失效')
    b=binding_metadata(row,worker_id=j['device_id'])
    if any(j['plan']['payload'][k]!=b[k] for k in TUPLE):
        raise pubs.PublicationConflict('隔离样单与当前制品不一致')
    device_keys._online(s,owner_id,j['device_id'])
    return row,dict(j)


def upload_intent(s, *,publication_id,owner_id,nonce,result_id,sha256,size_bytes,content_md5):
    row,j=_job(s,publication_id=publication_id,owner_id=owner_id,nonce=nonce)
    if (j['status']!='issued' or str(UUID(result_id))!=result_id or type(size_bytes) is not int
            or not 1<=size_bytes<=16*1024*1024 or not isinstance(sha256,str) or len(sha256)!=64
            or any(c not in '0123456789abcdef' for c in sha256)):
        raise pubs.PublicationConflict('样单上传已发行或摘要无效')
    provider=storage.provider();storage.require_bucket_proof(provider)
    if provider.bucket!=_archive(s,row)['bucket']:
        raise pubs.PublicationError('样单与归档证据桶不一致')
    key=build_object_key(account_id=owner_id,workload_id=j['workload_id'],shard_id=j['shard_id'],
        result_id=result_id,filename='result.mp4')
    now=int(time.time());expiry=min(now+300,j['expires_at'])
    issuance=artifact_issuance_receipt.issue(account_id=owner_id,workload_id=j['workload_id'],
        shard_id=j['shard_id'],worker_id=j['device_id'],attempt=1,result_id=result_id,object_key=key,
        sha256=sha256,size_bytes=size_bytes,content_type='video/mp4',issued_at=now,expires_at=expiry)
    if not issuance or provider._full_key(key)!=key:
        raise pubs.PublicationConflict('隔离样单上传签名或证据命名空间未配置')
    url,headers,_=storage.locked_put_grant(provider,object_key=key,sha256_hex=sha256,
        content_md5=storage.checked_content_md5(content_md5),content_type='video/mp4',
        expires=expiry-now,min_retention_hours=50)
    changed=s.execute(update(jobs_t).where(jobs_t.c.nonce==nonce,jobs_t.c.status=='issued')
        .values(status='upload_issued',issuance=issuance))
    if changed.rowcount!=1:
        raise pubs.PublicationConflict('该样单上传授权已发行')
    return {'schema':'qianshou.native-h3-review-upload-intent.v1','object_key':key,'result_id':result_id,
        'upload_url':url,'method':'PUT','headers':headers,'expires_at':expiry,'issuance_receipt':issuance}


def report(s, *,publication_id,owner_id,nonce,execution_receipt):
    row,j=_job(s,publication_id=publication_id,owner_id=owner_id,nonce=nonce)
    if j['status'] not in ('upload_issued','decoded','verified') or not j['issuance']:
        raise pubs.PublicationConflict('先完成独立样单上传授权')
    key=device_keys.active_key(s,owner_id=owner_id,worker_id=j['device_id'],key_id=j['device_key_id'])
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    execution(execution_receipt,j['plan']['payload'],{key['key_id']:Ed25519PublicKey.from_public_bytes(raw(key['public_key'],32))},now=int(time.time()))
    if j['execution'] is not None and j['execution']!=execution_receipt:
        raise pubs.PublicationConflict('真实审核样单执行回执不得替换')
    decoded=service('/native-h3/review/report',{'schema':'qianshou.native-h3-review-report.v1',
        'execution':execution_receipt,'issuance_receipt':j['issuance']})
    if decoded.get('challenge_nonce')!=nonce or decoded.get('artifact')!=execution_receipt['payload']['artifact']:
        raise pubs.PublicationError('独立媒体检查回执不匹配当前产物')
    s.execute(update(jobs_t).where(jobs_t.c.nonce==nonce).values(status='decoded',execution=execution_receipt,
        decoded_report=decoded))
    pair=s.execute(select(jobs_t).where(jobs_t.c.publication_id==publication_id,
        jobs_t.c.device_id==j['device_id'],jobs_t.c.expires_at>int(time.time()))).mappings().all()
    if len(pair)==2 and all(x['status'] in ('decoded','verified') or x['nonce']==nonce for x in pair):
        receipt=service('/native-h3/review/finalize',{'schema':'qianshou.native-h3-sample-finalize.v1',
            'challenge_nonces':[x['nonce'] for x in pair]})
        verified_at=int(time.time())
        if pubs._receipt_issue('sample',receipt,row,reviewer_id=None,now=verified_at,roots=pubs._roots()):
            raise pubs.PublicationError('独立双样例签名或当前制品绑定无效')
        s.execute(update(jobs_t).where(jobs_t.c.nonce.in_([x['nonce'] for x in pair]))
            .values(status='verified',sample_receipt=receipt,sample_verified_at=verified_at))
        if row['status']=='review':
            pubs.deposit_evidence(s,publication_id=publication_id,kind='sample',receipt=receipt)
        return {'schema':'qianshou.native-h3-review-report-response.v1','publication_id':publication_id,
            'worker_id':j['device_id'],'challenge_nonce':nonce,'status':'independent_sample_verified',
            'sample_receipt':receipt,'approval_required':row['status']=='review'}
    return {'schema':'qianshou.native-h3-review-report-response.v1','publication_id':publication_id,
        'worker_id':j['device_id'],'challenge_nonce':nonce,'status':'awaiting_second_sample',
        'sample_receipt':None,'approval_required':row['status']=='review'}


def restart(s, *,publication_id,owner_id,worker_id,key_id):
    """Explicit owner retry only; preserve superseded evidence and issue new random nonces."""
    row=_row(s,publication_id,owner_id)  # Locks publication and verifies the real signed archive.
    if row['status']!='review':
        raise pubs.PublicationConflict('已审核制品不得重跑审前样单')
    sample=(row['review_evidence'] or {}).get('sample')
    if sample is not None and pubs._receipt_issue('sample',sample,row,reviewer_id=None,
        now=int(time.time()),roots=pubs._roots()) is None:
        raise pubs.PublicationConflict('已有有效独立双样例，不需要重新运行')
    device_keys._online(s,owner_id,worker_id)
    device_keys.active_key(s,owner_id=owner_id,worker_id=worker_id,key_id=key_id)
    old=s.execute(select(jobs_t.c.nonce).where(jobs_t.c.publication_id==publication_id,
        jobs_t.c.device_id==worker_id).with_for_update()).scalars().all()
    now=int(time.time())
    s.execute(update(jobs_t).where(jobs_t.c.publication_id==publication_id,jobs_t.c.device_id==worker_id)
        .values(status='superseded',expires_at=now))
    session=start(s,publication_id=publication_id,owner_id=owner_id,worker_id=worker_id,key_id=key_id)
    pubs.AuditRepo.write(s,action='task_adapter_publication.native_review_restart',actor_kind='account',
        actor_id=owner_id,target_kind=pubs._AUDIT_TARGET_KIND,target_id=publication_id,
        detail={'worker_id':worker_id,'superseded_nonces':old,
            'new_nonces':[c['payload']['challenge_nonce'] for c in session['challenges']]})
    return session


class NativeDeviceSampleMissing(pubs.PublicationConflict):
    code='NATIVE_H3_DEVICE_SAMPLE_MISSING'


def verified_device_sample(s, *,row,worker_id):
    """Read a completed device-specific attestation; never reuse another PC's sample.

    The issuer validity window is checked at the server's completion timestamp.
    Continued presence still requires current approval, exact immutable tuple,
    active enrolled key and current connection; it does not repeat GPU work.
    """
    b=binding_metadata(row,worker_id=worker_id)
    existing=s.execute(select(jobs_t.c.nonce).where(jobs_t.c.publication_id==row['id'],
        jobs_t.c.owner_id==row['owner_id'],jobs_t.c.device_id==worker_id)).first()
    if existing is None:
        raise NativeDeviceSampleMissing('当前设备尚未启动独立双样例，请明确启用后运行')
    jobs=s.execute(select(jobs_t).where(jobs_t.c.publication_id==row['id'],
        jobs_t.c.owner_id==row['owner_id'],jobs_t.c.device_id==worker_id,
        jobs_t.c.status=='verified',jobs_t.c.sample_receipt.is_not(None))).mappings().all()
    if len(jobs)!=2 or any(j['sample_receipt']!=jobs[0]['sample_receipt']
            or j['sample_verified_at']!=jobs[0]['sample_verified_at']
            or j['device_key_id']!=jobs[0]['device_key_id'] for j in jobs):
        raise pubs.PublicationConflict('当前设备还缺独立双样例验证')
    receipt=jobs[0]['sample_receipt'];verified_at=jobs[0]['sample_verified_at'];key_id=jobs[0]['device_key_id']
    if type(verified_at) is not int or verified_at>int(time.time())+60:
        raise pubs.PublicationConflict('当前设备双样例完成时间无效')
    key=device_keys.active_key(s,owner_id=row['owner_id'],worker_id=worker_id,key_id=key_id)
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    device_roots={key_id:Ed25519PublicKey.from_public_bytes(raw(key['public_key'],32))}
    for j in jobs:
        p=challenge(j['plan'],b,_roots(),now=verified_at)
        if (p['challenge_nonce']!=j['nonce'] or j['expires_at']<=verified_at
                or not isinstance(j['decoded_report'],dict)
                or j['decoded_report'].get('challenge_nonce')!=j['nonce']):
            raise pubs.PublicationConflict('当前设备样例已过期、被替换或没有独立解码证据')
        e=execution(j['execution'],p,device_roots,now=verified_at)
        if j['decoded_report'].get('artifact')!=e['artifact']:
            raise pubs.PublicationConflict('当前设备真实样例产物与解码回执不符')
    if (pubs._receipt_issue('sample',receipt,row,reviewer_id=None,now=verified_at,roots=pubs._roots())
        or receipt['payload']['details'].get('device_id')!=worker_id
        or receipt['payload']['details'].get('device_key_id')!=key_id):
        raise pubs.PublicationConflict('当前设备样例签名、私钥或制品绑定无效')
    return receipt,key_id
