// Guards against stored XSS: channel, group, stream, provider and client values
// come from third-party playlists and players, so they must only ever reach the
// page through textContent or element properties, never through HTML strings.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const PAYLOAD = '<img src=x onerror=alert(1)>';
const ATTR_PAYLOAD = '" onmouseover="alert(1)';

// Minimal DOM: enough of createElement, querySelector, append and innerHTML for
// the render paths under test. innerHTML is parsed with a tiny tag tokenizer and
// every string written to it is recorded so the test can prove API data never
// goes through it.
const innerHtmlWrites = [];

class TextNode {
  constructor(data) { this.nodeType = 3; this.data = String(data); this.parentElement = null; }
  get textContent() { return this.data; }
}

class Element {
  constructor(tagName) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentElement = null;
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.isConnected = true;
    this.classList = {
      add: (...names) => names.forEach((n) => { if (!this.classList.contains(n)) this.className = `${this.className} ${n}`.trim(); }),
      remove: (...names) => { this.className = this.classes().filter((c) => !names.includes(c)).join(" "); },
      contains: (n) => this.classes().includes(n),
      toggle: (n) => { const has = this.classList.contains(n); has ? this.classList.remove(n) : this.classList.add(n); return !has; },
    };
  }
  classes() { return (this.className || "").split(/\s+/).filter(Boolean); }
  get className() { return this.attributes.class || ""; }
  set className(v) { this.attributes.class = String(v); }
  get id() { return this.attributes.id || ""; }
  set id(v) { this.attributes.id = String(v); }
  get title() { return this.attributes.title || ""; }
  set title(v) { this.attributes.title = String(v); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  async dispatch(type) { for (const fn of this.listeners[type] || []) await fn({}); }
  append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }
  appendChild(node) {
    if (!(node instanceof Element) && !(node instanceof TextNode)) node = new TextNode(node);
    node.parentElement = this;
    this.children.push(node);
    return node;
  }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this); }
  get textContent() { return this.children.map((c) => c.textContent).join(""); }
  set textContent(v) { this.replaceChildren(new TextNode(v)); }
  get innerHTML() { return this.children.map(serialize).join(""); }
  set innerHTML(html) { innerHtmlWrites.push(html); this.children = []; parseInto(this, html); }
  get outerHTML() { return serialize(this); }
  *descendants() { for (const c of this.children) { if (c instanceof Element) { yield c; yield* c.descendants(); } } }
  querySelectorAll(selector) { return [...this.descendants()].filter((el) => matches(el, selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function escapeText(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function serialize(node) {
  if (node instanceof TextNode) return escapeText(node.data);
  const attrs = Object.entries(node.attributes).map(([k, v]) => ` ${k}="${v.replace(/"/g, "&quot;")}"`).join("");
  return `<${node.tagName.toLowerCase()}${attrs}>${node.children.map(serialize).join("")}</${node.tagName.toLowerCase()}>`;
}

function parseInto(root, html) {
  const tokens = html.match(/<\/?[a-zA-Z][^>]*>|[^<]+/g) || [];
  let current = root;
  for (const token of tokens) {
    if (token.startsWith("</")) { current = current.parentElement; continue; }
    if (token.startsWith("<")) {
      const [, tag, rest] = token.match(/^<([a-zA-Z0-9]+)([^>]*)>$/);
      const el = new Element(tag);
      for (const [, name, value] of rest.matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) {
        if (name === "class") el.className = value || "";
        else if (name.startsWith("data-")) el.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value || "";
        else el.attributes[name] = value || "";
      }
      current.appendChild(el);
      current = el;
    } else if (token.trim()) {
      current.appendChild(new TextNode(token));
    }
  }
}

function matchesSimple(el, simple) {
  const tag = simple.match(/^[a-zA-Z0-9]+/);
  if (tag && el.tagName !== tag[0].toUpperCase()) return false;
  for (const [, cls] of simple.matchAll(/\.([\w-]+)/g)) if (!el.classList.contains(cls)) return false;
  for (const [, id] of simple.matchAll(/#([\w-]+)/g)) if (el.id !== id) return false;
  for (const [, name, value] of simple.matchAll(/\[([\w-]+)="([^"]*)"\]/g)) {
    const actual = name.startsWith("data-") ? el.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] : el.getAttribute(name);
    if (actual !== value) return false;
  }
  return true;
}
function matches(el, selector) {
  return selector.split(",").some((part) => {
    const simples = part.trim().split(/\s+/);
    let node = el;
    if (!matchesSimple(node, simples.at(-1))) return false;
    for (let i = simples.length - 2; i >= 0; i -= 1) {
      node = node.parentElement;
      while (node && !matchesSimple(node, simples[i])) node = node.parentElement;
      if (!node) return false;
    }
    return true;
  });
}

const body = new Element("body");
const document = {
  body,
  activeElement: null,
  createElement: (tag) => new Element(tag),
  getElementById: (id) => body.querySelector(`#${id}`),
};
const context = vm.createContext({
  window: { addEventListener() {} },
  document,
  lucide: { createIcons() {} },
  console,
});
for (const file of ["../source-picker.js", "../app.js"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), context);
}
vm.runInContext("this.state = State;", context);
const state = context.state;

const tick = () => new Promise((resolve) => setImmediate(resolve));
const noElement = (root, tag) => assert.equal(root.querySelectorAll(tag).length, 0, `${tag} element must not be created`);

test("stream card renders channel, group and status as text, not markup", () => {
  state.channelsByUuid = { "uuid-1": 10 };
  state.channelsMap = { 10: { id: 10, name: PAYLOAD, channel_group_id: 3 } };
  state.channelGroupsMap = { 3: `<b onclick=alert(1)>Sport</b>` };
  state.fetchStreamsForChannel = async () => [];
  innerHtmlWrites.length = 0;

  const card = state.createStreamCard({
    channel_id: "uuid-1", channel_name: PAYLOAD, stream_id: 1, state: "active",
    uptime: 60, total_bytes: 1000, client_count: 2,
  });

  noElement(card, "img");
  noElement(card, "b");
  assert.equal(card.querySelector("h3").textContent, PAYLOAD);
  assert.equal(card.querySelector(".stream-group-badge").textContent, "<b onclick=alert(1)>Sport</b>");
  assert.equal(card.querySelector(".stream-status-badge").className, "stream-status-badge status-live");
  assert.equal(card.querySelector(".stream-status-badge").textContent, state.formatState("active"));
  assert.match(card.outerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(card.outerHTML, /<img/);

  const stop = card.querySelector(".btn-stop-stream");
  assert.equal(stop.dataset.channelId, "uuid-1");
  assert.equal(stop.dataset.channelName, PAYLOAD);
  assert.equal(stop.textContent.trim(), "Stop stream");

  // Ids, labels and spec order are what updateStreamCard and the CSS rely on.
  assert.equal(card.querySelector(".select-wrapper").id, "select-wrapper-uuid-1");
  assert.equal(card.querySelector(".stream-pills-container").id, "pills-container-uuid-1");
  assert.equal(card.querySelector(".clients-toggle").id, "toggle-uuid-1");
  assert.equal(card.querySelector(".clients-toggle").getAttribute("aria-controls"), "clients-list-uuid-1");
  assert.equal(card.querySelector(".clients-list-container").id, "clients-list-uuid-1");
  assert.equal(card.querySelector(".clients-toggle span").textContent, "Connected clients (2)");
  assert.deepEqual(card.querySelectorAll(".spec-label").map((el) => el.textContent),
    ["Average bitrate", "Clients", "Uptime", "Data sent"]);
  assert.equal(card.querySelectorAll(".spec-value")[1].textContent, "2");

  for (const html of innerHtmlWrites) assert.doesNotMatch(html, /alert\(1\)/);
});

test("client rows set user agent, IP and username as text and coerce the rate", async () => {
  state.usersMap = { 7: `<i>${PAYLOAD}</i>` };
  state.channelsByUuid = {};
  state.fetchStreamsForChannel = async () => [];
  state.apiFetch = async () => ({ clients: [
    { user_id: 7, ip_address: `10.0.0.1${PAYLOAD}`, user_agent: `VLC${ATTR_PAYLOAD}`, current_rate_KBps: "1234.56", connected_at: Date.now() / 1000 - 90 },
    { user_id: "0", ip_address: "10.0.0.2", user_agent: PAYLOAD, current_rate_KBps: null },
  ] });
  innerHtmlWrites.length = 0;

  const card = state.createStreamCard({ channel_id: "uuid-2", channel_name: "Plain", stream_id: 1, state: "active" });
  await card.querySelector(".clients-toggle").dispatch("click");
  await tick();

  const rows = card.querySelectorAll(".client-row");
  assert.equal(rows.length, 2);
  noElement(card, "img");
  noElement(card, "i.client-user i");
  assert.equal(rows[0].querySelector(".client-user").textContent, `<i>${PAYLOAD}</i>`);
  assert.equal(rows[0].querySelector(".client-ip").textContent, `10.0.0.1${PAYLOAD}`);
  assert.equal(rows[0].querySelector(".client-ua").textContent, `VLC${ATTR_PAYLOAD}`);
  assert.equal(rows[0].querySelector(".client-ua").title, `VLC${ATTR_PAYLOAD}`);
  assert.equal(rows[0].querySelector(".client-rate").textContent, "1234.6 KB/s");
  assert.equal(rows[0].querySelector(".client-uptime").textContent, state.formatDuration(90));
  assert.equal(rows[1].querySelector(".client-user"), null);
  assert.equal(rows[1].querySelector(".client-ua").textContent, PAYLOAD);
  assert.equal(rows[1].querySelector(".client-rate").textContent, "0 KB/s");
  assert.equal(rows[1].querySelector(".client-uptime").textContent, "");
  assert.deepEqual(rows[0].querySelectorAll("span").map((el) => el.className),
    ["client-user", "client-ip", "client-ua", "client-rate", "client-uptime"]);

  for (const html of innerHtmlWrites) assert.doesNotMatch(html, /alert\(1\)/);
});

test("channels table renders names, groups, streams and providers as text", async () => {
  const tbody = new Element("tbody");
  tbody.id = "channels-table-body";
  const search = new Element("input");
  search.id = "channel-search-input";
  search.value = "";
  body.replaceChildren(tbody, search);

  state.channels = [
    { id: 10, uuid: "uuid-1", name: PAYLOAD, channel_number: 5, channel_group_id: 3 },
    { id: 11, uuid: "uuid-2", name: "Quiet", channel_number: 6, channel_group_id: 4 },
  ];
  state.channelsByUuid = { "uuid-1": 10, "uuid-2": 11 };
  state.channelGroupsMap = { 3: `<script>alert(1)</script>`, 4: "News" };
  state.activeStreams = [{ channel_id: "uuid-1", stream_id: 2, state: "buffering" }];
  state.fetchStreamsForChannel = async (id) => (id === 10
    ? [{ id: 2, name: PAYLOAD, m3u_account: { name: `<svg onload=alert(1)>` } }]
    : []);
  innerHtmlWrites.length = 0;

  state.renderChannelsExplorer();
  await tick();

  const rows = tbody.querySelectorAll("tr");
  assert.equal(rows.length, 2);
  noElement(tbody, "img");
  noElement(tbody, "script");
  noElement(tbody, "svg");

  const cells = rows[0].querySelectorAll("td");
  assert.deepEqual(cells.map((td) => td.className),
    ["", "channel-name-cell", "channel-group-cell", "channel-stream-cell", "actions-cell"]);
  assert.equal(cells[0].querySelector(".channel-no-badge").textContent, "5");
  assert.equal(cells[1].children[0].textContent, PAYLOAD);
  assert.equal(cells[1].querySelector(".stream-status-badge").className, "stream-status-badge status-live");
  assert.equal(cells[1].querySelector(".stream-status-badge").textContent, state.formatState("buffering"));
  assert.equal(cells[2].textContent, "<script>alert(1)</script>");
  assert.equal(cells[3].id, "source-cell-10");
  assert.equal(cells[3].querySelector(".cell-primary").textContent, PAYLOAD);
  assert.equal(cells[3].querySelector(".cell-secondary").textContent, "<svg onload=alert(1)>");
  assert.equal(cells[4].id, "actions-cell-10");
  assert.equal(cells[4].querySelector(".source-browse-btn").textContent, "Compare sources");

  const quiet = rows[1].querySelectorAll("td");
  assert.equal(quiet[1].querySelector(".stream-status-badge"), null);
  assert.equal(quiet[3].querySelector(".cell-negative").textContent, "No sources");
  assert.equal(quiet[4].querySelector(".cell-secondary").textContent, "–");

  assert.match(tbody.outerHTML, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(tbody.outerHTML, /<img|<script|<svg/);
  for (const html of innerHtmlWrites) assert.doesNotMatch(html, /alert\(1\)/);
});
