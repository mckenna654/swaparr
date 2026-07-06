#!/bin/sh

# Generate nginx config with substituted port
envsubst '$NGINX_PORT' < /etc/nginx/conf.d/default.conf.template > /etc/nginx/conf.d/default.conf

# Generate application config
envsubst '$DISPATCHARR_URL $DISPATCHARR_API_KEY' <<'JSON_EOF' > /usr/share/nginx/html/config.json
{
  "url": "${DISPATCHARR_URL:-}",
  "apiKey": "${DISPATCHARR_API_KEY:-}"
}
JSON_EOF
