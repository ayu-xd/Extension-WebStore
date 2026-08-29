const SUPABASE_URL = "https://pkzkoixryggxktaybwkp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBremtvaXhyeWdneGt0YXlid2twIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2MDQ2MDQsImV4cCI6MjA5MjE4MDYwNH0.G21RTb9scU7biERl1HqKQYOCUYV4pKStKF9Ls4lo8rY";

importScripts("assets/imageStorage.js");

let state = {
  accessToken: null,
  refreshToken: null,
  browserId: null,
  browserLabel: null,
  instanceKey: null,
  stats: { completed: 0, failed: 0 },
  isProcessing: false,
  processingLockAcquiredAt: 0,
  mainTabId: null,
  additionalTabId: null,
  lastTaskCompletedAt: 0,
  emptyPollCount: 0
};

// F5b: single-flight queue — read→append→write per entry, strictly ordered.
// Without this, concurrent debugLog calls (task logs + heartbeat + collector)
// race on engineLogs and silently drop entries.
let _logQueue = Promise.resolve();
function persistDebugLog(msg) {
  _logQueue = _logQueue.then(() => _writeDebugLogEntry(msg)).catch(() => { });
  return _logQueue;
}

async function _writeDebugLogEntry(msg) {
  try {
    const stored = await chrome.storage.local.get('engineLogs');
    const entry = `<div>[${new Date().toLocaleTimeString()}] ${escapeHtml(String(msg))}</div>`;
    const logHtml = (stored.engineLogs || '') + entry;
    const entries = logHtml.match(/<div>/g) || [];
    let updated = logHtml;

    if (entries.length > 500) {
      const parts = logHtml.split(/(?=<div>)/).filter(Boolean);
      updated = parts.slice(-500).join('');
    }

    await chrome.storage.local.set({ engineLogs: updated });
  } catch (e) {
    console.warn('Failed to persist debug log:', e);
  }
}

// ---------------------------------------------------------------------------
// Structured diagnostics (shareable): JSON events correlated by taskId.
// Answers exactly four questions about any run:
//   1. Which send path did a followup take (additional-tab handoff vs main-tab fallback)?
//   2. What did the live-id scrape return?
//   3. What page/check state was each tab in (URL, store hydration, clickChat)?
//   4. Why did anything retry or fail (typed classification)?
// Exported via popup -> "Download Logs". Never contains tokens/secrets.
// ---------------------------------------------------------------------------
const DIAG_EVENTS_CAP = 1500;

function dlog(ev, fields = {}, lvl = "info") {
  const entry = { ts: Date.now(), lvl, ev, ...fields };
  _logQueue = _logQueue.then(async () => {
    try {
      const stored = await chrome.storage.local.get("engineEvents");
      const events = Array.isArray(stored.engineEvents) ? stored.engineEvents : [];
      events.push(entry);
      if (events.length > DIAG_EVENTS_CAP) events.splice(0, events.length - DIAG_EVENTS_CAP);
      await chrome.storage.local.set({ engineEvents: events });
    } catch { }
  }).catch(() => { });
  return _logQueue;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function debugLog(msg) {
  persistDebugLog(msg).catch(() => { });
  chrome.runtime.sendMessage({ type: "DEBUG_LOG", msg }).catch(() => null);
}

// Dashboard-timezone "today" boundaries as UTC instants (read-only helper for
// the popup's sent/pending cards; no writes, no new tables).
function tzDayBoundsUtc(tz) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  const p = {};
  fmt.formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
  const guess = Date.parse(`${p.year}-${p.month}-${p.day}T00:00:00Z`);
  const f2 = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const q = {};
  f2.formatToParts(new Date(guess)).forEach(x => { q[x.type] = x.value; });
  const offset = Date.parse(`${q.year}-${q.month}-${q.day}T${q.hour}:${q.minute}:${q.second}Z`) - guess;
  return { start: new Date(guess - offset), end: new Date(guess - offset + 86400000) };
}

async function computeTodayStats() {
  if (!state.browserId) return { sentToday: 0, pendingToday: 0 };
  try {
    let tz;
    try {
      tz = (await getAccountHours())?.tz || browserTimeZone();
    } catch (_e) {
      tz = browserTimeZone();
    }
    const bounds = tzDayBoundsUtc(tz);
    const start = bounds.start.toISOString();
    const end = bounds.end.toISOString();
    const sent = await supabaseReq(`dm_tasks?select=id&browser_instance_id=eq.${state.browserId}&status=eq.completed&completed_at=gte.${start}&completed_at=lt.${end}`);
    const pend = await supabaseReq(`dm_tasks?select=id&browser_instance_id=eq.${state.browserId}&status=eq.pending&or=(scheduled_at.is.null,scheduled_at.lt.${end})`);
    return { sentToday: (sent || []).length, pendingToday: (pend || []).length };
  } catch (_e) {
    return { sentToday: 0, pendingToday: 0 };
  }
}

async function syncStatsFromDatabase() {
  if (!state.browserId) return state.stats;

  try {
    const rows = await supabaseReq(`dm_tasks?select=id,status&browser_instance_id=eq.${state.browserId}&status=in.(completed,failed)`);
    const stats = (rows || []).reduce((acc, row) => {
      if (row.status === 'completed') acc.completed += 1;
      if (row.status === 'failed') acc.failed += 1;
      return acc;
    }, { completed: 0, failed: 0 });

    state.stats = stats;
    await chrome.storage.local.set({ stats });
    chrome.runtime.sendMessage({ type: "STATS_UPDATE", stats }).catch(() => null);
    return stats;
  } catch (err) {
    debugLog(`Stats sync error: ${err.message}`);
    return state.stats;
  }
}

