"""Shanghai owner-scoped catalogue. Observation access is server-registered, not ownership proof.
No renderer URL, no generated task, no service auto-registration, no pretend READY.
"""
import json,time
from pathlib import Path
from fastapi import APIRouter,Depends,HTTPException
from platform_v8.api.deps import get_current_account
from platform_v8.api.rate_limit import rate_limit
router=APIRouter(prefix='/api/v8/apps/qianshou-image',tags=['image-models'])
POLICY=Path('/opt/edge/config/image-model-observers.json')
# Server-owned configuration only. No renderer endpoint or credential input.
import os

def project(raw,allowed):
 if not isinstance(raw,dict) or raw.get('schemaVersion')!=1 or not isinstance(raw.get('observations'),list) or len(raw['observations'])>12:raise ValueError('Invalid gateway catalog')
 entries=[]
 for row in raw['observations']:
  if not isinstance(row,dict):raise ValueError('Invalid observation row')
  if row.get('serviceId') not in allowed:continue
  model=row.get('modelId') or '尚未取得模型证据'
  if not isinstance(model,str) or len(model)>180 or any(ord(c)<32 for c in model):raise ValueError('Invalid model identity')
  alias=row['serviceId']
  # HTTP/self-reported discovery is display evidence only. A health flag cannot mint a selection.
  entries.append({'id':'gz-'+alias,'nodeLabel':'已授权观察服务 · '+alias,'modelId':model,'workerId':None,'selectionId':None,'modelSha256':None,'serviceHealthy':row.get('serviceHealthy') is True,'capabilityReady':False,'expiresAt':None,'reasons':['服务已发现；平台节点身份尚未绑定','模型哈希与完整工作流尚未验证','统一图片任务尚未登记']})
 return {'schemaVersion':1,'checkedAt':int(time.time()*1000),'entries':entries}

def observation_scope(policy, account_id):
 # publicServices is the operator-owned existing shared gateway pool, not account-owned workers.
 # Explicit owner additions remain separate. Neither collection authorizes execution.
 if not isinstance(policy,dict) or set(policy)!={'schemaVersion','publicServices','observers'} or policy['schemaVersion']!=1:raise ValueError('Invalid observation policy')
 if not isinstance(policy['observers'],dict):raise ValueError('Invalid observer map')
 public=policy['publicServices'];owner=policy['observers'].get(str(account_id),[])
 if public:raise ValueError('Explicit owner observation grant required; no public expansion')
 known={'5080','4060-1','4060-2'}
 for group in (public,owner):
  if not isinstance(group,list) or any(not isinstance(v,str) or v not in known for v in group) or len(group)!=len(set(group)):raise ValueError('Invalid observation scope')
 return sorted(set(public+owner))

@router.get('/models',dependencies=[Depends(rate_limit('image_models',per_minute=10,key='uid'))])
async def models(current=Depends(get_current_account)):
 try:
  raw=POLICY.read_bytes()
  if len(raw)>65536:raise ValueError()
  policy=json.loads(raw)
  allowed=observation_scope(policy,current.id)
 except Exception:raise HTTPException(503,'MODEL_OBSERVER_REGISTRY_REQUIRED') from None
 if not allowed:return {'schemaVersion':1,'checkedAt':int(time.time()*1000),'entries':[]}
 try:
  import asyncio
  from .pinned_gateway import read_catalog
  raw=await asyncio.wait_for(asyncio.to_thread(read_catalog,'/etc/qianshou/image-catalog-gateway.pem',os.environ.get('QSU_IMAGE_CATALOG_TOKEN','')),timeout=10)
  return project(raw,allowed)
 except Exception:raise HTTPException(503,'MODEL_CATALOG_UNAVAILABLE') from None
