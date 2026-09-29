"""One fixed Guangzhou TLS peer; fingerprint checked BEFORE any credential is sent."""
import hashlib,http.client,ssl,json,os
from pathlib import Path
HOST=os.environ.get('QS_GUANGZHOU_CATALOG_HOST','').strip()
PIN=os.environ.get('QS_GUANGZHOU_CATALOG_CERT_SHA256','').strip().lower()
def verify_peer(der):
 if len(PIN)!=64 or hashlib.sha256(der).hexdigest()!=PIN:raise ValueError('Gateway TLS identity changed')
def read_catalog(cert_file,token,connection_factory=http.client.HTTPSConnection):
 if not HOST:raise ValueError('Gateway host is not configured')
 if not isinstance(token,str) or len(token)<32:raise ValueError('Gateway observer identity missing')
 p=Path(cert_file)
 if p.is_symlink() or not p.is_file():raise ValueError('Pinned public certificate required')
 der=ssl.PEM_cert_to_DER_cert(p.read_text(encoding='ascii'));verify_peer(der)
 ctx=ssl.create_default_context(cafile=str(p));ctx.check_hostname=False
 # Existing self-signed IP certificate lacks SAN. Exact DER pin replaces name matching,
 # while TLS chain/time verification remains on. Never CERT_NONE or verify=False.
 conn=connection_factory(HOST,443,context=ctx,timeout=8)
 try:
  conn.connect();verify_peer(conn.sock.getpeercert(binary_form=True))
  conn.request('GET','/internal/image-model-catalog',headers={'Authorization':'Bearer '+token,'Accept':'application/json'})
  response=conn.getresponse()
  if response.status!=200:raise ValueError('Gateway catalog unavailable')
  raw=response.read(65537)
  if len(raw)>65536:raise ValueError('Catalog too large')
  return json.loads(raw)
 finally:conn.close()