// ---------------------------------------------------------------------------
// Supabase REST Client
// ---------------------------------------------------------------------------
async function supabaseReq(path, method = "GET", body = null, _retried = false) {
  const headers = {
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${state.accessToken ? state.accessToken : SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation"
  };
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, options);
  if (res.status === 401 && !_retried && state.refreshToken) {
    debugLog("Token expired, refreshing...");
    const refreshed = await refreshAccessToken();
    if (refreshed) return supabaseReq(path, method, body, true);
  }
  if (!res.ok) {
    throw new Error(`Supabase error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// Upsert (POST ...?on_conflict=...) with merge-duplicates. Used for the new
// per-account `contact_account_outreach` table so re-sending state for the same
// (contact, browser) pair updates instead of erroring on the unique constraint.
async function supabaseUpsert(path, body, onConflict, _retried = false) {
  const headers = {
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${state.accessToken ? state.accessToken : SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
    "Prefer": "resolution=merge-duplicates,return=representation"
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}?on_conflict=${onConflict}`, {
    method: "POST", headers, body: JSON.stringify(body)
  });
  if (res.status === 401 && !_retried && state.refreshToken) {
    debugLog("Token expired, refreshing...");
    const refreshed = await refreshAccessToken();
    if (refreshed) return supabaseUpsert(path, body, onConflict, true);
  }
  if (!res.ok) {
    throw new Error(`Supabase upsert error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// Dual-write: mirror per-account outreach state into contact_account_outreach.
// Non-fatal by design — the global `contacts` write is still the source of truth
// in Phase 1, so a failure here must never break a send.
async function caoUpsert(contactId, fields) {
  try {
    if (!contactId || !state.browserId) return;
    const userId = getUserIdFromToken(state.accessToken);
    if (!userId) return;
    await supabaseUpsert(
      "contact_account_outreach",
      {
        user_id: userId,
        contact_id: contactId,
        browser_instance_id: state.browserId,
        updated_at: new Date().toISOString(),
        ...fields
      },
      "contact_id,browser_instance_id"
    );
  } catch (err) {
    debugLog(`[CAO] dual-write failed (non-fatal): ${err.message}`);
  }
}

// A send can finish after executeTask's listener timed out. In that case the
// normal pollTasks success path never runs, so settle both the task and the
// contact here. This is deliberately limited to the fail-closed
// `delivery_unknown` state created by the timeout handler above.
async function settleLateVerifiedDelivery(taskId) {
  const completedAt = new Date().toISOString();
  const rows = await supabaseReq(
    `dm_tasks?id=eq.${taskId}&status=eq.failed&error_reason=like.delivery_unknown*`,
    "PATCH",
    { status: "completed", completed_at: completedAt, error_reason: null }
  );
  const task = rows?.[0];
  if (!task) return false;

  if (task.contact_id && task.task_type === "first_dm") {
    await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
      status: "dmed",
      dmed_at: completedAt,
      assigned_browser_id: state.browserId
    });
    await caoUpsert(task.contact_id, {
      status: "dmed",
      dmed_at: completedAt,
      campaign_id: task.campaign_id || null
    });
  } else if (task.contact_id && task.task_type?.startsWith("followup_")) {
    const stepLetter = task.task_type.replace("followup_1", "").toUpperCase() || "A";
    await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
      followup_1a_sent: true,
      current_follow_up: `1${stepLetter}`,
      last_follow_up_at: completedAt
    });
    await caoUpsert(task.contact_id, {
      followup_1a_sent: true,
      current_follow_up: `1${stepLetter}`,
      last_follow_up_at: completedAt
    });
  }

  state.stats.failed = Math.max(0, state.stats.failed - 1);
  state.stats.completed++;
  state.lastTaskCompletedAt = Date.now();
  await chrome.storage.local.set({ stats: state.stats });
  dlog("late_delivery_completed", { taskId, taskType: task.task_type });
  debugLog(`[Safety] Late verified delivery completed for task ${taskId}.`);
  return true;
}

async function refreshAccessToken() {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: state.refreshToken })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || "Refresh failed");
    state.accessToken = data.access_token;
    state.refreshToken = data.refresh_token;
    await chrome.storage.local.set({ accessToken: state.accessToken, refreshToken: state.refreshToken });
    // Clear any previous session-expired flag
    await chrome.storage.local.remove('sessionExpired');
    debugLog("Token refreshed!");
    return true;
  } catch (err) {
    debugLog(`Refresh failed: ${err.message}`);
    // Session honesty: mark as expired so the popup shows the native login
    // instead of a fake "Online" state. Single atomic write — no window where
    // tokens are gone but the flag isn't set yet (that race caused UI flicker).
    state.accessToken = null;
    state.refreshToken = null;
    await chrome.storage.local.set({ sessionExpired: true, accessToken: null, refreshToken: null });
    stopEngine();
    chrome.runtime.sendMessage({ type: "HUB_SESSION_EXPIRED" }).catch(() => null);
    debugLog("[Session] Marked as expired. Popup will show login.");
    return false;
  }
}

// ---------------------------------------------------------------------------
// Extension Core Logic
// ---------------------------------------------------------------------------

async function init() {
  const data = await chrome.storage.local.get(['accessToken', 'refreshToken', 'browserId', 'browserLabel', 'instanceKey', 'stats', 'mainTabId', 'additionalTabId', 'enginePaused', 'disconnectedByUser']);
  if (data.accessToken) state.accessToken = data.accessToken;
  if (data.refreshToken) state.refreshToken = data.refreshToken;
  if (data.browserId && !data.disconnectedByUser) state.browserId = data.browserId;
  if (data.browserLabel) state.browserLabel = data.browserLabel;
  if (data.instanceKey) state.instanceKey = data.instanceKey;
  if (data.stats) state.stats = data.stats;
  if (data.mainTabId) state.mainTabId = data.mainTabId;
  if (data.additionalTabId) state.additionalTabId = data.additionalTabId;

  // Heartbeat runs 24/7 — even when paused — so the web app knows the browser is online.
  // Clear any stale leaseExpiresAt so the first write after restart always goes through,
  // preventing browsers from showing Offline after a reload or DB migration.
  if (state.browserId) {
    chrome.alarms.create("engine_heartbeat", { periodInMinutes: 1 });
    await chrome.storage.local.remove('leaseExpiresAt');
    sendHeartbeat(true).catch(() => { });
  }

  if (data.enginePaused) {
    debugLog("[Init] Engine is paused, skipping task engine auto-start.");
    return;
  }

  if (state.refreshToken && state.browserId) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      startEngine();
      await syncStatsFromDatabase();
    }
  } else if (state.accessToken && state.browserId) {
    startEngine();
    await syncStatsFromDatabase();
  } else if (state.refreshToken || state.accessToken) {
    // We have a session but no paired row (e.g. the row was deleted from the
    // dashboard, or this is the first boot after a session sync). Re-pair via
    // the idempotent upsert — create-or-adopt this browser's own row.
    // NEVER auto-repair while the user explicitly disconnected.
    if (data.disconnectedByUser) {
      debugLog("[Init] User disconnected — staying unlinked until Reconnect.");
    } else {
      if (state.refreshToken) await refreshAccessToken();
      if (state.accessToken) await ensurePairedRow();
    }
  }
}

async function handleLogin(email, password) {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error_description || data.msg || "Authentication failed");

    state.accessToken = data.access_token;
    state.refreshToken = data.refresh_token;
    // Fresh own-session login — clear prior expiry/disconnect flags in one write.
    await chrome.storage.local.set({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      sessionExpired: false,
      disconnectedByUser: false
    });

    chrome.runtime.sendMessage({ type: "HUB_LOGIN_SUCCESS" }).catch(() => null);

    // Pairing is automatic — create-or-adopt this browser's row right after a
    // successful login.
    await ensurePairedRow();
  } catch (err) {
    chrome.runtime.sendMessage({ type: "HUB_LOGIN_ERROR", error: err.message }).catch(() => null);
  }
}

function getUserIdFromToken(token) {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(atob(base64).split('').map(function (c) {
      return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    return JSON.parse(jsonPayload).sub;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Auto-Pair: create or adopt a browser_instances row without user input.
// Called after session sync or login. RLS permits owner-scoped inserts.
// Handles UNIQUE(ig_username) conflicts by adopting the existing row.
// ---------------------------------------------------------------------------

function generateInstanceKey() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let key = "";
  for (let i = 0; i < 12; i++) {
    if (i > 0 && i % 4 === 0) key += "-";
    key += chars[Math.floor(Math.random() * chars.length)];
  }
  return key;
}

// Ensures this browser has a STABLE instance_key persisted in chrome.storage.
// The key (not row count) is the identity of "this physical browser": it lets us
// tell apart "the same machine reconnecting" (same key → adopt) from "a new
// distinct browser" (different key → always create a fresh row).
//
// SINGLE-FLIGHT: concurrent callers (SW boot + popup connect can fire in the
// same second) share one promise. Without this, two callers both saw "no key",
// generated different keys, and the browser got TWO rows — the duplicate-
// browser bug from 2026-08-23.
let _instanceKeyPromise = null;
async function ensureInstanceKey() {
  if (state.instanceKey) return state.instanceKey;
  if (_instanceKeyPromise) return _instanceKeyPromise;
  _instanceKeyPromise = (async () => {
    let stored = null;
    try {
      stored = (await chrome.storage.local.get('instanceKey')).instanceKey || null;
    } catch (e) { }
    if (!stored) {
      stored = generateInstanceKey();
      try {
        await chrome.storage.local.set({ instanceKey: stored });
        debugLog(`[AutoPair] Created persistent instance key: ${stored}`);
      } catch (e) { }
    }
    state.instanceKey = stored;
    return stored;
  })();
  const result = await _instanceKeyPromise;
  _instanceKeyPromise = null;
  return result;
}

// ---------------------------------------------------------------------------
// Ownership (simplified): with UNIQUE(user_id, instance_key) in the DB, a
// physical browser profile maps to exactly ONE row. instance_key is the single
// source of truth; browserId is just a cache of that row's id.
//
// We no longer verify ownership on every heartbeat (that DB read on every write
// was the source of thrash and "split-brain" churn). The only real failure mode
// left is "the row was deleted from the dashboard while we were away" — which is
// cheap to recover from by simply re-running the idempotent upsert in
// autoPairBrowser(). ensurePairedRow() does exactly that when browserId is
// missing, and is a no-op when we already have one.
// ---------------------------------------------------------------------------
async function ensurePairedRow() {
  if (state.browserId) return true;
  if (!state.accessToken) return false;
  await autoPairBrowser();
  return !!state.browserId;
}

// ---------------------------------------------------------------------------
// Auto-Pair (simplified): ONE idempotent upsert keyed on (user_id, instance_key).
//
// The DB has a UNIQUE(user_id, instance_key) constraint (see
// supabase/simplify_pairing_unique_instance_key.sql). That lets us "create or
// adopt" this physical browser's row in a single call — no fetch-all,
// no find-or-create branching, no key-collision retries, and structurally NO
// duplicate rows on reconnect/re-login. This replaces the old four-way race
// (autoPair + handleConnect + verifyOwnership + registerAccounts) with one path.
//
// It also writes the heartbeat lease FIRST (before the slower stats/engine work)
// so the dashboard flips to "Online" immediately after login instead of after
// the whole chain finishes — the "Offline right after setup" fix.
// ---------------------------------------------------------------------------
// SINGLE-FLIGHT: duplicate HUB_CONNECTs (popup + storage-change render) must
// collapse into one pairing run, never two racing full chains.
let _pairingPromise = null;

async function autoPairBrowser() {
  // Already paired in this worker's memory → nothing to do. Keeps reconnect
  // spam (multiple boot paths) from re-running heartbeats/engine starts.
  if (state.browserId) return;

  if (_pairingPromise) return _pairingPromise;
  _pairingPromise = _autoPairBrowserInner().finally(() => { _pairingPromise = null; });
  return _pairingPromise;
}

async function _autoPairBrowserInner() {
  const userId = getUserIdFromToken(state.accessToken);
  if (!userId) {
    debugLog("[Pair] No valid token — cannot pair.");
    return;
  }

  try {
    const myKey = await ensureInstanceKey();

    // Create-or-adopt the row for THIS browser profile in one call.
    // NOTE: we deliberately do NOT send `label` here — on reconnect the row may
    // already carry an "@ig_username" label that registerAccounts set, and a
    // merge-duplicates upsert would clobber it. We only assert identity + active.
    const rows = await supabaseUpsert(
      "browser_instances",
      {
        user_id: userId,
        instance_key: myKey,
        status: "active",
      },
      "user_id,instance_key"
    );

    if (rows && rows.length > 0) {
      state.browserId = rows[0].id;
      state.browserLabel = rows[0].label || state.browserLabel || "Chrome";
    }

    await chrome.storage.local.set({
      browserId: state.browserId,
      browserLabel: state.browserLabel,
    });
    debugLog(`[Pair] Paired row ${state.browserId} for key ${myKey}.`);

    // Show Online NOW: write the lease before any slower work.
    await chrome.storage.local.remove('leaseExpiresAt');
    _workHoursCache = null;
    await sendHeartbeat(true);

    // Slower follow-up work (does not gate the Online state).
    await syncStatsFromDatabase();
    // Respect the pause switch — pairing links the browser, it must NOT
    // silently un-pause a paused engine (log showed pair→startEngine fights).
    const pauseState = await chrome.storage.local.get('enginePaused');
    if (pauseState.enginePaused) {
      debugLog("[Pair] Linked, but engine stays paused by user.");
    } else {
      startEngine();
    }
    chrome.runtime.sendMessage({ type: "HUB_CONNECTED_SUCCESS", label: state.browserLabel, stats: state.stats }).catch(() => null);
  } catch (err) {
    debugLog(`[Pair] Error: ${err.message}`);
    chrome.runtime.sendMessage({ type: "HUB_CONNECTED_ERROR", error: err.message }).catch(() => null);
  }
}

async function fetchBrowsers() {
  try {
    const userId = getUserIdFromToken(state.accessToken);
    if (!userId) {
      debugLog("Cannot fetch browsers: invalid or missing token");
      chrome.runtime.sendMessage({ type: "FETCH_BROWSERS_SUCCESS", browsers: [] }).catch(() => null);
      return;
    }
    const browsers = await supabaseReq(`browser_instances?user_id=eq.${userId}&select=id,label,instance_key&order=created_at.desc`);
    const list = browsers || [];

    // Only surface rows that belong to THIS physical browser (same instance_key),
    // so a user can't accidentally pick a row owned by another machine.
    const myKey = await ensureInstanceKey();
    const own = list.filter(b => b.instance_key === myKey);

    // Legacy fallback: if we have NO own-key row yet (e.g. paired before this
    // fix, so the key was never stored), show all rows so the user can still
    // pick one. handleConnect will adopt the chosen row's key.
    const result = own.length > 0 ? own : list;

    chrome.runtime.sendMessage({ type: "FETCH_BROWSERS_SUCCESS", browsers: result }).catch(() => null);
  } catch (err) {
    debugLog(`Fetch browsers error: ${err.message}`);
  }
}

// handleConnect is kept only for backward-compat with any old popup build that
// still sends HUB_CONNECT. The picker/manual-key UI is gone — connecting is now
// identical to auto-pairing this browser's own (user_id, instance_key) row.
async function handleConnect() {
  await autoPairBrowser();
}

async function startEngine() {
  stopEngine();
  console.log(`Starting Engine with Browser ID: ${state.browserId}`);
  debugLog(`Engine started for ${state.browserLabel}`);

  // Never turn every in-flight send back into pending on startup. A previous
  // service worker can still have clicked Instagram's Send button when this
  // worker starts; requeueing it here creates a second physical DM. Tasks that
  // cannot report a final outcome are left for explicit reconciliation instead.

  // Create alarms for the Manifest V3 background script.
  // Heartbeat must ALWAYS be scheduled whenever a browser is active — the auto-pair
  // flow never passes through init(), and init() only creates it if a browserId was
  // already present at boot. Creating here guarantees the 24/7 heartbeat alarm exists
  // on every connect/pair. (alarms.create is idempotent: same name replaces.)
  chrome.alarms.create("engine_heartbeat", { periodInMinutes: 1 }); // Every 1 min keep-alive
  chrome.alarms.create("engine_poll", { periodInMinutes: 0.25 }); // 15 seconds
  chrome.alarms.create("engine_refresh_token", { periodInMinutes: 45 }); // Refresh JWT every 45 min
  chrome.alarms.create("engine_collect_messages", { periodInMinutes: 2 }); // Every 2 min read-receipt check
  // UNIBOX: replies are user-initiated and bypass campaign pacing/sleeps,
  // so they get their own alarm that runs even while the engine sleeps.
  chrome.alarms.create("unibox_poll", { periodInMinutes: 1 });

  // Trigger initial runs
  pollTasks();
}

function stopEngine() {
  // NOTE: engine_heartbeat is NOT cleared here — it runs 24/7 so the web app knows the browser is online
  chrome.alarms.clear("engine_poll");
  chrome.alarms.clear("engine_refresh_token");
  chrome.alarms.clear("engine_collect_messages");
  console.log("Engine stopped.");
}

// Listen to alarms
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "engine_heartbeat") {
    sendHeartbeat().catch(() => { });
    // Self-heal: if we have a browserId, aren't paused, but the engine_poll
    // alarm doesn't exist (e.g. refresh failed at init → engine never started),
    // restart the engine now. This recovers from the "engine dead" gap.
    if (state.browserId && state.accessToken) {
      const paused = await chrome.storage.local.get('enginePaused');
      if (!paused.enginePaused) {
        const pollAlarm = await chrome.alarms.get('engine_poll');
        if (!pollAlarm) {
          debugLog("[Self-Heal] engine_poll alarm missing but browser is active — restarting engine.");
          startEngine();
        }
      }
    } else if (!state.browserId && state.accessToken) {
      // Self-heal: logged in but unpaired (row deleted from dashboard, or a
      // pairing that never completed). Re-run the idempotent create-or-adopt —
      // unless the user explicitly disconnected; then stay unlinked.
      const link = await chrome.storage.local.get('disconnectedByUser');
      if (link.disconnectedByUser) return;
      debugLog("[Self-Heal] Session present but no paired row — re-pairing.");
      await ensurePairedRow();
    }
  } else if (alarm.name === "engine_poll") {
    pollTasks().catch(() => { });
  } else if (alarm.name === "unibox_poll") {
    pollUniboxReplies().catch(() => { });
  } else if (alarm.name === "engine_refresh_token") {
    // Firm-hold login: the extension owns its own token family (independent
    // of the web app's). Refresh it unconditionally on schedule.
    refreshAccessToken().catch(() => { });
  } else if (alarm.name === "engine_collect_messages") {
    collectMessagesJob().catch(() => { });
  }
});

async function collectMessagesJob() {
  if (!state.browserId || state.isProcessing) return;
  const pauseData = await chrome.storage.local.get('enginePaused');
  if (pauseData.enginePaused) return;
  if (!state.mainTabId) return;

  if (state.lastTaskCompletedAt && Date.now() - state.lastTaskCompletedAt < 60000) {
    debugLog("[Collector] Skipping — a DM was sent less than 60s ago, waiting for Instagram to settle.");
    return;
  }

  try {
    debugLog("[Collector] Running periodic read-receipt check via React Fiber...");
    await chrome.tabs.sendMessage(state.mainTabId, {
      type: "adblock:info:to-content",
      isEmit: true,
      data: { type: "collectMessages", data: {} }
    }).catch(() => null);
  } catch (err) {
    debugLog(`[Collector] Error triggering collectMessages: ${err.message}`);
  }
}

// ── UNIBOX REPLIES (plan v2 §7 / Phase 4) ────────────────────────────────
// User-initiated replies from the web dashboard. Deliberately BYPASS:
//   - campaign pacing/sleeps (hot leads deserve fast answers)
//   - working-hours clamps   (a human pressed Send)
//   - the reply-exists guard (active back-and-forth chats: a newer inbound
//     must never cancel a typed response — skipMessageExistsCheck=true)
// Serialized one-at-a-time, ≥45s between automated sends (hot-lead pacing),
// 7-day expiry for tasks stranded by an offline browser.
let _uniboxInFlight = false;
let _uniboxLastSendAt = 0;
let _uniboxInFlightTaskId = null;

async function pollUniboxReplies() {
  if (!state.browserId || !state.mainTabId) return;
  if (_uniboxInFlight) return;
  // hot-lead pacing: ≥45s between consecutive automated sends
  if (Date.now() - _uniboxLastSendAt < 45000) return;

  const nowIso = new Date().toISOString();

  try {
    // 0. Expire replies stranded by an offline browser (>7 days old)
    const cutoff = new Date(Date.now() - 7 * 864e5).toISOString();
    const stale = await supabaseReq(
      `dm_tasks?select=id&task_type=eq.unibox_reply&browser_instance_id=eq.${state.browserId}&status=eq.pending&created_at=lt.${cutoff}`
    );
    if (stale?.length) {
      const ids = stale.map(t => t.id).join(",");
      await supabaseReq(`dm_tasks?id=in.(${ids})`, "PATCH", { status: "failed", error_reason: "expired_unsent" });
      await supabaseReq(`ig_messages?dm_task_id=in.(${ids})&send_status=eq.queued`, "PATCH", { send_status: "failed", send_error: "Couldn't deliver — your browser was offline too long." });
      debugLog(`[Unibox] expired ${stale.length} stale reply task(s).`);
    }

    // 1. Claim the oldest due reply (FIFO)
    const due = await supabaseReq(
      `dm_tasks?select=*&browser_instance_id=eq.${state.browserId}&task_type=eq.unibox_reply&status=eq.pending&or=(scheduled_at.is.null,scheduled_at.lte.${nowIso})&order=created_at.asc&limit=1`
    );
    if (!due || due.length === 0) return;
    const rt = due[0];

    _uniboxInFlight = true;
    try {
      // Conditional claim: a second worker/poll can never deliver the same
      // pending reply after this worker has claimed it.
      const claimed = await supabaseReq(`dm_tasks?id=eq.${rt.id}&status=eq.pending`, "PATCH", {
        status: "processing",
        claimed_at: nowIso
      });
      if (!claimed?.length) {
        dlog("unibox_claim_lost", { taskId: rt.id }, "warn");
        return;
      }
      _uniboxInFlightTaskId = rt.id;
      await supabaseReq(`ig_messages?dm_task_id=eq.${rt.id}&send_status=eq.queued`, "PATCH", { send_status: "sending" });

      // resolve lead handle from contact relation
      let targetUsername = null;
      if (rt.contact_id) {
        const ct = await supabaseReq(`contacts?select=username&id=eq.${rt.contact_id}`);
        targetUsername = ct?.[0]?.username || null;
      }
      if (!targetUsername) throw Object.assign(new Error("Lead handle missing for queued reply"), { permanent: true });
      if (!rt.thread_id) throw Object.assign(new Error("No thread id on queued reply"), { permanent: true });

      debugLog(`[Unibox] delivering reply to @${targetUsername} (task ${rt.id})`);

      // Additional-tab delivery, ColdDMs-style: pre-navigate to the thread,
      // then sendMessageFromDialog (self-recovery + composer contract).
      const res = await sendTaskToContent(
        "additional",
        "sendMessageFromDialog",
        {
          target: { username: targetUsername },
          message: { text: rt.message_text },
          taskId: rt.id,
          skipMessageExistsCheck: true
        },
        `https://www.instagram.com/direct/t/${rt.thread_id}/`
      );

      if (!res?.success) {
        throw new Error(res?.error?.error || "content script reported failure");
      }

      // ── DELIVERED ── The composer contract confirmed the physical send.
      // Completion bookkeeping must be terminal too: if the database rejects
      // `completed`, quarantine the task as a confirmed delivery rather than
      // leaving it processing for a scheduler to resend.
      _uniboxLastSendAt = Date.now();
      const completedAt = new Date().toISOString();
      try {
        const completed = await supabaseReq(`dm_tasks?id=eq.${rt.id}&status=eq.processing`, "PATCH", {
          status: "completed",
          completed_at: completedAt,
          error_reason: null
        });
        if (!completed?.length) throw new Error("completion update affected no processing row");
      } catch (e) {
        const reason = `delivery_confirmed_bookkeeping_failed: ${String(e?.message || e).slice(0, 180)}`;
        try {
          const quarantined = await supabaseReq(`dm_tasks?id=eq.${rt.id}&status=eq.processing`, "PATCH", {
            status: "failed",
            completed_at: completedAt,
            error_reason: reason
          });
          if (!quarantined?.length) throw new Error("terminal quarantine affected no processing row");
          dlog("unibox_delivery_quarantined", { taskId: rt.id, reason }, "error");
          debugLog(`[Unibox] delivery was verified but completion bookkeeping failed; task quarantined: ${reason}`);
        } catch (quarantineErr) {
          // This is a true operational emergency: never pretend the task is
          // settled, and leave an explicit diagnostic trail for manual repair.
          dlog("unibox_delivery_quarantine_failed", {
            taskId: rt.id,
            completionError: String(e?.message || e).slice(0, 180),
            quarantineError: String(quarantineErr?.message || quarantineErr).slice(0, 180)
          }, "error");
          debugLog(`[Unibox] CRITICAL: verified delivery could not be made terminal: ${quarantineErr.message}`);
        }
      }
      // Swap the synthetic queued bubble for the real harvested row. If the
      // DELETE fails, at least flip it to 'sent' so the UI never shows a
      // stale Queued state for a message Instagram already has.
      let deleted = false;
      try {
        await supabaseReq(`ig_messages?dm_task_id=eq.${rt.id}`, "DELETE");
        deleted = true;
      } catch (e) {
        debugLog(`[Unibox] non-fatal: synthetic delete failed: ${e.message}`);
      }
      if (!deleted) {
        try {
          await supabaseReq(`ig_messages?dm_task_id=eq.${rt.id}`, "PATCH", { send_status: "sent" });
        } catch (e) {
          debugLog(`[Unibox] non-fatal: synthetic sent-flip failed: ${e.message}`);
        }
      }
      debugLog(`[Unibox] reply delivered to @${targetUsername}.`);
    } catch (err) {
      const msg = String(err?.message || err);
      const permanent =
        err?.permanent ||
        err?.errorType === "user_does_not_accept_dms" ||
        /not found|does not allow|no thread id|handle missing/i.test(msg);
      const attempts = Number(rt.retry_count || 0);
      if (!permanent && attempts < 2) {
        await supabaseReq(`dm_tasks?id=eq.${rt.id}`, "PATCH", {
          status: "pending",
          retry_count: attempts + 1,
          error_reason: `[Unibox retry ${attempts + 1}/2] ${msg.slice(0, 150)}`
        }).catch(e => debugLog(`[Unibox] requeue patch failed: ${e.message}`));
        try {
          await supabaseReq(`ig_messages?dm_task_id=eq.${rt.id}&send_status=eq.sending`, "PATCH", { send_status: "queued" });
        } catch (_) { /* best-effort */ }
        debugLog(`[Unibox] reply ${rt.id} transient failure, requeued: ${msg}`);
      } else {
        await supabaseReq(`dm_tasks?id=eq.${rt.id}`, "PATCH", {
          status: "failed",
          error_reason: msg.slice(0, 300)
        }).catch(e => debugLog(`[Unibox] fail patch failed: ${e.message}`));
        // best-effort bubble update; fall back to bare status if send_error
        // column is missing (phase4 SQL not applied yet)
        try {
          await supabaseReq(`ig_messages?dm_task_id=eq.${rt.id}`, "PATCH", {
            send_status: "failed",
            send_error: permanent ? "Instagram won't let this account message this lead." : `Couldn't deliver after retries: ${msg.slice(0, 120)}`
          });
        } catch (_) {
          try {
            await supabaseReq(`ig_messages?dm_task_id=eq.${rt.id}`, "PATCH", { send_status: "failed" });
          } catch (_e2) { /* leave as-is */ }
        }
        debugLog(`[Unibox] reply ${rt.id} permanently failed: ${msg}`);
      }
    } finally {
      setTimeout(() => {
        _uniboxInFlight = false;
        _uniboxInFlightTaskId = null;
      }, 45000); // hot-lead gap
    }
  } catch (outer) {
    debugLog(`[Unibox] poll error: ${outer.message}`);
    _uniboxInFlight = false;
  }
}

