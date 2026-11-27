/**
 * Swaparr - Core Application Logic
 * Integrates with Dispatcharr HTTP REST API
 */

// Toast Notification Manager
const Toast = {
  container: null,

  init() {
    this.container = document.createElement("div");
    this.container.id = "toast-container";
    document.body.appendChild(this.container);
  },

  show(title, message, type = "info", options = {}) {
    if (!this.container) this.init();

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;

    const icons = { info: "info", success: "check-circle", error: "alert-triangle", warning: "alert-circle" };
    const heading = document.createElement("div");
    heading.className = "toast-title";
    const icon = document.createElement("i");
    icon.setAttribute("data-lucide", icons[type] || icons.info);
    const titleText = document.createElement("span");
    titleText.textContent = title;
    heading.append(icon, titleText);
    const body = document.createElement("div");
    body.className = "toast-body";
    body.textContent = message;
    toast.append(heading, body);

    const dismiss = () => {
      toast.classList.remove("is-visible");
      setTimeout(() => toast.remove(), 300);
    };
    if (options.action) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn btn-secondary toast-action";
      button.textContent = options.action.label;
      button.addEventListener("click", () => {
        dismiss();
        options.action.onClick();
      });
      toast.append(button);
    }

    this.container.appendChild(toast);
    SourcePicker.drawIcons();

    // Animate in
    requestAnimationFrame(() => toast.classList.add("is-visible"));

    // Toasts that offer an action stay longer so there is time to tap it.
    setTimeout(dismiss, options.duration || (options.action ? 12000 : 4000));
  },
};

// Pure decisions about stream health, kept free of the page so tests can run them.
const StreamHealth = {
  BUSY_STATES: new Set(["buffering", "connecting", "initializing"]),
  // Seconds without new data before a stream is called stalled. Dispatcharr's byte
  // counter may update in steps, and readings can come close together (switch checks,
  // manual refresh), so this is measured in time, not in readings.
  STALL_MS: 15000,
  SWITCH_TIMEOUT_MS: 25000,

  sample(stream, at = Date.now()) {
    return stream ? {
      stream_id: stream.stream_id, state: stream.state,
      total_bytes: Number(stream.total_bytes) || 0, uptime: Number(stream.uptime) || 0, at,
    } : null;
  },

  // Data rate between two readings of the same channel. A counter that goes backwards
  // (Dispatcharr restarted the stream) is a reset, not a stall.
  liveRate(prev, cur) {
    if (!prev || !cur || String(prev.stream_id) !== String(cur.stream_id)) return { kind: "measuring" };
    const bytes = cur.total_bytes - prev.total_bytes;
    if (!Number.isFinite(bytes) || bytes < 0 || cur.uptime < prev.uptime) return { kind: "measuring" };
    let seconds = cur.uptime - prev.uptime;
    if (!(seconds > 0)) seconds = (cur.at - prev.at) / 1000;
    if (!(seconds > 0)) return { kind: "measuring" };
    if (bytes === 0) return { kind: "empty" };
    return { kind: "rate", kbps: (bytes * 8) / seconds / 1000 };
  },

  // Carries one channel's health from the last reading to this one.
  next(entry, cur) {
    const rate = this.liveRate(entry?.sample, cur);
    if (rate.kind === "empty") {
      const lastGrowthAt = entry?.lastGrowthAt ?? entry?.sample?.at ?? cur.at;
      const display = cur.at - lastGrowthAt >= this.STALL_MS ? { kind: "stalled" } : entry?.display || { kind: "measuring" };
      return { sample: cur, lastGrowthAt, display };
    }
    return { sample: cur, lastGrowthAt: cur.at, display: rate.kind === "rate" ? rate : { kind: "measuring" } };
  },

  // Was a change of source made by this page, or by something else?
  classifyChange(prevStreamId, curStreamId, pending, now = Date.now()) {
    if (prevStreamId == null || curStreamId == null || String(prevStreamId) === String(curStreamId)) return null;
    if (pending && String(pending.to) === String(curStreamId) && now - pending.at < 120000) return "ours";
    return "outside";
  },

  // Decides whether a switch to `toId` has worked, from the readings taken since.
  evaluateSwitch(samples, fromId, toId, elapsedMs, timeoutMs = this.SWITCH_TIMEOUT_MS) {
    const last = samples[samples.length - 1];
    if (samples.length && !last) return { outcome: "stopped" };
    if (last) {
      const id = String(last.stream_id);
      if (id !== String(toId) && (fromId == null || id !== String(fromId))) {
        return { outcome: "moved", streamId: last.stream_id };
      }
      const onNew = samples.filter(item => item && String(item.stream_id) === String(toId));
      if (onNew.length >= 2) {
        const [before, after] = onNew.slice(-2);
        if (!this.BUSY_STATES.has(after.state) && after.total_bytes > before.total_bytes) return { outcome: "live" };
      }
    }
    return elapsedMs >= timeoutMs ? { outcome: "stuck" } : { outcome: "pending" };
  },
};

// Channels seen playing on this device, so the Channels list can open on them.
// Storage can be missing or blocked (private mode); the list then starts empty.
const RecentChannels = {
  KEY: "swaparr.recentChannels",
  KEEP_DAYS: 30,
  MAX: 40,

  read() {
    try {
      const data = JSON.parse(localStorage.getItem(this.KEY) || "{}");
      const cutoff = Date.now() - this.KEEP_DAYS * 86400000;
      return Object.fromEntries(Object.entries(data).filter(([, seen]) => Number(seen) > cutoff));
    } catch {
      return {};
    }
  },

  remember(uuids) {
    if (!uuids.length) return;
    try {
      const data = this.read();
      const now = Date.now();
      uuids.forEach((uuid) => { if (uuid) data[uuid] = now; });
      const kept = Object.entries(data).sort((a, b) => b[1] - a[1]).slice(0, this.MAX);
      localStorage.setItem(this.KEY, JSON.stringify(Object.fromEntries(kept)));
    } catch {
      // Not remembering is fine; the list just shows what is playing now.
    }
  },
};

// "Use this source tonight": a temporary priority order that Swaparr puts back at 3 am.
// Kept on this device; the order is restored the next time Swaparr is open after 3 am.
const Pins = {
  KEY: "swaparr.pins",

  read() {
    try {
      const list = JSON.parse(localStorage.getItem(this.KEY) || "[]");
      return Array.isArray(list) ? list.filter((pin) => pin && Number.isSafeInteger(pin.channelId)) : [];
    } catch {
      return [];
    }
  },

  write(list) {
    try {
      localStorage.setItem(this.KEY, JSON.stringify(list));
      return true;
    } catch {
      return false;
    }
  },

  find(channelId) {
    return this.read().find((pin) => pin.channelId === channelId);
  },

  save(pin) {
    return this.write([...this.read().filter((item) => item.channelId !== pin.channelId), pin]);
  },

  remove(channelId) {
    this.write(this.read().filter((pin) => pin.channelId !== channelId));
  },

  nextRevertTime(now = new Date()) {
    const at = new Date(now);
    at.setHours(3, 0, 0, 0);
    if (at <= now) at.setDate(at.getDate() + 1);
    return at.getTime();
  },

  pinnedOrder(ids, sourceId) {
    return [sourceId, ...ids.filter((id) => id !== sourceId)];
  },

  sameOrder(left, right) {
    return left.length === right.length && left.every((id, i) => id === right[i]);
  },

  sameSet(left, right) {
    const byNumber = (a, b) => a - b;
    return this.sameOrder([...left].sort(byNumber), [...right].sort(byNumber));
  },

  // What to do with a pin that is due, given the channel's order now.
  revertPlan(pin, currentIds) {
    if (this.sameOrder(currentIds, pin.pinned) && this.sameSet(pin.original, currentIds)) return "restore";
    return "leave";
  },
};

