"""Install an isolated FRP relay after its trusted IP certificate exists."""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import pwd
import secrets
import subprocess
import tarfile

APP = Path('/opt/qianshou-agent-relay')
CONFIG = Path('/etc/qianshou-agent-relay')
PUBLIC_PORT = 24443


def write(path, value, mode=0o644):
    """Write a root-owned deployment file with an explicit access mode."""
    path.write_text(value)
    path.chmod(mode)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ip', required=True)
    parser.add_argument('--archive', required=True)
    parser.add_argument('--sha256', required=True)
    args = parser.parse_args()
    ipaddress.IPv4Address(args.ip)
    archive = Path(args.archive)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != args.sha256:
        raise SystemExit('FRP archive checksum failed')
    certificate = Path('/var/lib/qianshou-agent-relay/acme/config/live/qianshou-relay-ip')
    if not (certificate / 'fullchain.pem').is_file():
        raise SystemExit('A production IP certificate is required before activation')
    if (CONFIG / 'enrollment.json').exists():
        raise SystemExit('Controller already enrolled; refusing credential replacement')
    APP.mkdir(mode=0o755, exist_ok=True)
    target = APP / 'frp-0.71.0'
    target.mkdir(mode=0o755, exist_ok=True)
    with tarfile.open(archive) as source:
        for name in ['frps', 'LICENSE']:
            member = source.getmember('frp_0.71.0_linux_amd64/' + name)
            if not member.isfile():
                raise SystemExit('Unexpected FRP archive entry')
            (target / name).write_bytes(source.extractfile(member).read())
            (target / name).chmod(0o755 if name == 'frps' else 0o644)
    try:
        account = pwd.getpwnam('qianshou-relay')
    except KeyError:
        subprocess.run(['useradd', '--system', '--no-create-home', '--home-dir',
                        '/var/lib/qianshou-agent-relay', '--shell', '/usr/sbin/nologin',
                        'qianshou-relay'], check=True)
        account = pwd.getpwnam('qianshou-relay')
    CONFIG.mkdir(exist_ok=True)
    CONFIG.chmod(0o750)
    os.chown(CONFIG, 0, account.pw_gid)
    identity = 'qs-' + secrets.token_hex(12)
    token = secrets.token_hex(32)
    write(CONFIG / 'registration.token', token + '\n', 0o600)
    write(CONFIG / 'policy.json', json.dumps({'user': identity, 'domain': args.ip,
          'proxy': 'devices', 'location': '/qianshou-device'}) + '\n', 0o600)
    for name in ['registration.token', 'policy.json']:
        os.chown(CONFIG / name, account.pw_uid, account.pw_gid)
    write(CONFIG / 'enrollment.json', json.dumps({'version': 1,
          'endpoint': 'https://' + args.ip + ':' + str(PUBLIC_PORT),
          'controllerId': identity, 'token': token}, indent=2) + '\n', 0o600)
    frps = '''bindAddr = "127.0.0.1"
bindPort = 17440
proxyBindAddr = "127.0.0.1"
vhostHTTPPort = 17441
vhostHTTPTimeout = 10
transport.maxPoolCount = 5
transport.tls.force = false
auth.method = "token"
auth.additionalScopes = ["HeartBeats", "NewWorkConns"]
auth.tokenSource.type = "file"
auth.tokenSource.file.path = "/etc/qianshou-agent-relay/registration.token"
allowPorts = [{ single = 65535 }]
maxPortsPerClient = 1
detailedErrorsToClient = false
log.to = "console"
log.level = "warn"
log.disablePrintColor = true
[[httpPlugins]]
name = "qianshou-device-policy"
addr = "127.0.0.1:17442"
path = "/handler"
ops = ["Login", "NewProxy"]
'''
    write(CONFIG / 'frps.toml', frps, 0o640)
    os.chown(CONFIG / 'frps.toml', 0, account.pw_gid)
    common = '''[Service]
User=qianshou-relay
Group=qianshou-relay
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
UMask=0077
Restart=on-failure
RestartSec=3
TimeoutStopSec=10
MemoryMax=256M
TasksMax=128
'''
    write(Path('/etc/systemd/system/qianshou-relay-policy.service'),
          '[Unit]\nDescription=Qianshou dedicated device registration policy\nAfter=network.target\n'
          + common + 'ExecStart=/usr/bin/python3 /opt/qianshou-agent-relay/policy.py --policy /etc/qianshou-agent-relay/policy.json\n'
          '[Install]\nWantedBy=multi-user.target\n')
    write(Path('/etc/systemd/system/qianshou-relay.service'),
          '[Unit]\nDescription=Qianshou isolated collaboration relay\nAfter=network.target qianshou-relay-policy.service\nRequires=qianshou-relay-policy.service\n'
          + common + 'ExecStart=/opt/qianshou-agent-relay/frp-0.71.0/frps -c /etc/qianshou-agent-relay/frps.toml\n'
          '[Install]\nWantedBy=multi-user.target\n')
    verify = subprocess.run([str(target / 'frps'), 'verify', '-c', str(CONFIG / 'frps.toml')], capture_output=True)
    if verify.returncode:
        raise SystemExit('FRP config verification failed before service activation')
    nginx = '''limit_conn_zone $binary_remote_addr zone=qianshou_relay_connections:1m;
server {
    listen 24443 ssl;
    server_name IP_ADDRESS;
    ssl_certificate CERT_PATH/fullchain.pem;
    ssl_certificate_key CERT_PATH/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:qianshou_relay_tls:1m;
    server_tokens off;
    client_max_body_size 1k;
    client_header_timeout 10s;
    client_body_timeout 10s;
    limit_conn qianshou_relay_connections 24;
    access_log off;
    error_log /var/log/nginx/qianshou-relay-error.log warn;
    location = /healthz {
        default_type application/json;
        return 200 '{"service":"qianshou-collaboration-relay","version":1}';
    }
    location = /~!frp {
        if ($request_method != GET) { return 405; }
        if ($args != "") { return 400; }
        if ($http_upgrade !~* ^websocket$) { return 426; }
        proxy_pass http://127.0.0.1:17440;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection upgrade;
        proxy_set_header Host IP_ADDRESS;
        proxy_set_header Cookie "";
        proxy_set_header Authorization "";
        proxy_buffering off;
        proxy_connect_timeout 5s;
        proxy_read_timeout 100s;
        proxy_send_timeout 100s;
    }
    location = /qianshou-device {
        if ($request_method != GET) { return 405; }
        if ($args != "") { return 400; }
        if ($http_upgrade !~* ^websocket$) { return 426; }
        proxy_pass http://127.0.0.1:17441;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection upgrade;
        proxy_set_header Host IP_ADDRESS;
        proxy_set_header Cookie "";
        proxy_set_header Authorization "";
        proxy_set_header Origin $http_origin;
        proxy_buffering off;
        proxy_connect_timeout 5s;
        proxy_read_timeout 100s;
        proxy_send_timeout 100s;
    }
    location / { return 404; }
}
'''.replace('IP_ADDRESS', args.ip).replace('CERT_PATH', str(certificate))
    nginx_path = Path('/etc/nginx/conf.d/qianshou-agent-relay.conf')
    if nginx_path.exists():
        raise SystemExit('Refusing to overwrite an existing relay nginx server')
    write(nginx_path, nginx)
    checked = subprocess.run(['nginx', '-t'], capture_output=True)
    if checked.returncode:
        nginx_path.unlink()
        raise SystemExit('Nginx verification failed; new server file removed')
    write(Path('/etc/systemd/system/qianshou-relay-certificate.service'),
          '[Unit]\nDescription=Renew Qianshou short-lived IP certificate\nAfter=docker.service network-online.target\n'
          '[Service]\nType=oneshot\nUMask=0077\nTimeoutStartSec=300\n'
          'ExecStart=/usr/bin/python3 /opt/qianshou-agent-relay/certificate.py --stage renew --ip ' + args.ip + '\n')
    write(Path('/etc/systemd/system/qianshou-relay-certificate.timer'),
          '[Unit]\nDescription=Check Qianshou certificate renewal every 12 hours\n'
          '[Timer]\nOnCalendar=*-*-* 00,12:15:00\nRandomizedDelaySec=900\nPersistent=true\n'
          '[Install]\nWantedBy=timers.target\n')
    subprocess.run(['systemctl', 'daemon-reload'], check=True)
    subprocess.run(['systemctl', 'enable', '--now', 'qianshou-relay-policy.service',
                    'qianshou-relay.service', 'qianshou-relay-certificate.timer'], check=True, capture_output=True)
    subprocess.run(['systemctl', 'reload', 'nginx'], check=True)
    print(json.dumps({'endpoint': 'https://' + args.ip + ':' + str(PUBLIC_PORT),
                      'controllerId': identity, 'enrollmentFile': str(CONFIG / 'enrollment.json'),
                      'frpVersion': '0.71.0', 'nginxTest': 'passed', 'credentialsPrinted': False}))


if __name__ == '__main__':
    main()
