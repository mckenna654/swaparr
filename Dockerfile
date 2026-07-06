FROM nginx:1.27-alpine

RUN apk add --no-cache gettext

COPY nginx.conf.template /etc/nginx/conf.d/default.conf.template
COPY 40-generate-config.sh /docker-entrypoint.d/
COPY index.html app.js style.css Swaparr.png /usr/share/nginx/html/

ARG NGINX_PORT=8080
ENV NGINX_PORT=${NGINX_PORT}

EXPOSE ${NGINX_PORT}

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${NGINX_PORT}/ >/dev/null || exit 1
