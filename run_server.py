#!/usr/bin/env python3
"""
Swaparr Static File Server
Serves the Swaparr mobile dashboard locally and displays network addresses for easy mobile access.
"""

import http.server
import socketserver
import socket
import os
import sys

PORT = 8080
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def log_message(self, format, *args):
        # Clean logging output
        sys.stderr.write("%s - - [%s] %s\n" %
                         (self.address_string(),
                          self.log_date_time_string(),
                          format%args))

def get_local_ips():
    ips = ['127.0.0.1']
    
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
            if ip != '127.0.0.1':
                print(f"  • http://{ip}:{PORT}")
    else:
        print("\nCould not auto-detect a local network IP address.")
        print("Please check your network settings or find your machine IP.")
        print(f"Server port: {PORT}")

    print("\nPress Ctrl+C to stop the server.")
    print("-" * 60)
    
    socketserver.TCPServer.allow_reuse_address = True
    try:
        with socketserver.TCPServer(("", PORT), Handler) as httpd:
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping Swaparr server. Goodbye!")
        sys.exit(0)
    except Exception as e:
        print(f"\nError starting server: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
