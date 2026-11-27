#!/usr/bin/env python3
"""Swaparr watcher: keeps an eye on Dispatcharr while nobody has Swaparr open.

Every few seconds it reads Dispatcharr's stream status, notes what changed (a channel
started or stopped, its source changed, its data stopped flowing) and keeps a short
history on disk. Swaparr's page shows that history under "What happened". With
NOTIFY_URL set, it also sends a phone alert (ntfy, Apprise, Home Assistant, any webhook)
for source changes and stalls.

Standard library only. Optional: off unless the container sets WATCHER=true.
Only reads from Dispatcharr; it never switches, stops or reorders anything.
"""

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STALL_READINGS = 3  # readings in a row with no new data before a stream counts as stalled
NOTIFY_QUIET_SECONDS = 300  # at most one alert per channel and kind in this window


def log(message):
    print(f"Swaparr watcher: {message}", flush=True)


def reading(stream):
    return {
        "stream_id": stream.get("stream_id"),
        "name": stream.get("channel_name") or "Unknown channel",
        "bytes": _number(stream.get("total_bytes")),
        "uptime": _number(stream.get("uptime")),
    }


def _number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def detect_events(previous, channels, now):
    """Compares one status reading with the last.

    previous: {channel_uuid: {"stream_id", "name", "bytes", "uptime", "empty", "stalled"}}
    channels: the "channels" list from /proxy/ts/status.
    Returns (events, current) where current replaces previous for the next call.
    """
    events = []
    current = {}
    for stream in channels or []:
        uuid = stream.get("channel_id")
        if not isinstance(uuid, str) or not uuid:
            continue
        now_reading = reading(stream)
        before = previous.get(uuid)
        entry = dict(now_reading, empty=0, stalled=False)
        base = {"at": now, "channel_uuid": uuid, "channel_name": now_reading["name"]}
        if before is None:
            events.append(dict(base, type="started", to_id=now_reading["stream_id"]))
        elif before["stream_id"] != now_reading["stream_id"]:
            events.append(dict(base, type="source_changed",
                               from_id=before["stream_id"], to_id=now_reading["stream_id"]))
        else:
            counter_reset = now_reading["bytes"] < before["bytes"] or now_reading["uptime"] < before["uptime"]
            no_new_data = not counter_reset and now_reading["bytes"] == before["bytes"]
            entry["empty"] = before["empty"] + 1 if no_new_data else 0
            entry["stalled"] = before["stalled"]
            if entry["empty"] >= STALL_READINGS and not before["stalled"]:
                entry["stalled"] = True
                events.append(dict(base, type="stalled", to_id=now_reading["stream_id"]))
            elif entry["empty"] == 0 and before["stalled"]:
                entry["stalled"] = False
                events.append(dict(base, type="recovered", to_id=now_reading["stream_id"]))
        current[uuid] = entry
    for uuid, before in previous.items():
        if uuid not in current:
            events.append({"at": now, "channel_uuid": uuid, "channel_name": before["name"], "type": "stopped"})
    return events, current


def describe(event, source_name):
    """Plain-English line for an event. source_name(channel_uuid, stream_id) -> str."""
    name = event["channel_name"]
    kind = event["type"]
    if kind == "started":
        return f"{name} started on {source_name(event['channel_uuid'], event.get('to_id'))}."
    if kind == "stopped":
        return f"{name} stopped."
    if kind == "source_changed":
        return (f"{name} changed source from {source_name(event['channel_uuid'], event.get('from_id'))} "
                f"to {source_name(event['channel_uuid'], event.get('to_id'))}.")
    if kind == "stalled":
        return f"{name} stopped receiving data on {source_name(event['channel_uuid'], event.get('to_id'))}."
    if kind == "recovered":
        return f"{name} is receiving data again."
    return f"{name}: {kind}."


