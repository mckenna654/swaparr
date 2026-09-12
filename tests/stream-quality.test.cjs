const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const context = vm.createContext({
  window: { addEventListener() {} },
  document: { createElement: () => ({}) },
});
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "../app.js"), "utf8") + "\nthis.state = State;",
  context,
);
const state = context.state;

test("labels include saved quality for object and JSON probe results", () => {
  const stats = { resolution: "1920x1080", source_fps: "59.94", video_codec: "avc1" };
  for (const stream_stats of [stats, JSON.stringify(stats)]) {
    assert.equal(state.formatStreamLabel({
      id: 1, name: "Sports", m3u_account: { name: "Primary" }, stream_stats,
    }), "Sports [Primary] — Last probed: 1080p · 59.94 fps · H.264");
  }
});

test("missing, malformed, and unusable stats leave an explicit unknown label", () => {
  for (const stream_stats of [undefined, null, "", "invalid JSON", "null", "[]", {},
    { resolution: "unknown", source_fps: "N/A", video_codec: null }]) {
    assert.equal(state.formatStreamLabel({ id: 7, stream_stats }),
      "Stream #7 [Unknown Source] — Quality unknown");
  }
});

test("partial stats, resolution forms, and codec aliases remain useful", () => {
  assert.equal(state.formatStreamQuality({ resolution: "3840 × 2160", video_codec: "h265" }),
    "2160p · HEVC");
  assert.equal(state.formatStreamQuality({ resolution: "1080i", source_fps: 25 }),
    "1080i · 25 fps");
  assert.equal(state.formatStreamQuality({ resolution: 720 }), "720p");
  assert.equal(state.formatStreamQuality({ source_fps: 0, video_codec: " av1 " }), "AV1");
});

test("options preserve IDs and selection and insert metadata as plain text", () => {
  const options = [];
  state.populateStreamOptions({ appendChild: (option) => options.push(option) }, [
    { id: 1, name: "Sports <HD> & More", stream_stats: { resolution: "1280x720" } },
    { id: 2, name: "Backup", stream_stats: { resolution: "1920x1080" } },
  ], "2");
  assert.equal(options[0].value, "1");
  assert.equal(options[0].selected, false);
  assert.equal(options[0].textContent,
    "Sports <HD> & More [Unknown Source] — Last probed: 720p");
  assert.equal(options[0].innerHTML, undefined);
  assert.equal(options[1].selected, true);
  assert.match(options[1].textContent, /1080p/);
});
