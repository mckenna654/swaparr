#!/bin/sh

cat <<JSON_EOF > /usr/share/nginx/html/config.json
{
  "url": "${DISPATCHARR_URL:-}",
  "apiKey": "${DISPATCHARR_API_KEY:-}"
}
JSON_EOF
