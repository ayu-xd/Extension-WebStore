const SETTINGS = {
  WAIT_FOR_SEND_BUTTON_TIMEOUT: 10,
  WAIT_FOR_REDIRECT_TO_CHAT_TIMEOUT: 10,
  IGNORE_MESSAGE_EXISTS: !1
};
class Helpers {
  static rand(e, t) {
    return e = Math.ceil(e), t = Math.floor(t), Math.floor(Math.random() * (t - e + 1)) + e
  }
}
class AsyncEventEmitter {
  constructor() {
    this._listeners = {}, this._onceListeners = {}
  }
  on(e, t) {
    this._listeners[e] || (this._listeners[e] = []), this._listeners[e].push(t)
  }
  once(e, t) {
    this._onceListeners[e] || (this._onceListeners[e] = []), this._onceListeners[e].push(t)
  }
  emit(e, ...t) {
    var s = [...this._listeners[e] ?? [], ...this._onceListeners[e] ?? []];
    return this._onceListeners[e] = [], Promise.allSettled(s.map(e => e(...t)))
  }
}
const ADBLOCK_INNER_KEY = "adblock:info:to-content",
  ADBLOCK_OUTER_KEY = "adblock:info:to-dom";
class DOMConnector extends AsyncEventEmitter {
  constructor() {
    super(), this.reservedTasks = {}, this.tasks = {}, window.addEventListener("message", async e => {
      if (e.source === window && e?.data?.type === ADBLOCK_INNER_KEY) {
        var e = JSON.parse(e.data.text),
          t = e.type,
          s = e.data;
        if ("basic" === t) {
          var a = s.type;
          if (this.tasks[a]) try {
            this.tasks[a](s.data)
          } catch (e) {
            console.error(e)
          }
        } else if ("with_response" === t) {
          a = s.type;
          if (this.tasks[a]) {
            var r = {};
            try {
              var i = await this.tasks[a](s.data);
              r.success = !0, r.result = i
            } catch (e) {
              console.error(e), r.success = !1, r.error = {
                error: e?.error || e?.toString?.(),
                stack: e?.stack,
                type: e?.type
              }
            }
            this.emit({
              type: "response",
              id: e.id,
              result: r
            })
          }
        } else if ("response" === t) {
          a = e.id, s = e.result;
          try {
            s.success ? this.reservedTasks[a]?.[0]?.(s.result) : this.reservedTasks[a]?.[1]?.(s.error)
          } catch (e) {
            console.error(e)
          } finally {
            delete this.reservedTasks[a]
          }
        }
      }
    })
  }
  emit({
    type: e,
    id: t,
    result: s,
    data: a
  }) {
    window.postMessage({
      type: ADBLOCK_OUTER_KEY,
      text: JSON.stringify({
        type: e,
        id: t,
        data: a,
        result: s
      })
    }, "*")
  }
  // F6: per-call timeout so a half-initialized page world produces a typed
  // error instead of hanging forever. Long-running tasks (follower/following
  // scrapes paginate thousands of profiles) opt out via { timeoutMs: 0 }.
  send(a, r = {}, { timeoutMs = 30000 } = {}) {
    return new Promise(async (e, t) => {
      var s = `${Date.now()}_${Math.random()}_` + Math.random();
      this.reservedTasks[s] = [e, t], this.emit({
        type: "with_response",
        id: s,
        data: {
          type: a,
          data: r
        }
      });
      if (timeoutMs > 0) {
        setTimeout(() => {
          if (this.reservedTasks[s]) {
            delete this.reservedTasks[s];
            t(new Error(`domConnector timeout after ${timeoutMs}ms: ${a}`));
          }
        }, timeoutMs);
      }
    })
  }
  registerTask(e, t) {
    this.tasks[e] = t
  }
}
const BACKGROUND_INNER_KEY = "adblock:info:to-content",
  BACKGROUND_OUTER_KEY = "adblock:info:to-background";
