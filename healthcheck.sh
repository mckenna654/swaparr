#!/bin/sh
# Container health: the page is served AND Dispatcharr answers through the proxy.
# A wrong DISPATCHARR_URL or API key shows as "unhealthy" in Docker and Unraid.
PORT="${NGINX_PORT:-8080}"
if ! wget -qO- "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
  echo "Swaparr is not serving its page on port ${PORT}."
  exit 1
fi
if ! wget -qO- "http://127.0.0.1:${PORT}/dispatcharr-api/proxy/ts/status" >/dev/null 2>&1; then
  echo "Dispatcharr did not answer through Swaparr's proxy. Check DISPATCHARR_URL and DISPATCHARR_API_KEY."
  exit 1
fi
echo "Swaparr is serving and Dispatcharr is answering."
