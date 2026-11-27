// Replays captured Dispatcharr responses (tests/fixtures/*.json) through Swaparr's
// parsers, so the code is checked against real response shapes, not only hand-made mocks.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const dir = path.join(__dirname, "fixtures");
const files = fs.readdirSync(dir).filter(name => name.endsWith(".json"));

const context = vm.createContext({
  window: { addEventListener() {} },
  document: { createElement: () => ({ append() {}, setAttribute() {}, dataset: {} }) },
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "../source-picker.js"), "utf8"), context);
vm.runInContext(fs.readFileSync(path.join(__dirname, "../app.js"), "utf8") + "\nthis.state = State;", context);
const state = context.state;

const list = body => (Array.isArray(body) ? body : body?.results || []);

if (!files.length) {
  test("captured Dispatcharr samples", { skip: "no captures in tests/fixtures yet" }, () => {});
}

for (const name of files) {
  test(`captured sample ${name} parses cleanly`, () => {
    const sample = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    assert.equal(sample.format, "swaparr-sample/1");
    const { responses } = sample;

    const status = responses.status?.body;
    if (status) {
      assert.ok(Array.isArray(status.channels), "status has a channels list");
      for (const stream of status.channels) {
        for (const field of ["channel_id", "stream_id", "state"]) {
          assert.ok(field in stream, `status channel has ${field}`);
        }
        state.formatBitrate(stream.total_bytes, stream.uptime);
        state.formatState(stream.state);
      }
    }

    for (const channel of list(responses.channels?.body)) {
      for (const field of ["id", "uuid", "name"]) assert.ok(field in channel, `channel has ${field}`);
    }

    for (const [label, item] of Object.entries(responses)) {
      if (!label.startsWith("channel_streams_") || !item.body) continue;
      assert.ok(Array.isArray(item.body), `${label} is a list`);
      for (const stream of item.body) {
        assert.ok(Number.isSafeInteger(stream.id), "stream id is a whole number");
        assert.equal(typeof state.formatStreamQuality(stream.stream_stats), "string");
        state.formatAccountName(stream.m3u_account);
      }
    }
  });
}
