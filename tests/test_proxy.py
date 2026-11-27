"""Loopback integration tests; no real Dispatcharr credentials or server required."""
import http.client
import http.server
import json
import os
from pathlib import Path
import re
import sys
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from run_server import API_ALLOWLIST, Handler, api_call_allowed


class Upstream(http.server.BaseHTTPRequestHandler):
    status = 200
    received = None

    def do_PATCH(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        type(self).received = (self.path, self.headers.get("Authorization"), json.loads(body))
        self.send_response(type(self).status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"streams": [3, 1, 2]}).encode())

    def do_GET(self):
        type(self).received = (self.path, self.headers.get("Authorization"), None)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"channels": []}')

    def log_message(self, *args):
        pass


class ProxyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        cls.proxy = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        for server in (cls.upstream, cls.proxy):
            threading.Thread(target=server.serve_forever, daemon=True).start()
        cls.environment = patch.dict(os.environ, {
            "DISPATCHARR_URL": f"http://127.0.0.1:{cls.upstream.server_port}",
            "DISPATCHARR_API_KEY": "test-only-key",
        })
        cls.environment.start()

    @classmethod
    def tearDownClass(cls):
        cls.environment.stop()
        for server in (cls.proxy, cls.upstream):
            server.shutdown()
            server.server_close()

    def request(self, path, method="PATCH"):
        connection = http.client.HTTPConnection("127.0.0.1", self.proxy.server_port, timeout=5)
        body = json.dumps({"streams": [3, 1, 2]}) if method in ("PATCH", "POST") else None
        connection.request(method, path, body, {"Content-Type": "application/json"})
        response = connection.getresponse()
        result = (response.status, response.read())
        connection.close()
        return result

    def test_patch_forwards_order_and_auth(self):
        Upstream.status = 200
        status, body = self.request("/dispatcharr-api/api/channels/channels/10/")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"streams": [3, 1, 2]})
        self.assertEqual(Upstream.received, ("/api/channels/channels/10/", "ApiKey test-only-key", {"streams": [3, 1, 2]}))

    def test_patch_preserves_permission_error(self):
        Upstream.status = 403
        self.assertEqual(self.request("/dispatcharr-api/api/channels/channels/10/")[0], 403)

    def test_patch_does_not_write_static_files(self):
        self.assertEqual(self.request("/index.html")[0], 405)

    def test_unlisted_calls_are_refused_before_reaching_dispatcharr(self):
        for method, path in [
            ("GET", "/dispatcharr-api/api/core/settings/"),
            ("PATCH", "/dispatcharr-api/api/accounts/users/1/"),
            ("GET", "/dispatcharr-api/api/m3u/accounts/1/"),
            ("PATCH", "/dispatcharr-api/api/channels/channels/10/streams/"),
            ("POST", "/dispatcharr-api/api/channels/channels/"),
            ("GET", "/dispatcharr-api/proxy/ts/change_stream/abc"),
            ("GET", "/dispatcharr-api/api/channels/channels/../../accounts/users/"),
        ]:
            with self.subTest(method=method, path=path):
                Upstream.received = None
                self.assertEqual(self.request(path, method)[0], 403)
                self.assertIsNone(Upstream.received, "Refused calls must not reach Dispatcharr")

    def test_listed_get_passes_with_query_string(self):
        status, body = self.request("/dispatcharr-api/api/channels/channels/?page=2&page_size=200", "GET")
        self.assertEqual(status, 200)
        self.assertEqual(Upstream.received[0], "/api/channels/channels/?page=2&page_size=200")

    def test_config_never_carries_the_key(self):
        with patch.dict(os.environ, {"DISABLE_PROXY": "true"}):
            connection = http.client.HTTPConnection("127.0.0.1", self.proxy.server_port, timeout=5)
            connection.request("GET", "/config.json")
            config = json.loads(connection.getresponse().read())
            connection.close()
        self.assertEqual(config, {"url": "/dispatcharr-api", "apiKey": "", "watcher": False})


class AllowlistTests(unittest.TestCase):
    def test_every_call_the_app_makes_is_allowed(self):
        for method, path in [
            ("GET", "/dispatcharr-api/api/accounts/users/"),
            ("GET", "/dispatcharr-api/api/m3u/accounts/"),
            ("GET", "/dispatcharr-api/api/channels/groups/"),
            ("GET", "/dispatcharr-api/api/channels/channels/"),
            ("GET", "/dispatcharr-api/api/channels/channels/12/streams/"),
            ("PATCH", "/dispatcharr-api/api/channels/channels/12/"),
            ("GET", "/dispatcharr-api/proxy/ts/status"),
            ("GET", "/dispatcharr-api/proxy/ts/status/0b6f9b5e-1c2d-4e5f-8a9b-123456789abc"),
            ("POST", "/dispatcharr-api/proxy/ts/change_stream/0b6f9b5e-1c2d-4e5f-8a9b-123456789abc"),
            ("DELETE", "/dispatcharr-api/proxy/ts/stop/0b6f9b5e-1c2d-4e5f-8a9b-123456789abc"),
            ("POST", "/dispatcharr-api/proxy/ts/stop/0b6f9b5e-1c2d-4e5f-8a9b-123456789abc"),
        ]:
            with self.subTest(method=method, path=path):
                self.assertTrue(api_call_allowed(method, path))

    def test_nginx_map_matches_dev_server_list(self):
        template = (Path(__file__).resolve().parents[1] / "nginx.conf.template").read_text()
        nginx_patterns = re.findall(r'"~(\^[^"]+)" 1;', template)
        self.assertEqual(nginx_patterns, API_ALLOWLIST)


if __name__ == "__main__":
    unittest.main()
