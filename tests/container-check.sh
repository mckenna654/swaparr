#!/bin/sh
# Builds the real image and checks the nginx proxy against a fake Dispatcharr.
# Needs Docker. Run from the repo root: sh tests/container-check.sh
set -eu

NET=swaparr-check-net
UP=swaparr-check-upstream
APP=swaparr-check-app
IMAGE=swaparr:check
PORT=18080

cleanup() {
  docker rm -f "$APP" "$UP" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

docker network create "$NET" >/dev/null

# A fake Dispatcharr that answers every request with the path and the key it received.
docker run -d --name "$UP" --network "$NET" python:3.12-alpine python -c '
import http.server, json
class H(http.server.BaseHTTPRequestHandler):
    def reply(self):
        body = json.dumps({"path": self.path, "auth": self.headers.get("Authorization"), "channels": []}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    do_GET = do_POST = do_PATCH = do_DELETE = reply
http.server.ThreadingHTTPServer(("0.0.0.0", 9191), H).serve_forever()
' >/dev/null

docker build -q -t "$IMAGE" . >/dev/null
docker run -d --name "$APP" --network "$NET" -p "$PORT:8080" \
  -e DISPATCHARR_URL=http://$UP:9191 -e DISPATCHARR_API_KEY=check-only-key \
  -e DISABLE_PROXY=true -e WATCHER=true "$IMAGE" >/dev/null

# Wait for nginx to answer.
i=0
until curl -fsS "http://127.0.0.1:$PORT/" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 30 ] && { echo "FAIL: nginx did not start"; docker logs "$APP"; exit 1; }
  sleep 1
done

fail() { echo "FAIL: $1"; exit 1; }
code() { curl -s -o /dev/null -w '%{http_code}' -X "$1" "http://127.0.0.1:$PORT$2"; }

docker exec "$APP" nginx -t >/dev/null 2>&1 || fail "nginx -t rejected the generated config"

body=$(curl -fsS "http://127.0.0.1:$PORT/dispatcharr-api/proxy/ts/status")
echo "$body" | grep -q '"auth": "ApiKey check-only-key"' || fail "allowed call did not carry the key: $body"
echo "$body" | grep -q '"path": "/proxy/ts/status"' || fail "allowed call reached the wrong path: $body"

[ "$(code GET /dispatcharr-api/api/channels/channels/?page=1)" = 200 ] || fail "channel list blocked"
[ "$(code PATCH /dispatcharr-api/api/channels/channels/12/)" = 200 ] || fail "priority save blocked"
[ "$(code POST /dispatcharr-api/proxy/ts/change_stream/abc-123)" = 200 ] || fail "switch blocked"
[ "$(code DELETE /dispatcharr-api/proxy/ts/stop/abc-123)" = 200 ] || fail "stop blocked"
[ "$(code GET /dispatcharr-api/proxy/ts/status/abc-123)" = 200 ] || fail "client list blocked"

[ "$(code GET /dispatcharr-api/api/core/settings/)" = 403 ] || fail "settings endpoint not blocked"
[ "$(code PATCH /dispatcharr-api/api/accounts/users/1/)" = 403 ] || fail "user edit not blocked"
[ "$(code DELETE /dispatcharr-api/api/channels/channels/12/)" = 403 ] || fail "channel delete not blocked"
[ "$(code GET /dispatcharr-api/api/m3u/accounts/1/)" = 403 ] || fail "provider account detail not blocked"

config=$(curl -fsS "http://127.0.0.1:$PORT/config.json")
echo "$config" | grep -q 'check-only-key' && fail "config.json exposes the key"
docker logs "$APP" 2>&1 | grep -q "DISABLE_PROXY is no longer supported" || fail "no warning for DISABLE_PROXY"

# Optional watcher: started, read-only through nginx, config tells the page it is on.
echo "$config" | grep -q '"watcher": true' || fail "config.json does not report the watcher"
i=0
until curl -fsS "http://127.0.0.1:$PORT/watcher/events" 2>/dev/null | grep -q '"enabled": true'; do
  i=$((i + 1))
  [ "$i" -gt 20 ] && { echo "FAIL: watcher did not answer"; docker logs "$APP"; exit 1; }
  sleep 1
done
events=$(curl -fsS "http://127.0.0.1:$PORT/watcher/events")
echo "$events" | grep -q '"last_error": null' || fail "watcher could not read the fake Dispatcharr: $events"
[ "$(code POST /watcher/events)" = 403 ] || fail "watcher accepts writes through nginx"
docker logs "$APP" 2>&1 | grep -q "watcher started" || fail "no watcher start-up line in the log"

# The health check runs inside the container; give it one try now.
if docker exec "$APP" sh -c '[ -x /usr/local/bin/swaparr-healthcheck ]'; then
  docker exec "$APP" /usr/local/bin/swaparr-healthcheck || fail "health check failed with a working Dispatcharr"
  docker stop "$UP" >/dev/null
  docker exec "$APP" /usr/local/bin/swaparr-healthcheck >/dev/null 2>&1 && fail "health check passed with Dispatcharr down"
fi

echo "PASS: image builds, nginx config valid, allowlist enforced, key stays server-side, watcher answers read-only"
