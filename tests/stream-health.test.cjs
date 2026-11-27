// The decisions behind "Bitrate now", "Stalled", "changed outside this page" and the
// switch check. They run on Dispatcharr's 5-second status readings.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const context = vm.createContext({ window: { addEventListener() {} }, document: { createElement: () => ({}) } });
vm.runInContext(fs.readFileSync(path.join(__dirname, "../app.js"), "utf8") + "\nthis.health = StreamHealth; this.pins = Pins;", context);
const H = context.health;
const reading = (stream_id, total_bytes, uptime, state = "active", at = uptime * 1000) => ({ stream_id, total_bytes, uptime, state, at });

test("live rate comes from the change between two readings", () => {
  const rate = H.liveRate(reading(1, 1_000_000, 100), reading(1, 3_500_000, 105));
  assert.equal(rate.kind, "rate");
  assert.equal(rate.kbps, 4000); // 2.5 MB in 5 s = 4 Mbps
});

test("a counter that goes backwards or a new source restarts measuring, never a stall", () => {
  assert.equal(H.liveRate(reading(1, 5_000_000, 100), reading(1, 1_000, 2)).kind, "measuring");
  assert.equal(H.liveRate(reading(1, 5_000_000, 100), reading(2, 5_100_000, 105)).kind, "measuring");
  assert.equal(H.liveRate(undefined, reading(1, 5, 1)).kind, "measuring");
});

test("stalled only after several readings in a row with no new data", () => {
  let entry;
  entry = H.next(entry, reading(1, 1_000_000, 100));
  entry = H.next(entry, reading(1, 2_000_000, 105));
  assert.equal(entry.display.kind, "rate");
  for (let i = 1; i < H.STALL_READINGS; i++) {
    entry = H.next(entry, reading(1, 2_000_000, 105 + i * 5));
    assert.equal(entry.display.kind, "rate", "one or two empty readings keep the last rate");
  }
  entry = H.next(entry, reading(1, 2_000_000, 125));
  assert.equal(entry.display.kind, "stalled");
  entry = H.next(entry, reading(1, 2_500_000, 130));
  assert.equal(entry.display.kind, "rate", "data flowing again clears the stall");
});

test("a source change is ours only when this page asked for that source recently", () => {
  const now = 1_000_000;
  assert.equal(H.classifyChange(1, 1, undefined, now), null);
  assert.equal(H.classifyChange(undefined, 3, undefined, now), null);
  assert.equal(H.classifyChange(1, 3, { to: 3, at: now - 5000 }, now), "ours");
  assert.equal(H.classifyChange(1, 3, { to: "3", at: now - 5000 }, now), "ours");
  assert.equal(H.classifyChange(1, 4, { to: 3, at: now - 5000 }, now), "outside");
  assert.equal(H.classifyChange(1, 3, { to: 3, at: now - 300000 }, now), "outside");
  assert.equal(H.classifyChange(1, 2, undefined, now), "outside");
});

test("a switch is live once the new source shows data flowing", () => {
  const samples = [reading(1, 900, 10), reading(3, 0, 1, "connecting"), reading(3, 50_000, 3)];
  assert.equal(H.evaluateSwitch(samples.slice(0, 2), 1, 3, 5000).outcome, "pending");
  assert.equal(H.evaluateSwitch(samples, 1, 3, 7500).outcome, "live");
});

test("a source still buffering or not moving data is not live", () => {
  const buffering = [reading(3, 0, 1, "buffering"), reading(3, 50_000, 3, "buffering")];
  assert.equal(H.evaluateSwitch(buffering, 1, 3, 5000).outcome, "pending");
  const frozen = [reading(3, 1000, 1), reading(3, 1000, 3)];
  assert.equal(H.evaluateSwitch(frozen, 1, 3, 5000).outcome, "pending");
  assert.equal(H.evaluateSwitch(frozen, 1, 3, 25000).outcome, "stuck");
});

test("a switch reports moved, stopped or stuck honestly", () => {
  assert.deepEqual({ ...H.evaluateSwitch([reading(3, 10, 1), reading(5, 20, 2)], 1, 3, 5000) }, { outcome: "moved", streamId: 5 });
  assert.equal(H.evaluateSwitch([reading(3, 10, 1), null], 1, 3, 5000).outcome, "stopped");
  assert.equal(H.evaluateSwitch([reading(1, 10, 1)], 1, 3, 5000).outcome, "pending", "old source can linger briefly");
  assert.equal(H.evaluateSwitch([reading(1, 10, 1)], 1, 3, 26000).outcome, "stuck");
  assert.equal(H.evaluateSwitch([], 1, 3, 1000).outcome, "pending");
});

test("pins restore 3 am tonight, or tomorrow once 3 am has passed", () => {
  const evening = new Date(2026, 10, 27, 20, 30);
  const tonight = new Date(context.pins.nextRevertTime(evening));
  assert.equal(tonight.getDate(), 28);
  assert.equal(tonight.getHours(), 3);
  const early = new Date(2026, 10, 28, 1, 0);
  assert.equal(new Date(context.pins.nextRevertTime(early)).getDate(), 28);
  const after = new Date(2026, 10, 28, 3, 0);
  assert.equal(new Date(context.pins.nextRevertTime(after)).getDate(), 29);
});

test("a pin puts the chosen source first and keeps the rest in order", () => {
  assert.deepEqual([...context.pins.pinnedOrder([1, 2, 3, 4], 3)], [3, 1, 2, 4]);
  assert.deepEqual([...context.pins.pinnedOrder([1, 2, 3], 1)], [1, 2, 3]);
});

test("restoring only happens when nobody changed the order since pinning", () => {
  const pin = { original: [1, 2, 3], pinned: [3, 1, 2] };
  assert.equal(context.pins.revertPlan(pin, [3, 1, 2]), "restore");
  assert.equal(context.pins.revertPlan(pin, [1, 3, 2]), "leave", "reordered by hand");
  assert.equal(context.pins.revertPlan(pin, [3, 1, 2, 4]), "leave", "a source was added");
  assert.equal(context.pins.revertPlan({ original: [1, 2, 3], pinned: [3, 1, 2, 9] }, [3, 1, 2, 9]), "leave", "never drops a source");
});
