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

# Generate application config based on DISABLE_PROXY setting
if [ "${DISABLE_PROXY}" = "true" ]; then
  cat <<JSON_EOF > /usr/share/nginx/html/config.json
{
  "url": "${DISPATCHARR_URL:-}",
  "apiKey": "${DISPATCHARR_API_KEY:-}"
}
JSON_EOF
else
  cat <<JSON_EOF > /usr/share/nginx/html/config.json
{
  "url": "/dispatcharr-api",
  "apiKey": ""
}
JSON_EOF
fi