// ── UNIBOX CAPTURE (plan v2 §5.2) ────────────────────────────────────────
// IG sometimes returns microsecond timestamps; normalize to ms and reject
// anything that can't be a real epoch-ms value.
function normalizeIgTimestampMs(v) {
  let n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  let t = Math.trunc(n);
  while (t > 1e13) t = Math.trunc(t / 1000);
  return t < 1e12 ? null : String(t);
}

// contacts lookup cache (60s) — one query per browser per minute, max
let _uniboxContactsCache = { at: 0, userId: null, map: new Map() };

async function uniboxResolveContext() {
  if (!state.browserId) throw new Error("browser not paired");
  const rows = await supabaseReq(
    `browser_instances?select=id,user_id,ig_username&id=eq.${state.browserId}`
  );
  const row = rows && rows[0];
  if (!row?.user_id) throw new Error("paired row missing user_id");
  if (
    _uniboxContactsCache.userId !== row.user_id ||
    Date.now() - _uniboxContactsCache.at > 60000
  ) {
    const contacts = await supabaseReq(
      `contacts?select=id,username&user_id=eq.${row.user_id}`
    );
    const map = new Map();
    for (const c of contacts || []) {
      map.set(String(c.username || "").toLowerCase(), c.id);
    }
    _uniboxContactsCache = { at: Date.now(), userId: row.user_id, map };
  }
  return {
    userId: row.user_id,
    accountUsername: row.ig_username
      ? String(row.ig_username).toLowerCase().replace(/^@/, "")
      : null,
    contacts: _uniboxContactsCache.map
  };
}

