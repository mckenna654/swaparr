/**
 * Swaparr - Core Application Logic
 * Integrates with Dispatcharr HTTP REST API
 */

// Toast Notification Manager
const Toast = {
  container: null,
  
  init() {
    this.container = document.createElement('div');
    this.container.id = 'toast-container';
    this.container.style.cssText = `
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 10000;
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: 350px;
      width: 100%;
    `;
    document.body.appendChild(this.container);
    
    // Inject mobile media query for toasts
    const style = document.createElement('style');
    style.innerHTML = `
      @media (max-width: 640px) {
        #toast-container {
          right: 12px !important;
          left: 12px !important;
          bottom: 12px !important;
          max-width: none !important;
        }
      }
    `;
    document.head.appendChild(style);
  },

  show(title, message, type = 'info') {
    if (!this.container) this.init();
    
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let borderClr = 'var(--accent-blue)';
    let bgClr = 'rgba(18, 24, 41, 0.95)';
    let textClr = '#ffffff';
    let icon = 'info';
    
    if (type === 'success') {
      borderClr = 'var(--accent-green)';
      icon = 'check-circle';
    } else if (type === 'error') {
      borderClr = 'var(--accent-red)';
      icon = 'alert-triangle';
    } else if (type === 'warning') {
      borderClr = 'var(--accent-warning)';
      icon = 'alert-circle';
    }
    
    toast.style.cssText = `
      background: ${bgClr};
      color: ${textClr};
      border-left: 4px solid ${borderClr};
      border-radius: 8px;
      padding: 12px 16px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.3);
      border-top: 1px solid rgba(255,255,255,0.05);
      border-bottom: 1px solid rgba(0,0,0,0.2);
      border-right: 1px solid rgba(255,255,255,0.05);
      display: flex;
      flex-direction: column;
      gap: 4px;
      opacity: 0;
      transform: translateY(20px);
      transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      backdrop-filter: blur(10px);
      position: relative;
    `;
    
    toast.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 0.9rem; font-family: var(--font-display);">
        <i data-lucide="${icon}" style="width: 16px; height: 16px; color: ${borderClr}"></i>
        <span>${title}</span>
      </div>
      <div style="font-size: 0.8rem; color: var(--text-muted); font-family: var(--font-sans); padding-left: 24px;">
        ${message}
      </div>
    `;
    
    this.container.appendChild(toast);
    lucide.createIcons({ attrs: { class: 'btn-icon' } });
    
    // Animate in
    setTimeout(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
    }, 10);
    
    // Auto remove
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-20px)';
      setTimeout(() => {
        toast.remove();
      }, 300);
    }, 4000);
  }
};

// Global App State
const State = {
  config: {
    url: 'http://localhost:9191',
    apiKey: ''
  },
  channels: [],          // Full channel objects from /api/channels/
  channelsByUuid: {},    // Map of UUID -> database ID
  channelsMap: {},       // Map of database ID -> Channel object
  activeStreams: [],     // Active streams list from /proxy/ts/status
  channelStreamsCache: {}, // Cache of stream list for each channel ID: { channelId: [streams] }
  m3uAccountsMap: {},    // Map of M3U account ID -> name (e.g. "Infinity", "B1G")
  
  refreshInterval: null,
  refreshCountdown: 5,
  countdownInterval: null,
  
  init() {
    this.loadConfig();
    this.setupEventListeners();
    lucide.createIcons();
    
    // Try initial fetch
    if (this.config.url) {
      this.refreshAll();
    } else {
      this.openSettings();
    }
  },
  
  loadConfig() {
    const savedUrl = localStorage.getItem('swaparr_url');
    const savedApiKey = localStorage.getItem('swaparr_api_key');
    
    if (savedUrl) this.config.url = savedUrl;
    if (savedApiKey) this.config.apiKey = savedApiKey;
    
    document.getElementById('dispatcharr-url').value = this.config.url;
    document.getElementById('dispatcharr-api-key').value = this.config.apiKey;
  },
  
  saveConfig(url, apiKey) {
    // Normalize URL
    let normalizedUrl = url.trim();
    if (normalizedUrl.endsWith('/')) {
      normalizedUrl = normalizedUrl.slice(0, -1);
    }
    
    this.config.url = normalizedUrl;
    this.config.apiKey = apiKey.trim();
    
    localStorage.setItem('swaparr_url', this.config.url);
    localStorage.setItem('swaparr_api_key', this.config.apiKey);
    
    Toast.show('Configuration Saved', 'Settings updated successfully.', 'success');
    this.refreshAll();
  },
  
  getHeaders() {
    const headers = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `ApiKey ${this.config.apiKey}`;
    }
    return headers;
  },
  
  async apiFetch(path, options = {}) {
    const url = `${this.config.url}${path}`;
    const headers = {
      ...this.getHeaders(),
      ...options.headers
    };
    
    const response = await fetch(url, {
      ...options,
      headers
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    return response.json();
  },
  
  updateConnectionStatus(connected, message = '') {
    const badge = document.getElementById('status-badge');
    const statusText = document.getElementById('status-text');
    
    if (connected) {
      badge.className = 'status-badge status-connected';
      statusText.textContent = 'API Connected';
    } else {
      badge.className = 'status-badge status-disconnected';
      statusText.textContent = message || 'API Disconnected';
    }
  },
  
  setupEventListeners() {
    // Settings Modal toggles
    document.getElementById('settings-btn').addEventListener('click', () => this.openSettings());
    document.getElementById('settings-close-btn').addEventListener('click', () => this.closeSettings());
    document.getElementById('settings-cancel-btn').addEventListener('click', () => this.closeSettings());
    
    // Toggle password eye
    document.getElementById('toggle-api-key-btn').addEventListener('click', () => {
      const input = document.getElementById('dispatcharr-api-key');
      const icon = document.querySelector('#toggle-api-key-btn i');
      if (input.type === 'password') {
        input.type = 'text';
        icon.setAttribute('data-lucide', 'eye-off');
      } else {
        input.type = 'password';
        icon.setAttribute('data-lucide', 'eye');
      }
      lucide.createIcons();
    });
    
    // Settings form submit
    document.getElementById('settings-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const url = document.getElementById('dispatcharr-url').value;
      const apiKey = document.getElementById('dispatcharr-api-key').value;
      this.saveConfig(url, apiKey);
      this.closeSettings();
    });
    
    // Connection Test button
    document.getElementById('test-connection-btn').addEventListener('click', () => this.testConnection());
    
    // Refresh Manual button
    document.getElementById('refresh-btn').addEventListener('click', () => {
      this.refreshAll();
      Toast.show('Refreshing', 'Fetching fresh data from Dispatcharr...', 'info');
    });
    
    // Auto Refresh toggle
    const autoCheck = document.getElementById('auto-refresh-check');
    autoCheck.addEventListener('change', () => {
      if (autoCheck.checked) {
        this.startAutoRefresh();
      } else {
        this.stopAutoRefresh();
      }
    });
    
    // Search Box
    document.getElementById('channel-search-input').addEventListener('input', () => this.renderChannelsExplorer());
    
    // Auto-close modal when clicking background overlay
    window.addEventListener('click', (e) => {
      const modal = document.getElementById('settings-modal');
      if (e.target === modal) {
        this.closeSettings();
      }
    });
  },
  
  openSettings() {
    document.getElementById('settings-modal').classList.add('show');
    document.getElementById('test-connection-result').style.display = 'none';
  },
  
  closeSettings() {
    document.getElementById('settings-modal').classList.remove('show');
  },
  
  async testConnection() {
    const urlInput = document.getElementById('dispatcharr-url').value.trim();
    const keyInput = document.getElementById('dispatcharr-api-key').value.trim();
    const resultBox = document.getElementById('test-connection-result');
    
    resultBox.style.display = 'block';
    resultBox.className = 'connection-result';
    resultBox.textContent = 'Connecting...';
    
    let testUrl = urlInput;
    if (testUrl.endsWith('/')) {
      testUrl = testUrl.slice(0, -1);
    }
    
    const headers = { 'Content-Type': 'application/json' };
    if (keyInput) {
      headers['Authorization'] = `ApiKey ${keyInput}`;
    }
    
    try {
      // Hit proxy status to verify
      const response = await fetch(`${testUrl}/proxy/ts/status`, { headers });
      if (response.ok) {
        resultBox.className = 'connection-result success';
        resultBox.textContent = 'Connection Successful! Dispatcharr API is responsive.';
        this.updateConnectionStatus(true);
      } else {
        resultBox.className = 'connection-result error';
        resultBox.textContent = `Error: HTTP ${response.status} - ${response.statusText}. Please verify the URL and API Key.`;
        this.updateConnectionStatus(false, `HTTP ${response.status}`);
      }
    } catch (err) {
      resultBox.className = 'connection-result error';
      resultBox.textContent = `Failed to connect: ${err.message}. Ensure Dispatcharr is running and CORS is enabled.`;
      this.updateConnectionStatus(false, 'Network Error');
    }
  },
  
  startAutoRefresh() {
    this.stopAutoRefresh();
    this.refreshCountdown = 5;
    document.getElementById('refresh-countdown').textContent = this.refreshCountdown;
    
    this.countdownInterval = setInterval(() => {
      this.refreshCountdown--;
      if (this.refreshCountdown <= 0) {
        this.refreshCountdown = 5;
        this.refreshActiveStreamsOnly();
      }
      document.getElementById('refresh-countdown').textContent = this.refreshCountdown;
    }, 1000);
  },
  
  stopAutoRefresh() {
    if (this.countdownInterval) clearInterval(this.countdownInterval);
    document.getElementById('refresh-countdown').textContent = '-';
  },
  
  async refreshAll() {
    try {
      this.updateConnectionStatus(false, 'Connecting...');
      await this.fetchM3uAccounts();
      await this.fetchChannels();
      
      // 2. Fetch active streams
      await this.fetchActiveStreams();
      
      this.updateConnectionStatus(true);
      this.startAutoRefresh();
    } catch (err) {
      console.error(err);
      this.updateConnectionStatus(false, 'API Error');
      Toast.show('Connection Failed', `Could not fetch data from Dispatcharr: ${err.message}`, 'error');
    }
  },
  
  async refreshActiveStreamsOnly() {
    try {
      await this.fetchActiveStreams();
      this.updateConnectionStatus(true);
    } catch (err) {
      console.error('Auto-refresh failed:', err);
      this.updateConnectionStatus(false, 'API Stale');
    }
  },
  
  async fetchAllPages(path, pageSize = 200) {
    const first = await this.apiFetch(`${path}?page=1&page_size=${pageSize}`);
    if (Array.isArray(first)) return first;

    const items = [...(first.results || [])];
    const totalPages = Math.ceil((first.count || items.length) / pageSize);

    for (let page = 2; page <= totalPages; page++) {
      const data = await this.apiFetch(`${path}?page=${page}&page_size=${pageSize}`);
      items.push(...(data.results || []));
    }

    return items;
  },

  async fetchM3uAccounts() {
    try {
      const data = await this.apiFetch('/api/m3u/accounts/');
      const accounts = Array.isArray(data) ? data : (data.results || []);

      this.m3uAccountsMap = {};
      accounts.forEach(account => {
        if (account.id && account.name) {
          this.m3uAccountsMap[account.id] = account.name;
        }
      });
    } catch (err) {
      console.error('Fetch M3U accounts failed:', err);
      this.m3uAccountsMap = {};
    }
  },

  async fetchChannels() {
    try {
      const channelsList = await this.fetchAllPages('/api/channels/channels/');

      this.channels = channelsList;
      this.channelsByUuid = {};
      this.channelsMap = {};

      channelsList.forEach(channel => {
        this.channelsMap[channel.id] = channel;
        if (channel.uuid) {
          this.channelsByUuid[channel.uuid] = channel.id;
        }
      });

      this.renderChannelsExplorer();
    } catch (err) {
      console.error('Fetch channels failed:', err);
      throw err;
    }
  },
  
  async fetchActiveStreams() {
    try {
      const data = await this.apiFetch('/proxy/ts/status');
      this.activeStreams = data.channels || [];
      
      // Update statistics panel
      document.getElementById('stat-active-count').textContent = this.activeStreams.length;
      
      let totalClients = 0;
      let totalBytes = 0;
      
      this.activeStreams.forEach(stream => {
        totalClients += (stream.client_count || 0);
        totalBytes += (stream.total_bytes || 0);
      });
      
      document.getElementById('stat-client-count').textContent = totalClients;
      
      // Compute total bandwidth from active streams
      // We can use a rolling bitrate calculation or average
      let totalBitrateKbps = 0;
      this.activeStreams.forEach(stream => {
        if (stream.uptime > 0 && stream.total_bytes) {
          // Calculate bitrate: (bytes * 8) / uptime / 1000 = Kbps
          const bitrate = (stream.total_bytes * 8) / stream.uptime / 1000;
          totalBitrateKbps += bitrate;
        }
      });
      
      const totalMbps = totalBitrateKbps / 1000;
      document.getElementById('stat-bandwidth').textContent = `${totalMbps.toFixed(2)} Mbps`;
      
      // Render active streams grid
      await this.renderActiveStreams();
    } catch (err) {
      console.error('Fetch active streams failed:', err);
      throw err;
    }
  },
  
  async fetchStreamsForChannel(channelDbId) {
    if (this.channelStreamsCache[channelDbId]) {
      return this.channelStreamsCache[channelDbId];
    }
    
    try {
      const streams = await this.apiFetch(`/api/channels/channels/${channelDbId}/streams/`);
      this.channelStreamsCache[channelDbId] = streams || [];
      return this.channelStreamsCache[channelDbId];
    } catch (err) {
      console.error(`Failed to fetch streams for channel ${channelDbId}:`, err);
      return [];
    }
  },
  
  formatStreamLabel(stream) {
    return `${stream.name || `Stream #${stream.id}`} [${this.formatAccountName(stream.m3u_account)}]`;
  },

  formatAccountName(m3uAccount) {
    if (typeof m3uAccount === 'object' && m3uAccount?.name) return m3uAccount.name;
    const accountId = typeof m3uAccount === 'object' ? m3uAccount?.id : m3uAccount;
    if (accountId && this.m3uAccountsMap[accountId]) return this.m3uAccountsMap[accountId];
    if (accountId) return `M3U #${accountId}`;
    return 'Unknown Source';
  },

  buildStreamSelect(streams, activeStreamId, channelUuid, channelName) {
    const select = document.createElement('select');
    select.className = 'override-select';
    select.innerHTML = streams.map(s => {
      const isSelected = activeStreamId && String(s.id) === String(activeStreamId);
      return `<option value="${s.id}" ${isSelected ? 'selected' : ''}>${this.formatStreamLabel(s)}</option>`;
    }).join('');

    select.addEventListener('change', (e) => {
      const streamId = e.target.value;
      const streamName = e.target.options[e.target.selectedIndex].text;
      select.disabled = true;
      this.switchStream(channelUuid, streamId, channelName, streamName)
        .finally(() => { select.disabled = false; });
    });

    return select;
  },

  injectStreamDropdown(wrapper, streams, activeStreamId, channelUuid, channelName) {
    if (!wrapper) return;

    if (streams.length === 0) {
      wrapper.innerHTML = `<span class="select-placeholder">No streams configured</span>`;
      return;
    }

    const existingSelect = wrapper.querySelector('.override-select');
    if (existingSelect) {
      if (activeStreamId && existingSelect.value !== String(activeStreamId)) {
        existingSelect.value = String(activeStreamId);
      }
      return;
    }

    const select = this.buildStreamSelect(streams, activeStreamId, channelUuid, channelName);
    wrapper.innerHTML = '';
    wrapper.appendChild(select);

    const arrow = document.createElement('div');
    arrow.className = 'select-arrow';
    arrow.innerHTML = `<i data-lucide="chevron-down" style="width: 16px; height: 16px;"></i>`;
    wrapper.appendChild(arrow);
    lucide.createIcons();
  },

  updateStreamCard(card, stream) {
    const channelDbId = this.channelsByUuid[stream.channel_id];
    const channelInfo = channelDbId ? this.channelsMap[channelDbId] : null;
    const channelName = stream.channel_name || (channelInfo ? channelInfo.name : 'Unknown Channel');

    const isBuffering = stream.state === 'buffering' || stream.state === 'connecting' || stream.state === 'initializing';
    const statusClass = isBuffering ? 'status-buffering-glow' : 'status-active-glow';
    const statusText = stream.state || 'active';

    const badge = card.querySelector('.stream-status-badge');
    if (badge) {
      badge.className = `stream-status-badge ${statusClass}`;
      badge.textContent = statusText;
    }

    const specValues = card.querySelectorAll('.spec-value');
    if (specValues.length >= 4) {
      specValues[0].textContent = this.formatDuration(stream.uptime);
      specValues[1].textContent = this.formatBitrate(stream.total_bytes, stream.uptime);
      specValues[2].textContent = this.formatBytes(stream.total_bytes);
      specValues[3].textContent = `${stream.client_count || 0} active`;
    }

    const toggleLabel = card.querySelector('.clients-toggle span');
    if (toggleLabel) {
      toggleLabel.textContent = `Connected Clients (${stream.client_count || 0})`;
    }

    const select = card.querySelector('.override-select');
    if (select && stream.stream_id && select.value !== String(stream.stream_id)) {
      select.value = String(stream.stream_id);
    }

    const wrapper = card.querySelector('.select-wrapper');
    if (channelDbId && wrapper && !wrapper.querySelector('.override-select')) {
      this.fetchStreamsForChannel(channelDbId).then(streams => {
        this.injectStreamDropdown(wrapper, streams, stream.stream_id, stream.channel_id, channelName);
      });
    }
  },

  createStreamCard(stream) {
    const channelDbId = this.channelsByUuid[stream.channel_id];
    const channelInfo = channelDbId ? this.channelsMap[channelDbId] : null;

    const card = document.createElement('article');
    card.className = 'card stream-card';
    card.dataset.channelId = stream.channel_id;

    const isBuffering = stream.state === 'buffering' || stream.state === 'connecting' || stream.state === 'initializing';
    const statusClass = isBuffering ? 'status-buffering-glow' : 'status-active-glow';
    const statusText = stream.state || 'active';

    const channelName = stream.channel_name || (channelInfo ? channelInfo.name : 'Unknown Channel');
    const groupName = channelInfo && channelInfo.channel_group ? channelInfo.channel_group.name : 'No Group';

    card.innerHTML = `
      <div class="stream-card-header">
        <div class="stream-title-area">
          <h3>${channelName}</h3>
          <span class="stream-group-badge">${groupName}</span>
        </div>
        <span class="stream-status-badge ${statusClass}">${statusText}</span>
      </div>

      <div class="stream-card-specs">
        <div class="spec-item">
          <span class="spec-label">Uptime</span>
          <span class="spec-value">${this.formatDuration(stream.uptime)}</span>
        </div>
        <div class="spec-item">
          <span class="spec-label">Bitrate</span>
          <span class="spec-value">${this.formatBitrate(stream.total_bytes, stream.uptime)}</span>
        </div>
        <div class="spec-item">
          <span class="spec-label">Data Sent</span>
          <span class="spec-value">${this.formatBytes(stream.total_bytes)}</span>
        </div>
        <div class="spec-item">
          <span class="spec-label">Clients</span>
          <span class="spec-value">${stream.client_count || 0} active</span>
        </div>
      </div>

      <div class="stream-override-box stream-override-primary">
        <label class="override-label"><i data-lucide="list"></i> Switch Stream Source</label>
        <div class="select-wrapper" id="select-wrapper-${stream.channel_id}">
          <div class="spinner" style="width: 20px; height: 20px;"></div>
        </div>
      </div>

      <div class="stream-card-clients">
        <div class="clients-toggle" id="toggle-${stream.channel_id}">
          <span>Connected Clients (${stream.client_count || 0})</span>
          <i data-lucide="chevron-down"></i>
        </div>
        <div class="clients-list-container" id="clients-list-${stream.channel_id}">
          <div class="loading-state" style="padding: 10px;"><div class="spinner" style="width: 16px; height: 16px;"></div></div>
        </div>
      </div>

      <div class="stream-card-actions">
        <button class="btn btn-danger btn-stop-stream" data-channel-id="${stream.channel_id}" data-channel-name="${channelName.replace(/"/g, '&quot;')}">
          <i data-lucide="square"></i> Stop Stream
        </button>
      </div>
    `;

    const wrapper = card.querySelector('.select-wrapper');
    if (channelDbId) {
      this.fetchStreamsForChannel(channelDbId).then(streams => {
        this.injectStreamDropdown(wrapper, streams, stream.stream_id, stream.channel_id, channelName);
      });
    } else if (wrapper) {
      wrapper.innerHTML = `<span class="select-placeholder">Channel mapping not found</span>`;
    }

    const stopBtn = card.querySelector('.btn-stop-stream');
    stopBtn.addEventListener('click', () => {
      this.stopStream(stream.channel_id, channelName);
    });

    const toggle = card.querySelector('.clients-toggle');
    const listContainer = card.querySelector('.clients-list-container');

    toggle.addEventListener('click', async () => {
      const isExpanded = toggle.classList.toggle('expanded');
      listContainer.classList.toggle('show');

      if (isExpanded) {
        try {
          const detailData = await this.apiFetch(`/proxy/ts/status/${stream.channel_id}`);
          const clients = detailData.clients || [];

          if (clients.length === 0) {
            listContainer.innerHTML = `<div style="font-size: 0.75rem; color: var(--text-muted); text-align: center; padding: 10px;">No clients connected</div>`;
            return;
          }

          listContainer.innerHTML = clients.map(c => `
            <div class="client-row">
              <div class="client-info">
                <span class="client-ip">${c.ip_address}</span>
                <span class="client-ua">${c.user_agent}</span>
              </div>
              <div class="client-stats">
                <span class="client-rate">${c.current_rate_KBps ? c.current_rate_KBps.toFixed(1) + ' KB/s' : '0 KB/s'}</span>
                <span class="client-uptime">${c.connected_at ? this.formatDuration(Date.now()/1000 - c.connected_at) : ''}</span>
              </div>
            </div>
          `).join('');
        } catch (err) {
          listContainer.innerHTML = `<div style="font-size: 0.75rem; color: var(--accent-red); padding: 10px;">Error loading clients</div>`;
        }
      }
    });

    return card;
  },

  async renderActiveStreams() {
    const grid = document.getElementById('active-streams-grid');

    if (this.activeStreams.length === 0) {
      grid.innerHTML = `
        <div class="empty-state">
          <i data-lucide="tv-2"></i>
          <h3>No Active Streams</h3>
          <p>No streams are currently being proxied. Open a channel stream link in Tivimate, Plex, or your video player to start streaming.</p>
        </div>
      `;
      lucide.createIcons();
      return;
    }

    const activeIds = new Set(this.activeStreams.map(s => s.channel_id));

    grid.querySelectorAll('.stream-card').forEach(card => {
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

    grid.querySelectorAll('.empty-state, .loading-state').forEach(el => el.remove());
    lucide.createIcons();
  },
  
  renderChannelsExplorer() {
    const tbody = document.getElementById('channels-table-body');
    const query = document.getElementById('channel-search-input').value.toLowerCase().trim();
    
    tbody.innerHTML = '';
    
    // Filter channels list
    const filtered = this.channels.filter(ch => {
      const nameMatch = ch.name && ch.name.toLowerCase().includes(query);
      const groupMatch = ch.channel_group && ch.channel_group.name && ch.channel_group.name.toLowerCase().includes(query);
      return nameMatch || groupMatch;
    });
    
    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" class="table-placeholder">No channels match search filter.</td>
        </tr>
      `;
      return;
    }
    
    // Sort channels by number
    filtered.sort((a,b) => (a.channel_number || 0) - (b.channel_number || 0));
    
    // Render top 150 channels to maintain performance on mobile screen
    const maxRender = 150;
    const itemsToRender = filtered.slice(0, maxRender);
    
    itemsToRender.forEach(ch => {
      const tr = document.createElement('tr');
      
      const groupName = ch.channel_group ? ch.channel_group.name : 'No Group';
      
      // Determine active stream name (if channel is actively being streamed)
      const activeStream = this.activeStreams.find(s => this.channelsByUuid[s.channel_id] === ch.id);
      const activeStatusHtml = activeStream 
        ? `<span class="stream-status-badge status-active-glow" style="font-size: 0.7rem; padding: 1px 6px;">STREAMING (${activeStream.state})</span>`
        : '';
        
      tr.innerHTML = `
        <td data-label="Ch #"><span class="channel-no-badge">${ch.channel_number || '-'}</span></td>
        <td data-label="Channel Name" class="channel-name-cell">${ch.name} ${activeStatusHtml}</td>
        <td data-label="Channel Group" class="channel-group-cell">${groupName}</td>
        <td data-label="Current Stream / Source" class="channel-stream-cell" id="source-cell-${ch.id}">
          <span style="font-size: 0.8rem; color: var(--text-muted);">Loading sources...</span>
        </td>
        <td class="actions-cell" id="actions-cell-${ch.id}">
          <div class="spinner" style="width: 16px; height: 16px; margin-left: auto;"></div>
        </td>
      `;
      
      tbody.appendChild(tr);
      
      // Load sources dropdown for the channel
      this.fetchStreamsForChannel(ch.id).then(streams => {
        const sourceCell = document.getElementById(`source-cell-${ch.id}`);
        const actionsCell = document.getElementById(`actions-cell-${ch.id}`);
        
        if (!sourceCell || !actionsCell) return;
        
        if (streams.length === 0) {
          sourceCell.innerHTML = `<span style="color: var(--accent-red); font-size: 0.8rem;">No sources found</span>`;
          actionsCell.innerHTML = `<span style="font-size: 0.8rem; color: var(--text-muted); margin-left: auto;">-</span>`;
          return;
        }
        
        // Find current selected stream or default to first
        // If channel is actively streaming, highlight the active stream.
        // Otherwise look for the default profile or first stream.
        let activeStreamId = null;
        if (activeStream && activeStream.stream_id) {
          activeStreamId = activeStream.stream_id;
        }
        
        // Render name of the current active stream (or first stream name as placeholder)
        const currentStreamObj = streams.find(s => String(s.id) === String(activeStreamId)) || streams[0];
        sourceCell.innerHTML = `<span style="font-weight: 500;">${currentStreamObj.name}</span><br><span style="font-size: 0.75rem; color: var(--text-muted);">${this.formatAccountName(currentStreamObj.m3u_account)}</span>`;
        
        // Create dropdown selector in table
        const select = document.createElement('select');
        select.className = 'override-select';
        select.style.cssText = 'padding: 4px 28px 4px 8px; font-size: 0.8rem;';
        select.innerHTML = streams.map(s => {
          const isSelected = activeStreamId ? String(s.id) === String(activeStreamId) : false;
          return `<option value="${s.id}" ${isSelected ? 'selected' : ''}>${this.formatStreamLabel(s)}</option>`;
        }).join('');
        
        // On switch
        select.addEventListener('change', async (e) => {
          const streamId = e.target.value;
          const streamName = e.target.options[e.target.selectedIndex].text;
          
          if (activeStream) {
            // Live switch since it is currently streaming!
            await this.switchStream(activeStream.channel_id, streamId, ch.name, streamName);
          } else {
            // Channel is NOT currently streaming.
            // In Dispatcharr, to override the default stream profile or playlist stream, we can perform a profile switch or priority change.
            // Wait, we can test setting the stream profile, or let the user know this is used when stream starts.
            // But wait, the switch_stream endpoint ONLY works when a channel is actively running (since it replaces the stream URL in the live thread).
            // Let's show a modal/toast informing them.
            Toast.show('Channel Offline', `Stream selected for "${ch.name}". It will be applied as soon as the channel starts playing.`, 'warning');
          }
        });
        
        actionsCell.innerHTML = '';
        actionsCell.appendChild(select);
        
        const arrow = document.createElement('div');
        arrow.className = 'select-arrow';
        arrow.style.right = '8px';
        arrow.innerHTML = `<i data-lucide="chevron-down" style="width: 12px; height: 12px;"></i>`;
        actionsCell.appendChild(arrow);
        
        lucide.createIcons();
      });
    });
    
    // Add text labels to data cells for mobile responsiveness
    const rows = tbody.getElementsByTagName('tr');
    for (let r of rows) {
      const cells = r.getElementsByTagName('td');
      if (cells.length >= 4) {
        cells[0].setAttribute('data-label', 'Ch #');
        cells[1].setAttribute('data-label', 'Channel Name');
        cells[2].setAttribute('data-label', 'Channel Group');
        cells[3].setAttribute('data-label', 'Current Stream');
      }
    }
    
    lucide.createIcons();
  },
  
  async switchStream(channelUuid, streamId, channelName, streamName) {
    try {
      Toast.show('Switching Stream', `Routing "${channelName}" to "${streamName}"...`, 'info');

      await this.apiFetch(`/proxy/ts/change_stream/${channelUuid}`, {
        method: 'POST',
        body: JSON.stringify({ stream_id: parseInt(streamId) })
      });

      Toast.show('Stream Switched', `Successfully routed "${channelName}" to "${streamName}".`, 'success');
      await this.refreshActiveStreamsOnly();
    } catch (err) {
      console.error(err);
      Toast.show('Switch Failed', `Could not switch stream: ${err.message}`, 'error');
      throw err;
    }
  },

  async stopStream(channelUuid, channelName) {
    if (!confirm(`Are you sure you want to stop the stream for "${channelName}"? This will disconnect all connected viewers.`)) {
      return;
    }
    
    try {
      Toast.show('Stopping Stream', `Stopping stream and releasing client slots for "${channelName}"...`, 'info');
      
      // Try DELETE first, fall back to POST
      try {
        await this.apiFetch(`/proxy/ts/stop/${channelUuid}`, {
          method: 'DELETE'
        });
      } catch (e) {
        await this.apiFetch(`/proxy/ts/stop/${channelUuid}`, {
          method: 'POST',
          body: JSON.stringify({})
        });
      }
      
      Toast.show('Stream Stopped', `Successfully terminated stream for "${channelName}".`, 'success');
      this.refreshActiveStreamsOnly();
    } catch (err) {
      console.error(err);
      Toast.show('Action Failed', `Could not stop stream: ${err.message}`, 'error');
    }
  },
  
  // Format helpers
  formatDuration(seconds) {
    if (isNaN(seconds) || seconds <= 0) return '0s';
    
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    
    const parts = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    if (s > 0 || parts.length === 0) parts.push(`${s}s`);
    
    return parts.join(' ');
  },
  
  formatBitrate(bytes, uptimeSeconds) {
    if (!bytes || !uptimeSeconds || uptimeSeconds <= 0) return '0.00 Kbps';
    
    // (bytes * 8) / uptime / 1000 = Kbps
    const kbps = (bytes * 8) / uptimeSeconds / 1000;
    
    if (kbps > 1000) {
      return `${(kbps / 1000).toFixed(2)} Mbps`;
    }
    return `${kbps.toFixed(2)} Kbps`;
  },
  
  formatBytes(bytes) {
    if (isNaN(bytes) || bytes <= 0) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  }
};

// Initialize app when window loads
window.addEventListener('DOMContentLoaded', () => {
  State.init();
});
