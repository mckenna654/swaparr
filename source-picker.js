/* Shared source picker: browsing never changes the playing stream. */
const SourcePicker = {
  session: null,

  element(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text != null) element.textContent = text;
    return element;
  },

  async open(channelId, channelName, channelUuid) {
    if (this.session) return;
    const dialog = this.element("dialog", "source-picker");
    dialog.setAttribute("aria-labelledby", "picker-title");
    dialog.setAttribute("aria-describedby", "picker-description");
    const panel = this.element("div", "picker-panel");
    const header = this.element("header", "picker-header");
    const heading = this.element("div", "");
    const title = this.element("h2", "", "Choose stream source");
    title.id = "picker-title";
    heading.append(title, this.element("p", "picker-channel", channelName));
    const close = this.element("button", "icon-btn picker-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close source picker");
    header.append(heading, close);
    const description = this.element("p", "picker-description", "Last-probed quality. Values may have changed.");
    description.id = "picker-description";
    const toolbar = this.element("div", "picker-toolbar");
    const edit = this.element("button", "btn btn-secondary order-edit", "Edit source order");
    edit.type = "button";
    edit.disabled = true;
    const cancel = this.element("button", "btn btn-secondary order-cancel", "Cancel ordering");
    cancel.type = "button";
    cancel.hidden = true;
    const reload = this.element("button", "btn btn-secondary order-reload", "Reload saved order");
    reload.type = "button";
    reload.hidden = true;
    toolbar.append(edit, cancel, reload);
    const list = this.element("div", "picker-list");
    list.setAttribute("role", "group");
    list.setAttribute("aria-label", "Available stream sources");
    list.textContent = "Loading sources…";
    const footer = this.element("footer", "picker-footer");
    const message = this.element("p", "picker-message");
    message.setAttribute("role", "status");
    const confirm = this.element("button", "btn picker-confirm", "Choose a source");
    confirm.type = "button";
    confirm.disabled = true;
    const hint = this.element("p", "picker-hint", "Your stream changes only when you confirm.");
    footer.append(message, confirm, hint);
    panel.append(header, description, toolbar, list, footer);
    dialog.append(panel);
    const session = { dialog, list, message, confirm, close, edit, cancel, reload, title, hint, channelId, channelUuid, channelName,
      streams: [], draft: [], editing: false, selected: null, busy: false, trigger: document.activeElement };
    this.session = session;
    const dismiss = () => { if (!session.busy) dialog.close(); };
    close.addEventListener("click", dismiss);
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dismiss(); });
    dialog.addEventListener("cancel", (event) => { if (session.busy) event.preventDefault(); });
    dialog.addEventListener("close", () => {
      this.session = null;
      document.body.classList.remove("picker-open");
      dialog.remove();
      if (session.trigger?.isConnected) session.trigger.focus();
      else document.getElementById("refresh-btn")?.focus();
    });
    edit.addEventListener("click", () => {
      session.editing = true;
      session.draft = [...session.streams];
      session.error = "";
      this.renderSources();
      this.sync();
      session.list.querySelector(".order-down")?.focus();
    });
    cancel.addEventListener("click", () => {
      session.editing = false;
      session.error = "";
      session.conflict = false;
      this.renderSources();
      this.sync();
      edit.focus();
    });
    reload.addEventListener("click", () => this.reloadOrder());
    confirm.addEventListener("click", () => session.editing ? this.saveOrder() : this.confirm());
    document.body.append(dialog);
    document.body.classList.add("picker-open");
    dialog.showModal();
    close.focus();
    try {
      // Opening the picker deliberately fetches fresh choices, independently of card caches.
      const streams = await State.apiFetch(`/api/channels/channels/${channelId}/streams/`);
      if (this.session !== session) return;
      this.validateStreams(streams);
      session.streams = streams;
      State.channelStreamsCache[channelId] = streams;
      this.renderSources();
      this.sync();
    } catch {
      if (this.session !== session) return;
      list.textContent = "Could not load sources. Close this panel and try again.";
    }
  },

  validateStreams(streams) {
    if (!Array.isArray(streams) || streams.some(stream => !Number.isSafeInteger(stream.id) || stream.id <= 0)
      || new Set(streams.map(stream => stream.id)).size !== streams.length) {
      throw new Error("Unexpected source response. No order was saved.");
    }
  },

  sameOrder(left, right) {
    return left.length === right.length && left.every((stream, i) => stream.id === right[i].id);
  },

  renderSources() {
    const session = this.session;
    const { list, editing } = session;
    const streams = editing ? session.draft : session.streams;
    list.replaceChildren();
    if (!streams.length) list.textContent = "No sources are configured for this channel.";
    streams.forEach((stream, index) => {
        const row = this.element(editing ? "div" : "label", "source-option");
        row.dataset.sourceId = String(stream.id);
        const radio = this.element("input", "source-radio");
        radio.type = "radio";
        radio.name = "stream-source";
        radio.value = String(stream.id);
        const content = this.element("span", "source-option-content");
        content.append(this.element("strong", "source-provider", State.formatAccountName(stream.m3u_account)),
          this.element("span", "source-name", stream.name || `Stream #${stream.id}`));
        const quality = this.element("span", "source-quality");
        const values = State.formatStreamQuality(stream.stream_stats);
        (values ? values.split(" · ") : ["Quality unknown"]).forEach(value => quality.append(this.element("span", "quality-tag", value)));
        content.append(quality);
        const status = this.element("span", "source-choice-status");
        if (editing) {
          const handle = this.element("button", "order-handle", "⠿");
          handle.type = "button";
          handle.setAttribute("aria-label", `Drag source ${index + 1} to reorder; or use the move buttons`);
          handle.addEventListener("pointerdown", event => {
            if (session.busy || event.button !== 0) return;
            handle.setPointerCapture(event.pointerId);
            session.drag = { id: stream.id, target: stream.id };
            row.classList.add("is-dragging");
          });
          handle.addEventListener("pointermove", event => {
            if (!session.drag) return;
            const bounds = list.getBoundingClientRect();
            if (event.clientY < bounds.top + 40) list.scrollTop -= 15;
            if (event.clientY > bounds.bottom - 40) list.scrollTop += 15;
            const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".source-option");
            if (!target || !list.contains(target)) return;
            session.drag.target = Number(target.dataset.sourceId);
            list.querySelectorAll(".source-option").forEach(item => item.classList.toggle("is-drop-target", item === target));
          });
          const finish = event => {
            const drag = session.drag;
            session.drag = null;
            if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
            list.querySelectorAll(".source-option").forEach(item => item.classList.remove("is-dragging", "is-drop-target"));
            if (drag && event.type === "pointerup") this.moveSource(drag.id, session.draft.findIndex(item => item.id === drag.target), "order-handle");
          };
          handle.addEventListener("pointerup", finish);
          handle.addEventListener("pointercancel", finish);
          const controls = this.element("div", "order-controls");
          [["up", "↑", -1], ["down", "↓", 1]].forEach(([direction, symbol, delta]) => {
            const button = this.element("button", `icon-btn order-${direction}`, symbol);
            button.type = "button";
            button.disabled = index + delta < 0 || index + delta >= streams.length;
            button.setAttribute("aria-label", `Move source ${index + 1} ${direction}`);
            button.addEventListener("click", () => this.moveSource(stream.id, index + delta, `order-${direction}`));
            controls.append(button);
          });
          const rank = this.element("span", "source-rank", String(index + 1));
          row.append(handle, rank, content, controls);
        } else row.append(content, status, radio);
        radio.addEventListener("change", () => {
          session.selected = stream;
          this.sync();
        });
        list.append(row);
    });
  },

  moveSource(id, target, focusClass) {
    const session = this.session;
    if (!session?.editing || session.busy || target < 0 || target >= session.draft.length) return;
    const index = session.draft.findIndex(stream => stream.id === id);
    if (index < 0 || index === target) return;
    session.draft.splice(target, 0, session.draft.splice(index, 1)[0]);
    this.renderSources();
    this.sync();
    const row = session.list.querySelector(`[data-source-id="${id}"]`);
    const control = row.querySelector(`.${focusClass}`);
    (control.disabled ? row.querySelector(".order-handle") : control).focus();
    row.scrollIntoView({ block: "nearest" });
    session.message.textContent = `Source moved to position ${target + 1}. Save order to apply.`;
  },

  setBusy(busy) {
    const session = this.session;
    session.busy = busy;
    session.dialog.querySelectorAll("button, input").forEach(control => { control.disabled = busy; });
  },

  async reloadOrder() {
    const session = this.session;
    if (!session || session.busy) return;
    this.setBusy(true);
    try {
      const streams = await State.apiFetch(`/api/channels/channels/${session.channelId}/streams/`);
      this.validateStreams(streams);
      session.streams = streams;
      session.draft = [...streams];
      session.selected = null;
      session.conflict = false;
      session.error = "";
      State.channelStreamsCache[session.channelId] = streams;
    } catch (error) {
      session.error = `Could not reload sources: ${error.message}`;
    } finally {
      this.setBusy(false);
      this.renderSources();
      this.sync();
    }
  },

  async saveOrder() {
    const session = this.session;
    if (!session?.editing || session.busy || session.confirm.disabled) return;
    this.setBusy(true);
    session.confirm.textContent = "Saving order…";
    let saved = false;
    try {
      this.validateStreams(session.draft);
      const latest = await State.apiFetch(`/api/channels/channels/${session.channelId}/streams/`);
      this.validateStreams(latest);
      if (!this.sameOrder(latest, session.streams)) {
        session.conflict = true;
        throw new Error("Sources changed in Dispatcharr. Reload saved order and arrange them again; nothing was overwritten.");
      }
      if (session.draft.length !== latest.length || session.draft.some(stream => !latest.some(item => item.id === stream.id))) {
        throw new Error("The source list is incomplete. Close the picker and try again.");
      }
      await State.apiFetch(`/api/channels/channels/${session.channelId}/`, {
        method: "PATCH", body: JSON.stringify({ streams: session.draft.map(stream => stream.id) }),
      });
      saved = true;
      const verified = await State.apiFetch(`/api/channels/channels/${session.channelId}/streams/`);
      this.validateStreams(verified);
      if (!this.sameOrder(verified, session.draft)) throw new Error("Dispatcharr returned a different order.");
      session.streams = verified;
      State.channelStreamsCache[session.channelId] = verified;
      session.editing = false;
      session.error = "";
      session.conflict = false;
      Toast.show("Source order saved", "Priority updated in Dispatcharr. Current playback is unchanged.", "success");
      State.renderChannelsExplorer();
    } catch (error) {
      // A failed response may still follow a successful write. Reload before any retry
      // when confirmation was received but the read-back could not be verified.
      session.conflict = session.conflict || saved;
      session.error = saved ? `Order submitted, but verification failed. Reload saved order to check. ${error.message}`
        : `Could not save order: ${error.message}`;
    } finally {
      this.setBusy(false);
      this.renderSources();
      this.sync();
    }
  },

  sync() {
    const session = this.session;
    if (!session || session.busy) return;
    session.edit.hidden = session.editing;
    session.edit.disabled = session.streams.length < 2;
    session.cancel.hidden = !session.editing;
    session.reload.hidden = !session.editing || !session.conflict;
    session.confirm.classList.toggle("order-save", session.editing);
    session.title.textContent = session.editing ? "Edit source order" : "Choose stream source";
    session.hint.textContent = session.editing ? "First source = highest priority. Saving does not switch current playback."
      : "Your stream changes only when you confirm.";
    if (session.editing) {
      session.confirm.textContent = "Save order";
      session.confirm.disabled = !!session.conflict || this.sameOrder(session.draft, session.streams);
      session.message.textContent = session.error || "Drag a handle or use the arrows to set source priority.";
      return;
    }
    const active = State.activeStreams.find(stream => stream.channel_id === session.channelUuid);
    session.list.querySelectorAll(".source-option").forEach(row => {
      const radio = row.querySelector("input");
      const playing = active && String(active.stream_id) === radio.value;
      const selected = session.selected && String(session.selected.id) === radio.value;
      row.classList.toggle("is-selected", !!selected);
      radio.checked = !!selected;
      row.querySelector(".source-choice-status").textContent = playing ? "Playing" : selected ? "Selected" : "";
    });
    const same = session.selected && active && String(session.selected.id) === String(active.stream_id);
    session.confirm.disabled = !active || !session.selected || same;
    session.confirm.textContent = same ? "Already playing" : session.selected
      ? `Switch to ${State.formatAccountName(session.selected.m3u_account)}` : "Choose a source";
    session.message.textContent = session.error || (active ? "" : "Channel offline. You can compare sources; switching is available while playing.");
  },

  async confirm() {
    const session = this.session;
    if (!session || session.busy || session.confirm.disabled) return;
    this.setBusy(true);
    session.error = "";
    session.confirm.disabled = true;
    session.close.disabled = true;
    session.list.querySelectorAll("input").forEach(input => { input.disabled = true; });
    session.confirm.textContent = "Switching…";
    try {
      // Recheck the channel before changing it, including when polling was disabled.
      const status = await State.apiFetch("/proxy/ts/status");
      const active = (status.channels || []).find(stream => stream.channel_id === session.channelUuid);
      if (!active) throw new Error("This channel has stopped. Start playback before switching sources.");
      if (String(active.stream_id) !== String(session.selected.id)) {
        await State.switchStream(session.channelUuid, session.selected.id, session.channelName, session.selected.name);
      }
      session.dialog.close();
    } catch (error) {
      this.setBusy(false);
      session.error = error.message || "Could not switch sources. Please try again.";
      this.sync();
    }
  },
};