async function syncUniboxThreads(data) {
  const ctx = await uniboxResolveContext();
  const threads = data?.threads || {};
  for (const [targetUsername, info] of Object.entries(threads)) {
    try {
      const handle = String(targetUsername || "").toLowerCase();
      const contactId = ctx.contacts.get(handle) || null;
      // campaign-lead filter: only threads belonging to known contacts
      if (!contactId) continue;
      if (!info?.thread_key || !Array.isArray(info.messages)) continue;

      // group guard (v2 §5.4): >1 distinct non-account sender = group chat
      const participantSenders = new Set(
        info.messages.map(m => String(m.username || "").toLowerCase())
      );
      if (ctx.accountUsername) participantSenders.delete(ctx.accountUsername);
      if (participantSenders.size > 1) continue;

      // watermark: push only messages newer than last successful sync
      const wmKey = `wm:${state.browserId}:${info.thread_key}`;
      const wmData = await chrome.storage.local.get(wmKey);
      const watermark = Number(wmData[wmKey] || 0);

      const seenIds = new Set();
      const fresh = [];
      for (const m of info.messages) {
        const ts = normalizeIgTimestampMs(m.timestampMs);
        if (!ts) continue;
        const id = String(m.messageId ?? "");
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        if (Number(ts) <= watermark) continue;
        fresh.push({
          message_id: id,
          is_own: String(m.username || "").toLowerCase() !== handle,
          text: typeof m.text === "string" ? m.text : null,
          sender_ig_id: m.instagram_id ? String(m.instagram_id) : null,
          ts_ms: Number(ts)
        });
      }
      if (!fresh.length) continue; // idle thread costs nothing

      fresh.sort((a, b) => a.ts_ms - b.ts_ms);
      const windowed = fresh.slice(-30); // rolling window cap

      // ── ENRICHMENT (v1.4.3): attribute the campaign and resolve the lead's
      // real name/avatar so the dashboard inbox can show both. Two tiny
      // owner-scoped lookups keyed on the contact PK, run ONLY for threads
      // that have fresh messages (idle threads cost nothing). Any failure
      // here must degrade to the pre-v1.4.3 behavior — nulls — never abort
      // the sync; the RPC coalesces, so nulls also can't clobber values that
      // were already written by a previous sync or the SQL backfill.
      let enrichCampaignId = null;
      let enrichFullName = null;
      let enrichAvatarUrl = null;
      try {
        const [contactRows, campaignRows] = await Promise.all([
          supabaseReq(`contacts?select=full_name,image_url&id=eq.${contactId}&user_id=eq.${ctx.userId}&limit=1`),
          supabaseReq(`dm_tasks?select=campaign_id&contact_id=eq.${contactId}&campaign_id=not.is.null&order=created_at.desc&limit=1`)
        ]);
        enrichFullName = (contactRows?.[0]?.full_name || "").trim() || null;
        enrichAvatarUrl = contactRows?.[0]?.image_url || null;
        enrichCampaignId = campaignRows?.[0]?.campaign_id || null;
        dlog("unibox_thread_enriched", {
          target: handle,
          hasCampaign: !!enrichCampaignId,
          hasName: !!enrichFullName,
          hasAvatar: !!enrichAvatarUrl
        });
      } catch (enrichErr) {
        // Fail-open: sync continues with nulls (identical to pre-v1.4.3 behavior).
        dlog("unibox_enrich_failed", {
          target: handle,
          error: String(enrichErr?.message || enrichErr).slice(0, 180)
        }, "warn");
      }

      const payload = {
        user_id: ctx.userId,
        contact_id: contactId,
        campaign_id: enrichCampaignId,
        browser_instance_id: state.browserId,
        account_ig_username: ctx.accountUsername,
        thread_id: String(info.thread_key),
        target_username: targetUsername,
        target_full_name: enrichFullName,
        target_profile_pic_url: enrichAvatarUrl,
        messages: windowed
      };
      const res = await supabaseReq(`rpc/sync_unibox_thread`, "POST", {
        p_payload: payload
      });
      const out = Array.isArray(res) ? res[0] : res;
      const newWm = Number(out?.watermark_ms || 0);
      if (newWm > 0) await chrome.storage.local.set({ [wmKey]: newWm });
      debugLog(`[Unibox] synced @${targetUsername}: ${windowed.length} msg(s), wm=${newWm}`);
    } catch (e) {
      // one bad thread must never abort the rest of the dump
      debugLog(`[Unibox] thread ${targetUsername} failed: ${e.message}`);
    }
  }
}

async function processCollectedMessages(readReceipts) {
  try {
    if (!Array.isArray(readReceipts) || readReceipts.length === 0) return;

    const seenUsernames = new Set();
    const repliedUsernames = new Set();
    let seenCount = 0;
    let replyCount = 0;

    for (const entry of readReceipts) {
      if (!entry || !entry.username) continue;

      if (entry.hasSeen || entry.hasReply) {
        seenUsernames.add(entry.username.toLowerCase());
        if (entry.hasSeen) seenCount++;
        if (entry.hasReply) {
          replyCount++;
          repliedUsernames.add(entry.username.toLowerCase());
        }
      }
    }

    if (seenUsernames.size > 0) {
      const userList = Array.from(seenUsernames);
      debugLog(`[Collector] Found ${userList.length} contact(s) — ${seenCount} seen, ${replyCount} replied.`);

      for (let i = 0; i < userList.length; i += 50) {
        const chunk = userList.slice(i, i + 50);
        const inQuery = chunk.map(u => `"${u}"`).join(",");
        await supabaseReq(
          `contacts?media_seen=eq.false&username=in.(${inQuery})`,
          "PATCH",
          { media_seen: true, media_seen_at: new Date().toISOString() }
        );
        // Dual-write per-account seen state. The seen/reply came from THIS
        // browser's logged-in IG account, so it belongs to (contact, thisBrowser).
        try {
          const seenContacts = await supabaseReq(`contacts?select=id&username=in.(${inQuery})`);
          for (const c of (seenContacts || [])) {
            await caoUpsert(c.id, { media_seen: true, media_seen_at: new Date().toISOString() });
          }
        } catch (e) {
          debugLog(`[CAO] seen dual-write failed (non-fatal): ${e.message}`);
        }
      }
    }

    // Leads who replied: proactively cancel their remaining follow-ups so we never
    // DM someone who already responded — the belt-and-suspenders behind the send-time guard.
    if (repliedUsernames.size > 0) {
      const repliedList = Array.from(repliedUsernames);
      for (let i = 0; i < repliedList.length; i += 50) {
        const chunk = repliedList.slice(i, i + 50);
        const inQuery = chunk.map(u => `"${u}"`).join(",");
        const contacts = await supabaseReq(`contacts?select=id&username=in.(${inQuery})`);
        for (const contact of (contacts || [])) {
          // Persist the reply (global + per-account) so the scheduler stops
          // generating ghost follow-ups for this lead. NOT media_seen — this is
          // a genuine reply detected from the Relay store.
          try {
            await supabaseReq(`contacts?id=eq.${contact.id}`, "PATCH",
              { replied: true, replied_at: new Date().toISOString() });
          } catch (e) { debugLog(`[Replied] global persist failed (non-fatal): ${e.message}`); }
          await caoUpsert(contact.id, { replied: true, replied_at: new Date().toISOString() });
          await cancelPendingFollowups(contact.id, "lead_replied");
        }
      }
    }
  } catch (err) {
    debugLog(`[Collector] Error processing collected messages: ${err.message}`);
  }
}

