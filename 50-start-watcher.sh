#!/bin/sh
# Starts the optional watcher (history and phone alerts) next to nginx when WATCHER=true.
# It restarts itself if it ever exits, and logs to the container log.
case "$(echo "${WATCHER:-false}" | tr '[:upper:]' '[:lower:]')" in
  true|1|yes)
    (
      while true; do
        python3 /opt/swaparr/swaparr_watcher.py
        echo "Swaparr watcher: stopped, restarting in 5 s"
        sleep 5
      done
    ) >/proc/1/fd/1 2>/proc/1/fd/2 &
    if [ -n "${NOTIFY_URL:-}" ]; then ALERTS=on; else ALERTS=off; fi
    echo "Swaparr: watcher started (history in ${WATCHER_DATA:-/data}, phone alerts ${ALERTS})"
    ;;
esac
