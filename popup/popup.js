document.addEventListener('DOMContentLoaded', async () => {
  // ── element refs ──
  const $ = id => document.getElementById(id);
  const loginView = $('loginView'), selectView = $('selectView'), activeView = $('activeView');
  const loginBtn = $('loginBtn'), connectAppBtn = null;
  const connectBtn = $('connectBtn'), logoutBtn = $('logoutBtn'), disconnectBtn = null;
  const emailInput = $('email'), passwordInput = $('password');
  const loginMessage = $('loginMessage'), selectMessage = $('selectMessage');
  const gearBtn = $('gearBtn'), gearSheet = $('gearSheet'), sheetBackdrop = $('sheetBackdrop');
  const brandTitle = $('brandTitle');
  const engineToggleBtn = $('engineToggleBtn');
  const sentTodayDisplay = $('sentTodayDisplay');
  const pendingTodayDisplay = $('pendingTodayDisplay');

  const imageUploadInput = $('imageUploadInput');
  const selectImagesBtn = $('selectImagesBtn');
  const clearImagesBtn = $('clearImagesBtn');
  const imageCountDisplay = $('imageCountDisplay');

  const debugDiv = $('debugLogs');
  const downloadLogsBtn = $('downloadLogsBtn');
  const clearLogsBtn = $('clearLogsBtn');
  const autoScrollToggle = $('autoScrollToggle');
  const logsOverlay = $('logsOverlay');
  const logsCloseBtn = $('logsCloseBtn');
  let autoScrollLogs = true;

  let state;
  try {
    state = await chrome.storage.local.get(['accessToken', 'browserId', 'browserLabel', 'stats', 'sessionExpired']);
  } catch (e) {
    state = { accessToken: null, browserId: null, browserLabel: null, stats: null };
  }

  // One-time cleanup of keys retired by the v1.4 UI redesign.
  chrome.storage.local.remove(['pacingSettings', 'disconnectedByUser']).catch(() => { });

  // ── auth view rendering (deterministic, subscribes to storage) ──
  const AUTH_KEYS = ['accessToken', 'refreshToken', 'browserId', 'browserLabel', 'sessionExpired'];
  let lastAuthRender = '';

  async function renderAuthView() {
    const snap = await chrome.storage.local.get(['accessToken', 'browserId', 'browserLabel', 'sessionExpired']);
    const sig = `${!!snap.accessToken}|${!!snap.browserId}|${!!snap.sessionExpired}`;
    const entering = sig !== lastAuthRender;
    lastAuthRender = sig;

    closeGear();

    if (!snap.accessToken) {
      showLoginView();
      if (snap.sessionExpired) showMessage(loginMessage, 'Your session expired. Log in again to continue.', 'error');
      return;
    }
    if (snap.browserId) {
      showActiveView(snap.browserLabel);
    } else {
      showConnectingView();
      if (entering) chrome.runtime.sendMessage({ type: 'HUB_CONNECT' });
    }
  }

  function showLoginView() {
    selectView.classList.add('hidden');
    activeView.classList.add('hidden');
    logsOverlay.classList.add('hidden');
    loginView.classList.remove('hidden');
    emailInput.value = '';
    passwordInput.value = '';
    loginBtn.textContent = 'Login';
    loginBtn.disabled = false;
    showMessage(loginMessage, '', '');
  }

  function showConnectingView() {
    loginView.classList.add('hidden');
    activeView.classList.add('hidden');
    selectView.classList.remove('hidden');
    showMessage(selectMessage, 'Connecting this browser to your account...', '');
  }

  async function showActiveView(label) {
    loginView.classList.add('hidden');
    selectView.classList.add('hidden');
    activeView.classList.remove('hidden');
    refreshStatsFromBackground();
    const data = await chrome.storage.local.get('enginePaused');
    updateEngineToggle(!!data.enginePaused);
  }

  renderAuthView();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!AUTH_KEYS.some(k => k in changes)) return;
    renderAuthView();
  });

  // ── login ──
  loginBtn.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    const password = passwordInput.value.trim();
    if (!email || !password) {
      showMessage(loginMessage, 'Please enter Email and Password', 'error');
      return;
    }
    loginBtn.textContent = 'Authenticating...';
    loginBtn.disabled = true;
    chrome.runtime.sendMessage({ type: 'HUB_LOGIN', payload: { email, password } });
  });

  // ── manual reconnect (edge state only) ──
  connectBtn.addEventListener('click', async () => {
    connectBtn.textContent = 'Connecting...';
    connectBtn.disabled = true;
    showMessage(selectMessage, 'Linking this browser to your account...', '');
    chrome.runtime.sendMessage({ type: 'HUB_CONNECT' });
  });

  // ── logout (gear sheet) ──
  logoutBtn.addEventListener('click', async () => {
    await chrome.storage.local.remove([
      'accessToken', 'refreshToken', 'sessionExpired',
      'enginePaused', 'wakeUpAt'
    ]);
    chrome.runtime.sendMessage({ type: 'HUB_DISCONNECT' });
    showLoginView();
  });

  // ── engine toggle ──
  engineToggleBtn.addEventListener('click', async () => {
    const data = await chrome.storage.local.get('enginePaused');
    const newPaused = !data.enginePaused;
    await chrome.storage.local.set({ enginePaused: newPaused });
    updateEngineToggle(newPaused);
    chrome.runtime.sendMessage({ type: newPaused ? 'HUB_PAUSE_ENGINE' : 'HUB_RESUME_ENGINE' });
  });

  function updateEngineToggle(isPaused) {
    engineToggleBtn.classList.toggle('paused', isPaused);
    engineToggleBtn.classList.toggle('running', !isPaused);
    engineToggleBtn.textContent = isPaused ? 'Press to start' : 'Press to stop';
    engineToggleBtn.setAttribute('aria-label', isPaused ? 'Start engine' : 'Stop engine');
  }

  // ── gear sheet ──
  const backBtn = $('backBtn');
  function closeGear() {
    gearSheet.classList.add('hidden');
    sheetBackdrop.classList.add('hidden');
  }
  gearBtn.addEventListener('click', () => {
    gearSheet.classList.remove('hidden');
    sheetBackdrop.classList.remove('hidden');
  });
  sheetBackdrop.addEventListener('click', closeGear);
  backBtn.addEventListener('click', closeGear);

  // ── stats cards ──
  function renderStats(stats) {
    if (!stats) return;
    sentTodayDisplay.textContent = stats.sentToday ?? 0;
    pendingTodayDisplay.textContent = stats.pendingToday ?? 0;
  }
  function refreshStatsFromBackground() {
    chrome.runtime.sendMessage({ type: 'GET_STATS' }, response => {
      if (chrome.runtime.lastError || !response?.stats) return;
      renderStats(response.stats);
    });
  }
  chrome.runtime.onMessage.addListener(msg => {
    if (msg.type === 'STATS_UPDATE') renderStats(msg.stats);

    if (msg.type === 'HUB_LOGIN_SUCCESS') {
      lastAuthRender = '';           // force transition detection on next render
      showConnectingView();
    }
    if (msg.type === 'HUB_LOGIN_ERROR') {
      showMessage(loginMessage, msg.error || 'Login failed', 'error');
      loginBtn.textContent = 'Login';
      loginBtn.disabled = false;
    }
    if (msg.type === 'HUB_CONNECTED_SUCCESS') showActiveView(msg.label);
    if (msg.type === 'HUB_CONNECTED_ERROR') {
      showMessage(selectMessage, msg.error || 'Connection failed', 'error');
      connectBtn.textContent = 'Reconnect Engine';
      connectBtn.disabled = false;
    }
    if (msg.type === 'HUB_SESSION_EXPIRED') {
      showLoginView();
      showMessage(loginMessage, 'Your session expired. Log in again to continue.', 'error');
    }
    if (msg.type === 'DEBUG_LOG' && !logsOverlay.classList.contains('hidden')) {
      appendLog(`[${new Date().toLocaleTimeString()}] ${msg.msg}`);
    }
  });

  // ── hidden gesture: tap the wordmark 7× (within 4s) to reveal live logs ──
  let taps = 0, tapTimer = null;
  brandTitle.addEventListener('click', () => {
    taps++;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => { taps = 0; }, 4000);
    if (taps >= 7) {
      taps = 0;
      openLogs();
    }
  });

  function openLogs() {
    logsOverlay.classList.remove('hidden');
    loadStoredLogsIntoDom();
    refreshStatsFromBackground();
  }
  logsCloseBtn.addEventListener('click', () => logsOverlay.classList.add('hidden'));

  function loadStoredLogsIntoDom() {
    chrome.storage.local.get('engineLogs').then(stored => {
      if (!debugDiv || !stored.engineLogs) return;
      debugDiv.innerHTML = stored.engineLogs;
      if (autoScrollLogs) debugDiv.scrollTop = debugDiv.scrollHeight;
    });
  }

  autoScrollToggle.addEventListener('click', () => {
    autoScrollLogs = !autoScrollLogs;
    autoScrollToggle.classList.toggle('off', !autoScrollLogs);
    autoScrollToggle.setAttribute('aria-pressed', String(autoScrollLogs));
    autoScrollToggle.textContent = `Auto-scroll: ${autoScrollLogs ? 'on' : 'off'}`;
    if (autoScrollLogs && debugDiv) debugDiv.scrollTop = debugDiv.scrollHeight;
  });

  clearLogsBtn.addEventListener('click', async () => {
    debugDiv.innerHTML = '<div>[System] Logs cleared.</div>';
    await chrome.storage.local.set({ engineLogs: debugDiv.innerHTML });
    await chrome.storage.local.set({ engineEvents: [] });
  });

  function appendLog(text) {
    const entry = document.createElement('div');
    entry.textContent = text;
    debugDiv.appendChild(entry);
    const entries = debugDiv.querySelectorAll('div');
    if (entries.length > 500) {
      for (let i = 0; i < entries.length - 500; i++) entries[i].remove();
    }
    if (autoScrollLogs) debugDiv.scrollTop = debugDiv.scrollHeight;
  }

  // ── download diagnostic bundle (subtle mini action in gear sheet) ──
  downloadLogsBtn?.addEventListener('click', async () => {
    let events = [];
    let legacyHtml = '';
    try {
      const stored = await chrome.storage.local.get(['engineEvents', 'engineLogs']);
      events = Array.isArray(stored.engineEvents) ? stored.engineEvents : [];
      legacyHtml = stored.engineLogs || '';
    } catch (e) { }

    const manifest = chrome.runtime.getManifest();
    const parts = [];
    parts.push('=== DMDroid DIAGNOSTIC BUNDLE ===');
    parts.push(`Generated: ${new Date().toISOString()}`);
    parts.push(`Extension: v${manifest.version}`);
    parts.push(`User agent: ${navigator.userAgent}`);
    parts.push('');
    parts.push('--- SESSION EVENTS ---');
    if (events.length === 0) parts.push('(no structured events recorded)');
    for (const e of events) {
      const time = new Date(e.ts).toLocaleTimeString();
      const { ts, lvl, ev, ...rest } = e;
      const fields = Object.keys(rest).length ? ' | ' + JSON.stringify(rest) : '';
      parts.push(`[${time}] ${(lvl || 'info').toUpperCase()} ${ev}${fields}`);
    }
    parts.push('');
    parts.push('--- LEGACY ENGINE LOG ---');
    try {
      if (legacyHtml) {
        const doc = new DOMParser().parseFromString(legacyHtml, 'text/html');
        parts.push(Array.from(doc.querySelectorAll('div')).map(d => d.textContent).join('\n'));
      } else {
        parts.push('(empty)');
      }
    } catch (e) {
      parts.push('(legacy log unavailable)');
    }

    const blob = new Blob([parts.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dmdroid-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // ── local image manager ──
  if (globalThis.ImageStorage && imageCountDisplay) {
    globalThis.ImageStorage.getAllImagesCount().then(count => {
      imageCountDisplay.textContent = count;
    }).catch(e => console.error('Error loading image count', e));
  }

  selectImagesBtn?.addEventListener('click', () => imageUploadInput.click());

  imageUploadInput?.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    selectImagesBtn.textContent = 'Saving...';
    selectImagesBtn.disabled = true;

    async function detectMimeType(file) {
      const buffer = await file.slice(0, 12).arrayBuffer();
      const bytes = new Uint8Array(buffer);
      if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
      if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
      if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
          bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
      if (bytes[0] === 0x42 && bytes[1] === 0x4D) return 'image/bmp';
      return 'image/jpeg';
    }

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const username = file.name.replace(/\.[^.]+$/, '');
        let mimeType = file.type;
        if (!mimeType || !mimeType.startsWith('image/')) {
          mimeType = await detectMimeType(file);
        }
        const correctBlob = new Blob([await file.arrayBuffer()], { type: mimeType });
        await globalThis.ImageStorage.saveImage(username, correctBlob);
      }
      const newCount = await globalThis.ImageStorage.getAllImagesCount();
      if (imageCountDisplay) imageCountDisplay.textContent = newCount;
    } catch (err) {
      console.error('Upload error', err);
    } finally {
      selectImagesBtn.textContent = 'Select Images';
      selectImagesBtn.disabled = false;
      imageUploadInput.value = '';
    }
  });

  clearImagesBtn?.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear all loaded images?')) {
      try {
        await globalThis.ImageStorage.clearAll();
        const newCount = await globalThis.ImageStorage.getAllImagesCount();
        if (imageCountDisplay) imageCountDisplay.textContent = newCount;
      } catch (err) {
        console.error('Clear error', err);
      }
    }
  });

  function showMessage(element, msg, type) {
    if (!element) return;
    element.textContent = msg;
    element.className = type ? `message ${type}` : 'message';
  }
});