// Global App State
const State = {
  config: {
    url: "http://localhost:9191",
    apiKey: "",
  },
  channels: [], // Full channel objects from /api/channels/
  channelsByUuid: {}, // Map of UUID -> database ID
  channelsMap: {}, // Map of database ID -> Channel object
  channelGroupsMap: {}, // Map of group ID -> group name
  activeStreams: [], // Active streams list from /proxy/ts/status
  channelStreamsCache: {}, // Cache of stream list for each channel ID: { channelId: [streams] }
  m3uAccountsMap: {}, // Map of M3U account ID -> name (e.g. "Primary", "Backup")
  usersMap: {}, // Map of user ID -> username
  health: {}, // channel UUID -> live rate tracking (StreamHealth.next)
  lastStreamIds: {}, // channel UUID -> source playing at the last reading
  pendingSwitches: {}, // channel UUID -> { from, to, at } for switches made on this page
  outsideChanges: {}, // channel UUID -> { from, to, at } for changes made elsewhere
  switchChecks: {}, // channel UUID -> token while a switch is being checked
  findRuns: {}, // channel UUID -> token while "Find a working source" is running

  refreshInterval: null,
  refreshCountdown: 5,
  countdownInterval: null,

  async init() {
    this.setupEventListeners();
    SourcePicker.drawIcons();

    await this.loadConfig();

    // Try initial fetch
    if (this.config.url) {
      this.refreshAll();
    } else {
      this.openSettings();
    }

    this.renderPins();
    // Due pins are checked every minute while the page is open.
    setInterval(() => {
      if (Pins.read().some((pin) => pin.until <= Date.now())) this.revertDuePins();
    }, 60000);
    // Guarded: an older cached index.html has no history section.
    const history = document.getElementById("history-section");
    if (this.config.watcher && history) {
      history.hidden = false;
      setInterval(() => this.refreshHistory(), 30000);
    }
  },

  async loadConfig() {
    try {
      const response = await fetch("/config.json");
      if (response.ok) {
        const configData = await response.json();
        if (configData.url) {
          let normalizedUrl = configData.url.trim();
          if (normalizedUrl.endsWith("/")) {
            normalizedUrl = normalizedUrl.slice(0, -1);
          }
          this.config.url = normalizedUrl;
        }
        if (configData.apiKey) {
          this.config.apiKey = configData.apiKey.trim();
        }
        this.config.watcher = configData.watcher === true;
      }
    } catch (err) {
      console.warn("Failed to load server config:", err);
    }

    if (this.config.url === "/dispatcharr-api") {
      document.getElementById("dispatcharr-url").value = "Set on the server (proxy mode)";
      document.getElementById("dispatcharr-api-key").value = "••••••••••••••••";
    } else {
      document.getElementById("dispatcharr-url").value = this.config.url;
      document.getElementById("dispatcharr-api-key").value = this.config.apiKey ? "••••••••••••••••" : "Not set";
    }
  },

  getHeaders() {
    const headers = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `ApiKey ${this.config.apiKey}`;
    }
    return headers;
  },

  async apiFetch(path, options = {}) {
    const url = `${this.config.url}${path}`;
    const headers = {
      ...this.getHeaders(),
      ...options.headers,
    };

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
      error.status = response.status;
      throw error;
    }

    // Some endpoints answer 200 with no body. That is a success, not a parse error.
    const text = await response.text();
    if (!text.trim()) return null;
    return JSON.parse(text);
  },

  updateConnectionStatus(connected, message = "") {
    const badge = document.getElementById("status-badge");
    const statusText = document.getElementById("status-text");

    if (connected) {
      badge.className = "status-badge status-connected";
      statusText.textContent = "Connected";
    } else {
      badge.className = "status-badge status-disconnected";
      statusText.textContent = message || "Disconnected";
    }
  },

  setupEventListeners() {
    // Settings Modal toggles
    document
      .getElementById("settings-btn")
      .addEventListener("click", () => this.openSettings());
    document
      .getElementById("settings-close-btn")
      .addEventListener("click", () => this.closeSettings());
    document
      .getElementById("settings-cancel-btn")
      .addEventListener("click", () => this.closeSettings());

    // Toggle password eye
    document
      .getElementById("toggle-api-key-btn")
      .addEventListener("click", () => {
        const input = document.getElementById("dispatcharr-api-key");
        const icon = document.querySelector("#toggle-api-key-btn i");
        if (input.type === "password") {
          input.type = "text";
          icon.setAttribute("data-lucide", "eye-off");
        } else {
          input.type = "password";
          icon.setAttribute("data-lucide", "eye");
        }
        SourcePicker.drawIcons();
      });

    // Settings form submit prevented
    document.getElementById("settings-form").addEventListener("submit", (e) => {
      e.preventDefault();
      this.closeSettings();
    });

    // Connection Test button
    document
      .getElementById("test-connection-btn")
      .addEventListener("click", () => this.testConnection());

    // Guarded: a phone can briefly hold an older cached index.html without this button.
    document
      .getElementById("capture-sample-btn")
      ?.addEventListener("click", () => this.captureSample());

    // Refresh Manual button
    document.getElementById("refresh-btn").addEventListener("click", () => {
      this.refreshAll();
      Toast.show(
        "Refreshing",
        "Fetching from Dispatcharr",
        "info",
      );
    });

    // Auto Refresh toggle
    const autoCheck = document.getElementById("auto-refresh-check");
    autoCheck.addEventListener("change", () => {
      if (autoCheck.checked) {
        this.startAutoRefresh();
      } else {
        this.stopAutoRefresh();
      }
    });

    // Search Box
    document
      .getElementById("channel-search-input")
      .addEventListener("input", () => this.renderChannelsExplorer());

    // Auto-close modal when clicking background overlay
    window.addEventListener("click", (e) => {
      const modal = document.getElementById("settings-modal");
      if (e.target === modal) {
        this.closeSettings();
      }
    });
  },

  openSettings() {
    document.getElementById("settings-modal").classList.add("show");
    document.getElementById("test-connection-result").style.display = "none";
  },

  closeSettings() {
    document.getElementById("settings-modal").classList.remove("show");
  },

  async testConnection() {
    const resultBox = document.getElementById("test-connection-result");

    resultBox.style.display = "block";
    resultBox.className = "connection-result";
    resultBox.textContent = "Connecting…";

    try {
      // Hit proxy status to verify through our proxy
      const response = await fetch(`${this.config.url}/proxy/ts/status`, { 
        headers: this.getHeaders() 
      });
      if (response.ok) {
        resultBox.className = "connection-result success";
        resultBox.textContent =
          "Connected. Dispatcharr answered.";
        this.updateConnectionStatus(true);
      } else {
        resultBox.className = "connection-result error";
        resultBox.textContent = `HTTP ${response.status} ${response.statusText}. Check the URL and API key.`;
        this.updateConnectionStatus(false, `HTTP ${response.status}`);
      }
    } catch (err) {
      resultBox.className = "connection-result error";
      resultBox.textContent = `Could not connect: ${err.message}. Check that Dispatcharr is running and reachable.`;
      this.updateConnectionStatus(false, "Network error");
    }
  },

  async captureSample() {
    const button = document.getElementById("capture-sample-btn");
    const resultBox = document.getElementById("capture-sample-result");
    button.disabled = true;
    resultBox.style.display = "block";
    resultBox.className = "connection-result";
    resultBox.textContent = "Reading from Dispatcharr…";
    try {
      const { summary, file } = await SampleCapture.run((path) => this.apiFetch(path));
      const name = SampleCapture.download(file);
      resultBox.className = summary.answered ? "connection-result success" : "connection-result error";
      resultBox.textContent = `Saved ${name}. ${summary.answered} of ${summary.total} calls answered. `
        + "Attach it to a GitHub issue or share it with Claude.";
    } catch (err) {
      resultBox.className = "connection-result error";
      resultBox.textContent = `Could not capture sample data: ${err.message}`;
    } finally {
      button.disabled = false;
    }
  },

  startAutoRefresh() {
    this.stopAutoRefresh();
    this.refreshCountdown = 5;
    document.getElementById("refresh-countdown").textContent =
      this.refreshCountdown;

    this.countdownInterval = setInterval(() => {
      this.refreshCountdown--;
      if (this.refreshCountdown <= 0) {
        this.refreshCountdown = 5;
        this.refreshActiveStreamsOnly();
      }
      document.getElementById("refresh-countdown").textContent =
        this.refreshCountdown;
    }, 1000);
  },

  stopAutoRefresh() {
    if (this.countdownInterval) clearInterval(this.countdownInterval);
    document.getElementById("refresh-countdown").textContent = "-";
  },

  async refreshAll() {
    try {
      this.updateConnectionStatus(false, "Connecting...");
      this.channelStreamsCache = {};
      document.querySelectorAll(".select-wrapper").forEach(wrapper => delete wrapper.dataset.streamId);
      
      // Fetch sequentially to prevent tripping strict reverse proxy rate limiters (429 errors)
      await this.fetchM3uAccounts();
      await this.fetchUsers();
      await this.fetchChannelGroups();
      await this.fetchChannels();

      // Fetch active streams
      await this.fetchActiveStreams();
      this.renderChannelsExplorer();

      this.updateConnectionStatus(true);
      this.revertDuePins();
      if (this.config.watcher) this.refreshHistory();
      if (document.getElementById("auto-refresh-check").checked) this.startAutoRefresh();
    } catch (err) {
      console.error(err);
      this.updateConnectionStatus(false, "Error");
      Toast.show(
        "Connection failed",
        `Could not fetch data from Dispatcharr: ${err.message}`,
        "error",
      );
    }
  },

  async refreshActiveStreamsOnly() {
    try {
      await this.fetchActiveStreams();
      this.updateConnectionStatus(true);
    } catch (err) {
      console.error("Auto-refresh failed:", err);
      this.updateConnectionStatus(false, "Not responding");
    }
  },

  async refreshHistory() {
    const list = document.getElementById("history-list");
    if (!list) return;
    try {
      const response = await fetch("/watcher/events?limit=20", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const events = Array.isArray(data.events) ? data.events : [];
      if (!events.length) {
        list.replaceChildren(SourcePicker.element("li", "history-empty",
          "Nothing yet. Channel starts, stops, source changes and stalls will appear here."));
        return;
      }
      list.replaceChildren(...events.map((event) => this.buildHistoryItem(event)));
    } catch {
      list.replaceChildren(SourcePicker.element("li", "history-empty is-error",
        "The watcher is not answering. Check the Swaparr container log."));
    }
  },

  buildHistoryItem(event) {
    const item = SourcePicker.element("li", `history-item is-${String(event.type || "").replace(/[^a-z_]/g, "")}`);
    const at = Number(event.at) * 1000;
    const when = SourcePicker.element("time", "history-time", Number.isFinite(at) ? this.formatWhen(at) : "");
    if (Number.isFinite(at)) when.setAttribute("datetime", new Date(at).toISOString());
    item.append(when, SourcePicker.element("span", "history-text", String(event.text || event.type || "")));
    return item;
  },

  formatWhen(ms) {
    const date = new Date(ms);
    const today = new Date();
    const time = this.formatClock(ms);
    if (date.toDateString() === today.toDateString()) return time;
    return `${date.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
  },

  renderPins() {
    const bar = document.getElementById("pins-bar");
    if (!bar) return;
    const pins = Pins.read();
    bar.hidden = pins.length === 0;
    bar.replaceChildren(...pins.map((pin) => {
      const row = SourcePicker.element("div", "pin-row");
      row.append(SourcePicker.element("span", "pin-text",
        `${pin.channelName} uses ${pin.sourceName} first until ${this.formatWhen(pin.until)}.`));
      const button = SourcePicker.element("button", "btn btn-secondary pin-restore", "Restore now");
      button.type = "button";
      button.addEventListener("click", () => this.revertDuePins(pin.channelId));
      row.append(button);
      return row;
    }));
  },

  // Puts pinned channels back to their usual order: due pins, or one channel now.
  // Only restores when nobody changed the order since pinning; otherwise leaves it.
  async revertDuePins(onlyChannelId = null) {
    if (this.revertingPins) return;
    this.revertingPins = true;
    try {
      const now = Date.now();
      for (const pin of Pins.read()) {
        if (onlyChannelId == null ? pin.until > now : pin.channelId !== onlyChannelId) continue;
        try {
          const path = `/api/channels/channels/${pin.channelId}/streams/`;
          const latest = await this.apiFetch(path);
          SourcePicker.validateStreams(latest);
          if (Pins.revertPlan(pin, latest.map((source) => source.id)) === "restore") {
            await this.apiFetch(`/api/channels/channels/${pin.channelId}/`, {
              method: "PATCH", body: JSON.stringify({ streams: pin.original }),
            });
            const verified = await this.apiFetch(path);
            SourcePicker.validateStreams(verified);
            if (!Pins.sameOrder(verified.map((source) => source.id), pin.original)) {
              throw new Error("Dispatcharr returned a different order.");
            }
            this.channelStreamsCache[pin.channelId] = verified;
            Toast.show("Source order restored", `${pin.channelName} is back to its usual source order.`, "success");
          } else {
            Toast.show("Pin ended", `${pin.channelName}'s sources were changed since pinning, so Swaparr left the order as it is.`, "info");
          }
          Pins.remove(pin.channelId);
        } catch (err) {
          // Keep the pin and try again later.
          console.error("Restoring pinned order failed:", err);
          if (onlyChannelId != null) Toast.show("Could not restore order", err.message, "error");
        }
      }
    } finally {
      this.revertingPins = false;
      this.renderPins();
    }
  },

  async fetchAllPages(path, pageSize = 200) {
    const first = await this.apiFetch(`${path}?page=1&page_size=${pageSize}`);
    if (Array.isArray(first)) return first;

    const items = [...(first.results || [])];
    const totalPages = Math.ceil((first.count || items.length) / pageSize);

    for (let page = 2; page <= totalPages; page++) {
      // 50ms delay between pages to prevent reverse proxies from throwing 429 Too Many Requests
      await new Promise(resolve => setTimeout(resolve, 50));
      
      const data = await this.apiFetch(
        `${path}?page=${page}&page_size=${pageSize}`,
      );
      items.push(...(data.results || []));
    }

    return items;
  },

  async fetchUsers() {
    try {
      const users = await this.fetchAllPages("/api/accounts/users/");
      this.usersMap = {};
      users.forEach((u) => {
        this.usersMap[u.id] = u.username || u.email || `User #${u.id}`;
      });
    } catch (err) {
      console.error("Failed to fetch users:", err);
    }
  },

  async fetchM3uAccounts() {
    try {
      const data = await this.apiFetch("/api/m3u/accounts/");
      const accounts = Array.isArray(data) ? data : data.results || [];

      this.m3uAccountsMap = {};
      accounts.forEach((account) => {
        if (account.id && account.name) {
          this.m3uAccountsMap[account.id] = account.name;
        }
      });
    } catch (err) {
      console.error("Fetch M3U accounts failed:", err);
      this.m3uAccountsMap = {};
    }
  },

  async fetchChannelGroups() {
    try {
      const groups = await this.fetchAllPages("/api/channels/groups/");
      this.channelGroupsMap = {};
      groups.forEach((g) => {
        this.channelGroupsMap[g.id] = g.name || `Group #${g.id}`;
      });
    } catch (err) {
      console.error("Failed to fetch channel groups:", err);
    }
  },

  async fetchChannels() {
    try {
      const channelsList = await this.fetchAllPages("/api/channels/channels/");

      this.channels = channelsList;
      this.channelsByUuid = {};
      this.channelsMap = {};

      channelsList.forEach((channel) => {
        this.channelsMap[channel.id] = channel;
        if (channel.uuid) {
          this.channelsByUuid[channel.uuid] = channel.id;
        }
      });

      this.renderChannelsExplorer();
    } catch (err) {
      console.error("Fetch channels failed:", err);
      throw err;
    }
  },

  async fetchActiveStreams() {
    try {
      const data = await this.apiFetch("/proxy/ts/status");
      this.activeStreams = data.channels || [];
      RecentChannels.remember(this.activeStreams.map((stream) => stream.channel_id));

      // Update statistics panel
      document.getElementById("stat-active-count").textContent =
        this.activeStreams.length;

      let totalClients = 0;
      this.activeStreams.forEach((stream) => {
        totalClients += stream.client_count || 0;
      });

      document.getElementById("stat-client-count").textContent = totalClients;

      this.trackStreams(this.activeStreams);

      // "Your channels" lists what is playing, so redraw it when that set changes.
      const activeKey = this.activeStreams.map((stream) => stream.channel_id).sort().join(",");
      if (activeKey !== this.lastActiveKey) {
        const first = this.lastActiveKey === undefined;
        this.lastActiveKey = activeKey;
        const search = document.getElementById("channel-search-input");
        if (!first && search && !search.value.trim()) this.renderChannelsExplorer();
      }

      // Bandwidth uses the live rate where one is known, else the average since start.
      let totalBitrateKbps = 0;
      this.activeStreams.forEach((stream) => {
        const display = this.health[stream.channel_id]?.display;
        if (display?.kind === "rate") totalBitrateKbps += display.kbps;
        else if (display?.kind !== "stalled" && stream.uptime > 0 && stream.total_bytes) {
          totalBitrateKbps += (stream.total_bytes * 8) / stream.uptime / 1000;
        }
      });

      const totalMbps = totalBitrateKbps / 1000;
      document.getElementById("stat-bandwidth").textContent =
        `${totalMbps.toFixed(2)} Mbps`;

      // Render active streams grid
      await this.renderActiveStreams();
    } catch (err) {
      console.error("Fetch active streams failed:", err);
      throw err;
    }
  },

  // Updates live rates and notices source changes that this page did not make.
  trackStreams(streams) {
    const now = Date.now();
    const seen = new Set();
    streams.forEach((stream) => {
      const uuid = stream.channel_id;
      seen.add(uuid);
      this.health[uuid] = StreamHealth.next(this.health[uuid], StreamHealth.sample(stream, now));
      const kind = StreamHealth.classifyChange(this.lastStreamIds[uuid], stream.stream_id, this.pendingSwitches[uuid], now);
      if (kind === "outside") {
        this.outsideChanges[uuid] = { from: this.lastStreamIds[uuid], to: stream.stream_id, at: now };
      }
      this.lastStreamIds[uuid] = stream.stream_id;
    });
    Object.keys(this.health).forEach((uuid) => {
      if (!seen.has(uuid)) {
        delete this.health[uuid];
        delete this.lastStreamIds[uuid];
        delete this.outsideChanges[uuid];
      }
    });
  },

  sourceName(channelUuid, streamId) {
    const streams = this.channelStreamsCache[this.channelsByUuid[channelUuid]] || [];
    const source = streams.find((item) => String(item.id) === String(streamId));
    if (!source) return `source #${streamId}`;
    return `${source.name || `Stream #${source.id}`} (${this.formatAccountName(source.m3u_account)})`;
  },

  formatClock(ms) {
    return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  },

  // One short line under the current source: a check in progress, or a change made elsewhere.
  renderSourceNote(card, channelUuid) {
    const note = card.querySelector(".source-note");
    if (!note) return;
    const outside = this.outsideChanges[channelUuid];
    if (this.switchChecks[channelUuid]) {
      note.className = "source-note is-checking";
      note.textContent = this.switchChecks[channelUuid].label;
      note.hidden = false;
    } else if (outside && Date.now() - outside.at < 30 * 60000) {
      note.className = "source-note is-outside";
      note.textContent = `Source changed outside this page at ${this.formatClock(outside.at)}. `
        + `It was ${this.sourceName(channelUuid, outside.from)}.`;
      note.hidden = false;
    } else {
      note.hidden = true;
      note.textContent = "";
    }
  },

  renderRate(element, stream) {
    const display = this.health[stream.channel_id]?.display || { kind: "measuring" };
    element.classList.toggle("is-warning", display.kind === "stalled");
    element.textContent = display.kind === "rate" ? this.formatKbps(display.kbps)
      : display.kind === "stalled" ? "Stalled" : "Measuring";
    element.title = `Average since start: ${this.formatBitrate(stream.total_bytes, stream.uptime)}`;
  },

  async fetchStreamsForChannel(channelDbId) {
    if (this.channelStreamsCache[channelDbId]) {
      return this.channelStreamsCache[channelDbId];
    }

    try {
      const streams = await this.apiFetch(
        `/api/channels/channels/${channelDbId}/streams/`,
      );
      this.channelStreamsCache[channelDbId] = streams || [];
      return this.channelStreamsCache[channelDbId];
    } catch (err) {
      console.error(`Failed to fetch streams for channel ${channelDbId}:`, err);
      return [];
    }
  },

  formatStreamLabel(stream) {
    const name = `${stream.name || `Stream #${stream.id}`} [${this.formatAccountName(stream.m3u_account)}]`;
    const quality = this.formatStreamQuality(stream.stream_stats);
    return `${name} — ${quality ? `Last probed: ${quality}` : "Quality unknown"}`;
  },

  formatStreamQuality(streamStats) {
    let stats = streamStats;
    if (typeof stats === "string") {
      try {
        stats = JSON.parse(stats);
      } catch {
        return "";
      }
    }
    if (!stats || typeof stats !== "object" || Array.isArray(stats)) return "";

    const details = [];
    const resolution = String(stats.resolution || "").trim();
    const dimensions = resolution.match(/^\d+\s*[x×]\s*(\d+)$/i);
    const heightOnly = resolution.match(/^(\d+)([pi])?$/i);
    const height = Number(dimensions?.[1] || heightOnly?.[1]);
    if (height > 0) {
      details.push(`${height}${heightOnly?.[2]?.toLowerCase() || "p"}`);
    }

    const fps = Number(stats.source_fps);
    if (Number.isFinite(fps) && fps > 0) {
      details.push(`${Number(fps.toFixed(2))} fps`);
    }

    if (typeof stats.video_codec === "string" && stats.video_codec.trim()) {
      const codec = stats.video_codec.trim().toUpperCase();
      details.push(/^(AVC1|AVC|H264|H\.264)$/.test(codec) ? "H.264"
        : /^(HEVC|H265|H\.265|HEV1|HVC1)$/.test(codec) ? "HEVC" : codec);
    }

    return details.join(" · ");
  },

  populateStreamOptions(select, streams, activeStreamId) {
    streams.forEach((stream) => {
      const option = document.createElement("option");
      option.value = String(stream.id);
      option.textContent = this.formatStreamLabel(stream);
      option.selected = activeStreamId != null && String(stream.id) === String(activeStreamId);
      select.appendChild(option);
    });
  },

  formatAccountName(m3uAccount) {
    if (typeof m3uAccount === "object" && m3uAccount?.name)
      return m3uAccount.name;
    const accountId =
      typeof m3uAccount === "object" ? m3uAccount?.id : m3uAccount;
    if (accountId && this.m3uAccountsMap[accountId])
      return this.m3uAccountsMap[accountId];
    if (accountId) return `M3U #${accountId}`;
    return "Unknown Source";
  },

  renderSourceControl(wrapper, streams, activeStreamId, channelUuid, channelName) {
    if (!wrapper) return;
    const current = streams.find(source => String(source.id) === String(activeStreamId));
    const summary = SourcePicker.element("div", "current-source");
    summary.append(SourcePicker.element("strong", "current-provider",
      current ? this.formatAccountName(current.m3u_account) : "Source unavailable"),
      SourcePicker.element("span", "current-source-name", current?.name || "Refresh or open sources to check."));
    const button = SourcePicker.element("button", "btn source-change-btn", "Change source");
    button.type = "button";
    button.setAttribute("aria-haspopup", "dialog");
    button.addEventListener("click", () => SourcePicker.open(this.channelsByUuid[channelUuid], channelName, channelUuid));
    wrapper.replaceChildren(summary);
    wrapper.parentElement.querySelector(".source-change-btn")?.remove();
    wrapper.parentElement.append(button);
    this.renderStreamPills(channelUuid, activeStreamId, streams);
  },

  renderStreamPills(channelUuid, selectedStreamId, streams) {
    const container = document.getElementById(`pills-container-${channelUuid}`);
    if (!container) return;
    const stream = streams.find(source => String(source.id) === String(selectedStreamId));
    const quality = this.formatStreamQuality(stream?.stream_stats);
    container.replaceChildren(SourcePicker.element("span", "quality-caption", "Last-probed quality"));
    (quality ? quality.split(" · ") : ["Quality unknown"]).forEach(value => {
      container.append(SourcePicker.element("span", "quality-tag", value));
    });
    if (!stream) return;
    try {
      const stats = typeof stream.stream_stats === "string" ? JSON.parse(stream.stream_stats) : stream.stream_stats;
      if (typeof stats?.audio_codec === "string" && stats.audio_codec.trim()) {
        container.append(SourcePicker.element("span", "quality-tag",
          `${stats.audio_codec.toUpperCase()}${stats.audio_channels ? ` · ${stats.audio_channels} ch` : ""}`));
      }
      const props = typeof stream.custom_properties === "string" ? JSON.parse(stream.custom_properties) : stream.custom_properties;
      if (props && (props.catchup || props["catchup-days"] || props["catchup-type"])) {
        container.append(SourcePicker.element("span", "quality-tag", "Catch-up"));
      }
    } catch {
      // Partial or malformed probe data must not prevent source selection.
    }
  },

  updateStreamCard(card, stream) {
    const channelDbId = this.channelsByUuid[stream.channel_id];
    const channelInfo = channelDbId ? this.channelsMap[channelDbId] : null;
    const channelName =
      stream.channel_name ||
      (channelInfo ? channelInfo.name : "Unknown Channel");

    const isBuffering =
      stream.state === "buffering" ||
      stream.state === "connecting" ||
      stream.state === "initializing";
    const statusClass = isBuffering
      ? "status-buffering"
      : "status-live";
    const statusText = this.formatState(stream.state);

    const badge = card.querySelector(".stream-status-badge");
    if (badge) {
      badge.className = `stream-status-badge ${statusClass}`;
      badge.textContent = statusText;
    }

    const specValues = card.querySelectorAll(".spec-value");
    if (specValues.length >= 4) {
      this.renderRate(specValues[0], stream);
      specValues[1].textContent = String(stream.client_count || 0);
      specValues[2].textContent = this.formatDuration(stream.uptime);
      specValues[3].textContent = this.formatBytes(stream.total_bytes);
    }
    this.renderSourceNote(card, stream.channel_id);

    const toggleLabel = card.querySelector(".clients-toggle span");
    if (toggleLabel) {
      toggleLabel.textContent = `Connected clients (${stream.client_count || 0})`;
    }

    const wrapper = card.querySelector(".select-wrapper");
    if (channelDbId && wrapper && wrapper.dataset.streamId !== String(stream.stream_id)) {
      wrapper.dataset.streamId = String(stream.stream_id);
      this.fetchStreamsForChannel(channelDbId).then((streams) => {
        if (card.isConnected && wrapper.dataset.streamId === String(stream.stream_id)) {
          this.renderSourceControl(wrapper, streams, stream.stream_id, stream.channel_id, channelName);
        }
      });
    }
  },

  createStreamCard(stream) {
    const channelDbId = this.channelsByUuid[stream.channel_id];
    const channelInfo = channelDbId ? this.channelsMap[channelDbId] : null;

    const card = document.createElement("article");
    card.className = "card stream-card";
    card.dataset.channelId = stream.channel_id;

    const isBuffering =
      stream.state === "buffering" ||
      stream.state === "connecting" ||
      stream.state === "initializing";
    const statusClass = isBuffering
      ? "status-buffering"
      : "status-live";
    const statusText = this.formatState(stream.state);

    const channelName =
      stream.channel_name ||
      (channelInfo ? channelInfo.name : "Unknown Channel");
    const groupName =
      channelInfo &&
      channelInfo.channel_group_id &&
      this.channelGroupsMap[channelInfo.channel_group_id]
        ? this.channelGroupsMap[channelInfo.channel_group_id]
        : "No Group";

    card.innerHTML = `
      <div class="stream-card-header">
        <div class="stream-title-area">
          <h3></h3>
          <span class="stream-group-badge"></span>
        </div>
        <span class="stream-status-badge"></span>
      </div>

      <div class="stream-card-specs">
        <div class="spec-item">
          <span class="spec-label">Bitrate now</span>
          <span class="spec-value"></span>
        </div>
        <div class="spec-item">
          <span class="spec-label">Clients</span>
          <span class="spec-value"></span>
        </div>
        <div class="spec-item">
          <span class="spec-label">Uptime</span>
          <span class="spec-value"></span>
        </div>
        <div class="spec-item">
          <span class="spec-label">Data sent</span>
          <span class="spec-value"></span>
        </div>
      </div>

      <div class="stream-override-box">
        <span class="override-label">Current source</span>
        <div class="select-wrapper">
          <div class="spinner is-small"></div>
        </div>
        <p class="source-note" role="status" hidden></p>
        <div class="stream-pills-container"></div>
      </div>

      <div class="stream-card-clients">
        <button type="button" class="clients-toggle" aria-expanded="false">
          <span></span>
          <i data-lucide="chevron-down"></i>
        </button>
        <div class="clients-list-container">
          <div class="loading-state is-compact"><div class="spinner is-small"></div></div>
        </div>
      </div>

      <div class="stream-card-actions">
        <button type="button" class="btn btn-secondary btn-find-source">Find a working source</button>
        <button type="button" class="btn btn-danger btn-stop-stream">Stop stream</button>
      </div>
    `;

    // API values only ever reach the card as text, never as markup.
    card.querySelector("h3").textContent = channelName;
    card.querySelector(".stream-group-badge").textContent = groupName;
    const badge = card.querySelector(".stream-status-badge");
    badge.classList.add(statusClass);
    badge.textContent = statusText;
    const specValues = card.querySelectorAll(".spec-value");
    this.renderRate(specValues[0], stream);
    specValues[1].textContent = String(stream.client_count || 0);
    specValues[2].textContent = this.formatDuration(stream.uptime);
    specValues[3].textContent = this.formatBytes(stream.total_bytes);
    this.renderSourceNote(card, stream.channel_id);
    card.querySelector(".select-wrapper").id = `select-wrapper-${stream.channel_id}`;
    card.querySelector(".stream-pills-container").id = `pills-container-${stream.channel_id}`;
    const clientsToggle = card.querySelector(".clients-toggle");
    clientsToggle.id = `toggle-${stream.channel_id}`;
    clientsToggle.setAttribute("aria-controls", `clients-list-${stream.channel_id}`);
    clientsToggle.querySelector("span").textContent = `Connected clients (${stream.client_count || 0})`;
    card.querySelector(".clients-list-container").id = `clients-list-${stream.channel_id}`;
    card.querySelector(".btn-stop-stream").dataset.channelId = stream.channel_id;

    const wrapper = card.querySelector(".select-wrapper");
    if (channelDbId) {
      wrapper.dataset.streamId = String(stream.stream_id);
      this.fetchStreamsForChannel(channelDbId).then((streams) => {
        this.renderSourceControl(
          wrapper,
          streams,
          stream.stream_id,
          stream.channel_id,
          channelName,
        );
      });
    } else if (wrapper) {
      wrapper.replaceChildren(SourcePicker.element("span", "select-placeholder", "Channel not found"));
    }

    const findBtn = card.querySelector(".btn-find-source");
    findBtn.addEventListener("click", () => {
      if (this.findRuns[stream.channel_id]) {
        delete this.findRuns[stream.channel_id];
        delete this.switchChecks[stream.channel_id];
        findBtn.textContent = "Find a working source";
        this.renderSourceNote(card, stream.channel_id);
      } else {
        this.findWorkingSource(stream.channel_id, channelName, findBtn);
      }
    });

    const stopBtn = card.querySelector(".btn-stop-stream");
    stopBtn.addEventListener("click", () => {
      this.stopStream(stream.channel_id, channelName);
    });

    const toggle = card.querySelector(".clients-toggle");
    const listContainer = card.querySelector(".clients-list-container");

    toggle.addEventListener("click", async () => {
      const isExpanded = toggle.classList.toggle("expanded");
      toggle.setAttribute("aria-expanded", String(isExpanded));
      listContainer.classList.toggle("show");

      if (isExpanded) {
        try {
          const detailData = await this.apiFetch(
            `/proxy/ts/status/${stream.channel_id}`,
          );
          const clients = detailData.clients || [];

          if (clients.length === 0) {
            listContainer.replaceChildren(SourcePicker.element("div", "clients-note", "No clients connected"));
            return;
          }

          listContainer.replaceChildren(...clients.map((client) => this.buildClientRow(client)));
        } catch (err) {
          listContainer.replaceChildren(SourcePicker.element("div", "clients-note is-error", "Could not load clients"));
        }
      }
    });

    return card;
  },

  async renderActiveStreams() {
    const grid = document.getElementById("active-streams-grid");

    SourcePicker.sync();

    if (this.activeStreams.length === 0) {
      grid.innerHTML = `
        <div class="empty-state">
          <h3>No live streams</h3>
          <p>Nothing is being proxied right now. Start a channel in your player and it will appear here.</p>
        </div>
      `;
      SourcePicker.drawIcons();
      return;
    }

    const activeIds = new Set(this.activeStreams.map((s) => s.channel_id));

    grid.querySelectorAll(".stream-card").forEach((card) => {
      if (!activeIds.has(card.dataset.channelId)) {
        card.remove();
      }
    });

    for (const stream of this.activeStreams) {
      let card = grid.querySelector(`[data-channel-id="${stream.channel_id}"]`);

      if (card) {
        this.updateStreamCard(card, stream);
      } else {
        card = this.createStreamCard(stream);
        grid.appendChild(card);
      }
    }

    grid
      .querySelectorAll(".empty-state, .loading-state")
      .forEach((el) => el.remove());
    SourcePicker.drawIcons();
  },

  renderChannelsExplorer() {
    const tbody = document.getElementById("channels-table-body");
    const caption = document.getElementById("channels-caption");
    const query = document
      .getElementById("channel-search-input")
      .value.toLowerCase()
      .trim();
    // A newer render cancels source loading started by an older one.
    const token = (this.explorerToken = (this.explorerToken || 0) + 1);

    const activeByChannelId = {};
    this.activeStreams.forEach((s) => {
      const id = this.channelsByUuid[s.channel_id];
      if (id) activeByChannelId[id] = s;
    });

    let rows;
    if (query) {
      // Search covers every channel. Sources load only when a channel is opened.
      rows = this.channels.filter((ch) => {
        const nameMatch = ch.name && ch.name.toLowerCase().includes(query);
        const groupMatch =
          (this.channelGroupsMap[ch.channel_group_id] || ch.channel_group?.name || "").toLowerCase().includes(query);
        return nameMatch || groupMatch;
      });
      rows.sort((a, b) => (a.channel_number || 0) - (b.channel_number || 0));
      const total = rows.length;
      rows = rows.slice(0, 150);
      if (caption) {
        caption.textContent = total > rows.length
          ? `Showing the first ${rows.length} of ${total} matches. Refine the search to narrow it down.`
          : "Search results. Open Compare sources to see a channel's sources.";
      }
    } else {
      rows = this.yourChannels(activeByChannelId);
      if (caption) caption.textContent = "Your channels: playing now and watched recently. Search to find any channel.";
    }

    if (rows.length === 0) {
      const tr = document.createElement("tr");
      const td = SourcePicker.element("td", "table-placeholder",
        query ? "No channels match" : "Channels you watch will appear here. Search to find any channel.");
      td.colSpan = 5;
      tr.append(td);
      tbody.replaceChildren(tr);
      return;
    }

    const built = rows.map((ch) => {
      const groupName =
        ch.channel_group_id && this.channelGroupsMap[ch.channel_group_id]
          ? this.channelGroupsMap[ch.channel_group_id]
          : "No Group";
      const activeStream = activeByChannelId[ch.id];
      const tr = this.buildChannelRow(ch, groupName, activeStream);
      this.fillChannelRow(tr, ch, activeStream, this.channelStreamsCache[ch.id] || null);
      return { ch, tr, activeStream };
    });
    tbody.replaceChildren(...built.map((row) => row.tr));

    if (!query) this.loadRowSources(built, token);
  },

  // Channels playing now first, then the ones seen playing recently on this device.
  yourChannels(activeByChannelId) {
    const recent = RecentChannels.read();
    const seen = new Set();
    const rows = [];
    Object.keys(activeByChannelId).forEach((id) => {
      const ch = this.channelsMap[id];
      if (ch && !seen.has(ch.id)) { seen.add(ch.id); rows.push(ch); }
    });
    Object.entries(recent)
      .sort((a, b) => b[1] - a[1])
      .forEach(([uuid]) => {
        const ch = this.channelsMap[this.channelsByUuid[uuid]];
        if (ch && !seen.has(ch.id)) { seen.add(ch.id); rows.push(ch); }
      });
    return rows.slice(0, 30);
  },

  // Loads sources for "your channels" one at a time, never as a burst.
  async loadRowSources(built, token) {
    for (const { ch, tr, activeStream } of built) {
      if (token !== this.explorerToken) return;
      if (this.channelStreamsCache[ch.id]) continue;
      const streams = await this.fetchStreamsForChannel(ch.id);
      if (token !== this.explorerToken || !tr.isConnected) return;
      this.fillChannelRow(tr, ch, activeStream, streams);
    }
  },

  fillChannelRow(tr, ch, activeStream, streams) {
    const [, , , sourceCell, actionsCell] = tr.children;
    if (!sourceCell || !actionsCell) return;

    if (streams && streams.length === 0) {
      sourceCell.replaceChildren(SourcePicker.element("span", "cell-negative", "No sources"));
      actionsCell.replaceChildren(SourcePicker.element("span", "cell-secondary", "–"));
      return;
    }

    if (streams) {
      // Playing channels show their active source; others show their first (highest priority).
      const current = streams.find((s) => String(s.id) === String(activeStream?.stream_id)) || streams[0];
      sourceCell.replaceChildren(...this.buildSourceCell(current));
    } else {
      sourceCell.replaceChildren(SourcePicker.element("span", "cell-secondary", activeStream ? "Loading sources" : "–"));
    }

    const button = SourcePicker.element("button", "btn btn-secondary source-browse-btn", "Compare sources");
    button.type = "button";
    button.setAttribute("aria-haspopup", "dialog");
    button.addEventListener("click", () => SourcePicker.open(ch.id, ch.name, ch.uuid));
    actionsCell.replaceChildren(button);
  },

  // Sends the switch, then checks in the background that the new source really plays.
  // Returns { check }, a promise of the check's verdict, without waiting for it.
  async switchStream(channelUuid, streamId, channelName, streamName, { quiet = false } = {}) {
    const fromId = this.activeStreams.find((stream) => stream.channel_id === channelUuid)?.stream_id;
    try {
      if (!quiet) Toast.show("Switching source", `${channelName}: switching to ${streamName}`, "info");

      await this.apiFetch(`/proxy/ts/change_stream/${channelUuid}`, {
        method: "POST",
        body: JSON.stringify({ stream_id: parseInt(streamId) }),
      });

      this.pendingSwitches[channelUuid] = { from: fromId, to: streamId, at: Date.now() };
      delete this.outsideChanges[channelUuid];
      const token = { label: `Checking that ${streamName} plays…` };
      this.switchChecks[channelUuid] = token;

      // Refresh both pages so the user sees the change regardless of which tab they're on
      await this.refreshActiveStreamsOnly();
      if (document.getElementById("channels-table-body")) {
        this.renderChannelsExplorer();
      }

      const check = this.confirmSwitch(channelUuid, fromId, streamId, channelName, streamName, token, quiet);
      return { check };
    } catch (err) {
      console.error(err);
      if (!quiet) Toast.show("Switch failed", `Could not switch stream: ${err.message}`, "error");
      throw err;
    }
  },

  async confirmSwitch(channelUuid, fromId, toId, channelName, streamName, token, quiet) {
    const started = Date.now();
    const samples = [];
    const card = () => document.querySelector(`.stream-card[data-channel-id="${channelUuid}"]`);
    const finish = (verdict) => {
      if (this.switchChecks[channelUuid] === token) delete this.switchChecks[channelUuid];
      const element = card();
      if (element) this.renderSourceNote(element, channelUuid);
      if (!quiet) this.reportSwitch(verdict, channelUuid, fromId, channelName, streamName);
      return verdict;
    };
    const element = card();
    if (element) this.renderSourceNote(element, channelUuid);
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      if (this.switchChecks[channelUuid] !== token) return { outcome: "superseded" };
      try {
        await this.fetchActiveStreams();
      } catch {
        // A missed reading is not a verdict; keep checking until the time runs out.
        if (Date.now() - started >= StreamHealth.SWITCH_TIMEOUT_MS) return finish({ outcome: "stuck" });
        continue;
      }
      const current = this.activeStreams.find((stream) => stream.channel_id === channelUuid);
      samples.push(StreamHealth.sample(current));
      const verdict = StreamHealth.evaluateSwitch(samples, fromId, toId, Date.now() - started);
      if (verdict.outcome !== "pending") return finish(verdict);
    }
  },

  reportSwitch(verdict, channelUuid, fromId, channelName, streamName) {
    if (verdict.outcome === "live") {
      Toast.show("Playing", `${channelName} is live on ${streamName}.`, "success");
    } else if (verdict.outcome === "stuck") {
      const goBack = fromId != null && this.activeStreams.some((stream) => stream.channel_id === channelUuid);
      Toast.show("Not playing yet", `${streamName} has not started on ${channelName} after 25 seconds.`, "warning",
        goBack ? {
          action: {
            label: "Go back to previous source",
            onClick: () => this.switchStream(channelUuid, fromId, channelName, this.sourceName(channelUuid, fromId)).catch(() => {}),
          },
        } : {});
    } else if (verdict.outcome === "moved") {
      Toast.show("Source changed again",
        `${channelName} is now on ${this.sourceName(channelUuid, verdict.streamId)}. Dispatcharr or another device changed it.`,
        "warning");
    } else if (verdict.outcome === "stopped") {
      Toast.show("Channel stopped", `${channelName} stopped while the new source was being checked.`, "info");
    }
  },

  // Tries the channel's other sources in priority order until one plays.
  async findWorkingSource(channelUuid, channelName, button) {
    if (this.findRuns[channelUuid]) return;
    const run = {};
    this.findRuns[channelUuid] = run;
    const label = (text) => { if (button?.isConnected) button.textContent = text; };
    try {
      const channelDbId = this.channelsByUuid[channelUuid];
      if (!channelDbId) throw new Error("This channel is not in Swaparr's channel list. Refresh and try again.");
      const streams = await this.apiFetch(`/api/channels/channels/${channelDbId}/streams/`);
      this.channelStreamsCache[channelDbId] = streams || [];
      const startId = this.activeStreams.find((stream) => stream.channel_id === channelUuid)?.stream_id;
      const candidates = (streams || []).filter((source) => String(source.id) !== String(startId));
      if (!candidates.length) {
        Toast.show("No other sources", `${channelName} has no other sources to try.`, "info");
        return;
      }
      for (const [index, source] of candidates.entries()) {
        if (this.findRuns[channelUuid] !== run) return;
        if (!this.activeStreams.some((stream) => stream.channel_id === channelUuid)) {
          Toast.show("Channel stopped", `${channelName} is no longer playing.`, "info");
          return;
        }
        label(`Trying ${index + 1} of ${candidates.length}… (tap to stop)`);
        const name = source.name || `Stream #${source.id}`;
        const { check } = await this.switchStream(channelUuid, source.id, channelName, name, { quiet: true });
        const verdict = await check;
        if (this.findRuns[channelUuid] !== run) return;
        if (verdict.outcome === "live") {
          const tries = index + 1;
          Toast.show("Found a working source", `${channelName} is playing ${name} (${this.formatAccountName(source.m3u_account)}) after ${tries} ${tries === 1 ? "try" : "tries"}.`, "success");
          return;
        }
        if (verdict.outcome === "stopped") {
          Toast.show("Channel stopped", `${channelName} stopped while sources were being tried.`, "info");
          return;
        }
      }
      let back = "";
      const nowId = this.activeStreams.find((stream) => stream.channel_id === channelUuid)?.stream_id;
      if (startId != null && String(nowId) !== String(startId) && this.findRuns[channelUuid] === run) {
        try {
          await this.switchStream(channelUuid, startId, channelName, this.sourceName(channelUuid, startId), { quiet: true });
          back = " Swaparr switched back to the source it started on.";
        } catch {
          back = " Swaparr could not switch back to the source it started on.";
        }
      }
      Toast.show("No working source found", `Tried ${candidates.length} other ${candidates.length === 1 ? "source" : "sources"} for ${channelName}; none started playing.${back}`, "warning");
    } catch (err) {
      Toast.show("Could not try sources", err.message, "error");
    } finally {
      if (this.findRuns[channelUuid] === run) delete this.findRuns[channelUuid];
      label("Find a working source");
    }
  },

  async stopStream(channelUuid, channelName) {
    if (
      !confirm(
        `Are you sure you want to stop the stream for "${channelName}"? This will disconnect all connected viewers.`,
      )
    ) {
      return;
    }

    try {
      Toast.show(
        "Stopping stream",
        `Releasing client slots for ${channelName}`,
        "info",
      );

      // Try DELETE first. Fall back to POST only when the server says DELETE is
      // not supported; any other failure is reported as it is, not retried.
      try {
        await this.apiFetch(`/proxy/ts/stop/${channelUuid}`, {
          method: "DELETE",
        });
      } catch (e) {
        if (e.status !== 405 && e.status !== 501) throw e;
        await this.apiFetch(`/proxy/ts/stop/${channelUuid}`, {
          method: "POST",
          body: JSON.stringify({}),
        });
      }

      Toast.show(
        "Stream stopped",
        `${channelName} stopped and client slots released`,
        "success",
      );
      this.refreshActiveStreamsOnly();
    } catch (err) {
      console.error(err);
      Toast.show(
        "Stop failed",
        `Could not stop stream: ${err.message}`,
        "error",
      );
    }
  },

  // Format helpers
  // Builders below take API values as text only. Channel, group, stream, provider and
  // client strings come from third-party playlists and players, so they are never markup.
  buildChannelRow(ch, groupName, activeStream) {
    const tr = document.createElement("tr");
    const number = SourcePicker.element("td", "");
    number.append(SourcePicker.element("span", "channel-no-badge", String(ch.channel_number || "-")));
    const name = SourcePicker.element("td", "channel-name-cell", String(ch.name ?? ""));
    if (activeStream) {
      name.append(SourcePicker.element("span", "stream-status-badge status-live", this.formatState(activeStream.state)));
    }
    const group = SourcePicker.element("td", "channel-group-cell", String(groupName ?? ""));
    const source = SourcePicker.element("td", "channel-stream-cell");
    source.id = `source-cell-${ch.id}`;
    source.append(SourcePicker.element("span", "cell-secondary", "Loading sources"));
    const actions = SourcePicker.element("td", "actions-cell");
    actions.id = `actions-cell-${ch.id}`;
    actions.append(SourcePicker.element("div", "spinner is-small"));
    tr.append(number, name, group, source, actions);
    return tr;
  },

  buildSourceCell(stream) {
    return [
      SourcePicker.element("span", "cell-primary", String(stream.name || `Stream #${stream.id}`)),
      SourcePicker.element("span", "cell-secondary", this.formatAccountName(stream.m3u_account)),
    ];
  },

  buildClientRow(client) {
    const row = SourcePicker.element("div", "client-row");
    const info = SourcePicker.element("div", "client-info");
    if (client.user_id && client.user_id !== "0") {
      info.append(SourcePicker.element("span", "client-user", this.usersMap[client.user_id] || `User #${client.user_id}`));
    }
    const userAgent = String(client.user_agent || "");
    const agent = SourcePicker.element("span", "client-ua", userAgent);
    agent.title = userAgent;
    info.append(SourcePicker.element("span", "client-ip", String(client.ip_address || "")), agent);
    const rate = Number(client.current_rate_KBps);
    const stats = SourcePicker.element("div", "client-stats");
    stats.append(
      SourcePicker.element("span", "client-rate", Number.isFinite(rate) && rate > 0 ? `${rate.toFixed(1)} KB/s` : "0 KB/s"),
      SourcePicker.element("span", "client-uptime", client.connected_at ? this.formatDuration(Date.now() / 1000 - client.connected_at) : ""),
    );
    row.append(info, stats);
    return row;
  },

  formatState(state) {
    const labels = { active: "Live", buffering: "Buffering", connecting: "Connecting", initializing: "Starting" };
    if (labels[state]) return labels[state];
    return state ? state.charAt(0).toUpperCase() + state.slice(1) : "Live";
  },

  formatDuration(seconds) {
    if (isNaN(seconds) || seconds <= 0) return "0s";

    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    const parts = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    if (s > 0 || parts.length === 0) parts.push(`${s}s`);

    return parts.join(" ");
  },

  formatBitrate(bytes, uptimeSeconds) {
    if (!bytes || !uptimeSeconds || uptimeSeconds <= 0) return "0.00 Kbps";

    // (bytes * 8) / uptime / 1000 = Kbps
    const kbps = (bytes * 8) / uptimeSeconds / 1000;

    if (kbps > 1000) {
      return `${(kbps / 1000).toFixed(2)} Mbps`;
    }
    return `${kbps.toFixed(2)} Kbps`;
  },

  formatKbps(kbps) {
    if (!(kbps > 0)) return "0.00 Kbps";
    return kbps > 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${kbps.toFixed(2)} Kbps`;
  },

  formatBytes(bytes) {
    if (isNaN(bytes) || bytes <= 0) return "0 B";

    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  },
};

// Initialize app when window loads
window.addEventListener("DOMContentLoaded", () => {
  State.init();
});
