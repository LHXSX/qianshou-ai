"""Issue or renew a dedicated short-lived IP certificate using pinned Certbot."""
import argparse
import json
from pathlib import Path
import subprocess

IMAGE = 'certbot/certbot@sha256:f70ad0adbb7e117f0fe42a63c553f28ea451edabc0148757b6efcd9735acaa20'
BASE = Path('/var/lib/qianshou-agent-relay')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', choices=['staging', 'production', 'renew', 'check'], required=True)
    parser.add_argument('--ip', required=True)
    args = parser.parse_args()
    import ipaddress
    ipaddress.ip_address(args.ip)
    directory = BASE / ('acme-staging' if args.stage == 'staging' else 'acme')
    for name in ['config', 'work', 'logs']:
        (directory / name).mkdir(mode=0o700, parents=True, exist_ok=True)
    command = ['docker', 'run', '--rm', '--name', 'qianshou-relay-certbot',
               '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
               '-v', str(directory / 'config') + ':/etc/letsencrypt',
               '-v', str(directory / 'work') + ':/var/lib/letsencrypt',
               '-v', str(directory / 'logs') + ':/var/log/letsencrypt',
               '-v', str(BASE / 'webroot') + ':/webroot', IMAGE]
    if args.stage in ('renew', 'check'):
        command += ['renew', '--quiet']
        if args.stage == 'check':
            command += ['--dry-run']
    else:
        command += ['certonly', '--non-interactive', '--agree-tos',
                    '--register-unsafely-without-email', '--preferred-profile', 'shortlived',
                    '--webroot', '--webroot-path', '/webroot', '--ip-address', args.ip,
                    '--cert-name', 'qianshou-relay-ip']
        if args.stage == 'staging':
            command += ['--staging']
    result = subprocess.run(command, capture_output=True, timeout=240)
    log = directory / 'last-operation.log'
    log.write_bytes(result.stdout + result.stderr)
    log.chmod(0o600)
    if result.returncode:
        print(json.dumps({'stage': args.stage, 'exit': result.returncode, 'log': str(log)}))
        raise SystemExit(result.returncode)
    certificate = directory / 'config/live/qianshou-relay-ip/fullchain.pem'
    if args.stage == 'renew':
        subprocess.run(['nginx', '-t'], check=True, capture_output=True)
        subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    metadata = subprocess.run(['openssl', 'x509', '-in', str(certificate), '-noout',
                               '-dates', '-issuer', '-ext', 'subjectAltName'],
                              check=True, capture_output=True, text=True)
    print(json.dumps({'stage': args.stage, 'exit': 0, 'certificate': metadata.stdout.strip()}))


if __name__ == '__main__':
    main()
