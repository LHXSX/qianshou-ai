"""Bounded read-only Windows/H3 capability receipt. No tasks, model load or file edits."""
import argparse,datetime,hashlib,json,platform,urllib.request
from pathlib import Path

def get(port,path):
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open('http://127.0.0.1:'+str(port)+path,timeout=5) as r:
        if r.status!=200:raise ValueError('HTTP_STATUS')
        raw=r.read(4*1024*1024+1)
        if len(raw)>4*1024*1024:raise ValueError('METADATA_LIMIT')
        return json.loads(raw)

def probe(model_file=None):
    if platform.system()!='Windows':raise RuntimeError('WINDOWS_EXECUTION_REQUIRED')
    h3=get(8790,'/health');stats=get(8189,'/system_stats');nodes=get(8189,'/object_info')
    needed=['UpscaleModelLoader','ImageUpscaleWithModel','ImageScale','LoadImage','SaveImage']
    names=nodes.get('UpscaleModelLoader',{}).get('input',{}).get('required',{}).get('model_name',[[]])[0]
    if not isinstance(names,list):names=[]
    out=dict(schema='qs.windows.h3-readonly-probe.v1',observedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),hostname=platform.node(),platform='windows',
        h3={k:h3.get(k) for k in ('ok','status','model','comfy','instance','queue')},
        gpuNames=[d.get('name') for d in stats.get('devices',[]) if isinstance(d,dict)],
        modelProfiles=sorted(h3.get('model_profiles',{})),nodeClasses={n:n in nodes for n in needed},
        upscaleModelNames=names,requestsSubmitted=0,modelsLoaded=0,filesChanged=0)
    if model_file:
        path=Path(model_file)
        if path.is_symlink() or not path.is_file() or path.name!='realesr-general-x4v3.pth':raise ValueError('EXPLICIT_REALESRGAN_MODEL_REQUIRED')
        digest=hashlib.sha256()
        with path.open('rb') as f:
            for chunk in iter(lambda:f.read(1024*1024),b''):digest.update(chunk)
        out['upscaleModel']={'fileName':path.name,'bytes':path.stat().st_size,'sha256':digest.hexdigest()}
    return out

if __name__=='__main__':
    print(json.dumps(dict(status='ok',schema_version='v1',task_type='film_node_capabilities_v1',result=probe()),ensure_ascii=False))
