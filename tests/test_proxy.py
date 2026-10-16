"""Loopback integration tests; no real Dispatcharr credentials or server required."""
import http.client
import http.server
import json
import os
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from run_server import Handler


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

    def request(self, path):
        connection = http.client.HTTPConnection("127.0.0.1", self.proxy.server_port, timeout=5)
        connection.request("PATCH", path, json.dumps({"streams": [3, 1, 2]}), {"Content-Type": "application/json"})
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


if __name__ == "__main__":
    unittest.main()
