#!/usr/bin/env python3
"""
Swaparr Static File Server
Serves the Swaparr mobile dashboard locally and displays network addresses for easy mobile access.
"""

import http.server
import json
import os
import re
import socket
import socketserver
import sys
import urllib.request
import urllib.error

PORT = 8080
DIRECTORY = os.path.dirname(os.path.abspath(__file__))
UPSTREAM_TIMEOUT = 30

# The only Dispatcharr calls Swaparr makes, as "METHOD /path" patterns. Everything else
# is refused before the API key is attached. Keep in step with the map in
# nginx.conf.template; tests/test_proxy.py checks that both lists match.
API_ALLOWLIST = [
    r"^GET /dispatcharr-api/api/accounts/users/$",
    r"^GET /dispatcharr-api/api/m3u/accounts/$",
    r"^GET /dispatcharr-api/api/channels/groups/$",
    r"^GET /dispatcharr-api/api/channels/channels/$",
    r"^GET /dispatcharr-api/api/channels/channels/[0-9]+/streams/$",
    r"^PATCH /dispatcharr-api/api/channels/channels/[0-9]+/$",
    r"^GET /dispatcharr-api/proxy/ts/status$",
    r"^GET /dispatcharr-api/proxy/ts/status/[A-Za-z0-9-]+$",
    r"^POST /dispatcharr-api/proxy/ts/change_stream/[A-Za-z0-9-]+$",
    r"^(DELETE|POST) /dispatcharr-api/proxy/ts/stop/[A-Za-z0-9-]+$",
]
_ALLOWED = [re.compile(pattern) for pattern in API_ALLOWLIST]


def api_call_allowed(method, path):
    """True when METHOD and path (query string ignored) are on the allowlist."""
    key = f"{method} {path.split('?', 1)[0]}"
    return any(pattern.match(key) for pattern in _ALLOWED)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def do_GET(self):
        if self.path == "/config.json":
            self.send_response(200)
            self.send_header("Content-type", "application/json")
            self.end_headers()

            # The browser always talks to this proxy; the API key stays on the server.
            config_data = {"url": "/dispatcharr-api", "apiKey": ""}
            self.wfile.write(json.dumps(config_data).encode("utf-8"))
            return

        # Simple reverse proxy for local dev
        if self.path.startswith("/dispatcharr-api/"):
            self._handle_proxy()
            return

        super().do_GET()

    def do_POST(self):
        if self.path.startswith("/dispatcharr-api/"):
            self._handle_proxy()
            return
        
        self.send_response(405)
        self.end_headers()

    def do_PATCH(self):
        if self.path.startswith("/dispatcharr-api/"):
            self._handle_proxy()
            return
        self.send_response(405)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_DELETE(self):
        if self.path.startswith("/dispatcharr-api/"):
            self._handle_proxy()
            return
            
        self.send_response(405)
        self.end_headers()

    def _handle_proxy(self):
        if not api_call_allowed(self.command, self.path):
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        target_url_base = os.environ.get("DISPATCHARR_URL", "").rstrip("/")
        api_key = os.environ.get("DISPATCHARR_API_KEY", "")

        if not target_url_base:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b"DISPATCHARR_URL environment variable not set")
            return

        # Strip the prefix and forward
        api_path = self.path[len("/dispatcharr-api"):]
        target_url = f"{target_url_base}{api_path}"

        headers = {
            "Authorization": f"ApiKey {api_key}",
        }
        
        # Forward Content-Type if present
        if "Content-Type" in self.headers:
            headers["Content-Type"] = self.headers["Content-Type"]

        data = None
        if "Content-Length" in self.headers:
            length = int(self.headers["Content-Length"])
            data = self.rfile.read(length)

        try:
            req = urllib.request.Request(target_url, data=data, headers=headers, method=self.command)
            with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT) as response:
                self.send_response(response.status)
                for k, v in response.headers.items():
                    if k.lower() not in ("transfer-encoding", "connection"):
                        self.send_header(k, v)
                self.end_headers()
                self.wfile.write(response.read())
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            for k, v in e.headers.items():
                if k.lower() not in ("transfer-encoding", "connection"):
                    self.send_header(k, v)
            self.end_headers()
            self.wfile.write(e.read())
            e.close()
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(str(e).encode())

    def log_message(self, format, *args):
        # Clean logging output
        sys.stderr.write(
            "%s - - [%s] %s\n"
            % (self.address_string(), self.log_date_time_string(), format % args)
        )


def get_local_ips():
    ips = ["127.0.0.1"]

    # Method 1: Connection test (highly reliable for active interfaces)
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.1)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        if ip not in ips:
            ips.append(ip)
        s.close()
    except Exception:
        pass

    # Method 2: Fallback lookup
    try:
        hostname = socket.gethostname()
        for ip in socket.gethostbyname_ex(hostname)[2]:
            if ip not in ips and not ip.startswith("127."):
                ips.append(ip)
    except Exception:
        pass

    return ips


def main():
    # Change working directory to ensure correct serving folder
    os.chdir(DIRECTORY)

    ips = get_local_ips()
    primary_network_ip = ips[-1] if len(ips) > 1 else None

    print("=" * 60)
    print(" 🔄  SWAPARR - MOBILE OVERRIDE SERVER IS RUNNING")
    print("=" * 60)
    print("\nAccess the dashboard on this computer:")
    print(f"  👉  http://localhost:{PORT}")

    if primary_network_ip:
        print("\nAccess the dashboard on your MOBILE phone (same WiFi network):")
        print(f"  👉  http://{primary_network_ip}:{PORT}")
        print("\nAll available network interface paths:")
        for ip in ips:
            if ip != "127.0.0.1":
                print(f"  • http://{ip}:{PORT}")
    else:
        print("\nCould not auto-detect a local network IP address.")
        print("Please check your network settings or find your machine IP.")
        print(f"Server port: {PORT}")

    print("\nPress Ctrl+C to stop the server.")
    print("-" * 60)

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    socketserver.ThreadingTCPServer.daemon_threads = True
    try:
        with socketserver.ThreadingTCPServer(("", PORT), Handler) as httpd:
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Swaparr server. Goodbye!")
        sys.exit(0)
    except Exception as e:
        print(f"\nError starting server: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