// Cancel any still-pending follow-up tasks for a contact (e.g. after they replied).
// Only touches 'pending' rows — an in-flight 'processing' task is left alone.
// Cross-account fix: scoped by browser_instance_id so a reply received by THIS
// account only cancels THIS account's follow-ups — never another account's.
async function cancelPendingFollowups(contactId, reason) {
  if (!contactId) return 0;
  try {
    const browserFilter = state.browserId ? `&browser_instance_id=eq.${state.browserId}` : "";
    const cancelled = await supabaseReq(
      `dm_tasks?contact_id=eq.${contactId}&status=eq.pending&task_type=like.followup_*${browserFilter}`,
      "PATCH",
      { status: "skipped", error_reason: reason }
    );
    const count = Array.isArray(cancelled) ? cancelled.length : 0;
    if (count > 0) {
      debugLog(`[Collector] Cancelled ${count} pending follow-up(s) for contact ${contactId} (${reason}).`);
    }
    return count;
  } catch (err) {
    debugLog(`[Collector] Error cancelling follow-ups for contact ${contactId}: ${err.message}`);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Working Hours Safety Clamp (v2 — campaign-first, fail-open)
//
// Decision order for the head task:
//   1. Its campaign's window (when working_hours_enabled)  ← mirrors the server
//   2. Account-level user_settings hours (both non-null)   ← usually NULL
//   3. Nothing configured → RUN FREELY (never silently sleep again)
//
// Semantics agreed with product:
//   • End hour is INCLUSIVE ("until 11pm" = active through 23:59).
//   • Overnight windows wrap midnight (22→6 is valid).
//   • Clock = user_settings.timezone; missing/invalid → browser zone. Never UTC.
//   • Settings fetch failure → fail open; a broken read must not idle the engine.
//   • Naps taken because of hours are stamped with their rules; the heartbeat
//     re-checks on every real DB write and tears up the nap if rules changed.
// ---------------------------------------------------------------------------

let _workHoursCache = null;

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function timeZoneIsValid(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function hourInZone(tz) {
  try {
    return parseInt(
      new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: tz }).format(new Date()),
      10
    );
  } catch {
    return new Date().getHours();
  }
}

// Account-level defaults from user_settings. Returns null when unconfigured or
// when the fetch fails (fail open). Cached in memory only; force bypasses.
async function getAccountHours(force = false) {
  if (!force && _workHoursCache && Date.now() - _workHoursCache.fetchedAt < 5 * 60_000) {
    return _workHoursCache.value;
  }
  try {
    const userId = getUserIdFromToken(state.accessToken);
    if (!userId) return null;
    const settings = await supabaseReq(`user_settings?select=timezone,work_start_hour,work_end_hour&user_id=eq.${userId}`);
    const s = settings?.[0];
    const value = {
      start: s?.work_start_hour ?? null,
      end: s?.work_end_hour ?? null,
      tz: s?.timezone && timeZoneIsValid(s.timezone) ? s.timezone : browserTimeZone()
    };
    _workHoursCache = { fetchedAt: Date.now(), value };
    dlog("account_hours_loaded", { start: value.start, end: value.end, tz: value.tz });
    return value;
  } catch (err) {
    // Fail open + be loud about it — this exact silent path caused a full-day stall.
    _workHoursCache = null;
    dlog("hours_fetch_failed", { error: String(err?.message || err).slice(0, 200) }, "warn");
    debugLog(`[Hours] user_settings fetch failed — clamp disabled (fail-open): ${err.message}`);
    return null;
  }
}

// Resolve the effective window for one task. null => no constraint (run free).
function resolveWindowForTask(task, acct) {
  const c = task.campaigns;
  if (c && c.working_hours_enabled) {
    // Mirror server computeWorkingWindow: enabled campaign defaults to 9-18.
    return {
      start: c.work_start_hour ?? 9,
      end: c.work_end_hour ?? 18,
      tz: acct?.tz || browserTimeZone(),
      source: `campaign:${c.id}`
    };
  }
  if (acct && acct.start != null && acct.end != null) {
    return { start: acct.start, end: acct.end, tz: acct.tz, source: "account" };
  }
  return null;
}

// Inclusive end + overnight wrap. start===end means that single hour only.
function isWithinWindow(now, win) {
  const h = hourInZone(win.tz);
  if (win.start === win.end) return h === win.start;
  if (win.start < win.end) return h >= win.start && h <= win.end;
  return h >= win.start || h <= win.end; // wraps midnight
}

function minutesUntilWindow(now, win) {
  const h = hourInZone(win.tz);
  const m = now.getMinutes();
  let mins;
  if (win.start <= win.end) {
    mins = h < win.start ? (win.start - h) * 60 - m : (24 - h + win.start) * 60 - m;
  } else {
    mins = h > win.end ? (win.start - h) * 60 - m : (24 - h + win.start) * 60 - m;
  }
  return Math.max(mins, 1);
}

// Persist a nap together with WHY we took it, so it can be auto-healed later.
async function setWake(reason, wakeMs, meta = {}) {
  await chrome.storage.local.set({
    wakeUpAt: wakeMs,
    wakeReason: reason,
    wakeTaskId: meta.taskId ?? null
  });
}

async function sendHeartbeat(force = false) {
  if (!state.browserId) return;
  try {
    const stored = await chrome.storage.local.get('leaseExpiresAt');
    const leaseExpiresAt = stored.leaseExpiresAt || 0;

    // Only write to DB when lease expires within 2 minutes (or not set yet).
    // This cuts heartbeat writes from every 1 min to every ~8-9 min.
    // force=true bypasses the check — used on startup and new connections.
    if (!force && leaseExpiresAt > Date.now() + 120_000) {
      debugLog(`Heartbeat skipped — lease valid for ${Math.round((leaseExpiresAt - Date.now()) / 1000)}s`);
      return;
    }

    // Ownership gate removed: UNIQUE(user_id, instance_key) guarantees one row
    // per browser, so there is no "wrong row" to keep alive. If the row was
    // deleted from the dashboard, the PATCH below simply affects 0 rows; the
    // next connect / self-heal re-creates it via the idempotent upsert.

    const newExpiresAt = Date.now() + 600_000; // 10-minute lease
    const manifest = chrome.runtime.getManifest();
    const heartbeatPayload = {
      last_heartbeat_at: new Date().toISOString(),
      expires_at: new Date(newExpiresAt).toISOString(),
      status: 'active',
      extension_version: manifest.version,
      last_seen_at: new Date().toISOString(),
    };
    // Add platform/user_agent once (on force=true, i.e. first heartbeat)
    if (force) {
      try {
        const platformInfo = await chrome.runtime.getPlatformInfo();
        heartbeatPayload.platform = platformInfo.os || 'unknown';
      } catch { }
      heartbeatPayload.user_agent = navigator.userAgent || '';
    }
    await supabaseReq(`browser_instances?id=eq.${state.browserId}`, "PATCH", heartbeatPayload);
    await chrome.storage.local.set({ leaseExpiresAt: newExpiresAt });
    debugLog(`Heartbeat sent! Lease renewed for 10 min.`);

    // Piggyback (zero extra request slots): while we're already talking to the
    // DB, refresh account hours and re-check any hours-based nap against the
    // CURRENT rules. A settings change therefore applies within ~one lease
    // (~9 min worst case) instead of after the old nap expired.
    refreshHoursAndHealNaps().catch(() => { });
  } catch (err) {
    console.error("Heartbeat failed:", err);
    debugLog(`Heartbeat Error: ${err.message}`);
  }
}

// Re-evaluate a sleeping engine's hours-nap against fresh rules.
async function refreshHoursAndHealNaps() {
  const freshAcct = await getAccountHours(true);

  const stored = await chrome.storage.local.get(['wakeUpAt', 'wakeReason', 'wakeTaskId']);
  if (!stored.wakeUpAt || stored.wakeReason !== 'hours' || !stored.wakeTaskId) return;

  let win = null;
  try {
    const rows = await supabaseReq(
      `dm_tasks?select=id,campaigns!inner(id,working_hours_enabled,work_start_hour,work_end_hour)&id=eq.${stored.wakeTaskId}`
    );
    win = resolveWindowForTask(rows?.[0], freshAcct);
  } catch {
    return; // can't verify — keep the existing nap rather than thrashing
  }

  const now = new Date();
  if (!win || isWithinWindow(now, win)) {
    // Rules opened up (or vanished) — tear up the nap; next poll runs free.
    await chrome.storage.local.remove(['wakeUpAt', 'wakeReason', 'wakeTaskId']);
    dlog("nap_cancelled_rules_changed", { taskId: stored.wakeTaskId });
    debugLog(`[Hours] Working-hours rules changed while sleeping — nap cancelled, resuming.`);
    return;
  }

  // Still closed but the window itself moved — re-target the nap precisely.
  const mins = minutesUntilWindow(now, win);
  const oldWake = stored.wakeUpAt;
  const newWake = Date.now() + mins * 60_000;
  if (Math.abs(newWake - oldWake) > 60_000) {
    await setWake('hours', newWake, { taskId: stored.wakeTaskId });
    dlog("nap_retarged_rules_changed", { taskId: stored.wakeTaskId, newWakeInMins: mins });
    debugLog(`[Hours] Window changed while sleeping — nap re-targeted to +${mins}m.`);
  }
}

// ---------------------------------------------------------------------------
// Pacing Engine Helpers (centralized — server schedules, extension clamps)
// ---------------------------------------------------------------------------

async function pollTasks() {
  if (!state.browserId) return;
  const pacingData = await chrome.storage.local.get('wakeUpAt');
  if (pacingData.wakeUpAt && Date.now() < pacingData.wakeUpAt) {
    return; // Still sleeping until next scheduled task
  }

  if (state.isProcessing) {
    if (Date.now() - state.processingLockAcquiredAt > 960000) { // 16 min: just above the 15-min task timeout
      debugLog(`[System] Auto-recovering locked engine.`);
      state.isProcessing = false;
    } else {
      return;
    }
  }

  // Acquire lock immediately (before any awaits) to prevent TOCTOU race
  state.isProcessing = true;
  state.processingLockAcquiredAt = Date.now();

  try {
    // Check if engine is paused by user
    const pauseData = await chrome.storage.local.get('enginePaused');
    if (pauseData.enginePaused) {
      debugLog(`[Poll] Engine paused by user, skipping.`);
      return;
    }

    // 1. Fetch a pending task that is due now (scheduled_at <= now OR scheduled_at IS NULL)
    // NULL scheduled_at = old task generated before centralized pacing = "due now"
    // Campaign embed carries the hours this specific task must obey (per-campaign clamp).
    const nowIso = new Date().toISOString();
    const url = `dm_tasks?select=*,campaigns!inner(id,status,working_hours_enabled,work_start_hour,work_end_hour)&browser_instance_id=eq.${state.browserId}&status=eq.pending&campaigns.status=eq.active&or=(scheduled_at.is.null,scheduled_at.lte.${nowIso})&order=scheduled_at.asc.nullslast,created_at.asc&limit=1`;
    const tasks = await supabaseReq(url);

    if (!tasks || tasks.length === 0) {
      // Nothing due — find the next future scheduled_at so we sleep until then
      // instead of blind backoff. One cheap query.
      try {
        const future = await supabaseReq(`dm_tasks?select=scheduled_at&browser_instance_id=eq.${state.browserId}&status=eq.pending&scheduled_at=not.is.null&order=scheduled_at.asc&limit=1`);
        if (future && future.length > 0 && future[0].scheduled_at) {
          const nextAt = new Date(future[0].scheduled_at).getTime();
          const sleepMs = Math.max(nextAt - Date.now(), 5000); // min 5s safety
          await setWake('schedule', Date.now() + sleepMs);
          debugLog(`[Poll] 0 due tasks. Next at ${future[0].scheduled_at}. Sleeping ${Math.round(sleepMs / 1000)}s.`);
        } else {
          // No future tasks at all — back off
          const BACKOFF_MS = [30000, 60000, 120000, 300000];
          const backoffMs = BACKOFF_MS[Math.min(state.emptyPollCount, BACKOFF_MS.length - 1)];
          state.emptyPollCount++;
          await setWake('backoff', Date.now() + backoffMs);
          debugLog(`[Poll] 0 tasks at all. Backing off ${backoffMs / 1000}s.`);
        }
      } catch {
        state.emptyPollCount++;
      }
      return;
    }

    const task = tasks[0];
    state.emptyPollCount = 0;

    // 2. Per-campaign working-hours clamp (campaign first → account → run free).
    // Evaluated HERE so the window belongs to the exact task we're about to send.
    const acctHours = await getAccountHours();
    const win = resolveWindowForTask(task, acctHours);
    if (win && !isWithinWindow(new Date(), win)) {
      const mins = minutesUntilWindow(new Date(), win);
      await setWake('hours', Date.now() + mins * 60_000, { taskId: task.id });
      debugLog(`[Clamp] Outside ${win.source} window (${win.start}-${win.end} ${win.tz}). Sleeping ${mins}m.`);
      dlog("hours_clamp_sleep", { taskId: task.id, start: win.start, end: win.end, tz: win.tz, source: win.source, sleepMinutes: mins });
      return;
    }

    delete task.campaigns;

    // 3-minute hard floor — even if the server stamps 20 tasks at the same
    // second, the extension clamps to max 1 send per 3 minutes.
    if (state.lastTaskCompletedAt && Date.now() - state.lastTaskCompletedAt < 180000) {
      const waitMs = 180000 - (Date.now() - state.lastTaskCompletedAt);
      await setWake('floor', Date.now() + waitMs);
      debugLog(`[Floor] 3-min hard floor — waiting ${Math.round(waitMs / 1000)}s before next send.`);
      return;
    }

    if (task.contact_id) {
      const contacts = await supabaseReq(`contacts?select=username,full_name&id=eq.${task.contact_id}`);
      if (contacts && contacts.length > 0) {
        task.contacts = contacts[0];
      }
    }

    await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", { status: "processing", claimed_at: new Date().toISOString() });

    debugLog(`Processing task: ${task.task_type}`);
    const taskStartedAt = Date.now();
    dlog("task_claimed", {
      taskId: task.id,
      taskType: task.task_type,
      contact: task.contacts?.username || null,
      retryCount: Number(task.retry_count || 0),
      scheduledAt: task.scheduled_at || null
    });

    let taskSucceeded = false;
    try {
      const result = await executeTask(task);
      dlog("task_execute_done", { taskId: task.id, taskType: task.task_type, elapsedMs: Date.now() - taskStartedAt });

      if (result?.isLimited) {
        debugLog("[Pacing] Rate limit detected from content script! Pausing engine to prevent ban.");
        await chrome.storage.local.set({ enginePaused: true });
        // Auto-resume after a fixed 30 min cooldown.
        setTimeout(() => {
          chrome.storage.local.get('enginePaused', async (data) => {
            if (data.enginePaused) {
              await chrome.storage.local.remove('enginePaused');
              debugLog("[Pacing] Auto-resuming after rate-limit cooldown.");
            }
          });
        }, 30 * 60 * 1000);
      }

      if (result?.skippedReply) {
        await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
          status: "skipped",
          error_reason: "lead_replied"
        });
        state.stats.failed++;
        debugLog(`Task Skipped (lead replied): ${task.task_type}`);
        dlog("task_skipped_reply", { taskId: task.id, taskType: task.task_type, elapsedMs: Date.now() - taskStartedAt }, "warn");
      } else {
        await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
          status: "completed",
          completed_at: new Date().toISOString()
        });

        if (task.contact_id && task.task_type === 'first_dm') {
          await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
            status: "dmed",
            dmed_at: new Date().toISOString(),
            assigned_browser_id: state.browserId
          });
          await caoUpsert(task.contact_id, {
            status: "dmed",
            dmed_at: new Date().toISOString(),
            campaign_id: task.campaign_id || null
          });
        } else if (task.contact_id && task.task_type.startsWith('followup_')) {
          const stepLetter = task.task_type.replace('followup_1', '').toUpperCase() || 'A';
          await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
            followup_1a_sent: true,
            current_follow_up: `1${stepLetter}`,
            last_follow_up_at: new Date().toISOString()
          });
          await caoUpsert(task.contact_id, {
            followup_1a_sent: true,
            current_follow_up: `1${stepLetter}`,
            last_follow_up_at: new Date().toISOString()
          });
        }

        state.stats.completed++;
        state.lastTaskCompletedAt = Date.now();
        taskSucceeded = true;
        debugLog(`Task Completed: ${task.task_type}`);
        dlog("task_completed", { taskId: task.id, taskType: task.task_type, elapsedMs: Date.now() - taskStartedAt });
      }
    } catch (err) {
      console.error("Task failed:", err);
      // F4: type-based classification. retryClass = genuine reachability type
      // first, else the thrown ExtensionError type; contact-marking below keys
      // ONLY on the genuine unreachableType.
      const retryClass = err.unreachableType || err.errorType || null;
      const isThreadBusy = err.errorType === "thread_busy" || err.message?.includes("thread is busy");
      // A content-script timeout happens after the task was dispatched, so the
      // message may already be in Instagram. The same is true when Send was
      // clicked but our post-send verifier cannot see the new bubble. Neither
      // condition is retry-safe: resending is exactly how duplicate DMs occur.
      const isDeliveryUnknown =
        retryClass === "send_unconfirmed_error" ||
        /timed out waiting for content script response/i.test(String(err.message || ""));
      dlog("task_failed", {
        taskId: task.id,
        taskType: task.task_type,
        elapsedMs: Date.now() - taskStartedAt,
        errorType: err.errorType || null,
        unreachableType: err.unreachableType || null,
        retryClass,
        message: String(err.message || err).slice(0, 300)
      }, "error");
      if (isDeliveryUnknown) {
        await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
          status: "failed",
          error_reason: `delivery_unknown: ${String(err.message || err).slice(0, 240)}`
        });
        state.stats.failed++;
        debugLog(`[Safety] Task ${task.id} reached an unknown delivery state; it will not be auto-retried.`);
        dlog("task_delivery_unknown", { taskId: task.id, taskType: task.task_type, retryClass }, "warn");
      } else if (isThreadBusy) {
        await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", { status: "pending" });
        debugLog(`[Recovery] Task ${task.task_type} re-queued as pending (thread was busy) — backing off 60 s`);
        dlog("task_requeued_busy", { taskId: task.id }, "warn");
        // Back off 60 s before next poll. Without this the 15 s alarm immediately
        // re-claims the same task into a still-busy tab, producing the thread_busy
        // hammer loop. This is a safety net for any edge-case where thread_busy still
        // surfaces; the primary fix is the silent-return in content.js isBusy guards.
        await setWake('busy_backoff', Date.now() + 60_000);
      } else {
        const isPermanentError = [
          "user_is_unreachable",
          "user_not_found",
          "cannot_message_user",
          "account_disabled",
          "rate_limited_error"
        ].includes(retryClass);

        const currentRetries = Number(task.retry_count || 0);

        if (!isPermanentError && currentRetries < 3) {
          const nextRetry = currentRetries + 1;
          debugLog(`[Retry Engine] ${retryClass ? `[${retryClass}] ` : ""}Transient error on task ${task.id} (${err.message}). Retrying (${nextRetry}/3)...`);

          await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
            status: "pending",
            retry_count: nextRetry,
            error_reason: `[Attempt ${nextRetry}/3] ${err.message || String(err)}`
          });

          const wakeUpAt = Date.now() + 30000;
          await setWake('retry', wakeUpAt);
          dlog("task_retry_scheduled", { taskId: task.id, attempt: nextRetry, retryClass, backoffMs: 30000 }, "warn");
        } else {
          await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
            status: "failed",
            error_reason: currentRetries >= 3
              ? `Failed after 3 retries. Last error: ${err.message || String(err)}`
              : (err.message || String(err)),
            unreachable_type: err.unreachableType || null
          });

          if (retryClass === "rate_limited_error") {
            debugLog("[Pacing] Rate limit error detected! Pausing engine to prevent ban.");
            await chrome.storage.local.set({ enginePaused: true });
          } else if ((err.unreachableType || retryClass === "user_not_found") && task.contact_id) {
            // user_not_found included (F11): a 404'd handle is dead forever —
            // park the contact so future campaigns never claim it again.
            await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
              status: "unreachable"
            });
          }

          state.stats.failed++;
          debugLog(`Task Permanently Failed: ${err.message} ${retryClass ? `[${retryClass}]` : ''}`);
        }
      }
    }

    await chrome.storage.local.set({ stats: state.stats });
    (async () => {
      const today = await computeTodayStats().catch(() => ({ sentToday: 0, pendingToday: 0 }));
      chrome.runtime.sendMessage({ type: "STATS_UPDATE", stats: { ...state.stats, ...today } }).catch(() => null);
    })();

    // No local pacing sleep — the server's scheduled_at on the next task
    // determines when we wake. The poll query + wakeUpAt logic above
    // handles this automatically.

  } catch (err) {
    console.error("Polling error:", err);
  } finally {
    state.isProcessing = false;
  }
}

