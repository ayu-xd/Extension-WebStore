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
  // F-LOCK-01: taskId -> settle(err) for the currently pending executeTask promise.
  // The alarm watchdog used to poke state.isProcessing directly while that promise
  // was still pending, so two pollTasks bodies ended up writing one boolean. It now
  // rejects the promise through this registry and lets pollTasks unwind normally.
  taskSettlers: {},
  mainTabId: null,
  additionalTabId: null,
  // ADDL-GUARD-01: timestamp until which a dispatch into the additional tab is
  // considered in flight (set by sendTaskToContent for the "additional" tab,
  // generous grace because a slow reply is better than a killed one).
  // closeAdditionalTab defers while this is live, so a main-tab failure can no
  // longer kill a unibox reply / followup handoff mid-send — the "message
  // channel closed" deaths in the 2026-09-04 bundles were exactly this race.
  additionalInFlightUntil: 0,
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
    // S1: HEAD counts, not ID-list downloads. Same predicates as before —
    // note pending intentionally has NO lower day bound (includes overdue).
    const cacheKey = `${state.browserId}|${start}|${end}`;
    const now = Date.now();
    if (_todayStatsCache.key === cacheKey && now - _todayStatsCache.at < 30000 && _todayStatsCache.value) {
      return _todayStatsCache.value;
    }
    const [sent, pend] = await Promise.all([
      supabaseCount(`dm_tasks?browser_instance_id=eq.${state.browserId}&status=eq.completed&completed_at=gte.${start}&completed_at=lt.${end}`),
      supabaseCount(`dm_tasks?browser_instance_id=eq.${state.browserId}&status=eq.pending&or=(scheduled_at.is.null,scheduled_at.lt.${end})`)
    ]);
    const value = { sentToday: sent, pendingToday: pend };
    _todayStatsCache = { key: cacheKey, at: now, value };
    return value;
  } catch (_e) {
    // Stale beats zero: a failed refresh must not blank the cards.
    if (_todayStatsCache.value) return _todayStatsCache.value;
    return { sentToday: 0, pendingToday: 0 };
  }
}

// Last-good today-stats (memory only; day-bounded by cache key above).
let _todayStatsCache = { key: null, at: 0, value: null };

