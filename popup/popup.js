document.addEventListener('DOMContentLoaded', async () => {
  // ── element refs ──
  const $ = id => document.getElementById(id);
  const loginView = $('loginView'), selectView = $('selectView'), activeView = $('activeView');
  // ── consent view refs ──
  const consentView = $('consentView');
  const consentBtn = $('consentBtn');
  const consentCheckbox = $('consentCheckbox');
  const privacyPolicyLink = $('privacyPolicyLink');
  const tosLink = $('tosLink');
  const loginBtn = $('loginBtn'), connectAppBtn = null;
  const forgotLink = $('forgotLink');
  const connectBtn = $('connectBtn'), logoutBtn = $('logoutBtn'), disconnectBtn = null;
  const emailInput = $('email'), passwordInput = $('password');
  const loginMessage = $('loginMessage'), selectMessage = $('selectMessage');
  const gearBtn = $('gearBtn'), gearSheet = $('gearSheet'), sheetBackdrop = $('sheetBackdrop');
  const brandTitle = $('brandTitle');
  const engineToggleBtn = $('engineToggleBtn');
  const sentTodayDisplay = $('sentTodayDisplay');
  const pendingTodayDisplay = $('pendingTodayDisplay');

  // ── next-DM countdown (V.A. gesture reveal) ──
  const nextSendStrip = $('nextSendStrip');
  const nextSendTime = $('nextSendTime');
  const nextSendWhy = $('nextSendWhy');
  const pendingCard = pendingTodayDisplay ? pendingTodayDisplay.closest('.qcard') : null;
  let nextSendVisible = false;
  let nextSendData = null;
  let nextSendTickTimer = null;
  let nextSendTickCount = 0;

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

  // ── takeover waiting banner refs (declared up here so nothing that runs
  //    earlier — renderAuthView -> showActiveView -> refreshTakeover — can hit
  //    a temporal-dead-zone on them) ──
  const takeoverBanner = $('takeoverBanner');
  const takeoverHandle = $('takeoverHandle');
  const takeoverText = $('takeoverText');
  const takeoverBtn = $('takeoverBtn');
  let takeoverArmed = false;
  let takeoverArmTimer = null;

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
    const snap = await chrome.storage.local.get(['consentGiven', 'accessToken', 'browserId', 'browserLabel', 'sessionExpired']);
    const sig = `${!!snap.accessToken}|${!!snap.browserId}|${!!snap.sessionExpired}`;
    const entering = sig !== lastAuthRender;
    lastAuthRender = sig;

    closeGear();

    // Gate: consent must come first. If not yet given, show consent screen and stop.
    if (!snap.consentGiven) {
      showConsentView();
      return;
    }

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

  // ── view switching (single source of truth) ──
  // One screen at a time. Every show*View() used to hide only SOME of the
  // other screens, and none of them hid consentView: clicking "Continue" on
  // the consent screen left it rendered above the login form, so the popup
  // grew to two screens tall and looked like it panned/glitched.
  const ALL_VIEWS = [consentView, loginView, selectView, activeView, logsOverlay];
  function showOnlyView(view) {
    for (const v of ALL_VIEWS) v.classList.toggle('hidden', v !== view);
  }

  function showConsentView() {
    showOnlyView(consentView);
  }

  function showLoginView() {
    showOnlyView(loginView);
    passwordInput.value = '';
    // Prefill the remembered email — after a web-app password reset the user
    // only needs to type their new password.
    chrome.storage.local.get('lastLoginEmail').then(s => {
      emailInput.value = s.lastLoginEmail || '';
    });
    loginBtn.textContent = 'Login';
    loginBtn.disabled = false;
    showMessage(loginMessage, '', '');
  }

  function showConnectingView() {
    showOnlyView(selectView);
    showMessage(selectMessage, 'Connecting this browser to your account...', '');
  }

  async function showActiveView(label) {
    showOnlyView(activeView);
    refreshTakeover();
    refreshStatsFromBackground();
    refreshNextSendOnShow();
    const data = await chrome.storage.local.get('enginePaused');
    updateEngineToggle(!!data.enginePaused);
  }

  renderAuthView();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if ('takeoverWaiting' in changes) {
      renderTakeover(changes.takeoverWaiting.newValue || null);
    }
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
    // Remember the email so the login view can prefill it (e.g. after a
    // password reset completed on the web app).
    chrome.storage.local.set({ lastLoginEmail: email });
    chrome.runtime.sendMessage({ type: 'HUB_LOGIN', payload: { email, password } });
  });

  // ── forgot password (bridges to the web app's email-link reset) ──
  forgotLink.addEventListener('click', async () => {
    await chrome.tabs.create({ url: 'https://app.dmdroid.app/auth' });
    window.close();
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
    // Also remove consentGiven so the consent screen re-appears on next login.
    // This satisfies the Chrome Web Store requirement that consent is re-obtained
    // if the user fully logs out and starts a new session.
    await chrome.storage.local.remove([
      'accessToken', 'refreshToken', 'sessionExpired',
      'enginePaused', 'wakeUpAt', 'consentGiven',
      'takeoverBackoff', 'takeoverWaiting'
    ]);
    chrome.runtime.sendMessage({ type: 'HUB_DISCONNECT' });
    showLoginView();
  });

  // ── consent view handlers ──
  // Checkbox enables the Continue button
  consentCheckbox.addEventListener('change', () => {
    consentBtn.disabled = !consentCheckbox.checked;
  });

  // Continue button: persist consent and proceed to login
  consentBtn.addEventListener('click', async () => {
    if (!consentCheckbox.checked) return;
    await chrome.storage.local.set({ consentGiven: true });
    showLoginView();
  });

  // Links open in a new tab (chrome.tabs.create is required in MV3 popups)
  privacyPolicyLink.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://dmdroid.app/privacy-policy' });
  });
  tosLink.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://dmdroid.app/terms' });
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

  // ── takeover waiting banner (reinstall pairing) ──
  // This browser can be fully online and still send nothing, because another
  // row's LIVE LEASE still holds the Instagram account (a deleted extension's
  // lease takes ~10 minutes to lapse). Before this the state was invisible: the
  // engine just looked idle for 10+ minutes with no explanation.
  function renderTakeover(waiting) {
    clearTimeout(takeoverArmTimer);
    takeoverArmed = false;
    takeoverBtn.classList.remove('armed');
    takeoverBtn.textContent = 'Take it over now';
    takeoverBtn.classList.remove('hidden');

    if (!waiting || !waiting.handle) {
      takeoverBanner.classList.add('hidden');
      return;
    }
    takeoverBanner.classList.remove('hidden');
    takeoverHandle.textContent = waiting.handle;
    const until = waiting.until ? new Date(waiting.until).toLocaleTimeString() : null;
    takeoverText.textContent = until
      ? `Another browser's lease on this account runs until ${until}. It reconnects by itself after that — or you can take it over right now.`
      : `Another browser is holding this account. It reconnects by itself — or you can take it over right now.`;
  }

  async function refreshTakeover() {
    const s = await chrome.storage.local.get('takeoverWaiting');
    renderTakeover(s.takeoverWaiting || null);
  }

  takeoverBtn.addEventListener('click', () => {
    // Two-step confirm rather than window.confirm(): a native dialog can steal
    // focus and dismiss the popup before the click ever lands.
    if (!takeoverArmed) {
      takeoverArmed = true;
      takeoverBtn.classList.add('armed');
      takeoverBtn.textContent = 'Confirm — take over';
      takeoverArmTimer = setTimeout(() => {
        takeoverArmed = false;
        takeoverBtn.classList.remove('armed');
        takeoverBtn.textContent = 'Take it over now';
      }, 6000);
      return;
    }
    clearTimeout(takeoverArmTimer);
    takeoverArmed = false;
    takeoverBtn.classList.remove('armed');
    takeoverBtn.textContent = 'Taking over...';
    chrome.runtime.sendMessage({ type: 'HUB_FORCE_TAKEOVER' });
  });

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
    if (msg.type === 'HUB_TAKEOVER_WAITING') {
      renderTakeover({ handle: msg.handle, until: msg.until });
    }
    if (msg.type === 'HUB_TAKEOVER_DONE') {
      takeoverBanner.classList.remove('hidden');
      takeoverHandle.textContent = msg.handle || '';
      takeoverText.textContent = 'Done — this browser owns the account now. Sending resumes on the next poll.';
      takeoverBtn.classList.add('hidden');
      setTimeout(() => { refreshTakeover(); }, 3500);
    }
    if (msg.type === 'HUB_TAKEOVER_FAILED') {
      takeoverBanner.classList.remove('hidden');
      takeoverText.textContent = `Couldn't take over: ${msg.error || 'unknown error'}`;
      takeoverBtn.classList.remove('hidden');
      takeoverBtn.textContent = 'Try again';
    }
    if (msg.type === 'WAKE_WAKEUP' && nextSendVisible) {
      askNextSend();                   // engine woke → plan may have changed
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

  // ── hidden gesture: tap "Pending today" 7× (within 4s) to reveal the
  //    next-DM countdown on the main screen. V.A.-only — regular users never
  //    discover it, and the strip stays display:none until then. ──
  let cardTaps = 0, cardTapTimer = null;
  if (pendingCard) {
    pendingCard.addEventListener('click', () => {
      cardTaps++;
      clearTimeout(cardTapTimer);
      cardTapTimer = setTimeout(() => { cardTaps = 0; }, 4000);
      if (cardTaps >= 7) {
        cardTaps = 0;
        nextSendVisible = true;
        nextSendStrip.classList.add('visible');
        if (nextSendData) renderNextSend(nextSendData);
        else askNextSend();
        startNextSendTicker();
      }
    });
  }

  // ── next-DM countdown engine ──
  // The background already knows when the next send may fire: every poll cycle
  // persists wakeUpAt (+ WHY: schedule / floor / hours / backoff) via setWake().
  // This is that planned gap, rendered locally — no new storage, no spam.
  function fmtCountdown(ms) {
    if (ms <= 0) return 'now';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }

  function renderNextSend(data) {
    if (!data || !data.nextSendAt) {
      nextSendTime.textContent = 'no DM scheduled';
      nextSendWhy.textContent = data && data.reason === 'paused' ? 'engine is paused' : '';
      return;
    }
    nextSendTime.textContent = `in ~${fmtCountdown(data.nextSendAt - Date.now())}`;
    nextSendWhy.textContent =
      data.reason === 'paused'   ? 'engine paused' :
      data.reason === 'schedule' ? 'waiting for its scheduled time' :
      data.reason === 'hours'    ? 'outside working hours' :
      data.reason === 'floor'    ? '3-min pacing floor' :
      data.reason === 'backoff'  ? 'nothing due — polling' : '';
  }

  function askNextSend() {
    chrome.runtime.sendMessage({ type: 'GET_NEXT_SEND' }, response => {
      if (chrome.runtime.lastError) return;
      if (!response || !response.nextSend) return;
      nextSendData = response.nextSend;
      renderNextSend(nextSendData);
    });
  }

  function startNextSendTicker() {
    if (nextSendTickTimer) return;
    nextSendTickCount = 0;
    nextSendTickTimer = setInterval(() => {
      if (!nextSendVisible) {           // popup re-opened → strip hidden again
        clearInterval(nextSendTickTimer);
        nextSendTickTimer = null;
        return;
      }
      if (nextSendData) renderNextSend(nextSendData);
      if (++nextSendTickCount % 30 === 0) askNextSend();   // re-sync with the engine
    }, 1000);
  }

  function refreshNextSendOnShow() {
    if (!nextSendVisible) return;
    startNextSendTicker();
  }

  function openLogs() {
    logsOverlay.classList.remove('hidden');
    loadStoredLogsIntoDom();
    refreshStatsFromBackground();
    // V.A. convenience: print the next-DM plan as a log line too.
    askNextSend();
    setTimeout(() => {
      if (!nextSendData) return;
      const when = nextSendData.nextSendAt ? new Date(nextSendData.nextSendAt).toLocaleTimeString() : '(none)';
      const gap = nextSendData.nextSendAt ? fmtCountdown(nextSendData.nextSendAt - Date.now()) : '—';
      appendLog(`[System] Next DM: in ~${gap} (at ${when}) — reason: ${nextSendData.reason || 'idle'}`);
    }, 400);
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
