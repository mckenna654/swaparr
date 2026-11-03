// Channel, group, stream, provider and client strings come from third-party playlists
// and players. These tests prove the renderers treat them as text, never as markup.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const HOSTILE = '<img src=x onerror="alert(1)">';

// A tiny element model: enough for createElement, className, textContent, append,
// replaceChildren, ids and attributes. Setting innerHTML is an error on purpose.
function createElement(tag) {
  return {
    tagName: tag.toUpperCase(),
    className: "",
    textContent: "",
    id: "",
    title: "",
    children: [],
    attributes: {},
    dataset: {},
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    setAttribute(name, value) { this.attributes[name] = value; },
    set innerHTML(_) { throw new Error(`innerHTML set on <${tag}>`); },
  };
}

const context = vm.createContext({
  window: { addEventListener() {} },
  document: { createElement },
});
for (const file of ["../source-picker.js", "../app.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), context);
}
vm.runInContext("this.state = State;", context);
const state = context.state;

function walk(node, visit) {
  visit(node);
  node.children.forEach((child) => walk(child, visit));
}
function texts(node) {
  const out = [];
  walk(node, (n) => { if (n.textContent) out.push(n.textContent); });
  return out;
}
function tags(node) {
  const out = [];
  walk(node, (n) => out.push(n.tagName));
  return out;
}

test("channel rows keep hostile names, numbers, groups and states as text", () => {
  const row = state.buildChannelRow(
    { id: 7, name: HOSTILE, channel_number: HOSTILE },
    HOSTILE,
    { state: HOSTILE },
  );
  assert.ok(!tags(row).includes("IMG"), "no element was created from the string");
  assert.deepEqual(tags(row), ["TR", "TD", "SPAN", "TD", "SPAN", "TD", "TD", "SPAN", "TD", "DIV"]);
  const [number, name, group, source, actions] = row.children;
  assert.equal(number.children[0].textContent, HOSTILE);
  assert.equal(name.textContent, HOSTILE);
  assert.equal(name.children[0].className, "stream-status-badge status-live");
  assert.equal(name.children[0].textContent, HOSTILE);
  assert.equal(group.textContent, HOSTILE);
  assert.equal(source.id, "source-cell-7");
  assert.equal(actions.id, "actions-cell-7");
});

test("source cells and client rows keep provider and player strings as text", () => {
  const [primary, secondary] = state.buildSourceCell({ id: 3, name: HOSTILE, m3u_account: { name: HOSTILE } });
  assert.equal(primary.textContent, HOSTILE);
  assert.equal(secondary.textContent, HOSTILE);

  state.usersMap = { 9: HOSTILE };
  const row = state.buildClientRow({
    user_id: "9", ip_address: HOSTILE, user_agent: HOSTILE, current_rate_KBps: "not a number", connected_at: 0,
  });
  assert.ok(!tags(row).includes("IMG"));
  assert.equal(texts(row).filter((t) => t === HOSTILE).length, 3, "user, IP and agent all shown as text");
  const agent = row.children[0].children[2];
  assert.equal(agent.className, "client-ua");
  assert.equal(agent.title, HOSTILE);
  assert.equal(row.children[1].children[0].textContent, "0 KB/s");
});

test("stream states map to plain labels", () => {
  assert.equal(state.formatState("active"), "Live");
  assert.equal(state.formatState("buffering"), "Buffering");
  assert.equal(state.formatState(undefined), "Live");
  assert.equal(state.formatState("odd"), "Odd");
});
