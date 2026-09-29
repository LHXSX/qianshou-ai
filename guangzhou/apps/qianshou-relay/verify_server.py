"""Write a non-secret deployment receipt for the isolated relay and original services."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess

APP = Path('/opt/qianshou-agent-relay')
CONFIG = Path('/etc/qianshou-agent-relay')
BASE = Path('/var/lib/qianshou-agent-relay')


def run(command):
    """Read bounded service metadata; never use arbitrary configuration dumps."""
    return subprocess.run(command, check=True, capture_output=True, text=True, timeout=15).stdout.strip()


def main():
    change = json.loads((CONFIG / 'acme-change.json').read_text())
    site = Path(change['site']).read_bytes()
    before = (CONFIG / 'business-nginx.before').read_bytes()
    expected = before.decode().replace('server {', 'server {\n    include /etc/qianshou-agent-relay/acme-location.conf;\n', 1).encode()
    if site != expected:
        raise SystemExit('Business nginx configuration differs from the approved ACME-only change')
    units = {}
    for unit in ['qianshou-relay.service', 'qianshou-relay-policy.service',
                 'qianshou-relay-certificate.timer', 'qianshou-relay-certificate.service',
                 'frps.service', 'nginx.service']:
        lines = run(['systemctl', 'show', unit, '--property=ActiveState,SubState,MainPID,NextElapseUSecRealtime,Result,ExecMainStatus']).splitlines()
        units[unit] = dict(line.split('=', 1) for line in lines)
    files = [APP / name for name in ['policy.py', 'certificate.py', 'install_relay.py', 'prepare_acme.py']]
    files += [APP / 'frp-0.71.0/frps', Path('/etc/nginx/conf.d/qianshou-agent-relay.conf')]
    certificate = BASE / 'acme/config/live/qianshou-relay-ip/fullchain.pem'
    receipt = {'verifiedAt': datetime.now(timezone.utc).isoformat(), 'endpoint': 'https://203.0.113.20:24443',
               'frpVersion': run([str(APP / 'frp-0.71.0/frps'), '--version']),
               'certificate': run(['openssl', 'x509', '-in', str(certificate), '-noout', '-dates', '-issuer', '-ext', 'subjectAltName']),
               'services': units, 'businessNginx': change,
               'onlyAcmeLocationAdded': True,
               'privateFileModes': {name: oct((CONFIG / name).stat().st_mode & 0o777) for name in ['enrollment.json', 'registration.token', 'policy.json']},
               'files': [{'path': str(p), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in files],
               'certbotImage': 'certbot/certbot@sha256:f70ad0adbb7e117f0fe42a63c553f28ea451edabc0148757b6efcd9735acaa20',
               'scope': 'Dedicated controller registration and authenticated device WebSocket forwarding; no dashboard or generic port forwarding',
               'desktopPixels': 'External RustDesk remains separate'}
    run(['nginx', '-t'])
    receipt['nginxTest'] = 'passed'
    (BASE / 'DEPLOYMENT_RECEIPT.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
