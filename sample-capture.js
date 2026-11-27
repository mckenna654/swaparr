/* Capture sample data: one read-only pass over the Dispatcharr calls Swaparr uses,
 * with every name, address, URL and key replaced by a stand-in, saved as one file.
 * The file shows real response shapes without revealing anything about the server. */
const SampleCapture = {
  // Only short technical values under these keys are kept as they are. Every other
  // string becomes a stand-in such as "text-12". Numbers, true/false and null stay.
  SAFE_KEYS: new Set([
    "state", "resolution", "video_codec", "audio_codec", "audio_channels", "source_fps",
    "pixel_format", "stream_type", "video_profile", "sample_rate", "catchup-type",
  ]),
  SAFE_KEY_NAME: /^[a-z][a-z0-9_-]{0,39}$/,

  // Turns any API response into the same shape with private text replaced. The same
  // input text always gets the same stand-in, so links between responses (a channel's
  // uuid in the status list and in the channel list) survive.
  redact(value, aliases = new Map()) {
    const alias = (text) => {
      if (!aliases.has(text)) aliases.set(text, `text-${aliases.size + 1}`);
      return aliases.get(text);
    };
    const keepAsIs = (key, text) => this.SAFE_KEYS.has(key) && text.length <= 40
      && !/[:/@\\]/.test(text) && !/\d{1,3}(\.\d{1,3}){3}/.test(text);
    const walk = (node, key) => {
      if (typeof node === "string") {
        const trimmed = node.trim();
        if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
          try {
            return JSON.stringify(walk(JSON.parse(trimmed), key));
          } catch {
            // Not JSON after all; treat it as text below.
          }
        }
        return keepAsIs(key, node) ? node : alias(node);
      }
      if (Array.isArray(node)) return node.map(item => walk(item, key));
      if (node && typeof node === "object") {
        const out = {};
        for (const [name, child] of Object.entries(node)) {
          out[this.SAFE_KEY_NAME.test(name) ? name : alias(name)] = walk(child, name);
        }
        return out;
      }
      return node;
    };
    return walk(value, "");
  },

  // Keeps files small: long lists are cut to their first few entries.
  trim(value, limit = 10) {
    if (Array.isArray(value)) return value.slice(0, limit).map(item => this.trim(item, limit));
    if (value && typeof value === "object") {
      const out = {};
      for (const [name, child] of Object.entries(value)) out[name] = this.trim(child, limit);
      return out;
    }
    return value;
  },

  async collect(api) {
    const responses = {};
    const take = async (label, endpoint, path) => {
      try {
        responses[label] = { endpoint, body: this.trim(await api(path)) };
      } catch (error) {
        responses[label] = { endpoint, error: error.status || "failed" };
      }
      // Gentle pacing, like the rest of Swaparr, so a strict proxy never sees a burst.
      await new Promise(resolve => setTimeout(resolve, 100));
    };
    await take("users", "GET /api/accounts/users/", "/api/accounts/users/?page=1&page_size=5");
    await take("m3u_accounts", "GET /api/m3u/accounts/", "/api/m3u/accounts/");
    await take("groups", "GET /api/channels/groups/", "/api/channels/groups/?page=1&page_size=10");
    await take("channels", "GET /api/channels/channels/", "/api/channels/channels/?page=1&page_size=10");
    await take("status", "GET /proxy/ts/status", "/proxy/ts/status");

    const status = responses.status.body;
    const active = Array.isArray(status?.channels) ? status.channels.slice(0, 2) : [];
    for (const [i, stream] of active.entries()) {
      if (typeof stream.channel_id === "string" && /^[A-Za-z0-9-]+$/.test(stream.channel_id)) {
        await take(`status_detail_${i + 1}`, "GET /proxy/ts/status/{uuid}", `/proxy/ts/status/${stream.channel_id}`);
      }
    }
    const channelsBody = responses.channels.body;
    const channels = Array.isArray(channelsBody) ? channelsBody : channelsBody?.results || [];
    const ids = channels.map(channel => channel.id).filter(id => Number.isSafeInteger(id)).slice(0, 3);
    for (const [i, id] of ids.entries()) {
      await take(`channel_streams_${i + 1}`, "GET /api/channels/channels/{id}/streams/", `/api/channels/channels/${id}/streams/`);
    }
    return responses;
  },

  async run(api) {
    const responses = await this.collect(api);
    const answered = Object.values(responses).filter(item => !("error" in item)).length;
    // Only response bodies hold server data; labels and endpoint templates are Swaparr's own.
    const aliases = new Map();
    for (const item of Object.values(responses)) {
      if ("body" in item) item.body = this.redact(item.body, aliases);
    }
    return {
      summary: { answered, total: Object.keys(responses).length },
      file: {
        format: "swaparr-sample/1",
        captured_at: new Date().toISOString(),
        note: "Names, addresses, URLs and keys are replaced with stand-ins such as text-12.",
        responses,
      },
    };
  },

  download(file) {
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    const name = `swaparr-sample-${file.captured_at.slice(0, 10)}.json`;
    link.href = URL.createObjectURL(blob);
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    return name;
  },
};