// ---------------------------------------------------------------------------
// Instagram Tab & Content Script Communication
// ---------------------------------------------------------------------------

async function executeTask(task) {
  if (task.task_type === 'first_dm') {
    const targetUsername = task.contacts?.username;
    if (!targetUsername) throw new Error("Missing target username in contact relation");

    let hasImage = false;
    let imageUsername = null;
    let imageArrayBuffer = null;
    let imageType = null;

    debugLog(`[Image Lookup] Starting image lookup for username: "${targetUsername}"`);
    debugLog(`[Image Lookup] globalThis exists: ${typeof globalThis !== "undefined"} | ImageStorage exists: ${!!globalThis?.ImageStorage}`);

    if (typeof globalThis !== "undefined" && globalThis.ImageStorage) {
      try {
        const totalImages = await globalThis.ImageStorage.getAllImagesCount();
        debugLog(`[Image Lookup] Total images in DB: ${totalImages}`);

        const img = await globalThis.ImageStorage.getImage(targetUsername);
        debugLog(`[Image Lookup] getImage("${targetUsername}") returned: ${img ? `Blob(size=${img.size}, type="${img.type}")` : "null"}`);

        if (img) {
          hasImage = true;
          imageUsername = targetUsername;
          imageType = img.type || "image/jpeg"; // Fallback if MIME type is empty (e.g. file was saved with non-image extension)
          // Convert Blob to ArrayBuffer for passing through the Chrome Messaging bridge
          const arrayBuf = await img.arrayBuffer();
          // Convert ArrayBuffer to Array for JSON serialization just in case structured cloning fails over MV3 boundaries
          imageArrayBuffer = Array.from(new Uint8Array(arrayBuf));
          debugLog(`[Image Manager] Found local image for ${targetUsername} | type=${imageType} | bufferLen=${imageArrayBuffer.length} | sizeKB=${Math.round(imageArrayBuffer.length / 1024)}`);
        } else {
          debugLog(`[Image Lookup] No image found for "${targetUsername}" — the image may not have been saved or the username key doesn't match`);
        }
      } catch (imgErr) {
        debugLog(`[Image Lookup] ERROR retrieving image: ${imgErr?.toString()}`);
      }
    } else {
      debugLog(`[Image Lookup] SKIPPED — ImageStorage not available on globalThis`);
    }

    // If we have an image but the message template doesn't include [IMAGE], append it
    let finalMessageText = task.message_text;
    if (hasImage && !finalMessageText.includes('[IMAGE]')) {
      finalMessageText = finalMessageText + '\n[IMAGE]';
      debugLog(`[Image Manager] Message template missing [IMAGE] token — auto-appended`);
    }

    const payload = {
      target: { username: targetUsername },
      message: { text: finalMessageText },
      taskId: task.id,
      hasImage,
      imageUsername,
      imageType,
      imageArrayBuffer
    };

    debugLog(`[Image Payload] hasImage=${hasImage} | imageType=${imageType} | bufferExists=${!!imageArrayBuffer} | bufferLen=${imageArrayBuffer?.length ?? 0} | msgHasToken=${finalMessageText.includes('[IMAGE]')}`);
    dlog("task_execute_start", { taskId: task.id, taskType: task.task_type, path: "first_dm-main", target: targetUsername, hasImage });
    return new Promise((resolve, reject) => {
      let resolved = false;

      const handler = (message, sender) => {
        if (sender.tab?.id !== state.mainTabId) return;
        if (message.type === "adblock:info:to-background" && message.isEmit) {
          const payload = message.data;
          if (payload.type === "successTask" && payload.data.taskId === task.id) {
            if (resolved) return;
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);

            const data = payload.data;
            dlog("content_success", {
              taskId: task.id,
              taskType: task.task_type,
              threadId: data.threadId || null,
              response: data.response === true,
              isLimited: !!data.isLimited,
              resolvedFullName: data.resolvedFullName || null
            });
            (async () => {
              try {
                if (data.threadId) {
                  await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
                    thread_id: data.threadId,
                    last_message_id: data.lastMessageId || null,
                    last_message_ts: data.lastMessageTimestamp || new Date().toISOString(),
                    is_limited: !!data.isLimited
                  });
                  // Also write thread_id to contacts so the scheduler can
                  // include it when generating followup_ task rows.
                  // Phase 1 cross-account: only set the GLOBAL thread_id if it is
                  // currently NULL (i.e. this is the first-ever account to DM the
                  // lead). A 2nd account's thread must NOT overwrite it — that
                  // would point account A's pending follow-ups at account B's thread.
                  if (task.contact_id) {
                    try {
                      const existing = await supabaseReq(`contacts?select=thread_id&id=eq.${task.contact_id}`);
                      const currentThreadId = existing && existing[0] ? existing[0].thread_id : null;
                      if (!currentThreadId) {
                        await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
                          thread_id: data.threadId
                        });
                      }
                    } catch (e) {
                      // Fallback: preserve old behavior if the read fails.
                      await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
                        thread_id: data.threadId
                      });
                    }
                    // Dual-write per-account thread (always this account's own thread).
                    await caoUpsert(task.contact_id, { assigned_thread_id: data.threadId });
                  }
                }
                // Write back a live-resolved real name so follow-ups use the fast
                // server-side path instead of re-scraping every time. Only when:
                //  - the extension actually scraped a name this send (resolvedFullName),
                //  - and the stored full_name is still a username-placeholder
                //    (empty or equal to the username) — never clobber a real name
                //    or a manual override the user set.
                if (data.resolvedFullName && task.contact_id) {
                  try {
                    const storedFull = (task.contacts?.full_name || "").trim();
                    const storedUser = (task.contacts?.username || "").replace(/^@/, "").trim().toLowerCase();
                    const isPlaceholder = !storedFull || storedFull.trim().toLowerCase() === storedUser;
                    const newFull = String(data.resolvedFullName).trim();
                    if (isPlaceholder && newFull && newFull.toLowerCase() !== storedFull.toLowerCase()) {
                      await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
                        full_name: newFull
                      });
                      debugLog(`[Name] Persisted live-resolved full_name for ${task.contact_id}: "${newFull}"`);
                    }
                  } catch (e) {
                    // Non-fatal: resolution still worked, only the write-back failed.
                    debugLog(`[Name] Write-back skipped for ${task.contact_id}: ${e?.toString()}`);
                  }
                }
                if (data.response === true && task.contact_id) {
                  debugLog(`[Guard] Lead replied — skipping send for task ${task.id}, cancelling remaining follow-ups.`);
                  await cancelPendingFollowups(task.contact_id, "lead_replied");
                  await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
                    media_seen: true,
                    media_seen_at: new Date().toISOString(),
                    replied: true,
                    replied_at: new Date().toISOString()
                  });
                  // Dual-write per-account seen + replied state
                  await caoUpsert(task.contact_id, {
                    media_seen: true,
                    media_seen_at: new Date().toISOString(),
                    replied: true,
                    replied_at: new Date().toISOString()
                  });
                  // Signal pollTasks: nothing was sent (reply skip) — don't charge quota,
                  // don't advance the chain, mark the task skipped not completed.
                  resolve({ isLimited: !!data.isLimited, skippedReply: true });
                  return;
                }
                resolve({ isLimited: !!data.isLimited });
              } catch (err) {
                resolve({ isLimited: !!data.isLimited });
              }
            })();
          } else if (payload.type === "errorTask" && payload.data.taskId === task.id) {
            if (resolved) return;
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);

            const errReason = payload.data.error || "DM failed";
            dlog("content_error", {
              taskId: task.id,
              taskType: task.task_type,
              errorType: payload.data.errorType || null,
              unreachableType: payload.data.unreachableType || null,
              message: String(errReason).slice(0, 300)
            }, "error");

            // F4: keep fields distinct — unreachableType is genuine reachability
            // only; errorType is the thrown type. retryClass drives the retry tiers.
            const errObj = new Error(errReason);
            errObj.errorType = payload.data.errorType || null;
            errObj.unreachableType = payload.data.unreachableType || null;
            errObj.retryClass = errObj.unreachableType || errObj.errorType || null;
            reject(errObj);
          }
        }
      };

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          chrome.runtime.onMessage.removeListener(handler);
          // A browser-throttled, multi-bubble DM took just over six minutes in production.
          // Ten minutes leaves room for that without making a genuinely dead task wait for
          // the old 15-minute window. Timeout outcomes are settled as delivery_unknown,
          // never retried as a new physical send.
          dlog("task_timeout", { taskId: task.id, taskType: task.task_type, waitedMs: 600000 }, "warn");
          reject(new Error("Task timed out waiting for content script response"));
        }
      }, 600000);

      chrome.runtime.onMessage.addListener(handler);

      (async () => {
        try {
          const res = await sendTaskToContent("main", "sendMessage", payload);
          if (!res?.success) {
            if (!resolved) {
              resolved = true;
              chrome.runtime.onMessage.removeListener(handler);
              clearTimeout(timeoutId);
              reject(new Error(res?.error?.error || "Send message failed to start"));
            }
          }
        } catch (err) {
          if (!resolved) {
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);
            reject(err);
          }
        }
      })();
    });
  }
  else if (task.task_type.startsWith('followup_')) {
    const targetUsername = task.contacts?.username;
    if (!targetUsername) throw new Error("Missing target username in contact relation");

    // Follow-ups use the ColdDMs thread-open path. The main tab opens DMs, then
    // (because isOpenNewTab is set) calls findUserInDialogWithoutClick to scrape
    // the LIVE candidate.id off Instagram's freshly rendered search results,
    // always closes the search dialog, and hands off via sendMessageAdditionalTab.
    // The additional tab then opens https://www.instagram.com/direct/t/<live id>/
    // directly (thread already on screen, no search box) and sends there.
    //
    // We deliberately use the FRESH live id, never the stored thread_id: the
    // stored thread_id is a URL numeric id captured in a previous session, and
    // Instagram's open-check (_checkIfOpenUserRequired) compares it against the
    // live React store's thread_key — the two schemes don't always match, which
    // caused the old false "Dialog is not opened" failures. ColdDMs re-derives a
    // fresh id at send time; so do we. thread_id / assigned_thread_id remain
    // stored for observability only. targetUrl stays null so the MAIN tab does
    // not navigate — only the additional tab opens the live thread URL.
    const targetUrl = null;
    debugLog(`[Followup] Routing via main-tab live-id scrape -> additional-tab thread open for ${targetUsername}`);

    const payload = {
      target: { username: targetUsername },
      message: { text: task.message_text },
      taskId: task.id,
      skipMessageExistsCheck: false,
      isOpenNewTab: true
    };

    return new Promise((resolve, reject) => {
      let resolved = false;

      dlog("task_execute_start", { taskId: task.id, taskType: task.task_type, path: "followup-handoff", target: targetUsername });

      const handler = (message, sender) => {
        if (sender.tab?.id !== state.mainTabId && sender.tab?.id !== state.additionalTabId) return;
        if (message.type === "adblock:info:to-background" && message.isEmit) {
          const payload = message.data;
          if (payload.type === "successTask" && payload.data.taskId === task.id) {
            if (resolved) return;
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);

            const data = payload.data;
            dlog("content_success", {
              taskId: task.id,
              taskType: task.task_type,
              threadId: data.threadId || null,
              response: data.response === true,
              isLimited: !!data.isLimited,
              additionalTab: !!data.additionalTab
            });
            (async () => {
              try {
                if (data.threadId) {
                  await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
                    thread_id: data.threadId,
                    last_message_id: data.lastMessageId || null,
                    last_message_ts: data.lastMessageTimestamp || new Date().toISOString(),
                    is_limited: !!data.isLimited
                  });
                  // Dual-write per-account thread (this account's own thread)
                  if (task.contact_id) {
                    await caoUpsert(task.contact_id, { assigned_thread_id: data.threadId });
                  }
                }
                if (data.response === true && task.contact_id) {
                  debugLog(`[Guard] Lead replied — skipping send for task ${task.id}, cancelling remaining follow-ups.`);
                  await cancelPendingFollowups(task.contact_id, "lead_replied");
                  await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
                    media_seen: true,
                    media_seen_at: new Date().toISOString(),
                    replied: true,
                    replied_at: new Date().toISOString()
                  });
                  // Dual-write per-account seen + replied state
                  await caoUpsert(task.contact_id, {
                    media_seen: true,
                    media_seen_at: new Date().toISOString(),
                    replied: true,
                    replied_at: new Date().toISOString()
                  });
                  // Signal pollTasks: nothing was sent (reply skip) — don't charge quota,
                  // don't advance the chain, mark the task skipped not completed.
                  resolve({ isLimited: !!data.isLimited, skippedReply: true });
                  return;
                }
                resolve({ isLimited: !!data.isLimited });
              } catch (err) {
                resolve({ isLimited: !!data.isLimited });
              }
            })();
          } else if (payload.type === "errorTask" && payload.data.taskId === task.id) {
            if (resolved) return;
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);

            dlog("content_error", {
              taskId: task.id,
              taskType: task.task_type,
              errorType: payload.data.errorType || null,
              unreachableType: payload.data.unreachableType || null,
              message: String(payload.data.error || "Followup failed").slice(0, 300)
            }, "error");

            // F4: keep fields distinct — unreachableType is genuine reachability
            // only; errorType is the thrown type. retryClass drives the retry tiers.
            const errObj = new Error(payload.data.error || "Followup failed");
            errObj.errorType = payload.data.errorType || null;
            errObj.unreachableType = payload.data.unreachableType || null;
            errObj.retryClass = errObj.unreachableType || errObj.errorType || null;
            reject(errObj);
          }
        }
      };

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          chrome.runtime.onMessage.removeListener(handler);
          // Match the first-DM ten-minute watchdog: background-tab throttling can make
          // a legitimate multi-step delivery exceed five minutes. This path also settles
          // an expired delivery as unknown instead of retrying the physical send.
          dlog("task_timeout", { taskId: task.id, taskType: task.task_type, waitedMs: 600000 }, "warn");
          reject(new Error("Followup task timed out waiting for content script response"));
        }
      }, 600000);

      chrome.runtime.onMessage.addListener(handler);

      (async () => {
        try {
          const res = await sendTaskToContent("main", "sendMessage", payload, targetUrl);
          if (!res?.success) {
            if (!resolved) {
              resolved = true;
              chrome.runtime.onMessage.removeListener(handler);
              clearTimeout(timeoutId);
              reject(new Error(res?.error?.error || "Send message failed to start"));
            }
          }
        } catch (err) {
          if (!resolved) {
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);
            reject(err);
          }
        }
      })();
    });
  }
  else if (task.task_type === 'scrape_followers' || task.task_type === 'scrape_following') {
    return new Promise((resolve, reject) => {
      let resolved = false;

      const handler = (message, sender) => {
        if (sender.tab?.id !== state.additionalTabId) return;
        if (message.type === "adblock:info:to-background" && message.isEmit) {
          const payload = message.data;
          if (payload.type === "successTask" && payload.data.taskId === task.id) {
            if (resolved) return;
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);

            (async () => {
              try {
                const targets = payload.data.targets;
                if (targets && targets.length > 0) {
                  const params = JSON.parse(task.message_text);
                  const typeStr = task.task_type === 'scrape_followers' ? "followers" : "following";

                  const listRes = await supabaseReq(`target_lists`, "POST", {
                    user_id: task.user_id,
                    name: `Scraped: ${params.target} (${typeStr})`,
                    type: "raw",
                    count: targets.length
                  });

                  if (listRes && listRes.length > 0) {
                    const listId = listRes[0].id;

                    let contactIds = [];
                    for (let i = 0; i < targets.length; i += 1000) {
                      const chunk = targets.slice(i, i + 1000);
                      const contactsToInsert = chunk.map(t => ({
                        user_id: task.user_id,
                        username: t.username,
                        full_name: t.fullName || t.username,
                        status: 'not_started'
                      }));

                      const cRes = await supabaseReq(`contacts?select=id`, "POST", contactsToInsert);
                      if (cRes) contactIds = contactIds.concat(cRes.map(c => c.id));
                    }

                    for (let i = 0; i < contactIds.length; i += 1000) {
                      const chunk = contactIds.slice(i, i + 1000);
                      const links = chunk.map(cId => ({
                        target_list_id: listId,
                        contact_id: cId
                      }));
                      await supabaseReq(`target_list_items`, "POST", links);
                    }
                  }
                }
                resolve(true);
              } catch (err) {
                reject(err);
              }
            })();
          } else if (payload.type === "errorTask" && payload.data.taskId === task.id) {
            if (resolved) return;
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);
            reject(new Error(payload.data.error || "Scraping failed"));
          }
        }
      };

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          chrome.runtime.onMessage.removeListener(handler);
          reject(new Error("Scrape task timed out waiting for content script response"));
        }
      }, 300000);

      chrome.runtime.onMessage.addListener(handler);

      (async () => {
        try {
          const params = JSON.parse(task.message_text);
          const res = await sendTaskToContent("additional", "parsing", {
            taskId: task.id,
            username: params.target,
            type: task.task_type === 'scrape_followers' ? "followers" : "following",
            limit: params.limit
          });

          if (!res?.success) {
            if (!resolved) {
              resolved = true;
              chrome.runtime.onMessage.removeListener(handler);
              clearTimeout(timeoutId);
              reject(new Error(res?.error?.error || "Failed to start scrape"));
            }
          }
        } catch (err) {
          if (!resolved) {
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);
            reject(err);
          }
        }
      })();
    });
  }
  else {
    throw new Error(`Unsupported task_type: ${task.task_type}`);
  }
}

