// Run with Playwright installed: node tests/source-picker.browser.cjs
// Optional PLAYWRIGHT_MODULE, LUCIDE_SCRIPT, CHROME_PATH, SCREENSHOT_DIR overrides.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");
const screenshots = process.env.SCREENSHOT_DIR || "/private/tmp/swaparr-ui-check";
fs.mkdirSync(screenshots, { recursive: true });

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const sources = [
      { id: 1, name: "AU: Fox Sports 502", m3u_account: { name: "Infinity" }, stream_stats: { resolution: "1920x1080", source_fps: 50, video_codec: "h264", audio_codec: "ac3", audio_channels: "5.1" } },
      { id: 2, name: "AU | FOX SPORTS 502 HD", m3u_account: { name: "Promax" }, stream_stats: { resolution: "1280x720", source_fps: 25, video_codec: "h264" } },
      { id: 3, name: "Fox Sports 502 FHD", m3u_account: { name: "A1X Media" }, stream_stats: { resolution: "1920x1080", source_fps: 50, video_codec: "hevc" } },
      { id: 4, name: "AU | Fox Sports 502 FHD", m3u_account: { name: "B1G" } },
    ];
    let active = [{ channel_id: "fox-502", channel_name: "Fox Sports 502", stream_id: 1, state: "active", uptime: 598, total_bytes: 487230000, client_count: 1 }];
    const writes = [];
    const orderWrites = [];
    let failOrder = false;
    let failReadBack = false;
    let rejectNextSourceRead = false;
    let failSwitch = false;
    let failSources = false;
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.hostname === "unpkg.com") {
        if (process.env.LUCIDE_SCRIPT) return route.fulfill({ contentType: "text/javascript", body: fs.readFileSync(process.env.LUCIDE_SCRIPT) });
        return route.continue();
      }
      const endpoint = url.pathname.replace("/dispatcharr-api", "");
      let data;
      if (endpoint === "/config.json") data = { url: "/dispatcharr-api" };
      else if (endpoint === "/proxy/ts/status") data = { channels: active };
      else if (endpoint.startsWith("/proxy/ts/change_stream/")) {
        writes.push(route.request().postDataJSON());
        if (failSwitch) return route.fulfill({ status: 500, body: "Failed" });
        active[0].stream_id = writes.at(-1).stream_id;
        data = { success: true };
      } else if (endpoint.endsWith("/streams/")) {
        if (rejectNextSourceRead) {
          rejectNextSourceRead = false;
          return route.fulfill({ status: 503, body: "Unavailable" });
        }
        if (failSources) return route.fulfill({ status: 503, body: "Unavailable" });
        data = sources;
      } else if (endpoint === "/api/channels/channels/10/" && route.request().method() === "PATCH") {
        const payload = route.request().postDataJSON();
        orderWrites.push(payload);
        if (failOrder) return route.fulfill({ status: 403, body: "Forbidden" });
        assert.deepEqual(Object.keys(payload), ["streams"]);
        assert.deepEqual([...payload.streams].sort(), sources.map(source => source.id).sort());
        const ordered = payload.streams.map(id => sources.find(source => source.id === id));
        sources.splice(0, sources.length, ...ordered);
        rejectNextSourceRead = failReadBack;
        // A valid empty success response is supported too.
        return route.fulfill({ status: 204 });
      } else if (endpoint === "/api/channels/channels/") data = [{ id: 10, uuid: "fox-502", name: "Fox Sports 502", channel_number: 502, channel_group_id: 1 }];
      else if (endpoint === "/api/channels/groups/") data = [{ id: 1, name: "FOXTEL" }];
      else if (endpoint.startsWith("/api/")) data = [];
      if (data !== undefined) return route.fulfill({ json: data });
      const file = path.join(root, endpoint === "/" ? "index.html" : endpoint);
      const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };
      if (fs.existsSync(file)) return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] });
      return route.fulfill({ status: 404, body: "Not found" });
    });
    await page.goto("http://swaparr.test/");
    // Public documentation screenshots must obscure channel/provider identities,
    // including the background behind the modal. This style exists only in tests.
    await page.addStyleTag({ content: `
      .stream-title-area h3, .stream-group-badge, .current-provider,
      .current-source-name, .picker-channel, .source-provider, .source-name,
      .channel-name-cell, .channel-group-cell, .channel-stream-cell, .channel-no-badge {
        filter: blur(8px) !important;
      }
      .picker-confirm:not(.order-save) {
        color: transparent !important;
        text-shadow: 0 0 9px #14201d !important;
      }
    ` });
    const change = page.getByRole("button", { name: "Change source", exact: true });
    await change.waitFor();
    await page.evaluate(() => State.stopAutoRefresh());
    assert.match(await page.locator(".current-source").innerText(), /Infinity/);
    const sourceBox = await page.locator(".current-source").boundingBox();
    const changeBox = await change.boundingBox();
    assert.ok(changeBox.y >= sourceBox.y + sourceBox.height, "Source name stays visible above the button");
    await page.locator(".stream-card").screenshot({ path: path.join(screenshots, "live-card.png") });
    await change.click();
    await page.locator(".source-option").nth(3).waitFor();
    assert.equal(await page.locator(".source-option").count(), 4);
    assert.match(await page.locator(".source-option").nth(0).innerText(), /Playing/);
    assert.match(await page.locator(".source-option").nth(3).innerText(), /Quality unknown/);
    await page.locator(".source-radio").nth(2).check();
    assert.equal(writes.length, 0, "Browsing must not switch playback");
    await page.screenshot({ path: path.join(screenshots, "picker-mobile.png") });
    await page.keyboard.press("Escape");
    await page.locator("dialog").waitFor({ state: "detached" });
    assert.equal(writes.length, 0);
    assert.equal(await change.evaluate(element => document.activeElement === element), true);
    await change.click();
    await page.locator(".source-radio").nth(0).check();
    assert.equal(await page.locator(".picker-confirm").isDisabled(), true);
    await page.locator(".source-radio").nth(2).check();
    failSwitch = true;
    await page.locator(".picker-confirm").click();
    await page.waitForFunction(() => document.querySelector(".picker-message").textContent.includes("HTTP 500"));
    assert.equal(await page.locator("dialog").isVisible(), true, "Failure keeps picker open for retry");
    failSwitch = false;
    await page.locator(".picker-confirm").click();
    await page.locator("dialog").waitFor({ state: "detached" });
    assert.equal(writes.length, 2);
    assert.deepEqual(writes.at(-1), { stream_id: 3 });
    assert.match(await page.locator(".current-source").innerText(), /A1X Media/);
    // Polling updates current source and quality together after an external switch.
    active[0].stream_id = 2;
    await page.evaluate(() => State.refreshActiveStreamsOnly());
    await page.waitForFunction(() => document.querySelector(".current-provider").textContent === "Promax");
    assert.match(await page.locator(".stream-pills-container").innerText(), /720p/);
    await change.click();
    await page.locator(".source-radio").nth(0).check();
    active = [];
    await page.evaluate(() => State.refreshActiveStreamsOnly());
    assert.equal(await page.locator(".picker-confirm").isDisabled(), true);
    assert.match(await page.locator(".picker-message").innerText(), /offline/);
    await page.keyboard.press("Escape");
    await page.locator("dialog").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Compare sources" }).click();
    await page.locator(".source-option").nth(3).waitFor();
    assert.equal(await page.locator(".picker-confirm").isDisabled(), true);
    await page.keyboard.press("Escape");
    await page.locator("dialog").waitFor({ state: "detached" });
    failSources = true;
    await page.getByRole("button", { name: "Compare sources" }).click();
    await page.waitForFunction(() => document.querySelector(".picker-list").textContent.includes("Could not load"));
    await page.keyboard.press("Escape");
    await page.locator("dialog").waitFor({ state: "detached" });
    failSources = false;
    // Many sources and long labels must stay inside the viewport.
    sources.push(...Array.from({ length: 15 }, (_, i) => ({ id: 100 + i, name: "A very long stream name ".repeat(5), m3u_account: { name: "Additional provider" } })));
    await page.setViewportSize({ width: 320, height: 568 });
    await page.getByRole("button", { name: "Compare sources" }).click();
    await page.locator(".source-option").nth(18).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator(".picker-list").evaluate(element => element.scrollHeight > element.clientHeight), true);
    const footer = await page.locator(".picker-footer").boundingBox();
    assert.ok(footer.y + footer.height <= 569, "Confirmation remains visible");
    await page.keyboard.press("Escape");
    await page.locator("dialog").waitFor({ state: "detached" });
    sources.splice(4);
    active = [{ channel_id: "fox-502", channel_name: "Fox Sports 502", stream_id: 1, state: "active", uptime: 598, total_bytes: 487230000, client_count: 1 }];
    await page.evaluate(() => State.refreshActiveStreamsOnly());
    await page.setViewportSize({ width: 1280, height: 900 });
    await change.click();
    await page.locator(".source-radio").nth(2).check();
    await page.screenshot({ path: path.join(screenshots, "picker-desktop.png") });
    // Tab and Shift+Tab stay within the native modal.
    for (let i = 0; i < 10; i++) await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.querySelector("dialog").contains(document.activeElement)), true);
    await page.keyboard.press("Escape");
    await page.locator("dialog").waitFor({ state: "detached" });

    const sourceIds = () => page.locator(".source-option").evaluateAll(rows => rows.map(row => Number(row.dataset.sourceId)));
    const openEditor = async () => {
      await page.getByRole("button", { name: "Compare sources" }).click();
      await page.getByRole("button", { name: "Edit source order", exact: true }).click();
    };
    const cancelOrdering = page.getByRole("button", { name: "Cancel ordering" });
    const saveOrder = page.getByRole("button", { name: "Save order", exact: true });
    const switchesBefore = writes.length;
    await page.setViewportSize({ width: 390, height: 844 });
    await openEditor();
    assert.equal(await saveOrder.isDisabled(), true);
    await page.getByRole("button", { name: "Move source 1 down", exact: true }).focus();
    await page.keyboard.press("Enter");
    assert.deepEqual(await sourceIds(), [2, 1, 3, 4]);
    assert.equal(orderWrites.length, 0, "Moving must remain a local draft");
    await cancelOrdering.click();
    assert.deepEqual(await sourceIds(), [1, 2, 3, 4]);
    await page.getByRole("button", { name: "Edit source order", exact: true }).click();
    await page.getByRole("button", { name: "Move source 3 up", exact: true }).click();
    await page.locator(".picker-confirm").evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished)));
    await page.screenshot({ path: path.join(screenshots, "source-order-mobile.png") });
    failOrder = true;
    await saveOrder.click();
    await page.waitForFunction(() => document.querySelector(".picker-message").textContent.includes("HTTP 403"));
    assert.deepEqual(sources.map(source => source.id), [1, 2, 3, 4]);
    assert.deepEqual(await sourceIds(), [1, 3, 2, 4], "Failed save preserves draft");
    failOrder = false;
    await saveOrder.click();
    await page.getByRole("button", { name: "Edit source order", exact: true }).waitFor();
    assert.deepEqual(orderWrites.at(-1), { streams: [1, 3, 2, 4] });
    assert.equal(active[0].stream_id, 1, "Saving must not switch active playback");
    await page.keyboard.press("Escape");
    await page.locator("dialog").waitFor({ state: "detached" });
    await openEditor();
    assert.deepEqual(await sourceIds(), [1, 3, 2, 4], "Saved order persists on reopening");
    // Change the source list elsewhere after opening the editor.
    await page.getByRole("button", { name: "Move source 1 down", exact: true }).click();
    sources.push({ id: 5, name: "New source", m3u_account: { name: "New provider" } });
    const beforeConflict = orderWrites.length;
    await saveOrder.click();
    await page.waitForFunction(() => document.querySelector(".picker-message").textContent.includes("Sources changed"));
    assert.equal(orderWrites.length, beforeConflict, "Concurrent additions must not be overwritten");
    assert.equal(await saveOrder.isDisabled(), true);
    await page.getByRole("button", { name: "Reload saved order" }).click();
    await page.locator(".source-option").nth(4).waitFor();
    assert.deepEqual(await sourceIds(), [1, 3, 2, 4, 5]);
    assert.equal(await saveOrder.isDisabled(), true);
    // External reorder (same IDs) must also be detected.
    await page.getByRole("button", { name: "Move source 1 down", exact: true }).click();
    sources.reverse();
    await saveOrder.click();
    await page.waitForFunction(() => document.querySelector(".picker-message").textContent.includes("Sources changed"));
    assert.equal(orderWrites.length, beforeConflict);
    await page.getByRole("button", { name: "Reload saved order" }).click();
    await page.waitForFunction(() => !SourcePicker.session.busy);
    // Save while offline and recover when the write succeeds but read-back fails.
    active = [];
    await page.evaluate(() => State.refreshActiveStreamsOnly());
    await page.getByRole("button", { name: "Move source 1 down", exact: true }).click();
    const offlineDraft = await sourceIds();
    failReadBack = true;
    await saveOrder.click();
    await page.waitForFunction(() => document.querySelector(".picker-message").textContent.includes("verification failed"));
    assert.deepEqual(sources.map(source => source.id), offlineDraft);
    assert.equal(await saveOrder.isDisabled(), true);
    failReadBack = false;
    await page.getByRole("button", { name: "Reload saved order" }).click();
    await page.waitForFunction(() => !SourcePicker.session.busy);
    assert.deepEqual(await sourceIds(), offlineDraft);
    await page.getByRole("button", { name: "Move source 1 down", exact: true }).click();
    await saveOrder.click();
    await page.getByRole("button", { name: "Edit source order", exact: true }).waitFor();
    assert.equal(writes.length, switchesBefore, "Ordering must never call change_stream");
    await page.getByRole("button", { name: "Edit source order", exact: true }).click();
    // Desktop pointer drag uses the same priority model as the arrow buttons.
    const beforeDrag = await sourceIds();
    const firstHandle = await page.locator(".order-handle").first().boundingBox();
    const secondRow = await page.locator(".source-option").nth(1).boundingBox();
    await page.mouse.move(firstHandle.x + 10, firstHandle.y + 10);
    await page.mouse.down();
    await page.mouse.move(secondRow.x + 20, secondRow.y + secondRow.height / 2, { steps: 6 });
    await page.mouse.up();
    assert.deepEqual(await sourceIds(), [beforeDrag[1], beforeDrag[0], ...beforeDrag.slice(2)]);
    const beforeTouch = await sourceIds();
    const touchHandle = await page.locator(".order-handle").first().boundingBox();
    const touchTarget = await page.locator(".source-option").nth(1).boundingBox();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touchHandle.x + 10, y: touchHandle.y + 10 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: touchTarget.x + 20, y: touchTarget.y + touchTarget.height / 2 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    assert.deepEqual(await sourceIds(), [beforeTouch[1], beforeTouch[0], ...beforeTouch.slice(2)], "Touch drag must reorder too");
    await cdp.detach();
    await page.setViewportSize({ width: 320, height: 568 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const orderFooter = await page.locator(".picker-footer").boundingBox();
    assert.ok(orderFooter.y + orderFooter.height <= 569);
    const beforeEscape = orderWrites.length;
    await page.keyboard.press("Escape");
    await page.locator("dialog").waitFor({ state: "detached" });
    assert.equal(orderWrites.length, beforeEscape);
    // Empty and single-source channels cannot enter the editor.
    sources.splice(1);
    await page.getByRole("button", { name: "Compare sources" }).click();
    await page.locator(".source-option").waitFor();
    assert.equal(await page.getByRole("button", { name: "Edit source order", exact: true }).isDisabled(), true);
    await page.keyboard.press("Escape");
    await page.locator("dialog").waitFor({ state: "detached" });
    sources.splice(0);
    await page.getByRole("button", { name: "Compare sources" }).click();
    await page.waitForFunction(() => document.querySelector(".picker-list").textContent.includes("No sources"));
    assert.equal(await page.getByRole("button", { name: "Edit source order", exact: true }).isDisabled(), true);
    await page.keyboard.press("Escape");
    assert.deepEqual(errors, [], "No browser runtime errors");
    console.log("PASS: playback picker plus draft cancellation, ordered PATCH persistence, offline save, permissions/retry, concurrent additions/reorder, read-back failure, drag, narrow layout, empty/single sources, and no playback mutations during ordering");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