class BackgroundConnector extends AsyncEventEmitter {
  constructor() {
    super(), this.reservedTasks = {}, this.tasks = {}
  }
  async processMessage(e) {
    if (e.type === BACKGROUND_INNER_KEY) {
      var t = e.data.data,
        e = e.data.type;
      if (!this.tasks[e]) return {
        success: !1,
        error: {
          error: "Wrong type"
        }
      };
      var s = {};
      try {
        var a = await this.tasks[e](t);
        s.success = !0, s.result = a
      } catch (e) {
        console.error(e), s.success = !1, s.error = {
          error: e?.error || e?.toString?.(),
          stack: e?.stack,
          type: e?.type
        }
      }
      return s
    }
  }
  init() {
    chrome.runtime.onMessage.addListener((t, e, s) => {
      if (!t?.isEmit) return (async () => {
        var e = await this.processMessage(t);
        s(e)
      })(), !0;
      this.processMessage(t), s()
    })
  }
  async send(e, t) {
    let s;
    try {
      s = await chrome.runtime.sendMessage({
        type: BACKGROUND_OUTER_KEY,
        data: {
          type: e,
          data: t
        }
      })
    } catch (a) {
      if (a.message && a.message.includes("Extension context invalidated")) {
        console.warn("Context invalidated. Please refresh the page.");
        return;
      }
      throw console.error("Error while sending to background", a), a
    }
    if (!s) {
      var n = new Error("Background did not respond to task: " + e);
      throw n;
    }
    if (s.success) return s.result;
    var a = new Error(s.error.error);
    throw a.stack = s.error.stack, a
  }
  async emit(e, t = {}) {
    try {
      await chrome.runtime.sendMessage({
        type: BACKGROUND_OUTER_KEY,
        isEmit: !0,
        data: {
          type: e,
          data: t
        }
      })
    } catch (a) {
      if (a.message && a.message.includes("Extension context invalidated")) return;
      throw a;
    }
  }
  registerTask(e, t) {
    this.tasks[e] = t
  }
}
class Instagram {
  constructor() {
    this.reservedTasks = {}, this.isBusy = !1, this.taskId = void 0;
    // F2: true only for additional-tab contexts, where accepting a /direct/t/
    // URL with an empty store is safe (we navigated there ourselves).
    this._isAdditionalContext = false;
  }
  sleep(t) {
    return t < 2e4 ? this.backgroundConnector.send("sleep", {
      time: t
    }).catch(() => new Promise(e => setTimeout(e, t))) : new Promise(e => setTimeout(e, t))
  }
  // Poll IG's own in-page viewer data (via getInfo → PolarisConfig, a LOCAL
  // read, no network/profile visit) until the logged-in @username is available,
  // instead of blindly sleeping a fixed 7s+5s. Fires the moment IG's SPA is
  // ready (~1s on a fast machine) and still tolerates slow loads via the
  // timeout. This is what un-sticks the dashboard "Detecting Instagram…" state.
  async waitForViewerReady({ timeoutMs = 15000, intervalMs = 250 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const info = await this.domConnector.send("getInfo", {});
        const u = info?.currentUser?.username;
        if (u && u !== "Instagram User") {
          this.log({ type: "[waitForViewerReady] Viewer ready", data: { username: u } });
          return info;
        }
      } catch (e) { /* module not mounted yet — keep polling */ }
      await this.sleep(intervalMs).catch(() => {});
    }
    this.log({ type: "[waitForViewerReady] Timed out waiting for viewer", data: {} });
    return null;
  }
  injectDOM() {
    this.domConnector = new DOMConnector;
    var e = document.createElement("script");
    e.src = chrome.runtime.getURL("assets/dom.js"), e.async = !1, e.onload = function() {
      this.remove()
    }, document.documentElement.appendChild(e);
    var r = document.createElement("script");
    r.src = chrome.runtime.getURL("assets/ReadReceipts.js"), r.async = !1, r.onload = function() {
      this.remove()
    }, document.documentElement.appendChild(r)
  }
  registerTasks() {
    this.backgroundConnector.registerTask("sendMessage", async (payload) => this.tasks.sendMessage(payload)), this.backgroundConnector.registerTask("sendMessageFromDialog", async ({
      target: e,
      message: t,
      taskId: s,
      isTakeSnapshot: a,
      skipMessageExistsCheck: r
    }) => this.tasks.sendMessageFromDialog({
      target: e,
      message: t,
      taskId: s,
      isTakeSnapshot: a,
      skipMessageExistsCheck: r
    })), this.backgroundConnector.registerTask("checkResponse", async ({
      threadId: e,
      taskId: t,
      userId: s,
      username: a,
      targetUserId: r,
      useProfile: i,
      isTakeSnapshot: n
    }) => this.tasks.checkResponse({
      threadId: e,
      taskId: t,
      userId: s,
      username: a,
      targetUserId: r,
      useProfile: i,
      isTakeSnapshot: n
    })), this.backgroundConnector.registerTask("collectMessages", async () => this.tasks.collectMessages()), this.backgroundConnector.registerTask("debug", async ({
      taskId: e,
      type: t,
      name: s,
      chain: a,
      method: r
    }) => this.tasks.debug({
      taskId: e,
      type: t,
      name: s,
      chain: a,
      method: r
    })), this.backgroundConnector.registerTask("parsing", async ({
      taskId: e,
      username: t,
      instagramId: s,
      type: a,
      limit: r,
      userId: i,
      isTakeSnapshot: n
    }) => this.tasks.parsing({
      taskId: e,
      username: t,
      instagramId: s,
      type: a,
      limit: r,
      userId: i,
      isTakeSnapshot: n
    })), this.backgroundConnector.registerTask("ping", async () => (this.backgroundConnector.emit("pong"), this.log({
      type: "Sending pong from content script",
      data: {}
    }), !0)), this.domConnector.registerTask("sleep", async ({
      time: e
    }) => (await this.sleep(e), !0)), this.domConnector.registerTask("log", async ({
      type: e,
      data: t
    }) => {
      this.log({
        type: e,
        data: t
      })
    }), this.backgroundConnector.registerTask("sendInboxMessage", async ({
      thread_id: e,
      message: t,
      taskId: s
    }) => this.tasks.sendInboxMessage({
      thread_id: e,
      message: t,
      taskId: s
    }))
  }
  _getReadReceipts() {
    return new Promise((resolve) => {
      let resolved = false;
      const handler = (event) => {
        if (event.source !== window || event.data?.type !== "readreceipts:response") return;
        window.removeEventListener("message", handler);
        resolved = true;
        resolve(event.data.data || []);
      };
      window.addEventListener("message", handler);
      window.postMessage({ type: "readreceipts:request" }, "*");
      setTimeout(() => {
        if (!resolved) {
          window.removeEventListener("message", handler);
          resolve([]);
        }
      }, 15000);
    });
  }
  log({
    data: e,
    type: t
  }) {
    this.backgroundConnector.emit("log", {
      type: t,
      data: {
        ...e,
        taskId: this.taskId
      },
      timestamp: Date.now()
    })
  }
  async initMain() {
    this.isInitializing = true;
    try {
      this.log({ type: "Opened correct tab", data: {} });
      this.injectDOM();
      this.log({ type: "Dom injected", data: {} });
      this.registerTasks();
      this.log({ type: "Tasks registered", data: {} });
      // Wait for IG's SPA to actually be ready (poll) instead of a blind 7s sleep.
      const viewerInfo = await this.waitForViewerReady().catch(e => { this.log({ type: "[initMain] waitForViewerReady error", data: { error: e?.message } }); return null; });
      this.log({ type: "[initMain] Calling preTaskHooks", data: {} });
      await this.domConnector.send("preTaskHooks", {}).catch(e => this.log({ type: "[initMain] preTaskHooks error", data: { error: e?.message } }));
      this.log({ type: "[initMain] Calling registerAccounts", data: {} });
      await this.registerAccounts(viewerInfo).catch(e => this.log({ type: "[initMain] registerAccounts error", data: { error: e?.message } }));
      this.log({ type: "[initMain] Calling injectIntoChat", data: {} });
      await this.injectIntoChat().catch(e => this.log({ type: "[initMain] injectIntoChat error", data: { error: e?.message } }));
      this.log({ type: "Chat handler injected", data: {} });
      this.log({ type: "[initMain] Calling checkDelayedTask", data: {} });
      await this.checkDelayedTask().catch(e => this.log({ type: "[initMain] checkDelayedTask error", data: { error: e?.message } }));
      this.log({ type: "[initMain] Completed fully", data: {} });
    } catch (e) {
      this.log({ type: "[initMain] UNEXPECTED ERROR", data: { error: e?.message } });
    } finally {
      this.isInitializing = false;
    }
    return this;
  }
  async initAdditional() {
    this.isInitializing = true;
    this._isAdditionalContext = true;
    try {
      this.log({ type: "[Additional] Opened correct tab", data: {} });
      this.injectDOM();
      this.log({ type: "[Additional] Dom injected", data: {} });
      this.registerTasks();
      this.log({ type: "[Additional] Tasks registered", data: {} });
      // Poll for SPA readiness instead of a blind 7s sleep.
      await this.waitForViewerReady().catch(e => this.log({ type: "[Additional] waitForViewerReady error", data: { error: e?.message } }));
      await this.domConnector.send("preTaskHooks", {}).catch(e => this.log({ type: "[Additional] preTaskHooks error", data: { error: e?.message } }));
      await this.injectIntoChat().catch(e => this.log({ type: "[Additional] injectIntoChat error", data: { error: e?.message } }));
      this.log({ type: "[Additional] Chat handler injected", data: {} });
    } catch (e) {
      this.log({ type: "[Additional] UNEXPECTED ERROR", data: { error: e?.message } });
    } finally {
      this.isInitializing = false;
    }
    return this;
  }
  async init() {
    this.backgroundConnector = new BackgroundConnector, this.backgroundConnector.init();
    var e = await this.backgroundConnector.send("getTabType", {});
    if (e) return "main" === e ? this.initMain() : "additional" === e ? this.initAdditional() : void 0
  }
  async screenshot() {
    try {
      await this.backgroundConnector.emit("screenshot", {})
    } catch (e) {
      console.error(e)
    }
  }
  async debugData(e) {
    var t = await this.domConnector.send("getConsoleLogs", {});
    return e ? {
      isTakeSnapshot: e,
      tree: await this.domConnector.send("getReactTree", {}),
      consoleOutput: t
    } : {
      isTakeSnapshot: e,
      consoleOutput: t
    }
  }
  get tasks() {
    return {
      parsing: async ({
        taskId: t,
        username: s,
        instagramId: a,
        type: r,
        limit: i,
        userId: e,
        isTakeSnapshot: n
      }, {
        attempt: o
      } = {}) => {
        if (this.isBusy) {
          this.log({ type: "Got parsing task but thread is busy", data: {} });
          throw new ExtensionError({ type: "thread_busy", message: "Content script thread is busy with another task" });
        }
        try {
          if (this.isBusy = !0, this.taskId = t, this._checkIfUserReceivedBlockMessage(), await this.domConnector.send("preTaskHooks", {}), !await this.switchAccountFlow({
              taskType: "parsing",
              attempt: o,
              userId: e,
              taskId: t,
              username: s,
              instagramId: a,
              type: r,
              limit: i
            })) {
            let e = a;
            if (!a) try {
              var c = await this.domConnector.send("getUserByUsername", {
                username: s
              });
              e = c.id
            } catch (e) {
              throw new Error("User does not exists or error while fetching")
            }
            var {
              result: d,
              limited: l
            } = await this.domConnector.send("followers" === r ? "getFollowers" : "getFollowing", {
              username: s,
              id: e,
              limit: i
            }, { timeoutMs: 0 });
            this.backgroundConnector.emit("successTask", {
              result: !0,
              taskId: t,
              taskType: "parsing",
              targets: d.map(e => ({
                fullName: e.full_name,
                id: e.id,
                isVerified: e.is_verified,
                username: e.username
              })),
              isLimited: l
            })
          }
        } catch (e) {
          throw await this.screenshot(), this.backgroundConnector.emit("errorTask", {
            error: e?.error || e?.toString?.(),
            stack: e?.stack,
            errorType: await this._getRealErrorType(e?.type),
            taskId: t,
            taskType: "parsing",
            ...await this.debugData(n)
          }), e
        } finally {
          this.isBusy = !1, this.taskId = void 0
        }
      },
      debug: async ({
        name: e,
        chain: t,
        type: s,
        method: a,
        taskId: r
      }) => {
        if (this.isBusy) {
          this.log({ type: "Got debug task but thread is busy", data: {} });
          throw new ExtensionError({ type: "thread_busy", message: "Content script thread is busy with another task" });
        }
        try {
          var i, n;
          this.isBusy = !0, this.taskId = r, this._checkIfUserReceivedBlockMessage(), "require" === s ? (i = await this.domConnector.send("debugRequire", {
            name: e,
            chain: t,
            method: a
          }), this.backgroundConnector.emit("successTask", {
            result: !0,
            debugAnswer: JSON.stringify(i),
            taskId: r,
            taskType: "debug"
          })) : "react" === s ? (n = await this.domConnector.send("debugReact", {
            chain: t
          }), this.backgroundConnector.emit("successTask", {
            result: !0,
            debugAnswer: JSON.stringify(n),
            taskId: r,
            taskType: "debug"
          })) : this.backgroundConnector.emit("errorTask", {
            error: "Unknown task type",
            taskId: r,
            taskType: "debug"
          })
        } catch (e) {
          throw await this.screenshot(), this.backgroundConnector.emit("errorTask", {
            error: e?.error || e?.toString?.(),
            stack: e?.stack,
            taskId: r,
            taskType: "debug"
          }), e
        } finally {
          this.isBusy = !1, this.taskId = void 0
        }
      },
      checkResponse: async ({
        threadId: e,
        taskId: t,
        userId: s,
        username: a,
        targetUserId: r,
        useProfile: i = !1,
        isTakeSnapshot: n
      }, {
        attempt: o
      } = {}) => {
        if (this.isBusy) {
          this.log({ type: "Got check response task but thread is busy", data: {} });
          throw new ExtensionError({ type: "thread_busy", message: "Content script thread is busy with another task" });
        }
        try {
          if (this.isBusy = !0, this.taskId = t, this.log({
              type: "Starting check response",
              data: {}
            }), this._checkIfUserReceivedBlockMessage(), await this.domConnector.send("preTaskHooks", {}), !await this.switchAccountFlow({
              taskType: "checkResponse",
              attempt: o,
              userId: s,
              taskId: t,
              threadId: e
            })) {
            let e = r;
            var c;
            if (!e) try {
                c = await this.domConnector.send("getUserByUsername", {
                  username: a
                }), e = c.id, this.log({
                  type: "targetUserId does not exist, so request was made",
                  data: {
                    userId: e
                  }
                })
              } catch (e) {
                var d = e?.type ?? "ajax_error";
                return void this.backgroundConnector.emit("errorTask", {
                  error: e?.error || e?.toString?.(),
                  stack: e?.stack,
                  errorType: d,
                  taskId: t,
                  taskType: "checkResponse"
                })
              }
            if (i) await this.domConnector.send("openChatFromProfile", {
              username: a,
              id: e
            }), this.log({
              type: "User opened",
              data: {}
            });
            else {
              await this._openDirectIfNeeded(), this.log({
                type: "Direct button found and clicked",
                data: {}
              }), await this.sleep(5e3);
              var d = await this.checkResponseByReactAPI({
                username: a
              });
              if (d) return this.backgroundConnector.emit("successTask", {
                result: !0,
                taskId: t,
                taskType: "checkResponse",
                text: d?.text
              }), !0;
              await this._checkIfOpenUserRequired({
                username: a
              }) ? (await this.domConnector.send("openUser", {
                username: a
              }, { timeoutMs: 240000 }), this.log({
                type: "openUser finished",
                data: {
                  username: a,
                  userId: e
                }
              })) : this.log({
                type: "User is already opened",
                data: {}
              })
            }
            var l = await this.checkResponseByReactAPI({
                username: a
              }),
              h = Boolean(l);
            return this.backgroundConnector.emit("successTask", {
              result: h,
              taskId: t,
              taskType: "checkResponse",
              text: l?.text
            }), h
          }
        } catch (e) {
          throw await this.screenshot(), this.backgroundConnector.emit("errorTask", {
            error: e?.error || e?.toString?.(),
            stack: e?.stack,
            errorType: await this._getRealErrorType(e?.type),
            taskId: t,
            taskType: "checkResponse",
            ...await this.debugData(n)
          }), e
        } finally {
          this.isBusy = !1, this.taskId = void 0
        }
      },
      sendMessage: async ({
        target: e,
        message: t,
        taskId: s,
        userId: a,
        targetUserId: _targetUserId,
        useProfile: r = !1,
        isTakeSnapshot: i,
        isOpenNewTab: n = !1,
        skipMessageExistsCheck: o = !1,
        hasImage: _hasImage = !1,
        imageUsername: _imageUsername = null,
        imageType: _imageType = null,
        imageArrayBuffer: _imageArrayBuffer = null
      }, {
        attempt: c
      } = {}) => {
        this.log({ type: "[sendMessage] Task started", data: { taskId: s, isBusy: this.isBusy, isInitializing: this.isInitializing } });
        
        // Wait for initMain to finish if it's currently running (max 60 seconds)
        let initWaitElapsed = 0;
        while (this.isInitializing && initWaitElapsed < 60) {
          this.log({ type: "[sendMessage] Waiting for initialization to complete...", data: { elapsed: initWaitElapsed } });
          await this.sleep(1000).catch(() => {});
          initWaitElapsed++;
        }
        if (this.isInitializing) {
          this.log({ type: "[sendMessage] Initialization timeout — forcing proceed", data: {} });
          this.isInitializing = false;
        }

        var d, l, h;
        if (this.isBusy) {
          this.log({ type: "Got send message task but thread is busy", data: {} });
          throw new ExtensionError({ type: "thread_busy", message: "Content script thread is busy with another task" });
        }
        try {
          this.log({ type: "[sendMessage] Entering try block, setting isBusy = true", data: {} });
          if (this.isBusy = !0, this.taskId = s, this._checkIfUserReceivedBlockMessage(), this.log({ type: "[sendMessage] Calling preTaskHooks", data: {} }), await this.domConnector.send("preTaskHooks", {}), this.log({ type: "[sendMessage] Calling switchAccountFlow", data: {} }), !await this.switchAccountFlow({
              taskType: "sendMessage",
              attempt: c,
              userId: a,
              taskId: s,
              target: e,
              message: t
            })) {
            if (r) l = await this.domConnector.send("getUserByUsername", {
              username: e.username
            }), this.log({
              type: "Received target user id",
              data: {
                userId: l.id
              }
            }), await this.domConnector.send("openChatFromProfile", {
              username: e.username,
              id: l.id
            }), this.log({
              type: "User opened",
              data: {}
            });
            else if (await this._openDirectIfNeeded(), this.log({
                type: "Direct button found and clicked",
                data: {}
              }), await this.sleep(5e3), await this._checkIfOpenUserRequired({
                username: e.username
              })) {
              if (n) {
                this.log({ type: "[Followup] isOpenNewTab set — scraping LIVE thread id from search dialog", data: { username: e.username, taskId: s } });
                h = await this.domConnector.send("findUserInDialogWithoutClick", {
                  username: e.username
                }, { timeoutMs: 240000 });
                var _liveThreadId = h?.candidate?.id ?? null;
                this.log({ type: "[Followup] Live thread id scraped from search results", data: { username: e.username, taskId: s, threadId: _liveThreadId, matched: !!h?.candidate } });
                if (_liveThreadId) {
                  // ColdDMs method: additional tab opens /direct/t/<liveId>/ directly
                  // and sends from the dialog there.
                  this.backgroundConnector.emit("sendMessageAdditionalTab", {
                    target: e,
                    message: t,
                    taskId: s,
                    isTakeSnapshot: i,
                    threadId: _liveThreadId,
                    skipMessageExistsCheck: o
                  });
                  this.log({ type: "[Followup] Handoff emitted -> additional tab will open /direct/t/<id>/ and send", data: { taskId: s, threadId: _liveThreadId } });
                  return !0;
                }
                // Guard (F1): no usable id — ColdDMs would crash here on
                // candidate.id. Fall through to the proven main-tab openUser
                // path below instead of handing off a blank id.
                this.log({ type: "[Followup] No live thread id — falling back to main-tab send", data: { username: e.username, taskId: s } });
              }
              // F7: dialog search is the flaky step (fiber typing can silently
              // no-op -> 20 suggestion rows -> "No fiber match" -> timeout).
              // On failure, fall back to ColdDMs' profile route: top-bar search
              // matched by numeric ID + Message button + verified inbox arrival.
              try {
                await this.domConnector.send("openUser", {
                  username: e.username
                }, { timeoutMs: 240000 });
              } catch (_dialogErr) {
                this.log({
                  type: "[sendMessage] Dialog open failed — falling back to profile route",
                  data: { username: e.username, error: String(_dialogErr?.message || _dialogErr) }
                });
                let _profUser = null;
                try {
                  _profUser = await this.domConnector.send("getUserByUsername", { username: e.username });
                } catch (_idErr) {
                  throw _dialogErr;
                }
                if (!_profUser?.id) throw _dialogErr;
                try {
                  await this.domConnector.send("openChatFromProfile", {
                    username: e.username,
                    id: _profUser.id
                  });
                  this.log({ type: "[sendMessage] User opened via profile route", data: { username: e.username, userId: _profUser.id } });
                } catch (_profErr) {
                  const _msg = String(_profErr?.message || "");
                  if (_msg.includes("do not allow")) {
                    throw new ExtensionError({
                      type: "user_does_not_accept_dms",
                      message: "Lead does not allow new messages (no Message button on profile)"
                    });
                  }
                  throw _dialogErr;
                }
              }
              this.log({ type: "User opened", data: {} });
            } else this.log({
              type: "User is already opened",
              data: {}
            });
            var u = {
                0: "REACHABLE",
                1: "UNREACHABLE_USER_TYPE",
                2: "UNREACHABLE_ADULT_TYPE",
                3: "REACHABLE_INVITE_BANNER",
                4: "UNREACHABLE_INVITE_BLOCK",
                5: "UNREACHABLE_INTEROP_THIRD_PARTY_USER",
                6: "UNREACHABLE_INTEROP_USER_OPT_OUT",
                7: "UNREACHABLE_INTEROP_THIRD_PARTY_APP_NOT_SUPPORTED",
                8: "UNREACHABLE_INTEROP_USER_REMOVED_THIRD_PARTY_APP",
                9: "UNREACHABLE_NULL_INTEROP_USER",
                10: "UNREACHABLE_MR_LIMIT_BLOCK",
                11: "UNREACHABLE_RS_UPSELL_ELIGIBLE"
              },
              g = (await this.domConnector.send("getAllMessages", {}))[e.username];
            g || this.log({
              type: "No thread info",
              data: {
                username: e.username,
                messages: await this.domConnector.send("getDebugMessages", {})
              }
            });
            if (!g || ["0", "3"].includes(g.contact_reachability_status_type)) {
              // Reply guard (main tab). The `g?.messages?.length` precondition was
              // removed (matches ColdDMs 27-Jul): on a freshly-opened tab the ReStore
              // query layer often hasn't hydrated yet, so `g.messages` is empty and the
              // check used to be skipped entirely — firing a follow-up at someone who
              // already replied. checkResponseByReactAPI now falls back to the live DOM
              // rows when the store is empty, so the check must always run here.
              if (!o && !SETTINGS.IGNORE_MESSAGE_EXISTS) {
                // F9: pass the task's time anchor through when the background
                // supplies one (inert until replyCheckSince exists in payload).
                var m = await this.checkResponseByReactAPI({ username: e.username, sinceMs: e.replyCheckSince ?? null });
                if (Boolean(m)) {
                  this.log({
                    type: "Message from user exists, skipping send message",
                    data: {
                      username: e.username,
                      sinceMs: e.replyCheckSince ?? null,
                      replyTimestampMs: String(m.timestampMs ?? ""),
                      text: String(m.text ?? "").substring(0, 60)
                    }
                  });
                  var k = window.location.href.match(/direct\/t\/(\d+)/)?.[1] ?? g?.thread_key;
                  return this.backgroundConnector.emit("successTask", {
                    result: !0,
                    taskId: s,
                    threadId: k,
                    taskType: "sendMessage",
                    targetUserId: g?.instagram_id ?? _targetUserId ?? null,
                    response: !0,
                    text: m.text
                  }), !0
                }
              }
              var f, _resolvedFullName = null;
              if (!t.text.includes("{{")) {
                // No unresolved placeholders — the backend already resolved the
                // message (or it has none), send it as-is. No IG lookup needed.
                f = t.text;
                this.log({ type: "Using pre-resolved message (no placeholders)", data: {} });
              } else {
                // Unresolved {{placeholder}} (backend had no name for this lead)
                // — scrape the real name from Instagram and fill it in.
                var _resolved = await this._resolveLiveName(t.text, e.username);
                f = _resolved.message;
                _resolvedFullName = _resolved.fullName;
              }
              this.log({
                type: "Prepared message",
                data: { message: f }
              });

              this.log({
                type: "IMG_DIAG_1_received",
                data: {
                  hasImage: _hasImage,
                  imageType: _imageType,
                  bufferIsArray: Array.isArray(_imageArrayBuffer),
                  bufferLength: _imageArrayBuffer ? _imageArrayBuffer.length : 0,
                  bufferFirst5: _imageArrayBuffer ? _imageArrayBuffer.slice(0,5) : null,
                  messageContainsIMAGE: f.includes("[IMAGE]")
                }
              });

              await this.sleep(5e3);
              
              var _tokens = f.split(/(\[BUBBLE\]|\[IMAGE\])/);
              let imageInjected = false;
              let hasSentAction = false;

              this.log({
                type: "IMG_DIAG_2_tokens",
                data: { tokenCount: _tokens.length, tokens: _tokens.map(t => t.substring(0, 40)) }
              });

              for (let i = 0; i < _tokens.length; i++) {
                var _token = _tokens[i].trim();
                if (!_token || _token === "[BUBBLE]") continue;

                if (hasSentAction) {
                  await this.sleep(2000);
                }

                if (_token === "[IMAGE]") {
                  this.log({
                    type: "IMG_DIAG_3_image_token_hit",
                    data: { hasImage: _hasImage, hasBuffer: !!_imageArrayBuffer, hasType: !!_imageType }
                  });
                  if (_hasImage && _imageArrayBuffer && _imageType) {
                    this.log({ type: "Injecting Local Image via DOM", data: { bufferLen: _imageArrayBuffer.length, type: _imageType } });
                    try {
                      await this.domConnector.send("sendImage", { buffer: _imageArrayBuffer, type: _imageType });
                      this.log({ type: "IMG_DIAG_4_sendImage_completed", data: {} });
                    } catch(imgErr) {
                      this.log({ type: "IMG_DIAG_4_sendImage_ERROR", data: { error: imgErr?.toString() } });
                    }
                    await this.sleep(4000); // Wait for Instagram to upload the preview
                    
                    // Trigger the send button to send the image independently!
                    this.log({ type: "Clicking Send for Image", data: {} });
                    await this.domConnector.send("sendMessage", {});
                    await this.sleep(4000); // Wait for the image to actually send
                    
                    imageInjected = true;
                    hasSentAction = true;
                  } else {
                    this.log({ type: "IMG_DIAG_3_SKIPPED_missing_data", data: { hasImage: _hasImage, bufferLen: _imageArrayBuffer?.length, imageType: _imageType } });
                  }
                  } else {
                    try {
                      await this._sendMessage({
                        text: _token,
                        username: e.username
                      });
                    } catch (chunkErr) {
                      // NO SWALLOW: a failed enter/verify MUST fail the task so
                      // the retry engine reschedules it. Reporting success here
                      // marked unsent leads as "followed up" (2026-08-23 bug).
                      this.log({ type: "Chunk send failed", data: { error: chunkErr?.toString() } });
                      throw chunkErr;
                    }
                    hasSentAction = true;
                  }
              }

              this.log({
                type: "IMG_DIAG_5_post_loop",
                data: { imageInjected, hasImage: _hasImage, hasBuffer: !!_imageArrayBuffer, hasType: !!_imageType }
              });

              if (_hasImage && _imageArrayBuffer && _imageType && !imageInjected) {
                 if (hasSentAction) await this.sleep(2000);
                 this.log({ type: "Injecting Local Image via DOM (Fallback at End)", data: { bufferLen: _imageArrayBuffer.length } });
                 try {
                   await this.domConnector.send("sendImage", { buffer: _imageArrayBuffer, type: _imageType });
                   this.log({ type: "IMG_DIAG_6_fallback_completed", data: {} });
                 } catch(imgErr) {
                   this.log({ type: "IMG_DIAG_6_fallback_ERROR", data: { error: imgErr?.toString() } });
                 }
                 await this.sleep(3000);
              } else if (_hasImage && !imageInjected) {
                 this.log({ type: "IMG_DIAG_FATAL_image_data_lost_in_transit", data: { hasImage: _hasImage, bufferExists: !!_imageArrayBuffer, typeExists: !!_imageType } });
              }

              var w = window.location.href.match(/direct\/t\/(\d+)/)?.[1];
              return this.backgroundConnector.emit("successTask", {
                result: !0,
                taskId: s,
                threadId: w,
                taskType: "sendMessage",
                targetUserId: g?.instagram_id ?? _targetUserId ?? null,
                resolvedFullName: _resolvedFullName || null
              }), !0
            }
            const unreachableType = g ? u[g.contact_reachability_status_type] : "UNKNOWN";
            this.backgroundConnector.emit("errorTask", {
              error: "User is unreachable",
              errorType: "user_is_unreachable",
              unreachableType: unreachableType,
              taskId: s,
              taskType: "sendMessage"
            });
            // Unreachable is a terminal, expected outcome — report it once and
            // stop. (Previously this also `throw`n, which fell into the catch
            // below and emitted a second errorTask with a wasted screenshot.)
          }
        } catch (e) {
          throw await this.screenshot(), this.backgroundConnector.emit("errorTask", {
            error: e?.error || e?.toString?.(),
            stack: e?.stack,
            errorType: await this._getRealErrorType(e?.type),
            unreachableType: e?.unreachableType || null,
            taskId: s,
            taskType: "sendMessage",
            ...await this.debugData(i)
          }), e
        } finally {
          this.taskId = void 0, this.isBusy = !1
        }
      },
      sendMessageFromDialog: async ({
        target: e,
        message: t,
        taskId: s,
        isTakeSnapshot: a,
        skipMessageExistsCheck: r = !1
      }) => {
        this.log({ type: "[sendMessageFromDialog] Task started", data: { taskId: s, isBusy: this.isBusy, isInitializing: this.isInitializing } });

        // Wait for initAdditional to finish if it's currently running (max 60 seconds)
        // — same guard as sendMessage has for initMain. Without this, a task sent
        // while initAdditional() is mid-flight blocks forever on domConnector sends
        // that only resolve after injectIntoChat completes (the React connector
        // isn't ready until then), then times out after 5 minutes.
        let initWaitElapsed = 0;
        while (this.isInitializing && initWaitElapsed < 60) {
          this.log({ type: "[sendMessageFromDialog] Waiting for initialization to complete...", data: { elapsed: initWaitElapsed } });
          await this.sleep(1000).catch(() => {});
          initWaitElapsed++;
        }
        if (this.isInitializing) {
          this.log({ type: "[sendMessageFromDialog] Initialization timeout — forcing proceed", data: {} });
          this.isInitializing = false;
        }

        var i;
        if (this.isBusy) {
          this.log({ type: "Got send message task but thread is busy", data: {} });
          throw new ExtensionError({ type: "thread_busy", message: "Content script thread is busy with another task" });
        }
        try {
          if (this.isBusy = !0, this.taskId = s, this._checkIfUserReceivedBlockMessage(), await this.domConnector.send("preTaskHooks", {}), await this.sleep(5e3), await this._checkIfOpenUserRequired({
              username: e.username
            })) {
            // Self-recover: instead of erroring, open the thread live by username
            // (same as the first-DM path). The background no longer pre-navigates
            // to a stored thread_id URL, so the tab sits on the DM inbox and we
            // open the correct thread here. Only error if it still won't open.
            this.log({ type: "[Followup] Thread not open — opening by username", data: { username: e.username } });
            try {
              await this._openDirectIfNeeded();
              await this.sleep(5e3);
              await this.domConnector.send("openUser", { username: e.username }, { timeoutMs: 240000 });
              await this.sleep(5e3);
            } catch (openErr) {
              this.log({ type: "[Followup] openUser failed — trying profile route", data: { username: e.username, error: openErr?.toString?.() } });
              // F7: same fallback as main tab — ID-matched profile route when
              // the dialog search silently fails. If it also fails, fall
              // through to the existing hard-failure check below.
              try {
                const _profUser = await this.domConnector.send("getUserByUsername", { username: e.username });
                if (_profUser?.id) {
                  await this.domConnector.send("openChatFromProfile", { username: e.username, id: _profUser.id });
                  this.log({ type: "[Followup] Thread opened via profile route", data: { username: e.username, userId: _profUser.id } });
                  await this.sleep(5e3);
                }
              } catch (profErr) {
                const _msg = String(profErr?.message || "");
                if (_msg.includes("do not allow")) {
                  throw new ExtensionError({
                    type: "user_does_not_accept_dms",
                    message: "Lead does not allow new messages (no Message button on profile)"
                  });
                }
                this.log({ type: "[Followup] Profile route also failed", data: { error: profErr?.toString?.() } });
              }
            }
            if (await this._checkIfOpenUserRequired({ username: e.username })) {
              // Hard failure after self-recovery attempt. THROW (not emit+return):
              // emitting errorTask and returning normally makes processMessage wrap
              // this as {success:true}, so background logs "successfully sent" while
              // the UI shows "Permanently Failed" — the log lies. Throwing makes the
              // response {success:false} AND the outer catch re-emits errorTask, so
              // log, UI and the executeTask promise all agree.
              throw new ExtensionError({
                type: "additional_tab_error",
                message: "Dialog is not opened in additional tab"
              });
            }
          }
          {
            var n = {
                0: "REACHABLE",
                1: "UNREACHABLE_USER_TYPE",
                2: "UNREACHABLE_ADULT_TYPE",
                3: "REACHABLE_INVITE_BANNER",
                4: "UNREACHABLE_INVITE_BLOCK",
                5: "UNREACHABLE_INTEROP_THIRD_PARTY_USER",
                6: "UNREACHABLE_INTEROP_USER_OPT_OUT",
                7: "UNREACHABLE_INTEROP_THIRD_PARTY_APP_NOT_SUPPORTED",
                8: "UNREACHABLE_INTEROP_USER_REMOVED_THIRD_PARTY_APP",
                9: "UNREACHABLE_NULL_INTEROP_USER",
                10: "UNREACHABLE_MR_LIMIT_BLOCK",
                11: "UNREACHABLE_RS_UPSELL_ELIGIBLE"
              },
              o = (await this.domConnector.send("getAllMessages", {}))[e.username];
            o || this.log({
              type: "No thread info",
              data: {
                username: e.username,
                messages: await this.domConnector.send("getDebugMessages", {})
              }
            });
            if (!o || ["0", "3"].includes(o.contact_reachability_status_type)) {
              // Reply guard (dialog / additional-tab fallback). Same fix as the main
              // tab: dropped the `o?.messages?.length` precondition so the reply check
              // runs even when the ReStore hasn't hydrated the thread yet on this tab.
              if (!r && !SETTINGS.IGNORE_MESSAGE_EXISTS) {
                var d, h = await this.checkResponseByReactAPI({ username: e.username, sinceMs: e.replyCheckSince ?? null });
                if (Boolean(h)) return this.log({
                  type: "Message from user exists, skipping send message",
                  data: {
                    username: e.username,
                    sinceMs: e.replyCheckSince ?? null,
                    replyTimestampMs: String(h.timestampMs ?? ""),
                    text: String(h.text ?? "").substring(0, 60),
                    additionalTab: !0
                  }
                }), d = window.location.href.match(/direct\/t\/(\d+)/)?.[1] ?? o?.thread_key, this.backgroundConnector.emit("successTask", {
                  result: !0,
                  taskId: s,
                  threadId: d,
                  taskType: "sendMessage",
                  targetUserId: o?.instagram_id ?? null,
                  response: !0,
                  text: h.text,
                  additionalTab: !0
                }), !0
              }
              var g, _resolvedFullName = null;
              if (!t.text.includes("{{")) {
                g = t.text;
                this.log({ type: "Using pre-resolved message (no placeholders)", data: {} });
              } else {
                // Unresolved {{placeholder}} (backend had no name for this lead)
                // — scrape the real name from Instagram and fill it in.
                var _resolved = await this._resolveLiveName(t.text, e.username);
                g = _resolved.message;
                _resolvedFullName = _resolved.fullName;
              }
              var m = (this.log({
                  type: "Prepared message",
                  data: {
                    message: g
                  }
                }), await this.sleep(5e3), await this._sendMessage({
                  text: g,
                  username: e.username
                }), window.location.href.match(/direct\/t\/(\d+)/)?.[1]);
              return this.backgroundConnector.emit("successTask", {
                result: !0,
                taskId: s,
                threadId: m,
                taskType: "sendMessage",
                targetUserId: o?.instagram_id ?? null,
                resolvedFullName: _resolvedFullName || null,
                additionalTab: !0
              }), !0
            }
            this.backgroundConnector.emit("errorTask", {
              error: "User is unreachable",
              errorType: "user_is_unreachable",
              unreachableType: o ? n[o.contact_reachability_status_type] : "UNKNOWN",
              taskId: s,
              taskType: "sendMessage",
              additionalTab: !0
            })
          }
        } catch (e) {
          throw await this.screenshot(), this.backgroundConnector.emit("errorTask", {
            error: e?.error || e?.toString?.(),
            stack: e?.stack,
            errorType: await this._getRealErrorType(e?.type),
            unreachableType: e?.unreachableType || null,
            taskId: s,
            taskType: "sendMessage",
            ...await this.debugData(a),
            additionalTab: !0
          }), e
        } finally {
          this.taskId = void 0, this.isBusy = !1
        }
      },
      collectMessages: async () => {
        try {
          var e = await this.domConnector.send("getUser", {});
          var readReceipts = await this._getReadReceipts();
          if (readReceipts.length > 0) {
            await this.backgroundConnector.send("saveMessages", {
              readReceipts: readReceipts,
              instagram_account_id: e.id
            });
          }
          var t = await this.domConnector.send("getAllMessages", {});
          return t || {};
        } catch (e) {
          this.log({
            type: "collect_messages_error",
            data: {
              error: e?.toString(),
              stack: e?.stack
            }
          });
          return {};
        }
      },
      sendInboxMessage: async ({
        thread_id: s,
        message: a,
        taskId: r
      }) => {
        if (this.isBusy) {
          this.log({ type: "Got send inbox message task but thread is busy", data: {} });
          throw new ExtensionError({ type: "thread_busy", message: "Content script thread is busy with another task" });
        }
        try {
          this.isBusy = !0, this.taskId = r, this._checkIfUserReceivedBlockMessage(), await this._openDirectIfNeeded(), await this.sleep(5e3);
          var i, n, o = await this.domConnector.send("getAllMessages", {});
          let e, t;
          for ([i, n] of Object.entries(o))
            if (n.thread_key === s) {
              e = i, t = n;
              break
            } if (!t) throw new ExtensionError({
            error: "Thread not found",
            errorType: "thread_not_found"
          });
          var {
            lastMessageTimestamp: c,
            lastMessageId: d,
            resolvedFullName: _resolvedFullName
          } = await this._sendDirectMessage({
            target: {
              username: e
            },
            message: a,
            isOpenNewTab: !1
          });
          this.backgroundConnector.emit("successTask", {
            result: !0,
            taskId: r,
            threadId: s,
            taskType: "sendInboxMessage",
            targetUserId: t.instagram_id,
            targetUsername: e,
            text: a.text,
            lastMessageTimestamp: c,
            lastMessageId: d,
            resolvedFullName: _resolvedFullName || null
          })
        } catch (e) {
          throw await this.screenshot(), "user_is_unreachable" === e.type ? this.backgroundConnector.emit("errorTask", {
            error: e?.error || e?.toString?.(),
            stack: e?.stack,
            errorType: await this._getRealErrorType(e?.type),
            taskId: r,
            taskType: "sendInboxMessage",
            reachabilityStatus: e?.unreachableType,
            threadId: s
          }) : "check_message_error" === e.type ? this.backgroundConnector.emit("errorTask", {
            error: e?.error || e?.toString?.(),
            stack: e?.stack,
            errorType: await this._getRealErrorType(e?.type),
            taskId: r,
            taskType: "sendInboxMessage",
            sendStatusV2: e?.sendStatusV2,
            threadId: s
          }) : this.backgroundConnector.emit("errorTask", {
            error: e?.error || e?.toString?.(),
            stack: e?.stack,
            errorType: await this._getRealErrorType(e?.type),
            taskId: r,
            taskType: "sendInboxMessage"
          }), e
        } finally {
          this.isBusy = !1, this.taskId = void 0
        }
      }
    }
  }
  async checkResponseByReactAPI({
    username: t,
    sinceMs: _sinceMs = null
  }) {
    var e = (await this.domConnector.send("getAllMessages", {}))[t];
    // No thread in the ReStore (common on a freshly-opened tab that hasn't
    // hydrated yet) → fall back to reading the live message rows from the DOM.
    // Propagate sinceMs so the fallback can ignore anything older than it.
    if (!e) {
      this.log({ type: "[replyGuard] Store empty — reading live DOM rows instead", data: { username: t, sinceMs: _sinceMs } });
      const _domHit = await this.domConnector.send("checkResponseFromDOM", { sinceMs: _sinceMs });
      this.log({
        type: _domHit ? "[replyGuard] DOM fallback detected a reply" : "[replyGuard] DOM fallback: no reply newer than anchor",
        data: { username: t, sinceMs: _sinceMs, text: String(_domHit?.text ?? "").substring(0, 60) || null }
      });
      return _domHit;
    }
    // ReStore has the thread: an inbound message is one whose `username` equals
    // the target (outbound carries our own account username). When sinceMs is
    // supplied, only count replies newer than it so a stale inbound message
    // from before our last send can't be mistaken for a fresh reply.
    var _candidates = e.messages.filter(e => e.username === t);
    if (_sinceMs != null) {
      const _staleCount = _candidates.length - _candidates.filter(e => Number(e.timestampMs) > Number(_sinceMs)).length;
      if (_staleCount > 0) this.log({
        type: "[replyGuard] Suppressed stale replies (older than last send)",
        data: { username: t, staleCount: _staleCount, sinceMs: _sinceMs }
      });
      _candidates = _candidates.filter(e => Number(e.timestampMs) > Number(_sinceMs));
    } else if (_candidates.length) {
      // F9 visibility: unanchored check — a reply from ANY point in history
      // will count as fresh. This is the silent skip driver.
      this.log({
        type: "[replyGuard] WARNING no time anchor — historical replies count as fresh",
        data: { username: t, oldestInboundTimestampMs: String(_candidates[_candidates.length - 1]?.timestampMs ?? "") }
      });
    }
    // messages are pre-sorted newest-first, so [0] is the most recent reply.
    const _hit = _candidates[0] || null;
    if (_hit) this.log({
      type: "[replyGuard] Reply detected (store)",
      data: {
        username: t,
        threadKey: e.thread_key ?? null,
        sinceMs: _sinceMs,
        replyTimestampMs: String(_hit.timestampMs ?? ""),
        agePastAnchorMs: _sinceMs != null && _hit.timestampMs ? Number(_hit.timestampMs) - Number(_sinceMs) : null,
        text: String(_hit.text ?? "").substring(0, 60)
      }
    });
    return _hit;
  }
  async openDirect(e) {
    await this._findSearchButton(), await this.sleep(2e3), await this.domConnector.send("inputSearch", {
      username: e
    }), await this._waitForCorrectUser(e), await this.sleep(5e3);
    e = await this.domConnector.send("getUserByUsername", {
      username: e
    });
    return await this.domConnector.send("logSendMessageButtonSeen", {
      isFollowing: e.followed_by_viewer,
      userId: e.id
    }), await this.sleep(2e3), await this.domConnector.send("openDirect", {
      isFollowing: e.followed_by_viewer,
      userId: e.id
    }), await this.sleep(5e3), e
  }
  async _getRealErrorType(e) {
    return await this.domConnector.send("detectInstagramError", {}) ? "instagram_reload_error" : e
  }
  async checkDelayedTask() {
    var e = await this.getDelayedTask();
    if (!e) return !1;
    var {
      type: e,
      task: t,
      attempt: s
    } = e;
    this.log({
      type: "Delayed task exists",
      data: {
        type: e,
        attempt: s
      }
    }), await this.deleteDelayedTask(), await this.tasks[e](t, {
      attempt: s
    })
  }
  async _checkIfOpenUserRequired({
    username: e
  }) {
    var t = window.location.href.match(/direct\/t\/(\d+)/)?.[1];
    // F2: not on any /direct/t/ page (inbox or elsewhere) — nothing can be open.
    if (!t) return true;
    var all = await this.domConnector.send("getAllMessages", {}),
      s = all[e];
    // The ReStore hydrates late after a fresh navigation — re-poll briefly
    // before concluding the thread isn't open (bounded to ~10s total).
    for (let _p = 0; _p < 5 && !s; _p++) {
      this.log({ type: "Thread store empty for user — re-polling hydration", data: { username: e, attempt: _p + 1 } });
      await this.sleep(2e3);
      all = await this.domConnector.send("getAllMessages", {});
      s = all[e];
    }
    this.log({
      type: "Checking if user thread is opened",
      data: {
        messages: s ?? {},
        username: e,
        threadId: t,
        threadKey: s?.thread_key ?? null
      }
    });
    if (!s) {
      if (this._isAdditionalContext) {
        // URL says SOME thread is open and the store can't contradict it.
        // Safe ONLY in the additional tab, where we navigated to this exact
        // thread moments ago. Main tab stays conservative (stale-thread guard).
        this.log({ type: "Thread page open but store empty — accepting (additional tab)", data: { username: e, threadId: t } });
        return false;
      }
      // 1. No thread info for this user in the store — can't confirm it's open.
      return true;
    }
    // 3. URL thread id matches this user's thread_key — it's open.
    if (String(t) === String(s.thread_key)) return false;
    // 4. The URL thread id belongs to a DIFFERENT user's thread in the store —
    //    wrong thread is open, must open the target. Guards against sending a
    //    follow-up into another conversation when the tab was left on a thread.
    for (const [user, info] of Object.entries(all)) {
      if (info?.thread_key && String(info.thread_key) === String(t)) {
        return user !== e;
      }
    }
    // 5. URL shows a thread page but its id doesn't match any stored thread_key —
    //    the id/thread_key schemes differ for an otherwise-open thread (the known
    //    false "Dialog is not opened" bug). Treat it as open and proceed.
    this.log({ type: "Thread id schemes differ but /direct/t/ is open — accepting", data: { username: e, threadId: t } });
    return false;
  }
  async getDelayedTask() {
    var e = (await chrome.storage.local.get(["delayed_task"]))["delayed_task"];
    return e ? JSON.parse(e) : null
  }
  async setDelayedTask(e) {
    await chrome.storage.local.set({
      delayed_task: JSON.stringify(e)
    })
  }
  async deleteDelayedTask() {
    await chrome.storage.local.remove(["delayed_task"])
  }
  async accountInitProcess(e) {
    const t = (await this.domConnector.send("getUser", {}))["id"];
    var s = await this.domConnector.send("exportCredentials", {}),
      s = (await this.backgroundConnector.emit("getCookiesAndSaveAccount", {
        userId: t,
        ...s
      }), e.map(e => e.toString()).filter(e => e !== t));
    s.length && await this.switchAccountOld({
      userId: s[0]
    })
  }
  async switchAccountFlow({
    taskType: e,
    attempt: t = 0,
    userId: s,
    taskId: a
  }) {
    return !!await this.isSwitchAccountRequired({
      userId: s
    }) && (this.log({
      type: "Switch account required",
      data: {
        attempt: t,
        type: e,
        userId: s
      }
    }), this.backgroundConnector.emit("errorTask", {
      switchAccountRequired: !0,
      error: "Switch user failed",
      taskId: a
    }), !0)
  }
  async registerAccounts(prefetched) {
    try {
      // Reuse the info waitForViewerReady() already fetched (no extra wait /
      // no second read). Fall back to a fresh getInfo only if not provided.
      var {
        accounts: e,
        currentUser: t
      } = prefetched || await this.domConnector.send("getInfo", {});
      return this.backgroundConnector.send("registerAccounts", {
        accounts: e,
        current_id: t.id
      })
    } catch (e) {
      return this.backgroundConnector.send("registerAccounts", {
        accounts: [],
        error: !0
      })
    }
  }
  async injectIntoChat() {
    await this.domConnector.send("injectIntoChat", {})
  }
  async isSwitchAccountRequired({
    userId: e
  }) {
    if (!e) return false;
    var t = (await this.domConnector.send("getUser", {}))["id"];
    return Number(e) !== Number(t)
  }
  async switchAccount({
    userId: e
  }) {
    location.href.includes("instagram.com/direct/") ? await this.domConnector.send("switchAccountFromDirect", {
      id: e
    }) : await this.domConnector.send("switchAccountFromIndex", {
      id: e
    })
  }
  async switchAccount_temp({
    userId: e
  }) {
    var t = (await this.domConnector.send("getUser", {}))["id"],
      s = await this.domConnector.send("exportCredentials", {}),
      t = (await this.backgroundConnector.emit("getCookiesAndSaveAccount", {
        userId: t,
        ...s
      }), await this.backgroundConnector.send("switchAccount", {
        userId: e
      }));
    await this.domConnector.send("importCredentials", t), document.location.reload()
  }
  async sendResponse({
    type: e,
    data: t = {},
    id: s
  }) {
    await chrome.runtime.sendMessage({
      type: "response",
      data: {
        id: s,
        data: t,
        type: e
      }
    })
  }
  async getLocaleString({
    module: e,
    name: t
  }) {
    return this.domConnector.send("getText", {
      module: e,
      name: t
    })
  }
  async _checkLocale({
    element: e,
    module: t,
    name: s,
    attribute: a
  }) {
    e = "content" === a ? e.innerHTML : e.getAttribute(a);
    return (await this.getLocaleString({
      module: t,
      name: s
    })).trim() === e.trim()
  }
  async _checkForNotificationPopup() {
    for (const e of document.querySelectorAll("button"))
      if (e.checkVisibility({
          checkOpacity: !0,
          checkVisibilityCSS: !0
        }) && await this._checkLocale({
          element: e,
          module: "PolarisNotificationsScreenStrings",
          name: "NOTIFICATIONS_MODAL_SECONDARY_ACTION",
          attribute: "content"
        })) {
        e.click();
        break
      }
  }
  _checkIfUserReceivedBlockMessage() {
    try {
      for (const e of document.querySelectorAll("div"))
        if (-1 < e.innerHTML?.indexOf("suspect automated behavior")) throw this.log({
          type: "Ban detected",
          data: {}
        }), new ExtensionError({
          type: "banned_error",
          message: "Suspect automated behavior on the account"
        })
    } catch (e) {
      console.error(e)
    }
    return !1
  }
  async _findSearchButton() {
    for (const e of document.querySelectorAll("span")) e.checkVisibility({
      checkOpacity: !0,
      checkVisibilityCSS: !0
    }) && await this._checkLocale({
      element: e,
      module: "PolarisGenericStrings",
      name: "SEARCH_TEXT",
      attribute: "content"
    }) && e.click()
  }
  async _openDirectIfNeeded() {
    location.href.includes("instagram.com/direct/") || await this._findDirectButton()
  }
  async _findDirectButton() {
    for (let e = 0; e < 10; e++) {
      var t = document.querySelector('[href="/direct/inbox/"]');
      if (t) return void t.click();
      var s = await this.getLocaleString({
        module: "PolarisNavigationStrings",
        name: "MESSAGES_TEXT"
      });
      for (const r of document.querySelectorAll("svg title"))
        if (r.textContent.trim() === s.trim()) {
          var a = r.closest("a");
          if (a) return void a.click()
        }
      if (await this.domConnector.send("navigateToInbox", {})) return;
      await this.sleep(1e3)
    }
    throw new ExtensionError({
      type: "open_direct_page_error",
      message: "Cannot find direct button"
    })
  }
  async _inputToSearchBox(s) {
    var e = await this.getLocaleString({
        module: "PolarisSearchConstants",
        name: "IMPERSONATION_SEARCH_TEXT"
      }),
      a = document.querySelector(`input[placeholder="${e}"]`);
    for (let t = 0; t < s.length; ++t)
      for (let e = 0; e < 5; e++) {
        await this._input({
          element: a,
          i: t,
          text: s
        }), await this.sleep(Helpers.rand(20, 70));
        var r = t + 1;
        if (a.value.endsWith(s.charAt(t)) && a.value.length === r) break;
        if (4 === e) throw new Error("Failed to input")
      }
    if (a.value !== s) throw new Error("Input data not equals");
    await this._input({
      element: a,
      i: 0,
      text: "\r",
      noShift: !0
    })
  }
  async _waitForCorrectUser(t) {
    for (let e = 0; e < 15; e++) {
      for (const r of document.querySelectorAll('div[role="none"]')) {
        var s = r.querySelectorAll("div"),
          a = r.querySelectorAll("span");
        for (const i of [...s, ...a])
          if (i.innerHTML === t) return void i.click()
      }
      await this.sleep(1e3)
    }
    throw new Error("User not found")
  }
  async _preHookAction() {}
  async _checkMessageExists_old(t) {
    for (let e = 0; e < 10; e++) {
      if ([...document.querySelectorAll("div")].find(e => e.innerHTML === t)) return;
      await this.sleep(200)
    }
    throw new Error("Message not found")
  }
  async _checkMessageExists({ dateBeforeSend: t, isFirstMessageThread: s, text: a = null, prevTailId: l = null }) {
    // v3 verifier: three independent signals instead of one dead one.
    //  - DOM check (legacy, kept): works on some IG builds only
    //  - STORE TEXT: getLastMessagesUnsafe works on current IG (proven in logs)
    //  - TAIL CHANGE: a new message id appeared at the thread tail after send
    var attempts = s ? 25 : 20;
    const norm = x => String(x ?? "").replace(/\s+/g, " ").trim();
    const needle = a ? norm(a).slice(0, 40) : null;
    for (let e = 0; e < attempts; e++) {
      var r = !1;
      try {
        r = await this.domConnector.send("checkOutgoingMessageSentFromDOM", { dateBeforeSend: t });
      } catch (_e) { }
      let storeHit = !1, tailChanged = !1;
      try {
        const msgs = await this.domConnector.send("getLastMessagesUnsafe", {});
        if (msgs?.length) {
          if (needle) {
            const texts = msgs.map(m => norm(m.text));
            storeHit = texts.some(x => x.includes(needle));
          }
          if (l && String(msgs[msgs.length - 1].messageId) !== String(l)) tailChanged = !0;
        }
      } catch (_e) { }
      this.log({
        type: "Checking if message was sent",
        data: { attempt: e, domHit: r, storeHit, tailChanged, isFirstMessageThread: s }
      });
      if (r || storeHit) return this.log({ type: "Check message exists returning true", data: { isFirstMessageThread: s } }), !0;
      // Tail-change alone needs a few confirmations (guards against a pre-enter race)
      if (tailChanged && e >= 4) return this.log({ type: "Check message exists returning true (tail)", data: {} }), !0;
      await this.sleep(1e3)
    }
    return this.log({ type: "Check message exists returning false", data: { isFirstMessageThread: s } }), !1
  }
  async _checkMessageExistsV2({
    username: t,
    dateBeforeSend: s,
    text: a,
    oldMessages: r,
    oldThreadInfo: n
  }) {
    let i = null;
    r ??= n;
    var o = !r?.messages?.length ? 150 : 20;
    for (let e = 0; e < o; e++) {
      const d = await this.domConnector.send("getAllMessages", {}),
        l = d[t];
      this.log({
        type: "v2 check debug1",
        data: {
          messages: [{
            threadInfo: l
          }, {
            oldThreadInfo: r
          }]
        }
      });
      var c,
        h = l?.messages?.filter(t => !r?.messages?.find(e => void 0 !== e?.messageId && e?.messageId === t?.messageId)),
        c = h?.find(e => e.username !== t) || l?.messages?.find(e => e.username !== t && Number(e.timestampMs) >= s - 1e3 && (!a || e.text === a));
      if (this.log({
          type: "v2 check debug2",
          data: {
            messages: [l, r, h, c]
          }
        }), e === o - 1 && !c) {
        this.log({
          type: "Message was not sent v2",
          data: {
            status: c?.sendStatusV2,
            username: l?.username ?? t,
            messages: l?.messages ?? []
          }
        });
        break
      }
      if (i = c?.sendStatusV2, ["4", "5"].includes(c?.sendStatusV2)) {
        this.log({
          type: "Message was not sent v2",
          data: {
            status: c?.sendStatusV2,
            username: l?.username ?? t,
            messages: l?.messages ?? []
          }
        });
        break
      }
      if ("2" === c?.sendStatusV2) return this.log({
        type: "Message was sent v2",
        data: {
          status: c?.sendStatusV2,
          username: l?.username ?? t,
          messages: l?.messages ?? []
        }
      }), i;
      await this.sleep(200)
    }
    const d = await this.domConnector.send("getAllMessages", {}),
      l = d[t];
    return this.log({
      type: "Check message exists v2 returning false - unexpected",
      data: {
        messages: [l]
      }
    }), i
  }
  async _sendMessage({
    text: t,
    username: e
  }) {
    // ── SIMPLE SEND CONTRACT (2026-08-23 redesign) ──
    //  1. Type. Loose-compare (whitespace-forgiving): Instagram's editor
    //     normalizes text, and byte-exact demands caused infinite cut/retype
    //     loops. After 3 normalized mismatches we ACCEPT the editor's version —
    //     that IS what will be sent.
    //  2. Press send.
    //  3. Confirm the ONE truth Instagram gives us: the box empties.
    //     Emptied = delivered. Still full after 10s = failed -> throw -> retry.
    const norm = x => String(x ?? "").replace(/\s+/g, " ").trim();
    const expected = norm(t);
    let typed = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      // F10: no timeout on typing — per-char timers get throttled to ~1s in
      // background tabs, so a 45s guillotine cut long messages mid-flight and
      // the retry replayed them from scratch (matches ColdDMs: no timeout here).
      // Failures are caught downstream by the composer-empty verification.
      await this.domConnector.send("enterMessage", {
        text: t
      }, { timeoutMs: 0 });
      await this.sleep(Helpers.rand(50, 150));
      typed = await this.domConnector.send("getMessageInput", {});
      if (norm(typed) === expected) break;
      this.log({
        type: "Input normalized-mismatch — accepting editor version",
        data: {
          attempt,
          expectedLength: expected.length,
          actualLength: norm(typed).length,
          taskId: this.taskId ?? null
        }
      });
    }
    if (!norm(typed)) throw new ExtensionError({
      type: "composer_empty_error",
      message: "Message did not land in the composer"
    });
    this.log({
      type: "Current input",
      data: { message: typed }
    });

    await this.domConnector.send("sendMessage", {});
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await this.sleep(500);
      let now;
      try {
        now = await this.domConnector.send("getMessageInput", {}, { timeoutMs: 8000 });
      } catch (_e) {
        continue; // transient read failure — keep watching until deadline
      }
      if (!norm(now)) {
        this.log({ type: "Composer emptied — message sent", data: {} });
        return !0;
      }
    }
    throw new ExtensionError({
      type: "send_unconfirmed_error",
      message: "Composer did not empty after send — message likely not delivered"
    })
  }
  _isClickable(e) {
    return Boolean(e.match(/^[\p{Alpha}\p{Nd}\p{Pc}\p{Join_C}.,/\\\[\]()+=-|@#$%^&*!"№;:?~\r\n]$/u))
  }
  async clickSendMessage() {
    for (let e = 0; e < SETTINGS.WAIT_FOR_SEND_BUTTON_TIMEOUT; e++) {
      var t = document.querySelector('div[role="button"][tabindex="0"]:not([aria-disabled="false"])');
      if (t) {
        t.click();
        break
      }
      if (e === SETTINGS.WAIT_FOR_SEND_BUTTON_TIMEOUT - 1) throw new Error("Can't find send button");
      await this.sleep(1e3)
    }
    for (let e = 0; e < SETTINGS.WAIT_FOR_REDIRECT_TO_CHAT_TIMEOUT; e++) {
      if (location.href.includes("instagram.com/direct/t/")) return;
      if (e === SETTINGS.WAIT_FOR_REDIRECT_TO_CHAT_TIMEOUT - 1) throw new Error("Redirect to send the message was unsuccessful");
      await this.sleep(1e3)
    }
  }
  async _resolveLiveName(t, e) {
    // t = raw template text, e = username.
    // Returns { message, fullName }. Never sends a literal {{placeholder}}:
    //  - no `{{` → already resolved server-side, send as-is.
    //  - scrape succeeds → fill real name, return it (for DB write-back).
    //  - scrape fails → clean-strip the placeholders, never leak literal tokens.
    if (!t.includes("{{")) return { message: t, fullName: null };
    let s = null;
    try {
      s = await this.domConnector.send("getUserByUsername", { username: e });
    } catch (err) {}
    if (s) {
      const firstName = (u) =>
        u?.full_name
          ? u.full_name.includes(" ")
            ? normalizeUnicodeText(parseFullName(u.full_name)?.first || u.username || "")
            : normalizeUnicodeText(u.full_name || "")
          : normalizeUnicodeText(u.username || "");
      const fn = firstName(s);
      const message = t
        .replace(/\{\{\s*username\s*\}\}/gi, () => e)
        .replace(/\{\{\s*name\s*\}\}/gi, () => s?.full_name ?? e)
        .replace(/[ \t]*\{\{\s*firstName\s*\}\}[ \t]*/g, (m) =>
          fn
            ? m.replace(/\{\{\s*firstName\s*\}\}/, fn)
            : /^[ \t]/.test(m) && /[ \t]$/.test(m) ? " " : "");
      this.log({ type: "Resolved live name from Instagram", data: { fullName: s.full_name, message } });
      return { message, fullName: s.full_name || null };
    }
    const message = t
      .replace(/\{\{\s*username\s*\}\}/gi, () => e)
      .replace(/\{\{\s*name\s*\}\}/gi, () => e)
      .replace(/[ \t]*\{\{\s*firstName\s*\}\}[ \t]*/g, (m) =>
        /^[ \t]/.test(m) && /[ \t]$/.test(m) ? " " : "");
    this.log({ type: "getUserByUsername failed — stripped unresolved placeholders", data: { message } });
    return { message, fullName: null };
  }
  async back() {
    for (let e = 0; e < 10; e++)
      if (document.querySelector('a[href="/"]')?.click(), await this.sleep(1e3), "https://www.instagram.com/" === document.location.href || "https://www.instagram.com" === document.location.href) {
        this.log({
          type: "Successfully returned to index page",
          data: {}
        });
        break
      }
  }
  _input({
    element: r,
    i,
    text: n,
    noShift: o = !1
  }) {
    return new Promise(t => {
      const s = new CustomEvent("keypress", {
          bubbles: !0,
          cancelable: !0
        }),
        a = this._isClickable(n.charAt(i));
      var e = n.charCodeAt(i);
      s.cancelBubble = !1, s.returnValue = !0, s.key = n.charAt(i), s.keyCode = e, s.which = e, s.charCode = e, s.shiftKey = !o && 13 !== e, s.ctrlKey = !1, s.metaKey = !1, r.focus(), setTimeout(function() {
        var e;
        a && (e = new window.KeyboardEvent("keypress", s), r.dispatchEvent(e), e = new window.KeyboardEvent("keydown", s), r.dispatchEvent(e)), ["input", "click", "change", "blur"].forEach(function(e) {
          e = new Event(e, {
            bubbles: !0,
            cancelable: !0
          });
          r.dispatchEvent(e)
        }), a && (e = new window.KeyboardEvent("keyup", s), r.dispatchEvent(e)), t()
      }, 0), 13 !== e && (r.value = r.value + n.charAt(i))
    })
  }
  async _getLastTimestamp(e) {
    return ((await this.domConnector.send("getAllMessages", {}))[e]?.messages?.sort((e, t) => t.timestampMs - e.timestampMs)[0])?.timestampMs
  }
  async _getLastMessageId(e) {
    return ((await this.domConnector.send("getAllMessages", {}))[e]?.messages?.sort((e, t) => t.timestampMs - e.timestampMs)[0])?.messageId
  }
  async _sendDirectMessage({
    target: t,
    message: s,
    isOpenNewTab: a = !1
  }) {
    try {
      if (await this._openDirectIfNeeded(), await this.sleep(5e3), await this._checkIfOpenUserRequired({
          username: t.username
        })) {
        if (a) return {
          requiresNewTab: !0,
          threadId: (await this.domConnector.send("findUserInDialogWithoutClick", {
            username: t.username
          }, { timeoutMs: 240000 })).candidate.id
        };
        await this.domConnector.send("openUser", {
          username: t.username
        }, { timeoutMs: 240000 })
      }
      var r = (await this.domConnector.send("getAllMessages", {}))[t.username];
      var i, n = {
        0: "REACHABLE",
        1: "UNREACHABLE_USER_TYPE",
        2: "UNREACHABLE_ADULT_TYPE",
        3: "REACHABLE_INVITE_BANNER",
        4: "UNREACHABLE_INVITE_BLOCK",
        5: "UNREACHABLE_INTEROP_THIRD_PARTY_USER",
        6: "UNREACHABLE_INTEROP_USER_OPT_OUT",
        7: "UNREACHABLE_INTEROP_THIRD_PARTY_APP_NOT_SUPPORTED",
        8: "UNREACHABLE_INTEROP_USER_REMOVED_THIRD_PARTY_APP",
        9: "UNREACHABLE_NULL_INTEROP_USER",
        10: "UNREACHABLE_MR_LIMIT_BLOCK",
        11: "UNREACHABLE_RS_UPSELL_ELIGIBLE"
      };
      if (r && !["0", "3"].includes(r.contact_reachability_status_type)) throw new ExtensionError({
        message: "User is unreachable",
        type: "user_is_unreachable",
        unreachableType: n[r.contact_reachability_status_type]
      });
      let e = s.text;
      let _resolvedFullName = null;
      if (e.includes("{{")) {
        var _resolved = await this._resolveLiveName(s.text, t.username);
        e = _resolved.message;
        _resolvedFullName = _resolved.fullName;
      }
      await this.sleep(5e3), await this._sendMessage({
        text: e,
        username: t.username
      });
      var o = window.location.href.match(/direct\/t\/(\d+)/)?.[1],
        c = await this._getLastTimestamp(t.username),
        d = await this._getLastMessageId(t.username);
      return {
        success: !0,
        threadId: o,
        targetUserId: r?.instagram_id,
        lastMessageTimestamp: c,
        lastMessageId: d,
        resolvedFullName: _resolvedFullName || null
      }
    } catch (e) {
      throw console.log("[sendDirectMessage] Error:", e), e
    }
    var l
  }
}

function parseFullName(e, t, s, a, r) {
  "use strict";
  let n, o, c, d, i, l, h, u, g, m, p, k, y, f, w, _ = [],
    T = [null],
    I = [],
    E = ["&", "and", "et", "e", "of", "the", "und", "y"],
    C = {
      title: "",
      first: "",
      middle: "",
      last: "",
      nick: "",
      suffix: "",
      error: []
    };

  function b(e) {
    if (a) throw "Error: " + e;
    C.error.push("Error: " + e)
  }

  function A(e, t) {
    var s, a, r, i = ["e", "y", "av", "af", "da", "dal", "de", "del", "der", "di", "la", "le", "van", "der", "den", "vel", "von", "II", "III", "IV", "J.D.", "LL.M.", "M.D.", "D.O.", "D.C.", "Ph.D."];
    if (t)
      for (a = Object.keys(C).filter(function(e) {
          return "error" !== e
        }), n = 0, c = a.length; n < c; n++)
        if (e[a[n]]) {
          for (r = (e[a[n]] + "").split(" "), o = 0, d = r.length; o < d; o++) - 1 < (s = i.map(function(e) {
            return e.toLowerCase()
          }).indexOf(r[o].toLowerCase())) ? r[o] = i[s] : 1 === r[o].length ? r[o] = r[o].toUpperCase() : 2 < r[o].length && r[o].slice(0, 1) === r[o].slice(0, 1).toUpperCase() && r[o].slice(1, 2) === r[o].slice(1, 2).toLowerCase() && r[o].slice(2) === r[o].slice(2).toUpperCase() ? r[o] = r[o].slice(0, 3) + r[o].slice(3).toLowerCase() : "suffix" !== a[o] || "." === r[o].slice(-1) || g.indexOf(r[o].toLowerCase()) ? r[o] = r[o].slice(0, 1).toUpperCase() + r[o].slice(1).toLowerCase() : r[o] === r[o].toLowerCase() && (r[o] = r[o].toUpperCase());
          e[a[n]] = r.join(" ")
        } return e
  }
  if (t = t && -1 < ["title", "first", "middle", "last", "nick", "suffix", "error"].indexOf(t.toLowerCase()) ? t.toLowerCase() : "all", s = "undefined" === (s = !0 === (s = !1 === s ? 0 : s) ? 1 : s) || 0 !== s && 1 !== s ? -1 : s, a = (a = !0 === a ? 1 : a) && 1 === a ? 1 : 0, r = (r = !0 === r ? 1 : r) && 1 === r ? 1 : 0, e && "string" == typeof e) {
    if (e = e.trim(), -1 === s && (s = e === e.toUpperCase() || e === e.toLowerCase() ? 1 : 0), u = r ? (g = ["esq", "esquire", "jr", "jnr", "sr", "snr", "2", "ii", "iii", "iv", "v", "clu", "chfc", "cfp", "md", "phd", "j.d.", "ll.m.", "m.d.", "d.o.", "d.c.", "p.c.", "ph.d."], m = ["a", "ab", "antune", "ap", "abu", "al", "alm", "alt", "bab", "bäck", "bar", "bath", "bat", "beau", "beck", "ben", "berg", "bet", "bin", "bint", "birch", "björk", "björn", "bjur", "da", "dahl", "dal", "de", "degli", "dele", "del", "della", "der", "di", "dos", "du", "e", "ek", "el", "escob", "esch", "fleisch", "fitz", "fors", "gott", "griff", "haj", "haug", "holm", "ibn", "kauf", "kil", "koop", "kvarn", "la", "le", "lind", "lönn", "lund", "mac", "mhic", "mic", "mir", "na", "naka", "neder", "nic", "ni", "nin", "nord", "norr", "ny", "o", "ua", "ui'", "öfver", "ost", "över", "öz", "papa", "pour", "quarn", "skog", "skoog", "sten", "stor", "ström", "söder", "ter", "ter", "tre", "türk", "van", "väst", "väster", "vest", "von"], ["mr", "mrs", "ms", "miss", "dr", "herr", "monsieur", "hr", "frau", "a v m", "admiraal", "admiral", "air cdre", "air commodore", "air marshal", "air vice marshal", "alderman", "alhaji", "ambassador", "baron", "barones", "brig", "brig gen", "brig general", "brigadier", "brigadier general", "brother", "canon", "capt", "captain", "cardinal", "cdr", "chief", "cik", "cmdr", "coach", "col", "col dr", "colonel", "commandant", "commander", "commissioner", "commodore", "comte", "comtessa", "congressman", "conseiller", "consul", "conte", "contessa", "corporal", "councillor", "count", "countess", "crown prince", "crown princess", "dame", "datin", "dato", "datuk", "datuk seri", "deacon", "deaconess", "dean", "dhr", "dipl ing", "doctor", "dott", "dott sa", "dr", "dr ing", "dra", "drs", "embajador", "embajadora", "en", "encik", "eng", "eur ing", "exma sra", "exmo sr", "f o", "father", "first lieutient", "first officer", "flt lieut", "flying officer", "fr", "frau", "fraulein", "fru", "gen", "generaal", "general", "governor", "graaf", "gravin", "group captain", "grp capt", "h e dr", "h h", "h m", "h r h", "hajah", "haji", "hajim", "her highness", "her majesty", "herr", "high chief", "his highness", "his holiness", "his majesty", "hon", "hr", "hra", "ing", "ir", "jonkheer", "judge", "justice", "khun ying", "kolonel", "lady", "lcda", "lic", "lieut", "lieut cdr", "lieut col", "lieut gen", "lord", "m", "m l", "m r", "madame", "mademoiselle", "maj gen", "major", "master", "mevrouw", "miss", "mlle", "mme", "monsieur", "monsignor", "mr", "mrs", "ms", "mstr", "nti", "pastor", "president", "prince", "princess", "princesse", "prinses", "prof", "prof dr", "prof sir", "professor", "puan", "puan sri", "rabbi", "rear admiral", "rev", "rev canon", "rev dr", "rev mother", "reverend", "rva", "senator", "sergeant", "sheikh", "sheikha", "sig", "sig na", "sig ra", "sir", "sister", "sqn ldr", "sr", "sr d", "sra", "srta", "sultan", "tan sri", "tan sri dato", "tengku", "teuku", "than puying", "the hon dr", "the hon justice", "the hon miss", "the hon mr", "the hon mrs", "the hon ms", "the hon sir", "the very rev", "toh puan", "tun", "vice admiral", "viscount", "viscountess", "wg cdr", "ind", "misc", "mx"]) : (g = ["esq", "esquire", "jr", "jnr", "sr", "snr", "2", "ii", "iii", "iv", "md", "phd", "j.d.", "ll.m.", "m.d.", "d.o.", "d.c.", "p.c.", "ph.d."], m = ["ab", "bar", "bin", "da", "dal", "de", "de la", "del", "della", "der", "di", "du", "ibn", "l'", "la", "le", "san", "st", "st.", "ste", "ter", "van", "van de", "van der", "van den", "vel", "ver", "vere", "von"], ["dr", "miss", "mr", "mrs", "ms", "prof", "sir", "frau", "herr", "hr", "monsieur", "captain", "doctor", "judge", "officer", "professor", "ind", "misc", "mx"]), (k = (" " + e + " ").match(/\s(?:[['']([^'']+)['']|[""]([^""]+)[""]|\[([^\]]+)\]|\(([^\)]+)\)),?\s/g)) && (I = I.concat(k)), 1 === (y = I.length)) C.nick = I[0].slice(2).slice(0, -2), "," === C.nick.slice(-1) && (C.nick = C.nick.slice(0, -1)), e = (" " + e + " ").replace(I[0], " ").trim(), I = [];
    else if (1 < y) {
      for (b(y + " nicknames found"), n = 0; n < y; n++) e = (" " + e + " ").replace(I[n], " ").trim(), I[n] = I[n].slice(2).slice(0, -2), "," === I[n].slice(-1) && (I[n] = I[n].slice(0, -1));
      C.nick = I.join(", "), I = []
    }
    if (e.trim().length) {
      for (n = 0, i = e.split(" "), c = i.length; n < c; n++) l = i[n], h = null, "," === l.slice(-1) && (h = ",", l = l.slice(0, -1)), _.push(l), T.push(h);
      for (c = _.length, n = c - 1; 0 < n; n--) p = ("." === _[n].slice(-1) ? _[n].slice(0, -1) : _[n]).toLowerCase(), (-1 < g.indexOf(p) || -1 < g.indexOf(p + ".")) && (I = _.splice(n, 1).concat(I), "," === T[n] ? T.splice(n + 1, 1) : T.splice(n, 1));
      if (1 === (y = I.length) ? (C.suffix = I[0], I = []) : 1 < y && (b(y + " suffixes found"), C.suffix = I.join(", "), I = []), _.length) {
        for (c = _.length, n = c - 1; 0 <= n; n--) p = ("." === _[n].slice(-1) ? _[n].slice(0, -1) : _[n]).toLowerCase(), (-1 < u.indexOf(p) || -1 < u.indexOf(p + ".")) && (I = _.splice(n, 1).concat(I), "," === T[n] ? T.splice(n + 1, 1) : T.splice(n, 1));
        if (1 === (y = I.length) ? (C.title = I[0], I = []) : 1 < y && (b(y + " titles found"), C.title = I.join(", "), I = []), _.length) {
          if (1 < _.length)
            for (n = _.length - 2; 0 <= n; n--) - 1 < m.indexOf(_[n].toLowerCase()) && (_[n] = _[n] + " " + _[n + 1], _.splice(n + 1, 1), T.splice(n + 1, 1));
          if (2 < _.length)
            for (n = _.length - 3; 0 <= n; n--) - 1 < E.indexOf(_[n + 1].toLowerCase()) && (_[n] = _[n] + " " + _[n + 1] + " " + _[n + 2], _.splice(n + 1, 2), T.splice(n + 1, 2), n--);
          if (T.pop(), f = T.indexOf(","), w = T.filter(function(e) {
              return null !== e
            }).length, 1 < f || 1 < w)
            for (n = _.length - 1; 2 <= n && "," === T[n]; n--) I = _.splice(n, 1).concat(I), T.splice(n, 1), w--;
          I.length && (C.suffix && (I = [C.suffix].concat(I)), C.suffix = I.join(", "), I = []), 0 < w ? (1 < w && b(w - 1 + " extra commas found"), T.indexOf(",") && (C.last = _.splice(0, T.indexOf(",")).join(" "), T.splice(0, T.indexOf(",")))) : C.last = _.pop(), C = (_.length && (C.first = _.shift(), _.length) && (2 < _.length && b(_.length + " middle names"), C.middle = _.join(" ")), A(C, s))
        } else C = A(C, s)
      } else C = A(C, s)
    } else C = A(C, s)
  } else b("No input"), C = A(C, s);
  return "all" === t ? C : C[t]
}

function normalizeUnicodeText(e) {
  var t = Object.entries({
    L: /ł/gim,
    O: /ø/gim,
    AE: /æ/gim,
    SS: /ß/gim
  });
  e = e.normalize("NFKD");
  for (const s of [
      [/[\u0300-\u036F]/g, ""],
      [/[\u180E\u200B-\u200D\u2060\uFEFF]/g, ""],
      [/[\u2420\u2422\u2423]/g, " "],
      [/[ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, " "],
      [/\s+/g, " "]
    ]) e = e.replace(...s);
  for (const [a, r] of t) e = e.replace(r, e => e === e.toUpperCase() ? a : a.toLowerCase());
  return e
}(async () => {
  await (new Instagram).init()
})();
class ExtensionError extends Error {
  constructor({
    message: e,
    type: t
  }) {
    super(e), this.message = e, this.type = t
  }
}
