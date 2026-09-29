"""Stop only Qianshou relay services and restore the byte-verified ACME nginx edit."""
import hashlib
import json
from pathlib import Path
import subprocess

CONFIG = Path('/etc/qianshou-agent-relay')


def main():
    change = json.loads((CONFIG / 'acme-change.json').read_text())
    site = Path(change['site'])
    current = site.read_bytes()
    original = (CONFIG / 'business-nginx.before').read_bytes()
    if (hashlib.sha256(current).hexdigest() != change['afterSha256']
            or hashlib.sha256(original).hexdigest() != change['beforeSha256']):
        raise SystemExit('Business configuration changed; refusing an automatic rollback')
    server = Path('/etc/nginx/conf.d/qianshou-agent-relay.conf')
    retired = CONFIG / 'retired-relay-nginx.conf'
    if retired.exists():
        raise SystemExit('A retired configuration exists; inspect it before another rollback')
    server.rename(retired)
    site.write_bytes(original)
    checked = subprocess.run(['nginx', '-t'], capture_output=True)
    if checked.returncode:
        site.write_bytes(current)
        retired.rename(server)
        raise SystemExit('Rollback syntax check failed; active configuration restored')
    subprocess.run(['systemctl', 'disable', '--now', 'qianshou-relay-certificate.timer',
                    'qianshou-relay.service', 'qianshou-relay-policy.service'], check=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    print('Dedicated relay stopped. Existing business configuration restored; credentials and certificates retained for administrator review.')


if __name__ == '__main__':
    main()
