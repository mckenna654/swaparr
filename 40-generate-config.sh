#!/bin/sh

# Refuse to start without the one setting nginx cannot do without. An empty
# DISPATCHARR_URL would render "proxy_pass /;" and nginx would exit with an
# error that never names the missing variable.
if [ -z "${DISPATCHARR_URL}" ]; then
  echo "Swaparr: DISPATCHARR_URL is not set. Start the container with -e DISPATCHARR_URL=http://<dispatcharr-host>:9191" >&2
  exit 1
fi
if [ -z "${DISPATCHARR_API_KEY}" ]; then
  echo "Swaparr: DISPATCHARR_API_KEY is empty. Dispatcharr will reject proxied requests until it is set." >&2
fi

# Clean up trailing slashes from DISPATCHARR_URL for proxy_pass
export DISPATCHARR_URL_CLEAN=$(echo "$DISPATCHARR_URL" | sed 's:/*$::')

# Generate nginx config with substituted variables
envsubst '$NGINX_PORT $DISPATCHARR_URL_CLEAN $DISPATCHARR_API_KEY' < /etc/nginx/conf.d/default.conf.template > /etc/nginx/conf.d/default.conf

# DISABLE_PROXY used to hand the API key to the browser. It was removed because the
# key must only ever be used by this container. Old containers that still set it keep
# working in proxy mode instead of failing to start.
case "$(echo "${DISABLE_PROXY:-}" | tr '[:upper:]' '[:lower:]')" in
  true|1|yes)
    echo "Swaparr: DISABLE_PROXY is no longer supported and is ignored. Swaparr always uses its own proxy now, so the API key never reaches the browser. Remove DISABLE_PROXY from the container settings." >&2
    ;;
esac

case "$(echo "${WATCHER:-false}" | tr '[:upper:]' '[:lower:]')" in
  true|1|yes) WATCHER_ON=true ;;
  *) WATCHER_ON=false ;;
esac

cat <<JSON_EOF > /usr/share/nginx/html/config.json
{
  "url": "/dispatcharr-api",
  "apiKey": "",
  "watcher": ${WATCHER_ON}
}
JSON_EOF
