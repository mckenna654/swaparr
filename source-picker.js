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
    footer.append(message, confirm, this.element("p", "picker-hint", "Your stream changes only when you confirm."));
    panel.append(header, description, list, footer);
    dialog.append(panel);
    const session = { dialog, list, message, confirm, close, channelId, channelUuid, channelName,
      streams: [], selected: null, busy: false, trigger: document.activeElement };
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
    confirm.addEventListener("click", () => this.confirm());
    document.body.append(dialog);
    document.body.classList.add("picker-open");
    dialog.showModal();
    close.focus();
    try {
      // Opening the picker deliberately fetches fresh choices, independently of card caches.
      const streams = await State.apiFetch(`/api/channels/channels/${channelId}/streams/`);
      if (this.session !== session) return;
      if (!Array.isArray(streams)) throw new Error("Unexpected source response");
      session.streams = streams;
      State.channelStreamsCache[channelId] = streams;
      list.replaceChildren();
      if (!streams.length) list.textContent = "No sources are configured for this channel.";
      streams.forEach((stream) => {
        const row = this.element("label", "source-option");
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
        row.append(content, status, radio);
        radio.addEventListener("change", () => {
          session.selected = stream;
          this.sync();
        });
        list.append(row);
      });
      this.sync();
    } catch {
      if (this.session !== session) return;
      list.textContent = "Could not load sources. Close this panel and try again.";
    }
  },

  sync() {
    const session = this.session;
    if (!session || session.busy) return;
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
    session.busy = true;
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
      session.busy = false;
      session.close.disabled = false;
      session.list.querySelectorAll("input").forEach(input => { input.disabled = false; });
      session.error = error.message || "Could not switch sources. Please try again.";
      this.sync();
    }
  },
};