function randUrl() {
  const urls = [
    "https://www.instagram.com/instagram",
    "https://instagram.com",
    "https://www.instagram.com/direct/inbox/",
    "https://www.instagram.com/explore/"
  ];
  return urls[Math.floor(Math.random() * urls.length)];
}

async function openTab(type, targetUrl = null) {
  const stateKey = type === 'main' ? 'mainTabId' : 'additionalTabId';

  // MV3 service workers are routinely suspended while Chrome is in the
  // background. Refresh the durable tab ID on every dispatch so a revived
  // worker keeps using the tab it created before suspension.
  const storedTab = await chrome.storage.local.get(stateKey);
  if (storedTab[stateKey]) state[stateKey] = storedTab[stateKey];

  if (state[stateKey]) {
    let tab = null;
    try {
      tab = await chrome.tabs.get(state[stateKey]);
    } catch (e) {
      // Create a replacement only when Chrome confirms the stored tab is gone.
      const missingTabId = state[stateKey];
      state[stateKey] = null;
      await chrome.storage.local.remove(stateKey);
      dlog("tab_missing_replaced", {
        tabType: type,
        tabId: missingTabId,
        reason: String(e?.message || e).slice(0, 160)
      }, "warn");
    }

    if (tab) {
      // A discarded tab is still the user's pinned tab. Wake it and let the
      // normal ping/reload path below verify the content script; never create
      // a duplicate pinned tab merely because Chrome unloaded its renderer.
      if (tab.discarded) {
        dlog("tab_discarded_recovered", { tabType: type, tabId: tab.id, currentUrl: tab.url || null }, "warn");
        try {
          await chrome.tabs.reload(tab.id);
          for (let i = 0; i < 25; i++) {
            const reloaded = await chrome.tabs.get(tab.id).catch(() => null);
            if (!reloaded) break;
            if (reloaded.status === "complete" && !reloaded.discarded) break;
            await sleep(400);
          }
        } catch (e) {
          // Do not replace a tab solely because waking it failed. The existing
          // sendTaskToContent ping/reload recovery will make the final decision.
          dlog("tab_discarded_wake_failed", {
            tabType: type,
            tabId: tab.id,
            reason: String(e?.message || e).slice(0, 160)
          }, "warn");
        }
      }

      // For the additional tab with no explicit target, force-navigate to the DM
      // inbox so we never reuse a stale thread page from a previous task. The
      // content script then opens the correct thread live by username.
      const effectiveUrl = targetUrl || (type === 'additional' ? "https://www.instagram.com/direct/inbox/" : null);
      debugLog(`Reusing existing ${type} tab ${tab.id}`);
      dlog("tab_reused", { tabType: type, tabId: tab.id, currentUrl: tab.url || null, wasDiscarded: Boolean(tab.discarded) });
      dlog("tab_reuse", { tabType: type, tabId: tab.id, currentUrl: tab.url || null });
      if (effectiveUrl && tab.url !== effectiveUrl) {
        debugLog(`Navigating ${type} tab to target URL: ${effectiveUrl}`);
        dlog("tab_navigate", { tabType: type, tabId: tab.id, url: effectiveUrl }, "warn");
        await chrome.tabs.update(tab.id, { url: effectiveUrl });
        for (let i = 0; i < 25; i++) {
          try {
            const t = await chrome.tabs.get(tab.id);
            if (t.status === "complete") break;
          } catch (e) { break; }
          await sleep(400);
        }
      }
      return tab.id;
    }
  }

  debugLog(`Opening pinned Instagram ${type} tab...`);

  const tab = await chrome.tabs.create({
    url: targetUrl || randUrl(),
    active: false,
    index: 0,
    pinned: true
  });

  state[stateKey] = tab.id;
  await chrome.storage.local.set({ [stateKey]: tab.id });

  debugLog(`Tab opened (${type}): ${tab.id}, waiting for load...`);
  dlog("tab_created", { tabType: type, tabId: tab.id, url: tab.url || targetUrl || "random" });

  for (let i = 0; i < 25; i++) {
    try {
      const t = await chrome.tabs.get(tab.id);
      if (t.status === "complete") break;
    } catch (e) { break; }
    await sleep(400);
  }

  debugLog(`Tab ready (${type}).`);
  return tab.id;
}

