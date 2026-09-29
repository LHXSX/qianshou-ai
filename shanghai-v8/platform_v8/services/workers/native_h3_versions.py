"""Explicit immutable publication versions; never infer a version from client claims."""
from importlib import import_module
from sqlalchemy import select
from . import task_adapter_publications as pubs


def implementation(s, publication_id, group):
    version=pubs._get(s,publication_id)['contract_version']
    if version not in ('v1','v2'):
        raise pubs.PublicationError('原生H3合同版本不受支持')
    return import_module('.native_h3_'+group+('_v2' if version=='v2' else ''),__package__)


def call(group,name):
    def invoke(s,*,publication_id,**kwargs):
        return getattr(implementation(s,publication_id,group),name)(s,publication_id=publication_id,**kwargs)
    return invoke


review_start=call('review_samples','start')
review_restart=call('review_samples','restart')
review_upload=call('review_samples','upload_intent')
review_report=call('review_samples','report')
presence_challenge=call('presence','challenge')
presence_report=call('presence','report')
approved_context=call('presence','approved_context')
deposit=call('bindings','deposit')


def presence_implementation(s,nonce):
    from .native_h3_presence import presence_t
    plan=s.execute(select(presence_t.c.plan).where(presence_t.c.nonce==nonce)).scalar_one_or_none()
    if not isinstance(plan,dict):
        raise pubs.PublicationNotFound('续签挑战不存在')
    schema=plan.get('payload',{}).get('schema')
    suffix={'qianshou.native-h3-presence-challenge.v1':'','qianshou.native-h3-presence-challenge.v2':'_v2'}.get(schema)
    if suffix is None:raise pubs.PublicationError('续签挑战版本无效')
    return import_module('.native_h3_presence'+suffix,__package__)


def observation(s,*,nonce):
    return presence_implementation(s,nonce).observation(s,nonce=nonce)


def witness(s,*,owner_id,worker_id,connection_id,payload):
    return presence_implementation(s,payload.get('challenge_nonce')).witness(s,owner_id=owner_id,
        worker_id=worker_id,connection_id=connection_id,payload=payload)
