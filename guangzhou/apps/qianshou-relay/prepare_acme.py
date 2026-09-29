"""Add one ACME location without changing existing business routes or listeners."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

BASE = Path('/var/lib/qianshou-agent-relay')
INCLUDE = Path('/etc/qianshou-agent-relay/acme-location.conf')
MARKER = '    include /etc/qianshou-agent-relay/acme-location.conf;\n'


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--site', required=True)
    parser.add_argument('--expected-sha256', required=True)
    args = parser.parse_args()
    site = Path(args.site).resolve()
    original = site.read_bytes()
    if hashlib.sha256(original).hexdigest() != args.expected_sha256:
        raise SystemExit('Existing nginx configuration changed; no write performed')
    text = original.decode()
    if text.count('server {') != 1 or MARKER in text or '/.well-known/acme-challenge/' in text:
        raise SystemExit('Expected exactly one unmodified business server')
    BASE.mkdir(mode=0o755, exist_ok=True)
    INCLUDE.parent.mkdir(mode=0o700, exist_ok=True)
    backup = INCLUDE.parent / 'business-nginx.before'
    with backup.open('xb') as target:
        target.write(original)
    backup.chmod(0o600)
    webroot = BASE / 'webroot/.well-known/acme-challenge'
    webroot.mkdir(parents=True, exist_ok=True)
    probe = webroot / 'qianshou-relay-ready'
    probe.write_text('qianshou-relay-acme-ready-v1\n')
    INCLUDE.write_text('location ^~ /.well-known/acme-challenge/ {\n'
                       '    root /var/lib/qianshou-agent-relay/webroot;\n'
                       '    default_type text/plain;\n'
                       '    try_files $uri =404;\n'
                       '    limit_except GET HEAD { deny all; }\n'
                       '}\n')
    changed = text.replace('server {', 'server {\n' + MARKER, 1).encode()
    site.write_bytes(changed)
    checked = subprocess.run(['nginx', '-t'], capture_output=True)
    if checked.returncode:
        site.write_bytes(original)
        raise SystemExit('Nginx syntax rejected; original configuration restored')
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    receipt = {'site': str(site), 'beforeSha256': args.expected_sha256,
               'afterSha256': hashlib.sha256(changed).hexdigest(),
               'originalRoutesBytePreserved': changed.replace(MARKER.encode(), b'', 1).replace(b'server {\n\n', b'server {\n', 1) == original,
               'backup': str(backup), 'nginxTest': 'passed'}
    (INCLUDE.parent / 'acme-change.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
