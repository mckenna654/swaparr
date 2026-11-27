"""Watcher tests: event detection, history file, alerts and the read-only HTTP view."""
import http.client
import http.server
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "watcher"))
import swaparr_watcher as w


def status(*streams):
    return [dict(channel_id=uuid, channel_name=name, stream_id=sid, total_bytes=b, uptime=u)
            for uuid, name, sid, b, u in streams]


class DetectEventsTests(unittest.TestCase):
    def test_start_change_and_stop(self):
        events, state = w.detect_events({}, status(("a", "Fox Footy", 1, 100, 10)), 1000)
        self.assertEqual([e["type"] for e in events], ["started"])
        events, state = w.detect_events(state, status(("a", "Fox Footy", 2, 50, 1)), 1005)
        self.assertEqual([(e["type"], e["from_id"], e["to_id"]) for e in events], [("source_changed", 1, 2)])
        events, state = w.detect_events(state, [], 1010)
        self.assertEqual([(e["type"], e["channel_name"]) for e in events], [("stopped", "Fox Footy")])
        self.assertEqual(state, {})

    def test_stall_needs_several_empty_readings_and_recovers(self):
        _, state = w.detect_events({}, status(("a", "Ch", 1, 100, 10)), 0)
        kinds = []
        for i in range(1, w.STALL_READINGS + 2):
            events, state = w.detect_events(state, status(("a", "Ch", 1, 100, 10 + i * 5)), i)
            kinds += [e["type"] for e in events]
        self.assertEqual(kinds, ["stalled"], "one stall event, only after the threshold")
        events, state = w.detect_events(state, status(("a", "Ch", 1, 900, 40)), 9)
        self.assertEqual([e["type"] for e in events], ["recovered"])

    def test_counter_reset_is_not_a_stall(self):
        _, state = w.detect_events({}, status(("a", "Ch", 1, 5000, 100)), 0)
        for i in range(1, 6):
            events, state = w.detect_events(state, status(("a", "Ch", 1, 10, 1)), i)
            if i == 1:
                self.assertEqual(events, [])
        self.assertEqual(state["a"]["empty"], 4, "after a reset, a counter that then sits still does count")

    def test_ignores_rows_without_a_channel_id(self):
        events, state = w.detect_events({}, [{"stream_id": 1}, {"channel_id": ""}], 0)
        self.assertEqual((events, state), ([], {}))

    def test_describe_is_plain_english(self):
        names = lambda uuid, sid: {1: "AU Fox (Infinity)", 2: "Fox HD (Promax)"}.get(sid, f"source #{sid}")
        event = {"type": "source_changed", "channel_name": "Fox Footy", "channel_uuid": "a", "from_id": 1, "to_id": 2}
        self.assertEqual(w.describe(event, names), "Fox Footy changed source from AU Fox (Infinity) to Fox HD (Promax).")


class EventLogTests(unittest.TestCase):
    def test_appends_trims_and_reloads(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "events.jsonl")
            log = w.EventLog(path, keep=3)
            log.add([{"n": 1}, {"n": 2}])
            log.add([{"n": 3}, {"n": 4}])
            self.assertEqual([e["n"] for e in log.recent()], [4, 3, 2])
            self.assertEqual([e["n"] for e in w.EventLog(path, keep=3).recent()], [4, 3, 2])

    def test_unreadable_history_starts_fresh(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, "events.jsonl")
            Path(path).write_text("not json\n")
            self.assertEqual(w.EventLog(path).recent(), [])


class NotifierTests(unittest.TestCase):
    def event(self, at=1000, kind="source_changed"):
        return {"at": at, "type": kind, "channel_uuid": "a", "channel_name": "Fox Footy",
                "text": "Fox Footy changed source from A to B."}

    def test_text_format_for_ntfy_and_quiet_window(self):
        sent = []

        def opener(request, timeout):
            sent.append(request)
            return io.BytesIO(b"ok")

        notifier = w.Notifier("https://ntfy.example/swaparr", "text", opener)
        notifier.send(self.event(1000))
        notifier.send(self.event(1100))  # inside the quiet window
        notifier.send(self.event(1000, "started"))  # not an alert kind
        notifier.send(self.event(1400))
        self.assertEqual(len(sent), 2)
        self.assertEqual(sent[0].data, b"Fox Footy changed source from A to B.")
        self.assertEqual(sent[0].get_header("Title"), "Source changed: Fox Footy")

    def test_json_format(self):
        sent = []
        notifier = w.Notifier("https://apprise.example/notify", "json",
                              lambda request, timeout: sent.append(request) or io.BytesIO(b""))
        notifier.send(self.event(kind="stalled"))
        payload = json.loads(sent[0].data)
        self.assertEqual(payload["title"], "Stream stalled: Fox Footy")
        self.assertEqual(payload["body"], "Fox Footy changed source from A to B.")

    def test_no_url_means_no_alerts(self):
        self.assertFalse(w.Notifier("").wants(self.event()))


class HttpViewTests(unittest.TestCase):
    def test_events_endpoint_is_read_only(self):
        log = w.EventLog(None)
        log.add([{"type": "started", "text": "one"}, {"type": "stopped", "text": "two"}])
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), w.make_handler(log, {"last_reading_at": 5}))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            connection.request("GET", "/events?limit=1")
            body = json.loads(connection.getresponse().read())
            self.assertEqual(body["enabled"], True)
            self.assertEqual([e["text"] for e in body["events"]], ["two"])
            connection.request("POST", "/events", b"{}")
            self.assertEqual(connection.getresponse().status, 501)
            connection.close()
        finally:
            server.shutdown()
            server.server_close()


class DispatcharrClientTests(unittest.TestCase):
    def test_source_names_are_looked_up_once(self):
        calls = []
        responses = {
            "/api/channels/channels/?page=1&page_size=200": {"results": [{"id": 10, "uuid": "a"}], "next": None},
            "/api/channels/channels/10/streams/": [{"id": 2, "name": "Fox HD", "m3u_account": {"name": "Promax"}}],
        }

        def opener(request, timeout):
            path = request.full_url.replace("http://d", "")
            calls.append(path)
            self.assertEqual(request.get_header("Authorization"), "ApiKey k")
            return io.BytesIO(json.dumps(responses[path]).encode())

        client = w.Dispatcharr("http://d/", "k", opener)
        self.assertEqual(client.source_name("a", 2), "Fox HD (Promax)")
        self.assertEqual(client.source_name("a", 2), "Fox HD (Promax)")
        self.assertEqual(client.source_name("a", 9), "source #9")
        self.assertEqual(calls.count("/api/channels/channels/10/streams/"), 2, "unknown id triggers one more lookup")


if __name__ == "__main__":
    unittest.main()