async function closeTabs() {
  if (state.mainTabId) {
    try { await chrome.tabs.remove(state.mainTabId); } catch (e) { }
    state.mainTabId = null;
    await chrome.storage.local.remove('mainTabId');
    debugLog("Main Tab closed.");
  }
  if (state.additionalTabId) {
    try { await chrome.tabs.remove(state.additionalTabId); } catch (e) { }
    state.additionalTabId = null;
    await chrome.storage.local.remove('additionalTabId');
    debugLog("Additional Tab closed.");
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function sendTaskToContent(tabType, taskType, taskData, targetUrl = null) {
  const tabId = await openTab(tabType, targetUrl);

  debugLog(`Sending '${taskType}' to tab ${tabId}`);

  // Ping first to confirm content script is alive
  let pingOk = false;
  let reloadCount = 0;

  while (!pingOk && reloadCount < 2) {
    for (let i = 0; i < 5; i++) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: "adblock:info:to-content",
          data: { type: "ping", data: {} }
        });
        pingOk = true;
        break;
      } catch (e) {
        await sleep(2000);
      }
    }

    if (!pingOk) {
      reloadCount++;
      debugLog(`Content script not responding. Reloading tab (attempt ${reloadCount}/2)...`);
      dlog("cs_unresponsive_reload", { taskType, tabId, attempt: reloadCount }, "warn");
      await chrome.tabs.reload(tabId, { bypassCache: true });
      await sleep(8000); // Wait for load
    }
  }

  if (!pingOk) {
    dlog("cs_dead_after_reloads", { taskType, tabId }, "error");
    const errObj = new Error("Content script still not responding after tab reloads");
    errObj.unreachableType = "instagram_reload_error";
    throw errObj;
  }

  debugLog(`[sendTaskToContent] Sending actual task ${taskType} to tab ${tabId}...`);
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "adblock:info:to-content",
      data: { type: taskType, data: taskData }
    });
    debugLog(`[sendTaskToContent] Task ${taskType} successfully sent. Response: ${JSON.stringify(response)}`);
    dlog("task_dispatched", { taskType, tabId, ack: response ?? null });
    return response;
  } catch (err) {
    debugLog(`[sendTaskToContent] ERROR sending task ${taskType} to tab ${tabId}: ${err.message}`);
    dlog("task_dispatch_failed", { taskType, tabId, error: String(err.message).slice(0, 200) }, "error");
    throw err;
  }
}

async function sendToContentLite(tabType, taskType, taskData) {
  if (!state[tabType === 'main' ? 'mainTabId' : 'additionalTabId']) return null;
  const tabId = state[tabType === 'main' ? 'mainTabId' : 'additionalTabId'];

  try {
    const pingRes = await Promise.race([
      chrome.tabs.sendMessage(tabId, {
        type: "adblock:info:to-content",
        data: { type: "ping", data: {} }
      }),
      sleep(3000).then(() => null)
    ]);
    if (!pingRes) {
      debugLog(`[sendToContentLite] Content script busy, skipping ${taskType}`);
      return null;
    }

    const response = await chrome.tabs.sendMessage(tabId, {
      type: "adblock:info:to-content",
      data: { type: taskType, data: taskData }
    });
    return response;
  } catch (e) {
    debugLog(`[sendToContentLite] ${taskType} skipped: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "HUB_LOGIN") {
    handleLogin(message.payload.email, message.payload.password).catch(err => debugLog(`Login error: ${err.message}`));
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "FETCH_BROWSERS") {
    fetchBrowsers().catch(err => debugLog(`Fetch browsers error: ${err.message}`));
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "HUB_CONNECT") {
    // Legacy message from old popup builds — connecting now just auto-pairs.
    handleConnect().catch(err => debugLog(`Connect error: ${err.message}`));
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "HUB_DISCONNECT") {
    stopEngine();
    chrome.alarms.clear("engine_heartbeat");
    closeTabs();
    state.browserId = null;
    state.browserLabel = null;
    state.stats = { completed: 0, failed: 0 };
    chrome.storage.local.remove(['browserId', 'browserLabel', 'stats']).catch(() => null);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "GET_STATS") {
    (async () => {
      try {
        const stats = await syncStatsFromDatabase();
        const today = await computeTodayStats();
        sendResponse({ ok: true, stats: { ...stats, ...today } });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  if (message.type === "HUB_PAUSE_ENGINE") {
    debugLog("[Engine] Paused by user.");
    stopEngine();
    closeTabs();
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "HUB_RESUME_ENGINE") {
    debugLog("[Engine] Resumed by user. Opening tab eagerly.");
    // Resume also re-links if the user had disconnected — resuming IS intent
    // to run, and the popup's Reconnect path may route through here.
    chrome.storage.local.remove(['wakeUpAt', 'wakeReason', 'wakeTaskId', 'disconnectedByUser']).catch(() => null);
    startEngine();
    openTab('main').catch(err => debugLog(`Open tab error: ${err.message}`));
    sendResponse({ ok: true });
    return;
  }
  // HUB_SESSION_SYNCED removed (firm-hold login): the extension never imports
  // tokens from the web app. Both clients own independent Supabase sessions.

  // --- Content Script Messages (via BackgroundConnector) ---
  if (message.type === "adblock:info:to-background") {
    const taskType = message.data?.type;
    const taskData = message.data?.data;

    // getTabType: critical — tells content.js it's the "main" tab
    if (taskType === "getTabType") {
      const tabId = sender.tab?.id;
      (async () => {
        try {
          let result = null;
          if (tabId && state.mainTabId && tabId === state.mainTabId) result = "main";
          if (tabId && state.additionalTabId && tabId === state.additionalTabId) result = "additional";
          sendResponse({ success: true, result });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true; // async response
    }

    // sleep: content script uses this to sleep without blocking
    if (taskType === "sleep") {
      const ms = taskData?.time || 1000;
      (async () => {
        try {
          await sleep(ms);
          sendResponse({ success: true, result: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // pong: content script acknowledges ping
    if (taskType === "pong") {
      sendResponse({ success: true });
      return;
    }

    // log: content script sending a log
    if (taskType === "log") {
      // F5a: include the data payload (capped) — threadId values, errors and
      // counters live here; discarding them is what hid the followup bug.
      let detail = "";
      try {
        const json = JSON.stringify(taskData?.data ?? {});
        detail = json === "{}" ? "" : " | " + json.slice(0, 300);
      } catch { }
      debugLog(`[Content] ${taskData?.type}${detail}`);
      sendResponse({ success: true });
      return;
    }

    // successTask / errorTask: handled primarily by the Promise listener in executeTask.
    // If the listener timed out but the content script later verifies the Instagram
    // message, complete only rows which are still processing or were explicitly marked
    // delivery_unknown. We intentionally never revive arbitrary failed rows.
    if (taskType === "successTask" || taskType === "errorTask") {
      if (taskType === "successTask" && taskData?.taskId) {
        if (taskData.taskId === _uniboxInFlightTaskId) {
          // Unibox owns its completion in pollUniboxReplies. Letting this
          // generic path also PATCH it caused duplicate completion-trigger
          // calls for each Unibox reply.
          dlog("unibox_success_deferred", { taskId: taskData.taskId });
        } else {
          const completion = { status: "completed", completed_at: new Date().toISOString(), error_reason: null };
          // Normal completion path (including the Promise listener race).
          supabaseReq(`dm_tasks?id=eq.${taskData.taskId}&status=eq.processing`, "PATCH", completion).catch(() => {});
          // Late success after a timeout: only absorb the narrow fail-closed state
          // created above, never a real permanent failure. This also performs the
          // normal contact/follow-up completion bookkeeping the timed-out poller
          // could no longer reach.
          settleLateVerifiedDelivery(taskData.taskId).catch(() => {});
        }
      }
      sendResponse({ success: true });
      return;
    }

    // sendMessageAdditionalTab: main-tab sendMessage couldn't open the thread,
    // so it delegated to us (fallback). Open the additional tab pointed at the
    // thread's live URL and send from there — mirrors ColdDMs startTaskForAdditionalTab.
    if (taskType === "sendMessageAdditionalTab") {
      (async () => {
        try {
          const threadId = taskData?.threadId;
          const threadUrl = threadId ? `https://www.instagram.com/direct/t/${threadId}/` : null;
          const targetU = taskData?.target?.username ?? "(unknown)";
          debugLog(`[Followup->AddlTab] Handoff received for @${targetU} | taskId=${taskData?.taskId} | live threadId=${threadId || "(none)"} | url=${threadUrl || "(no url — will open by username)"}`);
          dlog("handoff_received", {
            taskId: taskData?.taskId || null,
            contact: targetU,
            threadId: threadId || null,
            url: threadUrl
          }, threadId ? "info" : "warn");
          if (!threadId) {
            debugLog(`[Followup->AddlTab] WARNING: no live threadId in handoff for @${targetU} — additional tab will land on inbox and must self-recover by username.`);
            dlog("handoff_missing_threadid", { taskId: taskData?.taskId || null, contact: targetU }, "error");
          }
          await sendTaskToContent("additional", "sendMessageFromDialog", {
            target: taskData?.target,
            message: taskData?.message,
            taskId: taskData?.taskId,
            isTakeSnapshot: taskData?.isTakeSnapshot,
            skipMessageExistsCheck: taskData?.skipMessageExistsCheck
          }, threadUrl);
          debugLog(`[Followup->AddlTab] sendMessageFromDialog dispatched to additional tab for @${targetU} | taskId=${taskData?.taskId}`);
          dlog("handoff_dispatched", { taskId: taskData?.taskId || null, contact: targetU, url: threadUrl });
          sendResponse({ success: true });
        } catch (err) {
          debugLog(`[Followup->AddlTab] Additional-tab send failed for taskId=${taskData?.taskId}: ${err.message}`);
          dlog("handoff_failed", { taskId: taskData?.taskId || null, error: String(err.message).slice(0, 200) }, "error");
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // saveMessages: content script sends read receipts for processing
    if (taskType === "saveMessages") {
      (async () => {
        try {
          await processCollectedMessages(taskData?.readReceipts || []);
          sendResponse({ success: true, result: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // saveConversations: UNIBOX CAPTURE (plan v2 §5) — content pushes the
    // full ReStore thread dump; we filter to campaign leads, apply watermarks,
    // and write via the sync_unibox_thread RPC (one round-trip per thread).
    if (taskType === "saveConversations") {
      (async () => {
        try {
          await syncUniboxThreads(taskData);
          sendResponse({ success: true, result: true });
        } catch (err) {
          debugLog(`[Unibox] saveConversations failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // registerAccounts: content script reports the logged-in IG account(s).
    // With UNIQUE(user_id, instance_key), the row we hold IS ours by definition,
    // so there's no split-brain check anymore. We just make sure a row exists
    // (create-or-adopt), then claim/refresh the IG username via the atomic RPC.
    if (taskType === "registerAccounts") {
      (async () => {
        try {
          const accounts = taskData?.accounts || [];
          const currentId = taskData?.current_id;
          const currentAccount = accounts.find((a) => a.instagram_id === currentId) || accounts[0];

          if (currentAccount && currentAccount.username) {
            // Ensure we have a paired row (idempotent upsert if missing).
            await ensurePairedRow();

            if (state.browserId) {
              const igUsername = currentAccount.username.toLowerCase().replace(/^@/, "");
              const igUserId = currentAccount.instagram_id || null;

              // Read our own row's current ig_username to avoid a redundant RPC.
              const existing = await supabaseReq(`browser_instances?select=id,ig_username&id=eq.${state.browserId}`);
              const row = existing && existing[0];
              const storedUsername = row && row.ig_username
                ? row.ig_username.toLowerCase().replace(/^@/, "")
                : null;

              if (storedUsername !== igUsername) {
                if (storedUsername) {
                  debugLog(`[IG Detect] MISMATCH: paired as @${storedUsername} but logged in as @${igUsername}. Updating.`);
                } else {
                  debugLog(`[IG Detect] Detected logged-in IG account: @${igUsername}`);
                }

                // Atomic RPC: if another (stale) row of THIS user owns this IG
                // account, it transfers campaigns/limits/outreach/pending tasks
                // to our row, frees the stale row (ig_username NULL, inactive),
                // then stamps our row. This is the PC→laptop takeover path.
                const rpcResult = await supabaseReq(`rpc/pair_or_adopt_ig_username`, "POST", {
                  p_new_browser_id: state.browserId,
                  p_ig_username: igUsername,
                  p_ig_user_id: igUserId,
                });
                debugLog(`[IG Detect] RPC result: ${JSON.stringify(rpcResult)}`);

                // Update the label to show the @handle
                state.browserLabel = `@${igUsername}`;
                await chrome.storage.local.set({ browserLabel: state.browserLabel });
                chrome.runtime.sendMessage({ type: "HUB_CONNECTED_SUCCESS", label: state.browserLabel, stats: state.stats }).catch(() => null);
              }
            }
          }

          sendResponse({ success: true, result: [] });
        } catch (err) {
          debugLog(`[IG Detect] Error: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // Default passthrough
    sendResponse({ success: true });
    return;
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  if (state.mainTabId === tabId) {
    state.mainTabId = null;
    chrome.storage.local.remove('mainTabId').catch(() => null);
  }
  if (state.additionalTabId === tabId) {
    state.additionalTabId = null;
    chrome.storage.local.remove('additionalTabId').catch(() => null);
  }
});

// Boot
dlog("session_boot", {
  version: chrome.runtime.getManifest().version,
  browserId: state.browserId ? state.browserId.slice(0, 8) : null
});
init();
