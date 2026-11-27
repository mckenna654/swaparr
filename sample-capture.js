/* Capture sample data: one read-only pass over the Dispatcharr calls Swaparr uses,
 * with every name, address, URL and key replaced by a stand-in, saved as one file.
 * The file shows real response shapes without revealing anything about the server. */
const SampleCapture = {
  // A value is kept only when its key is listed here AND it matches that key's strict
  // pattern. Every other string becomes a stand-in such as "text-12". Numbers,
  // true/false and null stay as they are.
  SAFE_VALUES: {
    state: /^[a-z_]{1,20}$/,
    resolution: /^(\d{2,5}\s*[x×]\s*\d{2,5}|\d{3,4}[pi]?)$/i,
    video_codec: /^[a-z0-9._-]{1,16}$/i,
    audio_codec: /^[a-z0-9._-]{1,16}$/i,
    pixel_format: /^[a-z0-9._-]{1,16}$/i,
    video_profile: /^[a-z0-9 ._-]{1,16}$/i,
    stream_type: /^[a-z0-9._-]{1,16}$/i,
    audio_channels: /^(mono|stereo|\d(\.\d)?( ?ch)?|\d\.\d\((side|back)\))$/i,
    source_fps: /^\d{1,3}(\.\d{1,3})?$/,
    sample_rate: /^\d{4,6}$/,
    "catchup-type": /^[a-z_-]{1,20}$/i,
  },

  // Field names kept as they are, so the file still shows Dispatcharr's schema. Any
  // other key (a username, channel name or address used as a map key) is replaced.
  KNOWN_FIELDS: new Set([
    "id", "uuid", "name", "count", "next", "previous", "results", "channels", "streams", "clients",
    "channel_id", "channel_name", "channel_number", "channel_group_id", "channel_group", "stream_id",
    "stream_name", "state", "uptime", "total_bytes", "client_count", "avg_bitrate", "avg_bitrate_kbps",
    "bitrate", "url", "logo", "logo_id", "logo_url", "tvg_id", "tvc_guide_stationid", "epg_data_id",
    "stream_profile_id", "stream_profile", "m3u_account", "m3u_account_id", "m3u_profile", "m3u_profile_id",
    "stream_stats", "stream_stats_updated_at", "custom_properties", "is_active", "is_stale", "is_custom",
    "last_seen", "updated_at", "created_at", "username", "email", "first_name", "last_name", "user_level",
    "user_id", "ip_address", "user_agent", "connected_at", "current_rate_KBps", "bytes_sent",
    "max_streams", "profiles", "account_type", "server_url", "password", "api_key", "priority",
    "refresh_interval", "current_viewers", "channel_count", "buffer_index", "owner", "worker_id",
    "local_index", "resolution", "source_fps", "video_codec", "audio_codec", "audio_channels",
    "pixel_format", "sample_rate", "video_bitrate", "audio_bitrate", "ffmpeg_output_bitrate",
    "video_profile", "stream_type", "catchup", "catchup-days", "catchup-type", "catchup-source",
    "tvg-id", "tvg-name", "tvg-logo", "group-title", "user_channel_profile", "auto_channel_sync",
  ]),

  // Turns any API response into the same shape with private text replaced. The same
  // input text always gets the same stand-in, so links between responses (a channel's
  // uuid in the status list and in the channel list) survive.
  redact(value, aliases = new Map()) {
    const alias = (text) => {
      if (!aliases.has(text)) aliases.set(text, `text-${aliases.size + 1}`);
      return aliases.get(text);
    };
    const keepAsIs = (key, text) => Object.hasOwn(this.SAFE_VALUES, key) && this.SAFE_VALUES[key].test(text.trim());
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
          out[this.KNOWN_FIELDS.has(name) ? name : alias(name)] = walk(child, name);
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