class EventLog:
    """Recent events kept in memory and appended to a JSON-lines file."""

    def __init__(self, path, keep=2000):
        self.path = path
        self.keep = keep
        self.lock = threading.Lock()
        self.events = []
        if path and os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as handle:
                    self.events = [json.loads(line) for line in handle if line.strip()][-keep:]
            except (OSError, ValueError) as error:
                log(f"could not read {path} ({error}); starting a fresh history")
                self.events = []

    def add(self, events):
        if not events:
            return
        with self.lock:
            self.events.extend(events)
            trimmed = len(self.events) > self.keep
            self.events = self.events[-self.keep:]
            if not self.path:
                return
            try:
                if trimmed:
                    tmp = self.path + ".tmp"
                    with open(tmp, "w", encoding="utf-8") as handle:
                        handle.writelines(json.dumps(item) + "\n" for item in self.events)
                    os.replace(tmp, self.path)
                else:
                    with open(self.path, "a", encoding="utf-8") as handle:
                        handle.writelines(json.dumps(item) + "\n" for item in events)
            except OSError as error:
                log(f"could not write history to {self.path}: {error}")

    def recent(self, limit=50):
        with self.lock:
            return list(reversed(self.events[-limit:]))


class Notifier:
    """Sends alerts to NOTIFY_URL. "text" suits ntfy; "json" suits Apprise and webhooks."""

    KINDS = {"source_changed": ("Source changed", "warning"), "stalled": ("Stream stalled", "rotating_light")}

    def __init__(self, url, fmt="text", opener=urllib.request.urlopen):
        self.url = url
        self.fmt = fmt if fmt in ("text", "json") else "text"
        self.opener = opener
        self.last_sent = {}

    def wants(self, event):
        if not self.url or event["type"] not in self.KINDS:
            return False
        key = (event["channel_uuid"], event["type"])
        if event["at"] - self.last_sent.get(key, 0) < NOTIFY_QUIET_SECONDS:
            return False
        self.last_sent[key] = event["at"]
        return True

    def request(self, event):
        title, tag = self.KINDS[event["type"]]
        title = f"{title}: {event['channel_name']}"
        if self.fmt == "json":
            body = json.dumps({"title": title, "body": event["text"], "type": "warning", "event": event}).encode()
            headers = {"Content-Type": "application/json"}
        else:
            body = event["text"].encode()
            # Header values must be latin-1; keep only what survives that.
            headers = {"Title": title.encode("latin-1", "replace").decode("latin-1"), "Tags": tag,
                       "Content-Type": "text/plain; charset=utf-8"}
        return urllib.request.Request(self.url, data=body, headers=headers, method="POST")

    def send(self, event):
        if not self.wants(event):
            return
        try:
            with self.opener(self.request(event), timeout=10) as response:
                response.read()
        except (urllib.error.URLError, OSError, ValueError) as error:
            log(f"alert not sent: {error}")


