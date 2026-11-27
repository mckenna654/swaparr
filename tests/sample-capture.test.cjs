// "Capture sample data" must never let a name, address, URL or key out of the browser.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const context = vm.createContext({ setTimeout, Blob: class {}, URL: {}, document: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, "../sample-capture.js"), "utf8") + "\nthis.capture = SampleCapture;", context);
const capture = context.capture;

// Every private value a Dispatcharr response could plausibly carry.
const SECRETS = [
  "http://user:pa55word@provider.example:8080/live/user/pa55word/123.ts",
  "jake@example.com",
  "192.168.1.50",
  "Fox Sports 502 HD",
  "Infinity IPTV",
  "Mum's iPad",
  "secret-api-key-123",
  "VLC/3.0.20 LibVLC/3.0.20",
  "Kayo Sports",
  "jakesmith",
  "kayo-sports-hd",
  "Fox Footy",
];

const hostile = {
  count: 2,
  results: [{
    id: 10,
    uuid: "0b6f9b5e-1c2d-4e5f-8a9b-123456789abc",
    name: "Fox Sports 502 HD",
    m3u_account: { id: 3, name: "Infinity IPTV", server_url: SECRETS[0], username: "user", password: "pa55word" },
    url: SECRETS[0],
    stream_stats: JSON.stringify({ resolution: "1920x1080", source_fps: 50, video_codec: "h264", audio_codec: "ac3", ffmpeg_output: SECRETS[0] }),
    custom_properties: { "tvg-name": "Kayo Sports", catchup: "default", "catchup-type": "flussonic" },
    clients: [{ ip_address: "192.168.1.50", user_agent: "VLC/3.0.20 LibVLC/3.0.20", user_id: "9", connected_at: 1700000000 }],
    // A sneaky value under a "safe" key must still be hidden.
    state: "jake@example.com",
    resolution: "http://evil.example/",
    is_active: true,
    tvg_id: null,
  }],
  users: [{ id: 1, username: "jake", email: "jake@example.com", api_key: "secret-api-key-123" }],
  by_name: { "Mum's iPad": 1, "192.168.1.50": 2, jakesmith: 3, "kayo-sports-hd": 4 },
  // Values under "safe" keys must still match that key's strict pattern.
  probe: { video_codec: "Fox Footy", audio_channels: "jakesmith", source_fps: "Kayo Sports" },
};

test("redaction hides every private string, including inside JSON text and object keys", () => {
  const text = JSON.stringify(capture.redact(hostile));
  for (const secret of SECRETS) {
    assert.ok(!text.includes(secret), `leaked: ${secret}`);
  }
  for (const fragment of ["pa55word", "provider.example", "example.com", "Fox Sports", "Infinity", "VLC", "jake", "kayo"]) {
    assert.ok(!text.includes(fragment), `leaked fragment: ${fragment}`);
  }
});

test("redaction keeps shape, numbers, flags and short technical values", () => {
  const out = capture.redact(hostile);
  const row = out.results[0];
  assert.equal(out.count, 2);
  assert.equal(row.id, 10);
  assert.equal(row.is_active, true);
  assert.equal(row.tvg_id, null);
  assert.deepEqual(Object.keys(row), Object.keys(hostile.results[0]));
  const stats = JSON.parse(row.stream_stats);
  assert.equal(stats.resolution, "1920x1080");
  assert.equal(stats.source_fps, 50);
  assert.equal(stats.video_codec, "h264");
  assert.equal(row.custom_properties["catchup-type"], "flussonic");
  assert.match(row.custom_properties["tvg-name"], /^text-\d+$/);
  assert.equal(row.clients[0].connected_at, 1700000000);
});

test("the same text gets the same stand-in, so links between responses survive", () => {
  const aliases = new Map();
  const status = capture.redact({ channels: [{ channel_id: "0b6f9b5e-1c2d-4e5f-8a9b-123456789abc" }] }, aliases);
  const channels = capture.redact(hostile, aliases);
  assert.equal(status.channels[0].channel_id, channels.results[0].uuid);
});

test("collect makes only read-only calls Swaparr already uses, and records failures", async () => {
  const calls = [];
  const api = async (p) => {
    calls.push(p);
    if (p === "/api/accounts/users/?page=1&page_size=5") throw Object.assign(new Error("HTTP 403"), { status: 403 });
    if (p === "/proxy/ts/status") return { channels: [{ channel_id: "abc-1", stream_id: 2 }] };
    if (p.startsWith("/api/channels/channels/?")) return { count: 1, results: [{ id: 10 }] };
    return [];
  };
  const result = await capture.run(api);
  assert.deepEqual(calls, [
    "/api/accounts/users/?page=1&page_size=5",
    "/api/m3u/accounts/",
    "/api/channels/groups/?page=1&page_size=10",
    "/api/channels/channels/?page=1&page_size=10",
    "/proxy/ts/status",
    "/proxy/ts/status/abc-1",
    "/api/channels/channels/10/streams/",
  ]);
  assert.equal(result.file.responses.users.error, 403);
  assert.equal(result.file.responses.status.endpoint, "GET /proxy/ts/status");
  assert.equal(result.summary.answered, 6);
  assert.equal(result.summary.total, 7);
});