// HEAD count helper: returns the exact count, transfers (almost) no body.
// Throws on missing/unparseable Content-Range so callers fall back loudly.
async function supabaseCount(path, _retried = false) {
  const headers = {
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${state.accessToken ? state.accessToken : SUPABASE_ANON_KEY}`,
    "Prefer": "count=exact"
  };
  const res = await fetchWithRetry(`${SUPABASE_URL}/rest/v1/${path}`, { method: "HEAD", headers });
  if (res.status === 401 && !_retried && state.refreshToken) {
    const refreshed = await refreshAccessTokenSingleFlight();
    if (refreshed) return supabaseCount(path, true);
  }
  if (!res.ok) {
    throw new Error(`Supabase count error: ${res.status} ${res.statusText}`);
  }
  const range = res.headers.get("content-range") || "";
  const m = range.match(/\/(\d+)\s*$/);
  if (!m) throw new Error(`Supabase count error: missing content-range (${range.slice(0, 40)})`);
  return Number(m[1]);
}

async function syncStatsFromDatabase() {
  if (!state.browserId) return state.stats;

  try {
    // CHURN-05: exclude parked-unreachable rows from the popup's failure count,
    // exactly as the web dashboard does (lib/scheduler.ts splits failed vs
    // unreachable on this column). A lead who no longer exists is attrition, not
    // a failed send, and it must not read as one in either surface.
    const rows = await supabaseReq(`dm_tasks?select=id,status,unreachable_type&browser_instance_id=eq.${state.browserId}&status=in.(completed,failed)&order=completed_at.desc.nullslast&limit=${EGRESS.statsHistoryLimit}`);
    // EGRESS-E8/EGRESS-LOG: history is unbounded as months accumulate; the cap
    // keeps this read constant-size. Exact counts hold until a browser passes
    // statsHistoryLimit rows — then stats_cap_hit fires instead of silently
    // undercounting.
    if ((rows || []).length >= EGRESS.statsHistoryLimit) {
      dlog("stats_cap_hit", { rows: rows.length, limit: EGRESS.statsHistoryLimit }, "warn");
    }
    const stats = (rows || []).reduce((acc, row) => {
      if (row.status === 'completed') acc.completed += 1;
      if (row.status === 'failed' && !row.unreachable_type) acc.failed += 1;
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
// EGRESS-OPTS: Supabase byte-saving switches. Single tuning surface — every
// optimized read/write below references these, and every one emits a
// dedicated log event (see EGRESS-LOG notes) so diagnostic bundles show the
// new behavior working (or failing loudly) without guessing.
// ---------------------------------------------------------------------------
const EGRESS = {
  // E1: columns the 15s task poll is allowed to read. Covers every task.*
  // field consumed downstream (executeTask, claim log, scrape params).
  pollCols: "id,contact_id,task_type,message_text,scheduled_at,retry_count,thread_id,campaign_id,user_id",
  // E1: columns the 1-min unibox poll reads (rt.* downstream). retry_count
  // is load-bearing: the error path below bounds reply retries from it — a
  // narrowed row without it defaults to 0 and retries forever.
  uniboxCols: "id,contact_id,thread_id,message_text,retry_count",
  // E2: contacts handle->id map TTL (was 60s) + unknown-handle refresh.
  contactsTtlMs: 30 * 60_000,
  // E3: account working-hours TTL (was 5 min). Fail-open unchanged.
  hoursTtlMs: 6 * 3600_000,
  // E8: stats history backstop — counts stay exact until a browser passes
  // this many completed+failed rows, then stats_cap_hit fires (warn).
  statsHistoryLimit: 10000,
};

// EGRESS-LOG: canary tripwire for narrowed polls. If PostgREST/RLS ever drops
// a column the claim path reads, the narrowed row is unusable — log loudly
// (error) and let the caller refetch select=*. A firing tripwire in a bundle
// means "widen EGRESS.pollCols/uniboxCols", never silent breakage.
function narrowGuard(row, cols, event) {
  const missing = cols.filter((c) => !row || !(c in row));
  if (missing.length) {
    dlog(event, { missing }, "error");
    return false;
  }
  return true;
}

// EGRESS-LOG: per-run collector batch counters, flushed as one collector_batch
// line (reset after flush). Module scope: processCollectedMessages runs are
// sequential on the alarm, so no interleaving. S7: unresolved counts receipts
// that matched no contact (skipped writes); replied counts resolved IDs.
const _egressBatch = { seen: 0, replied: 0, canceled: 0, unresolved: 0 };

// S7: confirmed-stranger receipts skip all writes until this TTL expires
// (memory-only: worst case is one extra quiet pass after a worker restart).
const _collectorMiss = new Map(); // username -> last-confirmed-miss-at
const COLLECTOR_MISS_TTL_MS = 30 * 60_000;

// ---------------------------------------------------------------------------
// Supabase REST Client
// ---------------------------------------------------------------------------

// E-07 FIX: network retry layer (2 attempts) wrapping every fetch() call.
// Absorbs transient network drops and 5xx/429 responses before they reach
// the auth logic that previously wiped tokens on any TypeError.
async function fetchWithRetry(url, options, attempts = 2) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, options);
      if ((res.status === 429 || res.status >= 500) && i < attempts) {
        const retryAfterRaw = res.headers.get('retry-after');
        const retryAfterMs = retryAfterRaw ? Number(retryAfterRaw) * 1000 : 1000 * (i + 1);
        await sleep(Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 1000 * (i + 1));
        continue;
      }
      return res;
    } catch (e) {
      if (i >= attempts || e.name === 'AbortError') throw e;
      await sleep(1000 * (i + 1));
    }
  }
}

async function supabaseReq(path, method = "GET", body = null, _retried = false, opts = null) {
  // EGRESS-E0: PATCH writes default to return=minimal (no response body) —
  // every PATCH call site in this file was audited: only settle (266),
  // unibox claim/completion/quarantine (821/878/887) and cancel (1225) read
  // the returned rows, and those pass { representation: true }. POST/GET keep
  // return=representation (target_lists + sync_unibox_thread consume rows).
  // S2: opts.select projects representation to listed columns; opts.minimal
  // forces minimal on any method (callers that ignore rows).
  const _minimal = (method === "PATCH" && !(opts && opts.representation)) || !!(opts && opts.minimal);
  const _select = opts && opts.select
    ? (path.includes("?") ? `&select=${opts.select}` : `?select=${opts.select}`)
    : "";
  const headers = {
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${state.accessToken ? state.accessToken : SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
    "Prefer": _minimal ? "return=minimal" : "return=representation"
  };
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const res = await fetchWithRetry(`${SUPABASE_URL}/rest/v1/${path}${_select}`, options);
  if (res.status === 401 && !_retried && state.refreshToken) {
    debugLog("Token expired, refreshing...");
    const refreshed = await refreshAccessTokenSingleFlight();
    if (refreshed) return supabaseReq(path, method, body, true, opts);
  }
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`Supabase error: ${res.status} ${res.statusText}${bodyText ? ` | ${bodyText.slice(0, 200)}` : ''}`);
  }
  if (_minimal) return null; // 204 No Content — callers must not read rows.
  return res.json();
}

// Upsert (POST ...?on_conflict=...) with merge-duplicates. Used for the new
// per-account `contact_account_outreach` table so re-sending state for the same
// (contact, browser) pair updates instead of erroring on the unique constraint.
async function supabaseUpsert(path, body, onConflict, _retried = false, opts = null) {
  // EGRESS-E0: upserts default to return=minimal (callers: caoUpsert ignores
  // rows). The browser_instances pairing upsert passes { representation: true }
  // because it reads rows[0].id/label.
  // S2: opts.select projects the representation (appended after on_conflict).
  const _minimal = !(opts && opts.representation);
  const _select = opts && opts.select ? `&select=${opts.select}` : "";
  const headers = {
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${state.accessToken ? state.accessToken : SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
    "Prefer": _minimal ? "resolution=merge-duplicates,return=minimal" : "resolution=merge-duplicates,return=representation"
  };
  const res = await fetchWithRetry(`${SUPABASE_URL}/rest/v1/${path}?on_conflict=${onConflict}${_select}`, {
    method: "POST", headers, body: JSON.stringify(body)
  });
  if (res.status === 401 && !_retried && state.refreshToken) {
    debugLog("Token expired, refreshing...");
    const refreshed = await refreshAccessTokenSingleFlight();
    if (refreshed) return supabaseUpsert(path, body, onConflict, true, opts);
  }
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`Supabase upsert error: ${res.status} ${res.statusText}${bodyText ? ` | ${bodyText.slice(0, 200)}` : ''}`);
  }
  if (_minimal) return null;
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

// EGRESS-E4: batched dual-write — one upsert call per 50-chunk instead of N
// single-row upserts. Array body = single PostgREST call; E0-minimal applies
// automatically (return ignored). Same non-fatal contract as caoUpsert.
async function caoUpsertMany(entries) {
  try {
    if (!entries?.length || !state.browserId) return;
    const userId = getUserIdFromToken(state.accessToken);
    if (!userId) return;
    const now = new Date().toISOString();
    await supabaseUpsert(
      "contact_account_outreach",
      entries.map(({ contactId, fields }) => ({
        user_id: userId,
        contact_id: contactId,
        browser_instance_id: state.browserId,
        updated_at: now,
        ...fields
      })),
      "contact_id,browser_instance_id"
    );
  } catch (err) {
    debugLog(`[CAO] batched dual-write failed (non-fatal): ${err.message}`);
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
    { status: "completed", completed_at: completedAt, error_reason: null },
    false,
    { representation: true, select: "contact_id,task_type,campaign_id" } // EGRESS-E0 opt-out: rows?.[0] below reads contact_id/type.
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
    // E-07 FIX: split network errors (TypeError: Failed to fetch) from genuine
    // auth rejections (4xx from the endpoint). A transient network drop says
    // nothing about auth validity — wiping tokens on every catch caused the
    // Aug 30 2:48 PM forced-logout and 2.5h manual re-login window.
    const isNetworkError = err instanceof TypeError || /failed to fetch/i.test(String(err?.message || err));
    if (isNetworkError) {
      debugLog(`Refresh network error (transient): ${err.message} — keeping tokens, will retry later.`);
      return false; // DO NOT touch tokens, DO NOT set sessionExpired, DO NOT stopEngine
    }
    // Genuine auth rejection (invalid_grant, 4xx from Supabase auth endpoint).
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

// E-08 FIX: single-flight mutex for refreshAccessToken.
// Supabase rotates refresh tokens single-use. When heartbeat, pollTasks and init
// all race to refresh simultaneously, the losers present the now-stale token
// and get a 400 — which the old catch-all misread as session-expired, nuking
// the session the winner just renewed. Single-flight ensures everyone awaits
// the SAME promise and only one HTTP call ever goes out per rotation cycle.
let _refreshInFlight = null;
async function refreshAccessTokenSingleFlight() {
  if (_refreshInFlight) return _refreshInFlight; // everyone awaits the same promise
  _refreshInFlight = (async () => {
    try {
      // Re-read tokens from storage first — another context may have just rotated them
      const stored = await chrome.storage.local.get(['accessToken', 'refreshToken']);
      if (stored.refreshToken && stored.refreshToken !== state.refreshToken) {
        // Someone else already refreshed; adopt their new pair and skip the round-trip.
        state.accessToken = stored.accessToken;
        state.refreshToken = stored.refreshToken;
        return true;
      }
      return await refreshAccessToken();
    } finally {
      _refreshInFlight = null;
    }
  })();
  return _refreshInFlight;
}

// ---------------------------------------------------------------------------
// Extension Core Logic
// ---------------------------------------------------------------------------

async function init() {
  // Migration (v1.4.8): rate-limit cooldowns were removed for ColdDMs parity, but
  // an install updating from <=1.4.7 may still carry { enginePaused: true,
  // enginePausedUntil: <future> } written by a cooldown. The auto-resume that
  // cleared it is gone, so without this the engine stays paused forever. The
  // presence of enginePausedUntil is proof the pause was a cooldown — the popup
  // toggle always removed it — so clearing both keys is safe and never un-pauses
  // a pause the user chose.
  const stale = await chrome.storage.local.get('enginePausedUntil');
  if (stale.enginePausedUntil) {
    await chrome.storage.local.remove(['enginePaused', 'enginePausedUntil']);
    debugLog("[Init] Cleared a stale rate-limit cooldown from a pre-1.4.8 build.");
  }

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
  // NOTE (Sep-09 fix): do NOT wipe leaseExpiresAt or force-send here. Under MV3
  // this init block re-runs on every alarm wake (~1/min), so wiping turned the
  // 10-min lease into a send-every-minute (~200 PATCHes/day/browser) plus
  // same-second doubles racing the alarm handler. The skip-checked send below
  // covers every case: first boot (no lease → sends), restart in-window
  // (lease valid → skips, DB still shows Online from the last write), restart
  // after expiry (sends). The force-send stays only in autoPairBrowser, where
  // a brand-new pairing genuinely needs immediate presence.
  if (state.browserId) {
    chrome.alarms.create("engine_heartbeat", { periodInMinutes: 1 });
    sendHeartbeat(false).catch(() => { });
  }

  if (await isEnginePaused(data)) {
    debugLog("[Init] Engine is paused, skipping task engine auto-start.");
    return;
  }

  if (state.refreshToken && state.browserId) {
    const refreshed = await refreshAccessTokenSingleFlight();
    if (refreshed) {
      startEngine();
      // S1: no lifetime history sync on ordinary boot — popup shows
      // today-counts (HEAD), lifetime state.stats restores from storage.
    }
  } else if (state.accessToken && state.browserId) {
    startEngine();
  } else if (state.refreshToken || state.accessToken) {
    // We have a session but no paired row (e.g. the row was deleted from the
    // dashboard, or this is the first boot after a session sync). Re-pair via
    // the idempotent upsert — create-or-adopt this browser's own row.
    // NEVER auto-repair while the user explicitly disconnected.
    if (data.disconnectedByUser) {
      debugLog("[Init] User disconnected — staying unlinked until Reconnect.");
    } else {
      if (state.refreshToken) await refreshAccessTokenSingleFlight();
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
      "user_id,instance_key",
      false,
      { representation: true, select: "id,label" } // EGRESS-E0 opt-out: rows[0].id/label below.
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
    if (await isEnginePaused(pauseState)) {
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
      if (!await isEnginePaused(paused)) {
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
    refreshAccessTokenSingleFlight().catch(() => { });
  } else if (alarm.name === "engine_collect_messages") {
    collectMessagesJob().catch(() => { });
  }
});

async function collectMessagesJob() {
  if (!state.browserId || state.isProcessing) return;
  const pauseData = await chrome.storage.local.get('enginePaused');
  if (await isEnginePaused(pauseData)) return;
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
    // CHURN-01: "skipped", not "failed". This is environmental attrition, not a
    // send error — the user's browser was simply off. The dashboard's failed
    // bucket (lib/scheduler.ts getTodayStats) counts status === "failed" only,
    // so "skipped" keeps it out of "Needs attention" while the reason string
    // still explains it on the task row. Mirrors what the server scheduler
    // already does for stalled follow-ups (_scheduler-engine.ts:640).
    const cutoff = new Date(Date.now() - 7 * 864e5).toISOString();
    const stale = await supabaseReq(
      `dm_tasks?select=id&task_type=eq.unibox_reply&browser_instance_id=eq.${state.browserId}&status=eq.pending&created_at=lt.${cutoff}`
    );
    if (stale?.length) {
      const ids = stale.map(t => t.id).join(",");
      await supabaseReq(`dm_tasks?id=in.(${ids})`, "PATCH", { status: "skipped", error_reason: "Not sent — your browser was offline for over 7 days, so this reply expired." });
      await supabaseReq(`ig_messages?dm_task_id=in.(${ids})&send_status=eq.queued`, "PATCH", { send_status: "failed", send_error: "Couldn't deliver — your browser was offline too long." });
      debugLog(`[Unibox] expired ${stale.length} stale reply task(s).`);
    }

    // 1. Claim the oldest due reply (FIFO). EGRESS-E1: narrowed columns —
    // the claim path reads id/contact_id/thread_id/message_text only.
    const due = await supabaseReq(
      `dm_tasks?select=${EGRESS.uniboxCols}&browser_instance_id=eq.${state.browserId}&task_type=eq.unibox_reply&status=eq.pending&or=(scheduled_at.is.null,scheduled_at.lte.${nowIso})&order=created_at.asc&limit=1`
    );
    if (!due || due.length === 0) return;
    if (!narrowGuard(due[0], EGRESS.uniboxCols.split(","), "unibox_narrow_missing_col")) {
      const full = await supabaseReq(
        `dm_tasks?select=*&browser_instance_id=eq.${state.browserId}&task_type=eq.unibox_reply&status=eq.pending&or=(scheduled_at.is.null,scheduled_at.lte.${nowIso})&order=created_at.asc&limit=1`
      );
      if (!full || full.length === 0) return;
      due[0] = full[0];
    }
    const rt = due[0];

    _uniboxInFlight = true;
    try {
      // Conditional claim: a second worker/poll can never deliver the same
      // pending reply after this worker has claimed it.
      const claimed = await supabaseReq(`dm_tasks?id=eq.${rt.id}&status=eq.pending`, "PATCH", {
        status: "processing",
        claimed_at: nowIso
      }, false, { representation: true, select: "id" }); // EGRESS-E0 opt-out: claimed?.length is the lock proof.
      if (!claimed?.length) {
        dlog("unibox_claim_lost", { taskId: rt.id }, "warn");
        return;
      }
      _uniboxInFlightTaskId = rt.id;
      await supabaseReq(`ig_messages?dm_task_id=eq.${rt.id}&send_status=eq.queued`, "PATCH", { send_status: "sending" });

      // resolve lead handle from contact relation
      let targetUsername = null;
      let targetFullName = null;
      let targetReplyCheckSince = null;
      if (rt.contact_id) {
        const ct = await supabaseReq(`contacts?select=username,full_name,dmed_at,last_follow_up_at&id=eq.${rt.contact_id}`);
        targetUsername = ct?.[0]?.username || null;
        targetFullName = usableFullName(ct?.[0]);
        targetReplyCheckSince = replyCheckSinceFor(ct?.[0]);
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
          target: { username: targetUsername, fullName: targetFullName, replyCheckSince: targetReplyCheckSince },
          message: { text: rt.message_text },
          taskId: rt.id,
          skipMessageExistsCheck: true
        },
        `https://www.instagram.com/direct/t/${rt.thread_id}/`
      );

      if (!res?.success) {
        // UNIBOX-LIE companion fix: carry the content script's error TYPE
        // through, not just the prose — the catch below needs it to tell a
        // terminal verdict (unreachable / dead handle: never retry, Instagram
        // already refused twice would just burn two 45 s cycles) from a
        // transient one.
        const _ct = res?.error?.type || null;
        const _ce = new Error(res?.error?.error || "content script reported failure");
        if (_ct) _ce.errorType = _ct;
        throw _ce;
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
        }, false, { representation: true, select: "id" }); // EGRESS-E0 opt-out: completed?.length proves terminality.
        if (!completed?.length) throw new Error("completion update affected no processing row");
      } catch (e) {
        const reason = `delivery_confirmed_bookkeeping_failed: ${String(e?.message || e).slice(0, 180)}`;
        try {
          const quarantined = await supabaseReq(`dm_tasks?id=eq.${rt.id}&status=eq.processing`, "PATCH", {
            status: "failed",
            completed_at: completedAt,
            error_reason: reason
          }, false, { representation: true, select: "id" }); // EGRESS-E0 opt-out: quarantined?.length proves terminality.
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
      // ── POST-DELIVERY BUBBLE RECONCILIATION ──────────────────────────────
      // Keep the synthetic ig_messages bubble alive and flip it to 'sent'
      // so the web app chat window immediately shows the outgoing reply with
      // a ✓ tick. DO NOT delete it — deleting it leaves the conversation
      // preview stale and makes the message invisible until the next periodic
      // sync cycle (up to 2 min).
      //
      // The next `collectMessages` alarm (every 2 min) will call
      // _emitUniboxCapture → syncUniboxThreads, which upserts the REAL
      // Instagram message_id row via `ON CONFLICT DO NOTHING`. When that
      // happens the synthetic bubble becomes an orphan (its dm_task_id is
      // no longer needed) but it remains harmlessly visible — the real row
      // lands alongside it with the correct message_id. This is acceptable:
      // duplicates are preferable to invisible messages.
      //
      // To give the web app an instant update we also kick off an immediate
      // capture of just this thread right now, without waiting for the alarm.
      try {
        await supabaseReq(`ig_messages?dm_task_id=eq.${rt.id}`, "PATCH", { send_status: "sent" });
      } catch (e) {
        debugLog(`[Unibox] non-fatal: sent-flip failed: ${e.message}`);
      }

      // Immediate post-delivery capture — harvests the just-sent message from
      // the IG React store and writes the real row to ig_messages right away.
      // Best-effort: failure here is non-fatal (the periodic alarm is the backstop).
      if (state.mainTabId) {
        chrome.tabs.sendMessage(state.mainTabId, {
          type: "adblock:info:to-content",
          isEmit: true,
          data: { type: "collectMessages", data: { targetUsername } }
        }).catch(() => null);
        debugLog(`[Unibox] triggered immediate capture for @${targetUsername} after delivery.`);
      }

      debugLog(`[Unibox] reply delivered to @${targetUsername}.`);
    } catch (err) {
      const msg = String(err?.message || err);
      const permanent =
        err?.permanent ||
        err?.errorType === "user_does_not_accept_dms" ||
        // UNIBOX-LIE companion fix: the content script's typed verdicts are
        // terminal — Instagram itself refused this recipient (unreachable
        // thread, dead handle). Retrying 45 s later cannot un-refuse a lead;
        // it only burns cycles and re-hammers the thread.
        err?.errorType === "user_is_unreachable" ||
        err?.errorType === "user_not_found" ||
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

// contacts lookup cache — memory first, chrome.storage second (below).
let _uniboxContactsCache = { at: 0, userId: null, map: new Map() };

async function uniboxResolveContext() {
  if (!state.browserId) throw new Error("browser not paired");
  const rows = await supabaseReq(
    `browser_instances?select=id,user_id,ig_username&id=eq.${state.browserId}`
  );
  const row = rows && rows[0];
  if (!row?.user_id) throw new Error("paired row missing user_id");
  // EGRESS-E2b: hydrate from persisted cache. Worker memory dies on every
  // service-worker restart (~1/min under MV3), which used to force a full
  // refetch each time (Sep-10 bundle: 382 refreshes). Storage survives.
  if (!_uniboxContactsCache.at) {
    await hydrateUniboxContactsCache(row.user_id).catch(() => {});
  }
  // EGRESS-E2: contacts handle->id map. TTL 30 min (was 60s) — contacts
  // barely change, and every refresh is logged below. Unknown handles force
  // a refresh (see syncUniboxThreads) so longer TTL can never drop hot leads.
  if (
    _uniboxContactsCache.userId !== row.user_id ||
    Date.now() - _uniboxContactsCache.at > EGRESS.contactsTtlMs
  ) {
    await refreshUniboxContactsMap(row.user_id, _uniboxContactsCache.userId !== row.user_id ? "user-change" : "ttl");
  }
  return {
    userId: row.user_id,
    accountUsername: row.ig_username
      ? String(row.ig_username).toLowerCase().replace(/^@/, "")
      : null,
    contacts: _uniboxContactsCache.map
  };
}

// EGRESS-E2/EGRESS-LOG: (re)fetch the contacts map. Every refresh logs
// contacts_map_refresh {reason, rows} — in a bundle, ~48/day at 30-min TTL
// vs ~1440/day at 60s TTL is the saving made visible. Reasons: boot (empty
// cache), ttl, user-change, unknown-handle (safety refresh, must never be
// absent when hot leads are missed).
async function refreshUniboxContactsMap(userId, reason) {
  const contacts = await supabaseReq(
    `contacts?select=id,username&user_id=eq.${userId}`
  );
  const map = new Map();
  for (const c of contacts || []) {
    map.set(String(c.username || "").toLowerCase(), c.id);
  }
  _uniboxContactsCache = { at: Date.now(), userId, map };
  // Negcache: drop only handles that now resolve (fresh contact may fix
  // them). Never blanket-clear: that forced one full refetch per unknown
  // handle per pass and persisted an empty misses set.
  for (const h of [..._unknownHandleCache.keys()]) {
    if (map.has(h)) _unknownHandleCache.delete(h);
  }
  // EGRESS-E2b: persist so the map (and negcache) survive worker restarts.
  // Best-effort: storage failure just means next boot refetches (old behavior).
  // Persisted AFTER the map/negcache were updated above — never before.
  await persistUniboxContactsCache();
  dlog("contacts_map_refresh", { reason, rows: map.size });
  return map;
}

// S3: persist map + negcache AFTER applying results. Split out so the sync
// loop can re-persist after recording misses (the old inline persist ran
// before the caller recorded the current miss, losing it on restart).
async function persistUniboxContactsCache() {
  try {
    await chrome.storage.local.set({ uniboxContactsCache: {
      at: _uniboxContactsCache.at, userId: _uniboxContactsCache.userId,
      entries: [..._uniboxContactsCache.map].slice(0, 5000),
      misses: [..._unknownHandleCache].slice(0, 500),
    } });
  } catch (_e) {
    debugLog(`[Unibox] contacts cache persist failed (non-fatal): ${_e?.message || _e}`);
  }
}

// EGRESS-E2b: restore persisted map + negcache. Validates owner + TTL —
// a row for another user or older than TTL is ignored (falls through to a
// logged refresh). Emits contacts_map_restored so bundles prove the save.
async function hydrateUniboxContactsCache(userId) {
  const stored = await chrome.storage.local.get("uniboxContactsCache");
  const c = stored && stored.uniboxContactsCache;
  if (!c || c.userId !== userId || typeof c.at !== "number") return false;
  if (Date.now() - c.at > EGRESS.contactsTtlMs) return false;
  if (!Array.isArray(c.entries)) return false;
  const map = new Map();
  for (const e of c.entries) {
    if (Array.isArray(e) && typeof e[0] === "string") map.set(e[0], e[1]);
  }
  _uniboxContactsCache = { at: c.at, userId, map };
  _unknownHandleCache.clear();
  if (Array.isArray(c.misses)) {
    for (const [h, ts] of c.misses) {
      if (typeof h === "string" && typeof ts === "number" && Date.now() - ts < EGRESS.contactsTtlMs) {
        _unknownHandleCache.set(h, ts);
      }
    }
  }
  dlog("contacts_map_restored", { rows: map.size, ageMin: Math.round((Date.now() - c.at) / 60000), misses: _unknownHandleCache.size });
  return true;
}

// EGRESS-E2 negative cache: handles that missed even after a forced refresh
// (strangers, groups, spam — threads that can never resolve). Without this,
// the unknown-handle safety net refetches the full map on EVERY sync for the
// same unresolvable threads (Sep-09 bundle: 35 refetches in 12 min).
const _unknownHandleCache = new Map(); // handle -> first-miss-at

// True if an unknown handle deserves a forced refresh: never seen, or its
// miss is older than the map TTL. Repeat sightings inside the window skip
// silently (logged once at insert by noteUnknownHandle below).
function unknownHandleNeedsRefresh(handle) {
  const missAt = _unknownHandleCache.get(handle);
  if (missAt && Date.now() - missAt < EGRESS.contactsTtlMs) return false;
  return true;
}

function noteUnknownHandle(handle, resolved) {
  if (resolved) { _unknownHandleCache.delete(handle); return; }
  // First-miss timestamp is FIXED (never re-stamped): the window must expire
  // on its own, or a contact added mid-window would be skipped indefinitely
  // by an ever-sliding expiry.
  if (!_unknownHandleCache.has(handle)) {
    dlog("unknown_handle_skipped", { handle });
    _unknownHandleCache.set(handle, Date.now());
  }
}

// S3: bounded targeted lookup for unknown handles — one small query instead
// of a full 775-row map per stranger. Case-insensitive exact match (ilike,
// no wildcards) with LIKE-escaping, so mixed-case stored rows resolve exactly
// as the lowercasing full-map build finds them. Last-wins on duplicate
// normalized usernames — same contract as the full build. Throws on transport
// failure: the caller must NOT record absence from a failed lookup.
async function resolveUnknownHandles(userId, handles) {
  const uniq = [...new Set((handles || []).map(h => String(h || "").toLowerCase()).filter(Boolean))].slice(0, 50);
  if (!uniq.length) return new Map();
  const esc = s => String(s).replace(/[\\%_]/g, m => `\\${m}`);
  const orTerm = uniq.map(h => `username.ilike.${esc(h)}`).join(",");
  const rows = await supabaseReq(`contacts?select=id,username&user_id=eq.${userId}&or=(${orTerm})`);
  const map = new Map();
  for (const c of rows || []) {
    map.set(String(c.username || "").toLowerCase(), c.id);
  }
  return map;
}

// S3: transport-failure suppression for the targeted batch (distinct from the
// 30-min absence TTL): a failed lookup retries next pass, but backs off 60s
// so an outage doesn't cost a query per pass per thread.
let _targetedFailAt = 0;

// Module-scope run counter for the hourly sync heartbeat (declared before
// use; alarms fire sequentially so no interleave).
let _uniboxSyncRuns = 0;

async function syncUniboxThreads(data) {
  const ctx = await uniboxResolveContext();
  const threads = data?.threads || {};
  // UNIBOX-OBS: per-run outcome counters. Every filter below used to skip
  // silently, which made missing threads undiagnosable (Sep-09: cristiano's
  // thread never synced, zero trace). The summary at the end names the
  // culprit outright. Runs with zero activity stay silent except every 30th
  // run (~hourly heartbeat) so pure-idle stretches remain visible.
  const _sum = { total: 0, synced: 0, notContact: 0, badShape: 0, group: 0, stale: 0, noId: 0, noTs: 0, emptyMsgs: 0, failed: 0, notContactSample: [] };
  // Late-reconciliation evidence: newest outgoing synced row per contact.
  // Consumed after the loop by reconcileLateDeliveries() — never blocks sync.
  const _lateEvidence = new Map();
  // S3: always read through this accessor — refreshUniboxContactsMap replaces
  // the Map object, so a captured reference goes stale mid-pass.
  const liveMap = () => _uniboxContactsCache.map;
  // S3 pre-pass: resolve unknown handles with ONE bounded batch instead of one
  // full map per stranger. Brand-new handles keep today's immediate full-refresh
  // guarantee (once each); expired misses are rechecked by the batch and
  // re-stamped without another full download. Transport failure records
  // nothing (failure is not absence) and suppresses retry for 60s.
  {
    const _preMiss = new Set(_unknownHandleCache.keys());
    const _need = [];
    for (const [targetUsername] of Object.entries(threads)) {
      const h = String(targetUsername || "").toLowerCase();
      if (h && !liveMap().get(h) && unknownHandleNeedsRefresh(h)) _need.push(h);
    }
    const _uniqNeed = [...new Set(_need)];
    if (_uniqNeed.length && Date.now() - _targetedFailAt > 60000) {
      let _contactsDirty = false;
      try {
        const found = await resolveUnknownHandles(ctx.userId, _uniqNeed);
        const nowMs = Date.now();
        for (const [h, id] of found) { liveMap().set(h, id); noteUnknownHandle(h, true); }
        for (const h of _uniqNeed) {
          if (found.has(h)) { _contactsDirty = true; continue; }
          // Confirmed miss as of this successful lookup: restart the quiet
          // interval (keeping the expired stamp would refresh every pass).
          const isNew = !_preMiss.has(h);
          _unknownHandleCache.delete(h);
          _unknownHandleCache.set(h, nowMs);
          if (isNew) dlog("unknown_handle_skipped", { handle: h });
          _contactsDirty = true;
        }
        dlog("contacts_targeted_resolve", { asked: _uniqNeed.length, found: found.size });
        // Blind-spot escape hatch: handles never seen before that the batch
        // could not resolve (case/RLS surprise) get today's one full refresh,
        // then join the normal miss cycle — never a repeat storm.
        const _brandNew = _uniqNeed.filter(h => !found.has(h) && !_preMiss.has(h));
        if (_brandNew.length) {
          try {
            const fresh = await refreshUniboxContactsMap(ctx.userId, "unknown-handle-new");
            for (const h of _brandNew) {
              const id = fresh.get(h) || null;
              if (id) noteUnknownHandle(h, true);
            }
          } catch (_) { /* miss records above already stand */ }
        }
      } catch (_) {
        _targetedFailAt = Date.now();
      }
      if (_contactsDirty) await persistUniboxContactsCache().catch(() => {});
    }
  }
  for (const [targetUsername, info] of Object.entries(threads)) {
    _sum.total++;
    try {
      const handle = String(targetUsername || "").toLowerCase();
      let contactId = liveMap().get(handle) || null;
      // Resolution ran in the pre-pass above (batch + one fallback refresh).
      // Anything still unknown was recorded this pass — skip quietly.
      if (!contactId) {
        _sum.notContact++;
        if (_sum.notContactSample.length < 3) _sum.notContactSample.push(handle || "(empty)");
        continue;
      }
      if (!info?.thread_key || !Array.isArray(info.messages)) { _sum.badShape++; continue; }

      // group guard (v2 §5.4): >1 distinct non-account sender = group chat
      const participantSenders = new Set(
        info.messages.map(m => String(m.username || "").toLowerCase())
      );
      if (ctx.accountUsername) participantSenders.delete(ctx.accountUsername);
      if (participantSenders.size > 1) { _sum.group++; continue; }

      // watermark: push only messages newer than last successful sync
      const wmKey = `wm:${state.browserId}:${info.thread_key}`;
      const wmData = await chrome.storage.local.get(wmKey);
      const watermark = Number(wmData[wmKey] || 0);

      const seenIds = new Set();
      const fresh = [];
      if (!info.messages.length) { _sum.emptyMsgs++; }
      for (const m of info.messages) {
        const ts = normalizeIgTimestampMs(m.timestampMs);
        if (!ts) { _sum.noTs++; continue; }
        const id = String(m.messageId ?? m.message_id ?? "");
        if (!id) { _sum.noId++; continue; }
        if (seenIds.has(id)) continue;
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
      if (!fresh.length) { _sum.stale++; continue; } // idle thread costs nothing

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
      _sum.synced++;
      debugLog(`[Unibox] synced @${targetUsername}: ${windowed.length} msg(s), wm=${newWm}`);
      try {
        const _own = windowed.filter(w => w && w.is_own && typeof w.text === "string" && w.text.trim());
        if (_own.length) {
          _own.sort((a, b) => a.ts_ms - b.ts_ms);
          const _best = _own[_own.length - 1];
          const _prev = _lateEvidence.get(contactId);
          if (!_prev || Number(_best.ts_ms) > Number(_prev.ts_ms)) {
            _lateEvidence.set(contactId, { handle, thread_key: String(info.thread_key), ts_ms: Number(_best.ts_ms), text: _best.text });
          }
        }
      } catch (_) {}
    } catch (e) {
      // one bad thread must never abort the rest of the dump
      _sum.failed++;
      debugLog(`[Unibox] thread ${targetUsername} failed: ${e.message}`);
    }
  }
  // UNIBOX-OBS summary: log on any activity, plus every 30th run as an
  // hourly heartbeat so pure-idle stretches stay distinguishable from a
  // dead sync loop. _uniboxSyncRuns is module scope (alarms are sequential).
  _uniboxSyncRuns++;
  if (_sum.synced || _sum.failed || _sum.notContact || _sum.badShape || _sum.group || _sum.noId || _sum.noTs || _uniboxSyncRuns % 30 === 0) {
    dlog("unibox_sync_summary", { ..._sum, run: _uniboxSyncRuns });
  }
  // Late reconciliation: flip send_unconfirmed / timeout rows to completed
  // once the inbox proof arrives. Runs only on passes that synced something,
  // never throws (sync outcome is already recorded above).
  if (_lateEvidence.size) {
    await reconcileLateDeliveries(_lateEvidence).catch(() => {});
  }
}

// Late-reconciliation (fail-closed self-heal for the verifier's blind spot).
// Evidence: newest outgoing synced row per contact from THIS pass (Relay text,
// IG timestamp). Candidates: failed/delivery_unknown* rows on THIS browser,
// excluding unibox_reply (owned by pollUniboxReplies). Match requires all of:
//   1. same contact_id (strongest key — never handle/thread strings),
//   2. first-40-char normalized text equality (truncation-safe both sides),
//   3. needle >= 15 chars (never auto-flip on "hi"/"lil"),
//   4. synced ts within [claimed_at - 10min skew, now] (no ancient credit).
// The flip reuses settleLateVerifiedDelivery(), which atomically re-checks
// status=failed + like.delivery_unknown* — races (watchdog, reaper, double
// pass) no-op instead of double-crediting. At most ONE row per contact per
// pass (oldest first); the rest wait for the next pass. NEVER requeues,
// NEVER touches watermarks, NEVER revives non-delivery_unknown failures.
async function reconcileLateDeliveries(evidence) {
  if (!evidence || !evidence.size) return;
  try {
    const rows = await supabaseReq(`dm_tasks?select=id,contact_id,task_type,message_text,claimed_at,created_at&browser_instance_id=eq.${state.browserId}&status=eq.failed&error_reason=like.delivery_unknown*&task_type=neq.unibox_reply&order=claimed_at.asc.nullslast,created_at.asc&limit=20`);
    if (!rows || !rows.length) return;
    const norm = x => String(x ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    const byContact = new Map();
    for (const r of rows) {
      if (!r || !r.contact_id) continue;
      if (!byContact.has(r.contact_id)) byContact.set(r.contact_id, []);
      byContact.get(r.contact_id).push(r);
    }
    for (const [contactId, ev] of evidence) {
      const cands = byContact.get(contactId);
      if (!cands || !cands.length) continue;
      const needle = norm(ev.text).slice(0, 40);
      if (!needle || needle.length < 15) continue;
      const evTs = Number(ev.ts_ms || 0);
      if (!evTs) continue;
      let flipped = false;
      for (const c of cands) {
        if (flipped) break;
        const cNeedle = norm(c.message_text).slice(0, 40);
        if (!cNeedle) continue;
        if (cNeedle !== needle && !norm(ev.text).includes(cNeedle) && !cNeedle.includes(needle)) continue;
        const anchor = c.claimed_at || c.created_at;
        const anchorMs = anchor ? new Date(anchor).getTime() : 0;
        if (anchorMs && evTs < anchorMs - 10 * 60_000) continue;
        if (anchorMs && evTs > Date.now() + 10 * 60_000) continue;
        const ok = await settleLateVerifiedDelivery(c.id).catch(() => false);
        if (ok) {
          flipped = true;
          dlog("late_unibox_reconciled", { taskId: c.id, taskType: c.task_type, target: ev.handle, thread_key: ev.thread_key }, "warn");
        }
      }
    }
  } catch (e) {
    dlog("late_unibox_reconcile_failed", { error: String(e?.message || e).slice(0, 180) }, "warn");
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

    // S7: shared identity map for this pass (seen block fills, replied
    // block consumes — replied ⊆ seen, so one lookup serves both).
    const _idByUser = new Map();
    if (seenUsernames.size > 0) {
      const userList = Array.from(seenUsernames);
      debugLog(`[Collector] Found ${userList.length} contact(s) — ${seenCount} seen, ${replyCount} replied.`);

      // S7: resolve the union ONCE per pass and share it between the seen +
      // replied loops below (replied ⊆ seen). Unmatched receipts skip every
      // write and sit in a short memory TTL; lookup transport failures record
      // nothing and retry next pass. Cancellation predicates unchanged.
      let _unresolved = 0;
      for (let i = 0; i < userList.length; i += 50) {
        const chunk = userList.slice(i, i + 50);
        // Recently-confirmed strangers cost nothing until the TTL expires
        // (a later contact-add re-resolves on expiry).
        const fresh = chunk.filter(u => {
          const miss = _collectorMiss.get(u);
          return !(miss && Date.now() - miss < COLLECTOR_MISS_TTL_MS);
        });
        if (!fresh.length) { _unresolved += chunk.length; continue; }
        const inQuery = fresh.map(u => `"${u}"`).join(",");
        let rows = null;
        try {
          rows = await supabaseReq(`contacts?select=id,username&username=in.(${inQuery})`);
        } catch (e) {
          debugLog(`[Collector] identity lookup failed (non-fatal, retry next pass): ${e.message}`);
          continue;
        }
        const nowMs = Date.now();
        const matched = new Set();
        for (const c of rows || []) {
          const key = String(c.username || "").toLowerCase();
          if (!key) continue;
          matched.add(key);
          if (c.id && !_idByUser.has(key)) _idByUser.set(key, c.id);
        }
        const hit = [];
        for (const u of fresh) {
          if (matched.has(u)) {
            hit.push(u);
            _collectorMiss.delete(u);
          } else {
            _collectorMiss.set(u, nowMs);
            _unresolved++;
          }
        }
        // Seen writes ONLY for matched usernames (same predicates as before).
        if (hit.length) {
          const hitQuery = hit.map(u => `"${u}"`).join(",");
          await supabaseReq(
            `contacts?media_seen=eq.false&username=in.(${hitQuery})`,
            "PATCH",
            { media_seen: true, media_seen_at: new Date().toISOString() }
          );
          // Dual-write per-account seen state. The seen/reply came from THIS
          // browser's logged-in IG account, so it belongs to (contact, thisBrowser).
          // EGRESS-E4: one batched upsert per chunk instead of N single-row calls.
          try {
            const _now = new Date().toISOString();
            await caoUpsertMany(hit.map(u => ({ contactId: _idByUser.get(u), fields: { media_seen: true, media_seen_at: _now } })).filter(e => e.contactId));
          } catch (e) {
            debugLog(`[CAO] seen dual-write failed (non-fatal): ${e.message}`);
          }
        }
      }
      _egressBatch.seen += _idByUser.size;
      _egressBatch.unresolved = (_egressBatch.unresolved || 0) + _unresolved;
    }

    // Leads who replied: proactively cancel their remaining follow-ups so we never
    // DM someone who already responded — the belt-and-suspenders behind the send-time guard.
    if (repliedUsernames.size > 0) {
      const repliedList = Array.from(repliedUsernames);
      for (let i = 0; i < repliedList.length; i += 50) {
        const chunk = repliedList.slice(i, i + 50);
        // S7: shared identity from the seen pass above — no second lookup.
        // Unmatched replied receipts were already counted unresolved there.
        const _ids = chunk.map(u => _idByUser.get(u)).filter(Boolean);
        if (!_ids.length) continue;
        // one batched dual-write, one batched cancel. Same semantics, 3 calls
        // per chunk regardless of chunk size.
        if (_ids.length) {
          const _now = new Date().toISOString();
          try {
            await supabaseReq(`contacts?id=in.(${_ids.join(",")})`, "PATCH",
              { replied: true, replied_at: _now });
          } catch (e) { debugLog(`[Replied] global persist failed (non-fatal): ${e.message}`); }
          await caoUpsertMany(_ids.map(id => ({ contactId: id, fields: { replied: true, replied_at: _now } })));
          _egressBatch.canceled += await cancelPendingFollowupsMany(_ids, "lead_replied");
        }
        _egressBatch.replied += _ids.length;
      }
    }
    // EGRESS-LOG: per-run batch summary — in a bundle this line replaces N
    // per-contact write logs. Zero-activity runs stay silent (no spam).
    // S7: seen/replied count RESOLVED identities now (inputs that match
    // nobody land in unresolved instead of inflating seen).
    if (_egressBatch.seen || _egressBatch.replied || _egressBatch.canceled || _egressBatch.unresolved) {
      dlog("collector_batch", { ..._egressBatch });
      _egressBatch.seen = 0; _egressBatch.replied = 0; _egressBatch.canceled = 0; _egressBatch.unresolved = 0;
    }
  } catch (err) {
    debugLog(`[Collector] Error processing collected messages: ${err.message}`);
  }
}

// Cancel any still-pending follow-up tasks for a batch of contacts.
// EGRESS-E4 companion to cancelPendingFollowups: one IN() PATCH per call
// instead of one per contact. Same pending-only + browser-scoped semantics;
// representation kept (E0 opt-out) because the length is the cancel count.
async function cancelPendingFollowupsMany(contactIds, reason) {
  if (!contactIds?.length) return 0;
  try {
    const browserFilter = state.browserId ? `&browser_instance_id=eq.${state.browserId}` : "";
    const cancelled = await supabaseReq(
      `dm_tasks?contact_id=in.(${contactIds.join(",")})&status=eq.pending&task_type=like.followup_*${browserFilter}`,
      "PATCH",
      { status: "skipped", error_reason: reason },
      false,
      { representation: true, select: "id" }
    );
    const count = Array.isArray(cancelled) ? cancelled.length : 0;
    if (count > 0) {
      debugLog(`[Collector] Cancelled ${count} pending follow-up(s) for ${contactIds.length} contact(s) (${reason}).`);
    }
    return count;
  } catch (err) {
    debugLog(`[Collector] Error batch-cancelling follow-ups: ${err.message}`);
    return 0;
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
      { status: "skipped", error_reason: reason },
      false,
      { representation: true, select: "id" } // EGRESS-E0 opt-out: length is the cancel count.
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

// CHURN-04: retire every still-pending task for a contact we just parked as
// unreachable.
//
// Why this is needed at all: parking sets contacts.status = 'unreachable', and
// api/_scheduler-engine.ts only ever builds candidates from
//   new DMs   -> status IN ('not_started','followed') AND dmed_at IS NULL
//   followups -> status = 'dmed' AND NOT replied
// so the park does correctly stop *future* generation for that contact. What it
// cannot do is reach backwards: rows the scheduler already wrote as 'pending' on
// an earlier cycle survive the park and get claimed on a later poll, so a handle
// we have already proven dead comes back around and fails a second time. That is
// the repeat-failure the user sees in the dashboard.
//
// Unlike cancelPendingFollowups this is deliberately NOT scoped by
// browser_instance_id: unreachable is a property of the lead, not of the account
// that discovered it, and the park it accompanies is user-wide too. RLS keeps the
// blast radius inside the owner's own rows. 'processing' is left alone so we never
// yank a task out from under an in-flight send.
async function retirePendingTasksForContact(contactId, reason) {
  if (!contactId) return;
  // S2: minimal write — the affected-row count is unknowable from a minimal
  // response, and the caller ignores the return value, so report nothing
  // rather than a fiction. Fire-and-forget by contract.
  try {
    await supabaseReq(
      `dm_tasks?contact_id=eq.${contactId}&status=eq.pending`,
      "PATCH",
      { status: "skipped", error_reason: reason }
    );
  } catch (err) {
    debugLog(`[Collector] Error retiring queued tasks for contact ${contactId}: ${err.message}`);
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
  // EGRESS-E3: TTL 6h (was 5 min). Fail-open unchanged — a stale window only
  // risks running outside hours, never stalling (clamp sleeps, never blocks).
  if (!force && _workHoursCache && Date.now() - _workHoursCache.fetchedAt < EGRESS.hoursTtlMs) {
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
    // EGRESS-LOG: ttl marker makes the 6h cadence visible in bundles
    // (account_hours_loaded should appear ~4/day, not ~288/day).
    dlog("account_hours_loaded", { start: value.start, end: value.end, tz: value.tz, ttl: "6h" });
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

// `enginePaused` has exactly one author: the user's popup toggle. It is STICKY —
// it means "stop", and only the user may undo it.
//
// ColdDMs parity note: upstream has NO rate-limit pausing at all. Its isLimited
// flag is written to the task row on the server (Colddms Latest/background.js:5895,
// :6065) and nothing client-side ever pauses the engine over it. Every cooldown
// mechanism here was our own invention (PACING-01/THROTTLE-*), and on this account
// the only thing that ever triggered it was the profile API we already removed
// (5 calls, 5 x 429, 0 verdicts) — a 30-minute outage per unfindable handle, self
// inflicted. Removed: pauseEngineForCooldown, enginePausedUntil, the auto-resume,
// and both call sites. is_limited is still recorded on the task row exactly as
// upstream records it, so the data survives; only the pausing is gone.
async function isEnginePaused(prefetched) {
  const data = prefetched || await chrome.storage.local.get('enginePaused');
  return !!data.enginePaused;
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

// ---------------------------------------------------------------------------
// Orphan reconciliation (B1): a MV3 restart mid-claim leaves a `processing`
// row with no live worker. Fresh worker boots isProcessing=false so it can
// never enter the 16-min lock-recovery branch; settle the orphan fail-closed
// once per worker lifetime before any new claim. NEVER requeue (duplicate-DM
// doctrine). Late verification flips delivery_unknown back via settleLateVerifiedDelivery.
// ---------------------------------------------------------------------------
let _reconciledOnce = false;
async function reconcileInFlightTask() {
  if (_reconciledOnce) return; _reconciledOnce = true;
  try {
    const { inFlightTaskId } = await chrome.storage.local.get('inFlightTaskId');
    if (!inFlightTaskId) return;
    const rows = await supabaseReq(`dm_tasks?select=id,status,browser_instance_id,task_type&id=eq.${inFlightTaskId}`);
    const row = rows?.[0];
    if (!row || row.status !== 'processing' || row.browser_instance_id !== state.browserId) {
      await chrome.storage.local.remove('inFlightTaskId').catch(() => {});
      return;
    }
    await supabaseReq(`dm_tasks?id=eq.${inFlightTaskId}&status=eq.processing`, 'PATCH', {
      status: 'failed',
      error_reason: 'delivery_unknown: the extension restarted during this send, so we can\'t tell whether the message went out. We won\'t retry it, so this lead can\'t receive the same DM twice — if it did land, this turns back into a completed send on its own.'
    });
    await chrome.storage.local.remove('inFlightTaskId').catch(() => {});
    dlog('orphan_reconciled', { taskId: inFlightTaskId, taskType: row.task_type }, 'warn');
  } catch (e) {
    dlog('orphan_reconcile_failed', { error: String(e?.message || e).slice(0, 200) }, 'warn');
  }
}

async function pollTasks() {
  if (!state.browserId) return;
  await reconcileInFlightTask().catch(() => {});
  const pacingData = await chrome.storage.local.get('wakeUpAt');
  if (pacingData.wakeUpAt && Date.now() < pacingData.wakeUpAt) {
    return; // Still sleeping until next scheduled task
  }

  if (state.isProcessing) {
    if (Date.now() - state.processingLockAcquiredAt > 960000) { // 16 min: just above the 15-min task timeout
      // E-01 Part 2 FIX: before recovering, check whether the content script is
      // still legitimately busy (a real 45-60 min task). If it is, extend the
      // lock instead of claiming a new task into a still-busy tab.
      const inFlightData = await chrome.storage.local.get('inFlightTaskId');
      if (inFlightData.inFlightTaskId) {
        const pingRes = await sendToContentLite('main', 'ping', {}).catch(() => null);
        if (pingRes) {
          // Content script alive and working — extend the lock, don't steal it.
          state.processingLockAcquiredAt = Date.now();
          dlog("lock_extended_busy_guard", { inFlightTaskId: inFlightData.inFlightTaskId }, "warn");
          debugLog(`[System] Lock recovery skipped — content script is still busy with task ${inFlightData.inFlightTaskId}. Extending lock.`);
          return;
        }
      }
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
    // Check if the engine is paused by the user. The only author of this flag is
    // the popup toggle — rate-limit cooldowns were removed for ColdDMs parity.
    const pauseData = await chrome.storage.local.get('enginePaused');
    if (await isEnginePaused(pauseData)) {
      debugLog(`[Poll] Engine paused by user, skipping.`);
      return;
    }

    // 1. Fetch a pending task that is due now (scheduled_at <= now OR scheduled_at IS NULL)
    // NULL scheduled_at = old task generated before centralized pacing = "due now"
    // Campaign embed carries the hours this specific task must obey (per-campaign clamp).
    // EGRESS-E1: narrowed columns — audited against every task.* read downstream
    // (executeTask, claim log, scrape params). Tripwire below refetches select=*
    // if a column ever goes missing, so narrowing can never silently break sends.
    const nowIso = new Date().toISOString();
    const url = `dm_tasks?select=${EGRESS.pollCols},campaigns!inner(id,status,working_hours_enabled,work_start_hour,work_end_hour)&browser_instance_id=eq.${state.browserId}&status=eq.pending&campaigns.status=eq.active&or=(scheduled_at.is.null,scheduled_at.lte.${nowIso})&order=scheduled_at.asc.nullslast,created_at.asc&limit=1`;
    let tasks = await supabaseReq(url);

    if (tasks && tasks.length > 0 && !narrowGuard(tasks[0], EGRESS.pollCols.split(","), "poll_narrow_missing_col")) {
      tasks = await supabaseReq(`dm_tasks?select=*,campaigns!inner(id,status,working_hours_enabled,work_start_hour,work_end_hour)&browser_instance_id=eq.${state.browserId}&status=eq.pending&campaigns.status=eq.active&or=(scheduled_at.is.null,scheduled_at.lte.${nowIso})&order=scheduled_at.asc.nullslast,created_at.asc&limit=1`);
    }

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
      // ANCHOR: dmed_at/last_follow_up_at feed replyCheckSinceFor below (2
      // tiny cols on an already-narrow single-row fetch — negligible egress).
      const contacts = await supabaseReq(`contacts?select=username,full_name,dmed_at,last_follow_up_at&id=eq.${task.contact_id}`);
      if (contacts && contacts.length > 0) {
        task.contacts = contacts[0];
      }
    }

    // FIX-DBLCLAIM: conditional claim (atomic test-and-set). The Sep-08 bundle
    // shows the same task claimed twice 1s apart: two overlapping poll runs
    // both fetched it as pending, and the old unconditional PATCH let both
    // succeed — risking a double-DM. With &status=eq.pending, the loser gets
    // zero rows and walks away. Same pattern as the unibox claim below.
    // Representation opt-out required: claimed?.length IS the lock proof.
    const claimedTask = await supabaseReq(`dm_tasks?id=eq.${task.id}&status=eq.pending`, "PATCH", { status: "processing", claimed_at: new Date().toISOString() }, false, { representation: true, select: "id" });
    if (!claimedTask?.length) {
      dlog("claim_lost_race", { taskId: task.id, taskType: task.task_type }, "warn");
      return;
    }
    // E-01 Part 2 FIX: persist the in-flight task ID so a revived worker can
    // check whether a task is still running before stealing the lock.
    await chrome.storage.local.set({ inFlightTaskId: task.id });

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

      // ColdDMs parity: isLimited is recorded on the task row (executeTask's
      // success payloads carry is_limited) and nothing pauses over it — the
      // engine keeps running exactly as upstream does.
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
      // TEARDOWN-01: two different questions are being asked here, and folding them
      // into one variable is what broke the teardown ladder in v1.4.5.
      //
      //   retryClass — the DECISION key, and always the ExtensionError type. Every
      //     consumer downstream compares it against CLASS names: the ladder's
      //     user_is_unreachable exemption (:1680), isDeliveryUnknown (:1662),
      //     isPermanentError, RETRY_CEILING, and TAB_HEALTHY_FAILURE_CLASSES. The
      //     old order (`err.unreachableType || err.errorType`) let Instagram's raw
      //     enum shadow the class, so on a genuinely unreachable lead retryClass was
      //     "UNREACHABLE_USER_TYPE" and not one of those five comparisons could
      //     match — the tab was destroyed and three attempts were burned on a lead
      //     that had already said no. Upstream ColdDMs keeps the two in separate
      //     parameters and tests only errorType (Colddms Latest/background.js:6214);
      //     this restores that separation.
      //   copyClass — the PROSE key, and nothing else. TASK_FAILURE_COPY carries
      //     per-enum customer sentences that the generic class name would flatten,
      //     so the sentence still prefers the enum. It decides no control flow.
      //
      // THROTTLE-02: normalise the name BEFORE either lane reads it. dom.js types a
      // 429 as "rate_limited" and background has only ever tested for
      // "rate_limited_error", and there are four separate content.js routes that can
      // surface a throttled profile lookup (:653 checkResponse, :830 and :1482 on the
      // send path, :1535 the dead-handle tiebreak). Fixing them one call site at a
      // time is how a route gets missed, so the mapping lives here at the single
      // point where every failure class is turned into a decision.
      const errorTypeRaw = err.errorType || null;
      const errorTypeClass = FAILURE_CLASS_ALIASES[errorTypeRaw] || errorTypeRaw;
      const retryClass = errorTypeClass || err.unreachableType || null;
      const copyClass = err.unreachableType || errorTypeClass || null;
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

      // F-BUSY-02: ColdDMs' teardown ladder, ported from its background.js:6214, and
      // deliberately hoisted ABOVE the branch chain so no failure class can slip past
      // it. The old code only navigated the main tab to the inbox, and only for five
      // dialog classes — every other failure left the content script alive with its
      // in-memory isBusy possibly still set, which is what the next task collided
      // with. Upstream destroys the tab on EVERY error except user_is_unreachable,
      // because a destroyed content script cannot stay busy.
      //   user_is_unreachable    -> leave the tab alone (expected outcome, tab is fine)
      //   rate_limited_error     -> leave the tab alone (see TEARDOWN-02 below)
      //   instagram_reload_error -> reload up to twice, then close (upstream's cap)
      //   anything else          -> close; next openTab creates a fresh pinned tab
      //
      // TEARDOWN-02: rate_limited_error joins the exemption because the doctrine is
      // "close means the tab is sick". A 429 says nothing about the tab — the tab is
      // healthy and Instagram is simply telling us to slow down. Closing it would
      // make the next resume open a brand-new tab and pull a full Instagram page
      // load moments after we were throttled, which is the opposite of what a
      // pacing failure asks for. The engine pauses below instead.
      if (TAB_HEALTHY_FAILURE_CLASSES.has(retryClass)) {
        // Upstream's exemption: nothing about the tab is suspect here.
        dlog("teardown_decision", { tier: "exempt", retryClass, errorType: err.errorType || null, tabId: state.mainTabId || null });
      } else if (retryClass === "instagram_reload_error") {
        const rc = Number((await chrome.storage.local.get('reloadCounter')).reloadCounter || 0);
        let reloaded = false;
        if (rc < 2 && state.mainTabId) {
          reloaded = await chrome.tabs.reload(state.mainTabId, { bypassCache: true })
            .then(() => true).catch(() => false);
        }
        if (reloaded) {
          await chrome.storage.local.set({ reloadCounter: rc + 1 });
          dlog("teardown_decision", { tier: "reload", retryClass, errorType: err.errorType || null, tabId: state.mainTabId || null, reloadCounter: rc + 1 });
          dlog("tab_reloaded_after_failure", { tabId: state.mainTabId, retryClass, reloadCounter: rc + 1 }, "warn");
        } else {
          dlog("teardown_decision", { tier: "close", retryClass, errorType: err.errorType || null, tabId: state.mainTabId || null, reloadCounter: rc, cause: "reload_cap_or_no_tab" });
          await closeMainTab(`instagram_reload_error after ${rc} reload attempts`);
          await chrome.storage.local.set({ reloadCounter: 0 });
        }
      } else {
        dlog("teardown_decision", { tier: "close", retryClass, errorType: err.errorType || null, unreachableType: err.unreachableType || null, tabId: state.mainTabId || null, cause: "unclassified" });
        await closeMainTab(retryClass || "unclassified task failure");
      }

      if (isDeliveryUnknown) {
        await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
          status: "failed",
          // CHURN-02: the `delivery_unknown:` prefix is load-bearing and must stay
          // byte-for-byte — settleLateVerifiedDelivery() finds these rows with
          // error_reason=like.delivery_unknown* and flips them to completed once the
          // send is verified, and rows already in the DB carry the same prefix. Only
          // the tail is now human-readable. (The web app should strip the prefix
          // before display; until it does, the sentence still reads correctly after it.)
          error_reason: "delivery_unknown: We clicked Send but Instagram never confirmed the message went out. We won't retry it, so this lead can't receive the same DM twice — if it did land, this turns back into a completed send on its own."
        });
        state.stats.failed++;
        debugLog(`[Safety] Task ${task.id} reached an unknown delivery state; it will not be auto-retried.`);
        dlog("task_delivery_unknown", { taskId: task.id, taskType: task.task_type, retryClass }, "warn");
      } else if (isThreadBusy) {
        // BUSY-REQUEUE-01: this used to PATCH only {status:"pending"} — no
        // retry_count — so a wedged tab (isBusy stuck true) produced an
        // INFINITE requeue loop: the 2026-09-03 bundle shows two tasks
        // ping-ponging claimed→busy→requeued for 12+ hours, every claim
        // reporting retryCount:0. Now the attempt is counted, the backoff
        // doubles (60s→2m→4m→8m→15m), and after 5 the task fails as
        // transient_busy instead of looping forever. Busy means another task
        // may be LIVE in that tab — the teardown ladder never closes on it —
        // so a bounded wait is the only safe response.
        const busyAttempts = Number(task.retry_count || 0) + 1;
        if (busyAttempts > 5) {
          await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
            status: "failed",
            error_reason: "The Instagram tab stayed busy with another send for over 20 minutes, so this send was stopped. Nothing was sent — the lead stays in your queue for the next run."
          });
          state.stats.failed++;
          debugLog(`[Recovery] Task ${task.id} re-queued as busy 5 times — giving up.`);
          dlog("task_busy_gave_up", { taskId: task.id, taskType: task.task_type }, "warn");
        } else {
          const busyBackoffMs = Math.min(60_000 * 2 ** (busyAttempts - 1), 15 * 60_000);
          await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
            status: "pending",
            retry_count: busyAttempts,
            error_reason: `The Instagram tab was busy with another send, so this one is waiting ${Math.round(busyBackoffMs / 60000)} min before trying again.`
          });
          debugLog(`[Recovery] Task ${task.task_type} re-queued as pending (thread was busy, attempt ${busyAttempts}/5) — backing off ${Math.round(busyBackoffMs / 60000)} s`);
          dlog("task_requeued_busy", { taskId: task.id, attempt: busyAttempts, backoffMs: busyBackoffMs }, "warn");
          await setWake('busy_backoff', Date.now() + busyBackoffMs);
        }
      } else {
        const isPermanentError = [
          "user_is_unreachable",
          "user_not_found",
          "cannot_message_user",
          "account_disabled",
          "rate_limited_error"
        ].includes(retryClass);

        const currentRetries = Number(task.retry_count || 0);

        // P7: per-class retry ceiling. Default is 1 (initial + one retry):
        // the 2nd/3rd generic retries almost never rescued anything — by then
        // the tab is genuinely sick — and each re-fire is a fresh page load +
        // search burst for zero payoff. Failed leads come back tomorrow via
        // normal regeneration, which is the real retry. The dialog attempt
        // itself is byte-identical to ColdDMs' _openUser (2 typed tries, 10
        // result polls each, then user_click_error) — the DELTA from ColdDMs
        // was the fresh-tab retry for the search_missing_* classes, and the
        // 09-05 log shows what it bought on mrsclaudiaserra: a second tab,
        // ~84s more dialog polling, the same zero results. ColdDMs fails the
        // task and lets the backend decide; our equivalent is fail + same-day
        // retire + tomorrow's scheduler cycle, which is the retry. So:
        //   • search_missing_alive keeps 1 fresh-tab retry — the profile API
        //     positively resolved the account, so index lag is plausible and
        //     the lead is never parked.
        //   • search_missing_unproven gets 0 — nothing was proven either way,
        //     a second blind search added no information, and the lead still
        //     comes back tomorrow via normal regeneration. "Try the username,
        //     then make them fuck off" — one clean attempt, no tab drama.
        // A dead handle (user_not_found) is permanent and never retries.
        const RETRY_CEILING = { search_missing_alive: 1, search_missing_unproven: 0 };
        const maxRetries = RETRY_CEILING[retryClass] ?? 1;

        // E-04/P5 note: the old inbox-freshen block that lived here only covered
        // five dialog classes and only navigated the tab. It is superseded by the
        // F-BUSY-02 teardown ladder hoisted above the branch chain, which now runs
        // for every failure class (see the comment there for the upstream rule).

        if (!isPermanentError && currentRetries < maxRetries) {
          const nextRetry = currentRetries + 1;
          debugLog(`[Retry Engine] ${retryClass ? `[${retryClass}] ` : ""}Transient error on task ${task.id} (${err.message}). Retrying (${nextRetry}/${maxRetries})...`);

          await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
            status: "pending",
            retry_count: nextRetry,
            // CHURN-02: was `[Attempt 1/3] <raw bridge message>`. The raw message is
            // still captured in the local diagnostics ring (dlog task_failed above),
            // which is where we debug from; the DB column is what the customer reads.
            error_reason: failureCopy(copyClass, { willRetry: true, attempt: nextRetry, maxRetries })
          });

          const wakeUpAt = Date.now() + 30000;
          await setWake('retry', wakeUpAt);
          dlog("task_retry_scheduled", { taskId: task.id, attempt: nextRetry, retryClass, backoffMs: 30000, maxRetries }, "warn");
        } else {
          // CHURN-03: decide the bucket first, because the copy depends on it —
          // when the class is recorded in unreachable_type, Actions.tsx already
          // prints it as its own "Type:" line and the sentence stays clean.
          const recordedType = unreachableTypeFor(err, retryClass);
          await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
            status: "failed",
            error_reason: failureCopy(copyClass, {
              attempt: currentRetries + 1,
              maxRetries,
              exhausted: currentRetries >= maxRetries,
              typeRecorded: !!recordedType
            }),
            unreachable_type: recordedType
          });

          // rate_limited_error deliberately falls through to the generic
          // else-if chain now: it is in isPermanentError (task row already
          // failed above with its own copy), the tab is exempt (TAB_HEALTHY_
          // FAILURE_CLASSES), and ColdDMs parity says a rate limit never
          // parks a lead and never pauses the engine — isLimited is only
          // ever recorded on the row, exactly as upstream does
          // (Colddms Latest/background.js:5895, :6065). The profile API that
          // produced every recorded 429 here is gone anyway (P9).
          if ((recordedType || retryClass === "search_missing_unproven") && task.contact_id) {
            // CHURN-05: the park and the retire are two different decisions now,
            // because their blast radii are nothing alike.
            //
            // CHURN-06: this condition reads `recordedType` — the value persisted to
            // the row above — instead of the raw `err.unreachableType` it used to
            // test. The two disagree in exactly one case, and that case is live:
            // when the borrowed enum lookup finds nothing, content.js:1112 emits
            // `unreachableType: undefined`, so the raw field is empty while
            // unreachableTypeFor() still resolves the class itself and stamps
            // unreachable_type = 'user_is_unreachable' on the task. The old test then
            // concluded there was nothing to clean up, on a row it had just labelled
            // unreachable. Reading the value we saved makes the record and the
            // cleanup agree. It cannot widen the park — that is nested under
            // retryClass === 'user_not_found' below — only the same-day retire.
            //
            // PARK (contacts.status = 'unreachable') is a one-way door. The
            // scheduler builds both candidate sets from contacts.status, both
            // cross-account RPCs filter on `c.status <> 'unreachable'`, and no UI
            // surface writes the status back — Actions.tsx's removeDmTask needs a
            // live task row, which a parked lead by definition never has. So it
            // now fires on user_not_found ONLY. Three things in dom.js produce that
            // class, and each is terminal on its own terms:
            //   • dom.js:930 — the handle fails IG's own charset ^[A-Za-z0-9._]+$.
            //     No network involved; the handle cannot exist as typed.
            //   • dom.js:947 — HTTP 404 from /api/v1/users/web_profile_info/.
            //     Proof from the server.
            //   • dom.js:961-979 — HTTP 200, an envelope shape we RECOGNISE, and an
            //     empty user slot. An unrecognised envelope deliberately falls back
            //     to the non-terminal profile_lookup_failed instead (P6 SAFETY),
            //     which is what makes narrowing the park onto this class safe.
            //
            // Deliberately no longer parking on:
            //   • err.unreachableType — the 12 names it can carry are read out of
            //     a borrowed numeric enum table (content.js:937-948) that we did
            //     not write, cannot verify, and now know to be incomplete: a live
            //     Relay dump shows a thread-level reachability_status of
            //     UNREACHABLE_INVITE_LIMIT_REACHED, which appears nowhere in that
            //     table. Worse, some names it does carry describe OUR account
            //     rather than the lead — UNREACHABLE_MR_LIMIT_BLOCK is our own
            //     message-request cap. Retiring a live lead forever because we hit
            //     a cap is the worst outcome on the table. The value is still
            //     recorded on the task row above, where it is diagnostics rather
            //     than a verdict.
            //   • search_missing_unproven — IG's DM search came back empty on two
            //     fresh tabs, and since P9 nothing else is consulted afterwards. So
            //     this is absence of evidence off the flakiest surface we read:
            //     strong, but never proof. It still clears today's queue below; it
            //     no longer discards the lead.
            //   • search_missing_alive stays excluded as before. A current content
            //     script can no longer throw it — P9 removed the profile-API
            //     tiebreak that produced it — but a tab still running the pre-P9
            //     script can until it reloads, and there the API positively
            //     resolved the account, so the index is what is stale.
            if (retryClass === "user_not_found") {
              // Best-effort. contacts.status is CHECK-constrained server-side and
              // contacts_status_check does not list 'unreachable' until the
              // widening migration runs, so this PATCH can 400. The retire below
              // is what actually keeps the dead lead out of the queue and must not
              // be skipped because the park was refused.
              try {
                await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
                  status: "unreachable"
                });
              } catch (parkErr) {
                dlog("contact_park_failed", { contactId: task.contact_id, retryClass, reason: parkErr?.message }, "warn");
                debugLog(`[Collector] Could not park contact ${task.contact_id} as unreachable: ${parkErr?.message}. Retiring its queued tasks anyway.`);
              }
            }

            // CHURN-04: the park above only stops the *next* generation cycle.
            // api/_scheduler-engine.ts builds candidates from contacts.status, so an
            // unreachable contact is excluded from both the new-DM and follow-up
            // candidate sets — but rows it already wrote as 'pending' on an earlier
            // cycle are untouched by that and get claimed on a later poll, so the
            // handle we just proved dead comes back around and fails again. Retiring
            // them here, in the same beat as the park, is what actually keeps a bad
            // lead out of the queue.
            //
            // It still runs for every class in the branch condition, parked or not.
            // For an unparked lead that makes it a same-day measure: it clears the
            // rows already queued for today so one bad handle cannot be hammered
            // all day, and tomorrow's cycle regenerates normally because the
            // contact's status was never touched. The copy has to say which of the
            // two happened, or the customer reads "set aside" on a lead that walks
            // straight back into the queue.
            await retirePendingTasksForContact(
              task.contact_id,
              retryClass === "user_not_found"
                ? "Skipped — this lead was set aside because Instagram can't deliver to their account."
                : "Skipped — Instagram wouldn't deliver to this lead on this attempt, so we cleared their remaining sends for today. They stay in the campaign and we'll try again on the next run."
            );
          }

          state.stats.failed++;
          debugLog(`Task Permanently Failed: ${err.message} ${retryClass ? `[${retryClass}]` : ''}`);
        }
      }
    } finally {
      // E-01 Part 2 FIX: always clear the in-flight task ID on both success and
      // error paths so the lock-recovery busy guard doesn't block on a finished task.
      await chrome.storage.local.remove('inFlightTaskId').catch(() => {});
      // F-LOCK-01: drop the settler on every path. This is the only place that is
      // guaranteed to run once per claimed task, so it is the only safe place to
      // unregister — leaving it behind would let a later watchdog reject a promise
      // that has already settled.
      delete state.taskSettlers[task.id];
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
// Lead name resolution (server-side first)
// ---------------------------------------------------------------------------

// ANCHOR: last outbound timestamp for reply checks (ms epoch) or null.
// checkResponseByReactAPI filters inbound to timestampMs > sinceMs, so a
// historic reply can never count as fresh. max() of both send markers;
// never-contacted leads (no dates) correctly yield null — there is no prior
// send to anchor against, and the WARNING path handles that visibly.
// Pure function of the contact row: safe to call on any payload path.
function replyCheckSinceFor(contact) {
  const t = Math.max(
    contact?.dmed_at ? new Date(contact.dmed_at).getTime() : 0,
    contact?.last_follow_up_at ? new Date(contact.last_follow_up_at).getTime() : 0
  );
  return Number.isFinite(t) && t > 0 ? t : null;
}

// N1: return contacts.full_name only when it holds a REAL name, never a
// placeholder. Importers and the unibox sync both write the username into
// full_name when they have nothing better, and some rows carry "@handle" or a
// blank string. Handing any of those to the content script as a name would make
// it skip the live Instagram lookup and greet the lead with their own handle.
// Mirrors the isPlaceholder test the full_name write-back already applies.
function usableFullName(contact) {
  const full = String(contact?.full_name ?? "").trim();
  if (!full) return null;
  const handle = String(contact?.username ?? "").replace(/^@+/, "").trim().toLowerCase();
  const bare = full.replace(/^@+/, "").trim().toLowerCase();
  if (handle && bare === handle) return null;
  return full;
}

// CHURN-06: persist a live-resolved real name so later sends take the fast
// server-side path (usableFullName -> payload target.fullName) instead of
// re-scraping through getUserByUsername, which is the flakiest call on the send
// path. Only ever overwrites a username-placeholder — never a real name and never
// a manual override the user typed.
//
// Shared deliberately: this used to be inline in the first_dm success handler
// only, so a lead first reached by a follow-up kept re-scraping forever even
// though content.js had already emitted resolvedFullName on that route too. One
// copy called from both handlers is what stops the two routes drifting again.
async function persistResolvedFullName(task, resolvedFullName) {
  if (!resolvedFullName || !task?.contact_id) return false;
  try {
    const storedFull = (task.contacts?.full_name || "").replace(/^@+/, "").trim();
    const storedUser = (task.contacts?.username || "").replace(/^@/, "").trim().toLowerCase();
    const isPlaceholder = !storedFull || storedFull.toLowerCase() === storedUser;
    const newFull = String(resolvedFullName).trim();
    if (!isPlaceholder || !newFull || newFull.toLowerCase() === storedFull.toLowerCase()) return false;
    await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", { full_name: newFull });
    debugLog(`[Name] Persisted live-resolved full_name for ${task.contact_id}: "${newFull}"`);
    return true;
  } catch (e) {
    // Non-fatal: resolution still worked, only the write-back failed.
    debugLog(`[Name] Write-back skipped for ${task.contact_id}: ${e?.toString()}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// CHURN-02 / CHURN-03 — customer-facing task failure labelling
//
// error_reason is read by paying users, not by us: the web app prints it
// verbatim inside a red "Error" panel (src/pages/Actions.tsx) and in the support
// view (Admin.tsx). A raw bridge message ("user_click_error: no result matched")
// therefore reads as a product defect and is exactly what makes people cancel,
// even when what actually happened was a dead lead.
//
// IMPORTANT: the keys below are NOT new vocabulary. Every one is a type string
// that already exists in this codebase. The 12 UNREACHABLE_*/REACHABLE_* keys
// are Instagram's own reachability enum, inherited verbatim from upstream
// ColdDMs (identical names and indices, assets/content.js:936). The remaining
// keys are the ExtensionError `type` values that dom.js and content.js already
// throw. Nothing here invents, renames or aliases a type — this is purely a
// display layer over the existing ones, and any class that is missing from the
// map falls through to the generic copy rather than leaking a raw message.
const TASK_FAILURE_COPY = {
  // --- Instagram reachability enum (upstream ColdDMs vocabulary, verbatim) ---
  UNREACHABLE_USER_TYPE: "Instagram doesn't allow message requests to this kind of account. Nothing was sent.",
  UNREACHABLE_ADULT_TYPE: "Instagram blocked the message request to this account. Nothing was sent.",
  UNREACHABLE_INVITE_BLOCK: "Instagram wouldn't let a message request reach this account. Nothing was sent.",
  UNREACHABLE_MR_LIMIT_BLOCK: "Instagram is refusing new message requests on this route right now. Nothing was sent.",
  UNREACHABLE_RS_UPSELL_ELIGIBLE: "Instagram won't deliver a message request to this account. Nothing was sent.",
  UNREACHABLE_INTEROP_THIRD_PARTY_USER: "This is a Messenger or WhatsApp account, so it can't receive Instagram DMs. Nothing was sent.",
  UNREACHABLE_INTEROP_USER_OPT_OUT: "This account has opted out of receiving messages from Instagram. Nothing was sent.",
  UNREACHABLE_INTEROP_THIRD_PARTY_APP_NOT_SUPPORTED: "This account is on an app that can't receive Instagram DMs. Nothing was sent.",
  UNREACHABLE_INTEROP_USER_REMOVED_THIRD_PARTY_APP: "This account removed the app it used to receive messages on. Nothing was sent.",
  UNREACHABLE_NULL_INTEROP_USER: "Instagram can no longer find a messaging inbox for this account. Nothing was sent.",
  // --- ExtensionError types thrown by content.js / dom.js ---
  user_not_found: "This Instagram handle no longer exists — the account was deleted, renamed or deactivated. Nothing was sent.",
  user_is_unreachable: "Instagram won't deliver a message request to this account. Nothing was sent.",
  banned_error: "Instagram has restricted your account's messaging, so we stopped to keep it safe. Nothing was sent — try again once the restriction lifts.",
  rate_limited_error: "Instagram rate-limited your account, so we stopped to keep it safe. Nothing was sent — this lead stays in the queue.",
  search_missing_alive: "This account exists but didn't come up in Instagram's DM search, so we couldn't open the chat. Nothing was sent — the lead stays in your queue.",
  search_missing_unproven: "Instagram's DM search couldn't find this handle, so we couldn't open the chat. Nothing was sent — the lead stays in your queue.",
  thread_not_found: "Instagram didn't return the conversation for this lead, so we couldn't read or continue it. Nothing was sent.",
  thread_busy: "Another send was already in progress in this conversation, so we skipped this one to avoid a duplicate DM.",
  composer_empty_error: "Instagram cleared the message box before we could send, so nothing went out.",
  send_unconfirmed_error: "We couldn't confirm Instagram accepted the message, so we stopped instead of risking a duplicate.",
  user_search_error: "Instagram's DM search didn't respond, so we couldn't open the chat. Nothing was sent.",
  user_click_error: "Instagram's DM search returned results but wouldn't open this lead's chat. Nothing was sent.",
  open_search_popup_error: "Instagram's new-message window wouldn't open, so nothing was sent.",
  open_direct_page_error: "Instagram's inbox wouldn't load, so nothing was sent.",
  react_bridge_timeout: "Instagram's page stopped responding mid-send, so we stopped. Nothing was sent.",
  instagram_reload_error: "Instagram's tab had to be reloaded mid-send, so we stopped. Nothing was sent.",
  additional_tab_error: "The background Instagram tab we send from wouldn't start, so nothing was sent.",
  collect_messages_error: "We couldn't read this conversation's messages from Instagram."
};
const GENERIC_RETRY_COPY = "Instagram didn't complete this send.";
const GENERIC_GIVEUP_COPY = "Instagram didn't complete this send. Nothing was sent — the lead stays in your queue.";

// Turn a retryClass into the sentence the account owner reads. `typeRecorded`
// says whether the class is also being written to dm_tasks.unreachable_type;
// Actions.tsx renders that column as its own "Type:" line, so the reference code
// is appended only when this string is support's only breadcrumb.
function failureCopy(retryClass, { willRetry = false, attempt = 0, maxRetries = 0, exhausted = false, typeRecorded = false } = {}) {
  const mapped = TASK_FAILURE_COPY[retryClass] || null;
  if (willRetry) {
    return `${mapped || GENERIC_RETRY_COPY} Retrying automatically (attempt ${attempt} of ${maxRetries}).`;
  }
  const base = mapped || GENERIC_GIVEUP_COPY;
  const tried = exhausted && attempt > 1 ? ` Tried ${attempt} times.` : "";
  return retryClass && !typeRecorded ? `${base}${tried} [${retryClass}]` : `${base}${tried}`;
}

// CHURN-03: which failures belong in dm_tasks.unreachable_type.
//
// This is the column the dashboard buckets on: lib/scheduler.ts counts a failed
// task as a real error only when unreachable_type IS NULL, and routes the rest to
// the quiet "filtered by Instagram" chip. Before this change the write was
// `err.unreachableType || null`, which is only ever set when Instagram handed us
// a thread with a reachability status — so a handle that no longer exists
// (user_not_found, which has no thread and therefore no status) landed in the red
// "Needs attention" bucket and read as our bug. That is the mislabelling the
// dashboard complaint was about.
//
// Every value that can be written here is an existing type string — Instagram's
// reachability enum via err.unreachableType, or one of the four proven-verdict
// ExtensionError types below. No new vocabulary is coined.
//
// search_missing_alive and search_missing_unproven are deliberately NOT here.
// "unproven" means IG's DM search came back empty and, since P9, nothing else was
// asked — quietly hiding a failure we cannot prove is how a dashboard stops being
// trustworthy. "alive" can no longer be thrown by a current content script (P9
// removed the profile-API tiebreak that produced it) but stays mapped for the
// update window, because a tab still running the old script can raise it until it
// reloads. Both keep their honest red row.
//
// Only two entries, and both are types something actually throws:
// content.js:800/:1563 throw user_not_found, content.js:2214 and the two dialog
// paths throw user_is_unreachable. The isPermanentError list further down also
// names cannot_message_user and account_disabled, but nothing in this extension or
// in upstream ColdDMs ever emits those two, so mapping them here would be
// inventing a vocabulary we don't have — if a future path does throw them they
// fall through to the generic copy and the red bucket, which is the safe default.
const PROVEN_UNREACHABLE_CLASSES = new Set([
  "user_not_found",
  "user_is_unreachable"
]);

// TEARDOWN-02: failure classes that say nothing bad about the Instagram tab, so the
// teardown ladder leaves it open. Keep this list short — the default must stay
// "close the tab", because a stale content script with isBusy still set is what the
// next task collides with. Membership requires a positive reason to trust the tab:
//   user_is_unreachable — Instagram answered us; the lead simply cannot be messaged.
//   rate_limited_error  — Instagram answered us; it wants fewer requests, not a new tab.
const TAB_HEALTHY_FAILURE_CLASSES = new Set([
  "user_is_unreachable",
  "rate_limited_error"
]);

// THROTTLE-02: dom.js and background.js grew two spellings for the same failure.
// dom.js:948 names a 429 "rate_limited"; every decision in this file — the pacing
// pause, isPermanentError, TAB_HEALTHY_FAILURE_CLASSES, TASK_FAILURE_COPY — was
// written against "rate_limited_error". Nothing bridged them, so a throttled
// profile lookup fell through as an unclassified failure: the tab was destroyed,
// three attempts were spent, the engine never paused, and on the dead-handle
// tiebreak route the lead was parked as unreachable on the strength of a throttle.
// Alias the vocabulary here rather than at each thrower, so a future route that
// emits the dom.js name is covered the day it is written. The raw name is still
// logged verbatim by dlog("task_failed") for diagnostics.
const FAILURE_CLASS_ALIASES = {
  rate_limited: "rate_limited_error"
};

function unreachableTypeFor(err, retryClass) {
  if (err?.unreachableType) return err.unreachableType;
  return PROVEN_UNREACHABLE_CLASSES.has(retryClass) ? retryClass : null;
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
      target: { username: targetUsername, fullName: usableFullName(task.contacts), replyCheckSince: replyCheckSinceFor(task.contacts) },
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
            chrome.alarms.clear(alarmName).catch(() => {});

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
                // server-side path instead of re-scraping every time. See
                // persistResolvedFullName — the placeholder-only guard lives there,
                // and the follow-up success handler calls the same helper.
                await persistResolvedFullName(task, data.resolvedFullName);
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
            chrome.alarms.clear(alarmName).catch(() => {});

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

      // E-05 FIX: use chrome.alarms instead of setTimeout so the watchdog
      // survives MV3 service-worker suspension. A suspended worker loses all
      // setTimeout callbacks; the alarm fires as soon as the worker revives,
      // producing elapsedMs close to waitedMs instead of 10-18x overruns.
      const alarmName = `task_watchdog_${task.id}`;
      chrome.alarms.create(alarmName, { when: Date.now() + 600000 });

      chrome.runtime.onMessage.addListener(handler);

      // F-LOCK-01: give the alarm watchdog a way to settle THIS promise. Without it
      // the watchdog force-released the poller's lock while this promise was still
      // pending, so the abandoned pollTasks body later ran its own finally and
      // cleared a lock that by then belonged to a newer task — a third task then got
      // claimed into a still-busy tab. It also leaked this listener forever.
      state.taskSettlers[task.id] = (err) => {
        if (resolved) return;
        resolved = true;
        chrome.runtime.onMessage.removeListener(handler);
        chrome.alarms.clear(alarmName).catch(() => {});
        reject(err);
      };

      (async () => {
        try {
          const res = await sendTaskToContent("main", "sendMessage", payload);
          if (!res?.success) {
            if (!resolved) {
              resolved = true;
              chrome.runtime.onMessage.removeListener(handler);
              chrome.alarms.clear(alarmName).catch(() => {});
              reject(new Error(res?.error?.error || "Send message failed to start"));
            }
          }
        } catch (err) {
          if (!resolved) {
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            chrome.alarms.clear(alarmName).catch(() => {});
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
      target: { username: targetUsername, fullName: usableFullName(task.contacts), replyCheckSince: replyCheckSinceFor(task.contacts) },
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
            chrome.alarms.clear(alarmName).catch(() => {});

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
                // CHURN-06: same name write-back as the first_dm path. content.js
                // already emitted resolvedFullName on this route (the dialog send in
                // the additional tab resolves the name when the template still has a
                // {{placeholder}}); this handler simply never read it, so a lead whose
                // first touch was a follow-up re-scraped their name on every send.
                await persistResolvedFullName(task, data.resolvedFullName);
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
            chrome.alarms.clear(alarmName).catch(() => {});

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

      // E-05 FIX: same alarm-based watchdog as first_dm path.
      const alarmName = `task_watchdog_${task.id}`;
      chrome.alarms.create(alarmName, { when: Date.now() + 600000 });

      chrome.runtime.onMessage.addListener(handler);

      // F-LOCK-01: same settler registration as the first_dm path above. Registering
      // it in only one of the two branches is exactly the hidden-route bug class that
      // made the earlier username-lookup fix look done while half the calls bypassed it.
      state.taskSettlers[task.id] = (err) => {
        if (resolved) return;
        resolved = true;
        chrome.runtime.onMessage.removeListener(handler);
        chrome.alarms.clear(alarmName).catch(() => {});
        reject(err);
      };

      (async () => {
        try {
          const res = await sendTaskToContent("main", "sendMessage", payload, targetUrl);
          if (!res?.success) {
            if (!resolved) {
              resolved = true;
              chrome.runtime.onMessage.removeListener(handler);
              chrome.alarms.clear(alarmName).catch(() => {});
              reject(new Error(res?.error?.error || "Send message failed to start"));
            }
          }
        } catch (err) {
          if (!resolved) {
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            chrome.alarms.clear(alarmName).catch(() => {});
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

                  const listRes = await supabaseReq(`target_lists?select=id`, "POST", {
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
                      await supabaseReq(`target_list_items`, "POST", links, false, { minimal: true });
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

// F-LOAD-01: ColdDMs records the HTTP response of every Instagram main_frame load
// (its background.js:6014 populating the `z` map) so openTab can tell a real page
// from an error page. Chrome reports status:"complete" for a 429 rate-limit wall or
// a 500 exactly as happily as for a good load, so without this we cannot tell
// "Instagram said no" from "this lead does not exist" — which is how live handles
// ended up parked as unreachable. In-memory only, like upstream: a suspended service
// worker loses the map, and a missing record always FAILS OPEN. Registered
// defensively so the extension still runs if `webRequest` is dropped from the
// manifest (the URL layer below keeps working without that permission).
const _mainFrameResponses = {};
if (chrome.webRequest?.onCompleted?.addListener) {
  chrome.webRequest.onCompleted.addListener(
    (d) => {
      if (d.type !== "main_frame" || d.tabId < 0) return;
      _mainFrameResponses[d.tabId] = {
        date: Date.now(),
        statusCode: Number(d.statusCode) || null,
        url: d.url || null
      };
    },
    { urls: ["*://*.instagram.com/*"] }
  );
}

// F-LOAD-01: URLs that mean "this tab is useless whatever HTTP code came back".
// Needs only the `tabs` permission we already hold. Trailing slashes on challenge/
// checkpoint are deliberate — bare "/challenge" would also match a profile such as
// /challenges_official, and closing a tab over a username would be its own bug.
const DEAD_END_URL_MARKERS = [
  "/accounts/login",
  "/accounts/suspended",
  "/accounts/disabled",
  "/challenge/",
  "/checkpoint/"
];

// Returns a reason string if this tab's most recent Instagram load was bad, else
// null. Both layers FAIL OPEN: an unknown state is never treated as bad, because
// closing a healthy tab on a guess is worse than missing one bad load. Pass
// startedAt = Infinity to disable the HTTP layer when no navigation was initiated.
function badTabLoadReason(tabId, startedAt, tabUrl) {
  const url = String(tabUrl || "");
  const hit = DEAD_END_URL_MARKERS.find((m) => url.includes(m));
  if (hit) return `page landed on ${hit} (url=${url.slice(0, 120)})`;
  const rec = _mainFrameResponses[tabId];
  // Only trust a response recorded AFTER this load began — upstream's `e < n`
  // guard at background.js:6584. A stale record describes the previous page.
  if (!rec || !(startedAt < rec.date) || !rec.statusCode) return null;
  if (rec.statusCode < 200 || rec.statusCode >= 300) {
    return `Instagram returned HTTP ${rec.statusCode} for ${String(rec.url || url).slice(0, 120)}`;
  }
  return null;
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
      // E-02 FIX: verify the tab is still on instagram.com before reusing.
      // Content scripts only inject on *://*.instagram.com/* — pings to any
      // other domain (skool.com, calendar.google.com, app.dmdroid.app, etc.)
      // will always fail, causing cs_unresponsive_reload storms against a
      // tab we can never fix. Do NOT close the user's tab — just forget it
      // and let the create-path below open a fresh pinned IG tab instead.
      if (tab.url && !tab.url.includes("instagram.com")) {
        dlog("tab_url_invalid_replaced", { tabType: type, tabId: tab.id, currentUrl: tab.url }, "warn");
        debugLog(`[E-02] Tab ${tab.id} is not on instagram.com (${tab.url}) — forgetting it and creating a fresh pinned IG tab.`);
        state[stateKey] = null;
        await chrome.storage.local.remove(stateKey);
        // fall through to the create-tab path (tab is nulled below)
      } else {
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
        // F-LOAD-01: Infinity disables the HTTP layer when we do NOT navigate, so a
        // stale response record from an earlier page can never condemn this tab. The
        // URL layer still runs either way — a tab already parked on the login wall is
        // useless regardless of when it got there.
        let navStartedAt = Infinity;
        if (effectiveUrl && tab.url !== effectiveUrl) {
          debugLog(`Navigating ${type} tab to target URL: ${effectiveUrl}`);
          dlog("tab_navigate", { tabType: type, tabId: tab.id, url: effectiveUrl }, "warn");
          navStartedAt = Date.now();
          await chrome.tabs.update(tab.id, { url: effectiveUrl });
          for (let i = 0; i < 25; i++) {
            try {
              const t = await chrome.tabs.get(tab.id);
              if (t.status === "complete") break;
            } catch (e) { break; }
            await sleep(400);
          }
        }
        const reusedTab = await chrome.tabs.get(tab.id).catch(() => null);
        const reusedBad = badTabLoadReason(tab.id, navStartedAt, reusedTab?.url || tab.url);
        if (reusedBad) {
          dlog("tab_bad_load", { tabType: type, tabId: tab.id, reason: reusedBad, phase: "reuse" }, "error");
          debugLog(`[F-LOAD-01] Reused ${type} tab is not on a usable Instagram page: ${reusedBad}`);
          if (type === 'main') await closeMainTab(`bad page load: ${reusedBad}`);
          else await closeAdditionalTab(`bad page load: ${reusedBad}`);
          const loadErr = new Error(`Instagram page load failed: ${reusedBad}`);
          loadErr.errorType = "instagram_reload_error";
          throw loadErr;
        }
        return tab.id;
      } // end of instagram.com check
    }
  }

  debugLog(`Opening pinned Instagram ${type} tab...`);

  const createStartedAt = Date.now();
  const tab = await chrome.tabs.create({
    url: targetUrl || randUrl(),
    active: false,
    index: 0,
    pinned: true
  });

  state[stateKey] = tab.id;
  await chrome.storage.local.set({ [stateKey]: tab.id });

  // F-LOAD-02: reset the reload ladder on a FRESH tab, mirroring upstream's
  // background.js:6567. We only zeroed it when the ladder itself gave up and closed,
  // so a tab replaced by any other route (stored tab missing, wandered off IG, dead
  // after reloads) inherited a stale counter and skipped the cheap reload entirely.
  if (type === 'main') await chrome.storage.local.set({ reloadCounter: 0 });

  debugLog(`Tab opened (${type}): ${tab.id}, waiting for load...`);
  dlog("tab_created", { tabType: type, tabId: tab.id, url: tab.url || targetUrl || "random" });

  for (let i = 0; i < 25; i++) {
    try {
      const t = await chrome.tabs.get(tab.id);
      if (t.status === "complete") break;
    } catch (e) { break; }
    await sleep(400);
  }

  // F-LOAD-01: upstream checks the HTTP code here and returns null on a bad load
  // (background.js:6593). We THROW instead, because upstream's caller checks for
  // null (:6192) and ours does not — sendTaskToContent would hand null straight to
  // chrome.tabs.sendMessage. Note errorType, NOT unreachableType: pollTasks parks
  // the contact as unreachable whenever err.unreachableType is set and retries are
  // exhausted, and parking a live lead because Instagram had a bad minute is the
  // exact harm this check exists to prevent.
  const freshTab = await chrome.tabs.get(tab.id).catch(() => null);
  const freshBad = badTabLoadReason(tab.id, createStartedAt, freshTab?.url || tab.url);
  if (freshBad) {
    dlog("tab_bad_load", { tabType: type, tabId: tab.id, reason: freshBad, phase: "create" }, "error");
    debugLog(`[F-LOAD-01] Fresh ${type} tab did not load a usable Instagram page: ${freshBad}`);
    if (type === 'main') await closeMainTab(`bad page load: ${freshBad}`);
    else await closeAdditionalTab(`bad page load: ${freshBad}`);
    const loadErr = new Error(`Instagram page load failed: ${freshBad}`);
    loadErr.errorType = "instagram_reload_error";
    throw loadErr;
  }

  debugLog(`Tab ready (${type}).`);
  return tab.id;
}

// F-BUSY-02: ColdDMs' disposability primitive, ported from its background.js:6680.
// Nulls the stored id BEFORE removing the tab, so even a failed remove leaves the id
// forgotten and the next openTab creates a fresh pinned IG tab instead of hammering a
// corpse. Closing the main tab also closes the additional tab, exactly as upstream
// does. This is the only reliable way to clear the content script's in-memory isBusy:
// a lease can be extended, a flag in another world cannot be reached.
// F-BUSY-02: mirrors upstream's closeAdditionalTab (background.js:6698). Same
// null-then-remove order as closeMainTab, for the same reason.
async function closeAdditionalTab(reason) {
  if (!state.additionalTabId) return;
  // ADDL-GUARD-01: a send is live in this tab (unibox reply / followup
  // handoff). Closing it now kills the dispatch mid-flight — the exact
  // "message channel closed" failures in the 2026-09-04 bundles. Defer: the
  // owning flow's own error handling closes the tab when it unwinds, and
  // openTab's bad-load/reload logic cleans up on the next cycle either way.
  if (Date.now() < state.additionalInFlightUntil) {
    dlog("additional_tab_close_deferred", { tabId: state.additionalTabId, reason: reason || null, inFlightForMs: state.additionalInFlightUntil - Date.now() }, "warn");
    return;
  }
  const tabId = state.additionalTabId;
  state.additionalTabId = null;
  await chrome.storage.local.remove('additionalTabId').catch(() => {});
  await chrome.tabs.remove(tabId).catch(() => {});
  dlog("additional_tab_closed", { tabId, reason: reason || null }, "warn");
}

async function closeMainTab(reason) {
  // Upstream's closeTab closes the additional tab first (background.js:6681).
  await closeAdditionalTab(reason);
  if (!state.mainTabId) return;
  const tabId = state.mainTabId;
  state.mainTabId = null;
  await chrome.storage.local.remove('mainTabId').catch(() => {});
  await chrome.tabs.remove(tabId).catch(() => {});
  dlog("main_tab_closed", { tabId, reason: reason || null }, "warn");
  debugLog(`[Recovery] Closed main tab (${reason || "unspecified"}). Next task opens a fresh one.`);
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
      // FIX-DEADTAB: the Sep-08 bundle shows this ladder firing reloads on an
      // already-closed tab ("No tab with id"). Verify the tab exists first.
      const _alive = await chrome.tabs.get(tabId).catch(() => null);
      if (!_alive) {
        dlog("tab_gone_before_reload", { taskType, tabId, attempt: reloadCount }, "warn");
        break;
      }
      debugLog(`Content script not responding. Reloading tab (attempt ${reloadCount}/2)...`);
      dlog("cs_unresponsive_reload", { taskType, tabId, attempt: reloadCount }, "warn");
      await chrome.tabs.reload(tabId, { bypassCache: true });
      await sleep(8000); // Wait for load
    }
  }

  if (!pingOk) {
    // FIX-DEADTAB: a tab parked outside the DM flow (e.g. instagram.com home)
    // can never satisfy a ping no matter how often it is reloaded. Navigate it
    // to the inbox once and re-ping before declaring it dead.
    const _placed = await chrome.tabs.get(tabId).catch(() => null);
    if (_placed && _placed.url && _placed.url.includes("instagram.com") && !_placed.url.includes("/direct/")) {
      dlog("tab_misplaced_navigate", { taskType, tabId, url: _placed.url }, "warn");
      try {
        await chrome.tabs.update(tabId, { url: "https://www.instagram.com/direct/inbox/" });
        await sleep(10000);
        for (let i = 0; i < 5 && !pingOk; i++) {
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
      } catch (_) { /* fall through to dead handling below */ }
    }
  }

  if (!pingOk) {
    dlog("cs_dead_after_reloads", { taskType, tabId }, "error");
    // E-02 FIX: null the stored tab state so the NEXT openTab call creates a
    // fresh pinned IG tab instead of repeatedly failing against this dead tab.
    const deadTab = await chrome.tabs.get(tabId).catch(() => null);
    if (deadTab && (!deadTab.url || !deadTab.url.includes("instagram.com"))) {
      // Tab wandered off IG entirely — forget it. The user's tab stays open.
      const deadKey = tabId === state.mainTabId ? 'mainTabId' : 'additionalTabId';
      state[deadKey] = null;
      await chrome.storage.local.remove(deadKey).catch(() => {});
      dlog("tab_url_invalid_nulled", { tabType, tabId, url: deadTab.url || null }, "warn");
    }
    const errObj = new Error("Content script still not responding after tab reloads");
    // CHURN-07: was `unreachableType`, which is the exact mistake the F-LOAD-01
    // comment above warns about — pollTasks parks the contact whenever
    // err.unreachableType is set, so a dead content script in OUR tab was parking
    // a perfectly live lead as unreachable. Same class name, correct field: it now
    // routes as a transient error with the normal retry and never touches the
    // contact. (Left as unreachableType this would also have retired the lead's
    // queued tasks once CHURN-04 landed, turning a browser hiccup into lost leads.)
    errObj.errorType = "instagram_reload_error";
    throw errObj;
  }

  debugLog(`[sendTaskToContent] Sending actual task ${taskType} to tab ${tabId}...`);
  // COLD-PACE-01: ColdDMs parity — their background sleeps 5s after a successful
  // ping before dispatching the task (Colddms Latest/background.js:6398). The
  // ping proves the CONTENT script is alive, not the page world: ReactDev boots
  // a few seconds later on a cold tab, and a bridge call posted pre-boot is
  // dropped by postMessage with no error, hanging until the 30s cap (the
  // 2026-09-05 log: two preTaskHooks timeouts, two tab destroys on one task —
  // attempt 3 won with ~6s of settle time the first two never got). v1.4.12-15
  // removed the viewer-wait that accidentally provided this buffer; this restores
  // the parent's deliberate one. Paid once per dispatch, nothing against the
  // 3-min send floor.
  await sleep(5000);
  // ADDL-GUARD-01: mark the additional tab as in flight for this dispatch.
  // The mark is a timestamp, not a flag — it expires naturally after the grace
  // window (11 min > the 10-min watchdog ceiling), so there is no finally to
  // clear and no path that can leak it. A deferred close is harmless; a
  // premature one kills a live reply.
  if (tabType === "additional") state.additionalInFlightUntil = Date.now() + 11 * 60_000;
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
// TAKEOVER-BACKOFF store: handle -> backoff-until timestamp. Module scope so
// the registerAccounts handler below shares it across invocations (declared
// here, before the listener, so it exists before any message can arrive).
const _takeoverBackoff = {};

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
        // S1: popup renders sentToday/pendingToday only — no lifetime history.
        const today = await computeTodayStats();
        sendResponse({ ok: true, stats: { ...today } });
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
    //
    // TAKEOVER-BACKOFF (module scope map below): when the RPC refuses with
    // takeover_blocked_live (handle alive on another live browser), we record
    // a 25-min per-handle backoff and answer subsequent attempts locally WITHOUT
    // network or log spam. Content's retry loop (3 min per tab init) then burns
    // ~8 local no-ops instead of hammering a call the server will refuse.
    // 25 min = 20-min server gate + 5 min margin, so local suppression never
    // outlasts the gate it mirrors. The extension never passes p_force — only
    // a future dashboard confirm may.
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

                // Takeover backoff: a live-elsewhere refusal parks this handle
                // for 25 min (no network, no spam). Expired entries are lazy-swept.
                if ((_takeoverBackoff[igUsername] || 0) > Date.now()) {
                  throw new Error(`takeover_blocked_live: backoff active for @${igUsername} (another live browser holds it)`);
                }
                for (const _h of Object.keys(_takeoverBackoff)) {
                  if (_takeoverBackoff[_h] <= Date.now()) delete _takeoverBackoff[_h];
                }

                // Atomic RPC: if another (stale) row of THIS user owns this IG
                // account, it transfers campaigns/limits/outreach/pending tasks
                // to our row, frees the stale row (ig_username NULL, inactive),
                // then stamps our row. This is the PC→laptop takeover path.
                // p_force is never passed: only a dashboard confirm may override
                // a live-elsewhere refusal (server default false).
                let rpcResult;
                try {
                  rpcResult = await supabaseReq(`rpc/pair_or_adopt_ig_username`, "POST", {
                    p_new_browser_id: state.browserId,
                    p_ig_username: igUsername,
                    p_ig_user_id: igUserId,
                  });
                } catch (_rpcErr) {
                  const _msg = String(_rpcErr?.message || _rpcErr);
                  if (/takeover_blocked_live/.test(_msg)) {
                    _takeoverBackoff[igUsername] = Date.now() + 25 * 60_000;
                    debugLog(`[IG Detect] Takeover refused — @${igUsername} is live on another browser; backing off 25m (no ping-pong).`);
                    throw _rpcErr;
                  }
                  // GHOST-ROW recovery: our cached browserId points at a row
                  // that no longer belongs to us (deleted from the dashboard,
                  // or paired under a different login). ensurePairedRow() trusts
                  // the cache so it never recovers — do it here: drop the stale
                  // identity, re-pair fresh under the current token, retry once.
                  // Without this the worker polls zero tasks and fails every
                  // registerAccounts forever (Sep-09: "not owned by caller"
                  // every 5s + permanent "0 tasks at all").
                  if (/not owned by caller/.test(_msg)) {
                    debugLog(`[IG Detect] Cached row gone/foreign — clearing identity and re-pairing fresh.`);
                    state.browserId = null;
                    state.browserLabel = null;
                    await chrome.storage.local.remove(["browserId", "browserLabel"]).catch(() => {});
                    await autoPairBrowser().catch(() => {});
                    if (state.browserId) {
                      rpcResult = await supabaseReq(`rpc/pair_or_adopt_ig_username`, "POST", {
                        p_new_browser_id: state.browserId,
                        p_ig_username: igUsername,
                        p_ig_user_id: igUserId,
                      });
                    } else {
                      throw _rpcErr;
                    }
                  } else {
                    throw _rpcErr;
                  }
                }
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

// E-05 FIX: alarm-based task watchdog listener.
// Handles task_watchdog_{taskId} alarms created by executeTask.
// Fires when the worker revives after suspension — timing is reliable
// because alarms persist through suspension (unlike setTimeout).
// CRITICAL: keeps delivery_unknown classification (invariant ∖1).
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith("task_watchdog_")) return;
  const taskId = alarm.name.slice("task_watchdog_".length);
  try {
    // Only settle if the task is still processing (not already completed/failed).
    const rows = await supabaseReq(`dm_tasks?id=eq.${taskId}&select=id,status,task_type`, "GET").catch(() => []);
    if (!rows || !rows.length || rows[0].status !== "processing") return;
    const taskType = rows[0].task_type || "unknown";
    dlog("task_timeout", { taskId, taskType, waitedMs: 600000 }, "warn");
    // delivery_unknown: never auto-retry a physical send (duplicate DM prevention).
    // CHURN-02 (second writer): this is the twin of the pollTasks delivery_unknown
    // branch and lands in the same customer-facing error_reason panel, so it gets
    // the same plain-English treatment. The wording differs from that one on
    // purpose: there we know Send was clicked, here the content script went silent
    // partway through and we cannot claim that much. The `delivery_unknown: `
    // prefix is load-bearing either way — settleLateVerifiedDelivery matches
    // error_reason=like.delivery_unknown* to flip the row back to completed.
    await supabaseReq(`dm_tasks?id=eq.${taskId}`, "PATCH", {
      status: "failed",
      error_reason: `delivery_unknown: Instagram stopped responding partway through this send, so we can't tell whether the message went out. We won't retry it, so this lead can't receive the same DM twice — if it did land, this turns back into a completed send on its own.`
    }).catch(() => {});
    dlog("task_delivery_unknown", { taskId, taskType, source: "alarm_watchdog" }, "warn");
    debugLog(`[Safety] Alarm watchdog: task ${taskId} timed out — settled as delivery_unknown.`);

    // F-LOCK-01: settle the pending executeTask promise instead of force-releasing
    // the lock behind pollTasks' back. pollTasks then unwinds through its own
    // catch — whose classifier already maps this exact message to delivery_unknown
    // (see isDeliveryUnknown above) — and its own finally, so state.isProcessing
    // keeps exactly one writer and the message listener is removed rather than
    // leaked. The row lands on the same values this handler just wrote.
    const settle = state.taskSettlers[taskId];
    if (settle) {
      const timeoutErr = new Error("Task timed out waiting for content script response");
      timeoutErr.errorType = "content_script_timeout";
      settle(timeoutErr);
    } else {
      // Ownership guard (B2): only release the lock/close the tab when the
      // timed-out task still owns them. Otherwise the alarm belongs to an
      // already-unwound task and the lock/tab belong to a NEWER task.
      const inflight = await chrome.storage.local.get('inFlightTaskId').catch(() => ({}));
      if (inflight && inflight.inFlightTaskId === taskId) {
        state.isProcessing = false;
        await chrome.storage.local.remove('inFlightTaskId').catch(() => {});
      }
    }

    // Same ownership rule for the tab reset: never close a newer task's tab
    // because an old alarm fired late.
    try {
      const inflight2 = await chrome.storage.local.get('inFlightTaskId').catch(() => ({}));
      const stillOurs = !inflight2 || !inflight2.inFlightTaskId || inflight2.inFlightTaskId === taskId;
      if (stillOurs) {
        await closeMainTab(`content script timeout on task ${taskId}`);
        dlog("cs_reset_after_timeout", { taskId }, "warn");
      } else {
        dlog("cs_reset_skipped_new_owner", { taskId, owner: inflight2.inFlightTaskId }, "warn");
      }
    } catch (_) {}
  } catch (e) {
    debugLog(`[Alarm Watchdog] Error processing alarm for task ${taskId}: ${e.message}`);
  }
});

// Boot
dlog("session_boot", {
  version: chrome.runtime.getManifest().version,
  browserId: state.browserId ? state.browserId.slice(0, 8) : null
});
// EGRESS-LOG: one line per boot declaring the active byte-saving switches,
// so any bundle is self-describing about which optimizations were live.
dlog("egress_opts", {
  pollNarrow: EGRESS.pollCols,
  uniboxNarrow: EGRESS.uniboxCols,
  contactsTtlMin: EGRESS.contactsTtlMs / 60000,
  hoursTtlH: EGRESS.hoursTtlMs / 3600000,
  minimalWrites: true,
  collectorBatch: true,
  statsLimit: EGRESS.statsHistoryLimit
});
// Eager instance_key mint: generating the key lazily at pairing leaves a
// kill-window (worker death between generate and persist mints a second key
// next boot → ghost row). Minting at install/update shrinks it to ~zero;
// the lazy path in ensureInstanceKey stays as fallback (function-declared,
// hoisted, storage-only — safe this early).
try {
  chrome.runtime.onInstalled.addListener(() => { ensureInstanceKey().catch(() => {}); });
} catch (_) {}
init();
