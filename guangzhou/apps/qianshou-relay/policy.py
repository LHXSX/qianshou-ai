"""Fail-closed FRP registration policy for one privately enrolled controller."""
import argparse
import http.server
import json
import re
from urllib.parse import parse_qs, urlsplit

MAX_BODY = 16384


def validate_policy(value):
    """Validate the administrator-owned, non-secret routing file."""
    if not isinstance(value, dict) or set(value) != {'user', 'domain', 'proxy', 'location'}:
        raise ValueError('invalid routing policy fields')
    if not re.fullmatch(r'[a-z0-9-]{8,64}', value['user']):
        raise ValueError('invalid controller identity')
    if not re.fullmatch(r'[a-z0-9.-]+', value['domain']):
        raise ValueError('invalid public domain')
    if value['proxy'] != 'devices' or value['location'] != '/qianshou-device':
        raise ValueError('only the device channel is supported')
    return value


def permit(operation, content, policy):
    """Permit exactly the enrolled identity and its single HTTP device route."""
    if not isinstance(content, dict):
        return False
    if operation == 'Login':
        return (content.get('user') == policy['user']
                and type(content.get('pool_count', 0)) is int
                and 0 <= content.get('pool_count', 0) <= 5
                and not content.get('client_spec'))
    if operation != 'NewProxy':
        return False
    user = content.get('user')
    if not isinstance(user, dict) or user.get('user') != policy['user']:
        return False
    return (content.get('proxy_name') == policy['user'] + '.' + policy['proxy']
            and content.get('proxy_type') == 'http'
            and content.get('custom_domains') == [policy['domain']]
            and content.get('locations') == [policy['location']]
            and all(not content.get(key) for key in (
                'subdomain', 'group', 'group_key', 'http_user', 'http_pwd',
                'host_header_rewrite', 'headers', 'request_headers',
                'response_headers', 'route_by_http_user', 'multiplexer', 'remote_port')))


def handler(policy):
    """Build a bounded loopback RPC handler without recording request contents."""
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            self.connection.settimeout(3)
            parsed = urlsplit(self.path)
            accepted = False
            try:
                query = parse_qs(parsed.query, strict_parsing=True)
                length = int(self.headers.get('Content-Length', '0'))
                if (parsed.path == '/handler' and set(query) == {'version', 'op'}
                        and query['version'] == ['0.1.0'] and len(query['op']) == 1
                        and 0 < length <= MAX_BODY
                        and self.headers.get_content_type() == 'application/json'
                        and not self.headers.get('Transfer-Encoding')):
                    data = json.loads(self.rfile.read(length))
                    accepted = isinstance(data, dict) and permit(query['op'][0], data.get('content'), policy)
            except (ValueError, TypeError, OSError):
                accepted = False
            response = ({'reject': False, 'unchange': True} if accepted else
                        {'reject': True, 'reject_reason': 'controller or route not enrolled'})
            body = json.dumps(response).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(body)
            self.close_connection = True

        def log_message(self, *_args):
            """FRP owns operational logs; request fields may contain credentials."""

    return Handler


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--policy', required=True)
    parser.add_argument('--port', type=int, default=17442)
    args = parser.parse_args()
    with open(args.policy, encoding='utf-8') as source:
        policy = validate_policy(json.load(source))
    http.server.HTTPServer(('127.0.0.1', args.port), handler(policy)).serve_forever()
