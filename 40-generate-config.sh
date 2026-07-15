#!/bin/sh

# Clean up trailing slashes from DISPATCHARR_URL for proxy_pass
export DISPATCHARR_URL_CLEAN=$(echo "$DISPATCHARR_URL" | sed 's:/*$::')

# Generate nginx config with substituted variables
envsubst '$NGINX_PORT $DISPATCHARR_URL_CLEAN $DISPATCHARR_API_KEY' < /etc/nginx/conf.d/default.conf.template > /etc/nginx/conf.d/default.conf

# Generate application config (client now points to the proxy, API key is hidden)
cat <<JSON_EOF > /usr/share/nginx/html/config.json
{
  "url": "/dispatcharr-api",
  "apiKey": ""
}
JSON_EOF
