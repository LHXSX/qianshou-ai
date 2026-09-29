"""Registration cannot expose a second route, identity, or protocol."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('policy', Path(__file__).parents[1] / 'policy.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
POLICY = p.validate_policy({'user': 'private-controller', 'domain': '203.0.113.20',
                            'proxy': 'devices', 'location': '/qianshou-device'})
VALID = {'user': {'user': 'private-controller'}, 'proxy_name': 'private-controller.devices',
         'proxy_type': 'http', 'custom_domains': ['203.0.113.20'],
         'locations': ['/qianshou-device']}


class PolicyTests(unittest.TestCase):
    def test_enrolled_route_is_accepted(self):
        self.assertTrue(p.permit('NewProxy', VALID, POLICY))

    def test_other_identity_is_rejected_even_with_valid_server_auth(self):
        data = copy.deepcopy(VALID); data['user']['user'] = 'other-controller'
        self.assertFalse(p.permit('NewProxy', data, POLICY))
        self.assertFalse(p.permit('Login', {'user': 'other-controller', 'pool_count': 0}, POLICY))

    def test_http_admin_routes_and_catch_all_are_rejected(self):
        for value in [['/'], ['/api'], ['/qianshou-device', '/api'], [], None]:
            with self.subTest(value=value):
                self.assertFalse(p.permit('NewProxy', dict(VALID, locations=value), POLICY))

    def test_other_transport_and_hosts_are_rejected(self):
        for protocol in ['tcp', 'udp', 'stcp', 'sudp', 'https', 'tcpmux', 'xtcp']:
            self.assertFalse(p.permit('NewProxy', dict(VALID, proxy_type=protocol), POLICY))
        for hosts in [[], ['other.test'], ['203.0.113.20', 'other.test']]:
            self.assertFalse(p.permit('NewProxy', dict(VALID, custom_domains=hosts), POLICY))

    def test_header_and_port_overrides_are_rejected(self):
        for key in ['subdomain', 'group', 'group_key', 'http_user', 'http_pwd',
                    'host_header_rewrite', 'headers', 'request_headers',
                    'response_headers', 'route_by_http_user', 'multiplexer', 'remote_port']:
            self.assertFalse(p.permit('NewProxy', dict(VALID, **{key: 'override'}), POLICY))

    def test_login_is_bounded_and_unknown_operations_fail_closed(self):
        self.assertTrue(p.permit('Login', {'user': POLICY['user'], 'pool_count': 0}, POLICY))
        self.assertTrue(p.permit('Login', {'user': POLICY['user']}, POLICY))
        self.assertFalse(p.permit('Login', {'user': POLICY['user'], 'client_spec': {'always_auth_pass': True}}, POLICY))
        for count in [-1, 6, True, '0', None]:
            self.assertFalse(p.permit('Login', {'user': POLICY['user'], 'pool_count': count}, POLICY))
        self.assertFalse(p.permit('FutureOperation', VALID, POLICY))
        self.assertFalse(p.permit('NewProxy', [], POLICY))

    def test_admin_policy_must_keep_device_path(self):
        with self.assertRaises(ValueError):
            p.validate_policy(dict(POLICY, location='/'))


if __name__ == '__main__':
    unittest.main()