class Dispatcharr:
    """Read-only Dispatcharr client with a cache of source names."""

    def __init__(self, base_url, api_key, opener=urllib.request.urlopen):
        self.base = base_url.rstrip("/")
        self.headers = {"Authorization": f"ApiKey {api_key}", "Accept": "application/json"}
        self.opener = opener
        self.channel_ids = {}  # channel uuid -> database id
        self.channel_ids_at = 0
        self.source_names = {}  # (channel uuid, stream id) -> "Name (Provider)"

    def get(self, path):
        request = urllib.request.Request(self.base + path, headers=self.headers)
        with self.opener(request, timeout=15) as response:
            text = response.read().decode("utf-8")
        return json.loads(text) if text.strip() else None

    def status(self):
        data = self.get("/proxy/ts/status") or {}
        return data.get("channels") or []

    def _refresh_channel_ids(self):
        ids = {}
        page = 1
        while page <= 50:
            data = self.get(f"/api/channels/channels/?page={page}&page_size=200")
            rows = data if isinstance(data, list) else (data or {}).get("results") or []
            for row in rows:
                if isinstance(row, dict) and row.get("uuid") and isinstance(row.get("id"), int):
                    ids[row["uuid"]] = row["id"]
            if isinstance(data, list) or not (data or {}).get("next"):
                break
            page += 1
            time.sleep(0.05)
        self.channel_ids = ids
        self.channel_ids_at = time.time()

    def source_name(self, channel_uuid, stream_id):
        if stream_id is None:
            return "an unknown source"
        key = (channel_uuid, stream_id)
        if key in self.source_names:
            return self.source_names[key]
        try:
            if channel_uuid not in self.channel_ids or time.time() - self.channel_ids_at > 3600:
                self._refresh_channel_ids()
            channel_id = self.channel_ids.get(channel_uuid)
            if channel_id is not None:
                for source in self.get(f"/api/channels/channels/{channel_id}/streams/") or []:
                    account = source.get("m3u_account")
                    provider = account.get("name") if isinstance(account, dict) else None
                    label = source.get("name") or f"Stream #{source.get('id')}"
                    self.source_names[(channel_uuid, source.get("id"))] = f"{label} ({provider})" if provider else label
        except (urllib.error.URLError, OSError, ValueError) as error:
            log(f"could not look up source names: {error}")
        return self.source_names.get(key, f"source #{stream_id}")


def make_handler(event_log, state):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path in ("/events", "/events/"):
                query = urllib.parse.parse_qs(parsed.query)
                try:
                    limit = max(1, min(200, int(query.get("limit", ["50"])[0])))
                except ValueError:
                    limit = 50
                self.reply(200, {"enabled": True, "last_reading_at": state.get("last_reading_at"),
                                 "last_error": state.get("last_error"), "events": event_log.recent(limit)})
            elif parsed.path in ("/health", "/health/"):
                self.reply(200, {"ok": True, "last_reading_at": state.get("last_reading_at")})
            else:
                self.reply(404, {"error": "not found"})

        def reply(self, status, payload):
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format, *args):  # noqa: A002 - matches the base signature
            pass

    return Handler


def run():
    url = os.environ.get("DISPATCHARR_URL", "").strip()
    if not url:
        log("DISPATCHARR_URL is not set; not starting")
        return 1
    interval = max(2.0, _number(os.environ.get("WATCH_INTERVAL", "5")) or 5.0)
    data_dir = os.environ.get("WATCHER_DATA", "/data")
    path = None
    if os.path.isdir(data_dir) and os.access(data_dir, os.W_OK):
        path = os.path.join(data_dir, "events.jsonl")
    else:
        log(f"{data_dir} is not a writable folder; history is kept only until the container restarts")

    event_log = EventLog(path)
    client = Dispatcharr(url, os.environ.get("DISPATCHARR_API_KEY", ""))
    notifier = Notifier(os.environ.get("NOTIFY_URL", "").strip(), os.environ.get("NOTIFY_FORMAT", "text").strip().lower())
    state: dict = {"last_reading_at": None, "last_error": None}

    port = int(_number(os.environ.get("WATCHER_PORT", "8099")) or 8099)
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(event_log, state))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    log(f"watching every {interval:g} s; alerts {'on' if notifier.url else 'off'}")

    previous = None
    while True:
        try:
            channels = client.status()
            now = time.time()
            if previous is None:
                _, previous = detect_events({}, channels, now)  # first reading is the baseline
            else:
                events, previous = detect_events(previous, channels, now)
                for event in events:
                    event["text"] = describe(event, client.source_name)
                    notifier.send(event)
                event_log.add(events)
            state["last_reading_at"] = now
            state["last_error"] = None
        except (urllib.error.URLError, OSError, ValueError) as error:
            if state["last_error"] != str(error):
                log(f"could not read Dispatcharr status: {error}")
            state["last_error"] = str(error)
        time.sleep(interval)


if __name__ == "__main__":
    sys.exit(run())
