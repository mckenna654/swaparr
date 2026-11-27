FROM nginx:1.27-alpine

# python3 runs the optional watcher (WATCHER=true); gettext renders the nginx config.
RUN apk add --no-cache gettext python3

COPY nginx.conf.template /etc/nginx/conf.d/default.conf.template
COPY 40-generate-config.sh 50-start-watcher.sh /docker-entrypoint.d/
COPY watcher/swaparr_watcher.py /opt/swaparr/swaparr_watcher.py
COPY index.html app.js source-picker.js sample-capture.js style.css Swaparr.png manifest.json /usr/share/nginx/html/
COPY vendor/ /usr/share/nginx/html/vendor/

ARG NGINX_PORT=8080
ENV NGINX_PORT=${NGINX_PORT}

EXPOSE ${NGINX_PORT}

COPY healthcheck.sh /usr/local/bin/swaparr-healthcheck
RUN chmod +x /usr/local/bin/swaparr-healthcheck /docker-entrypoint.d/50-start-watcher.sh

# Healthy means Swaparr can do its job: the page loads and Dispatcharr answers
# through the proxy with the configured key.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD /usr/local/bin/swaparr-healthcheck
