class ADBlockAsyncEventEmitter {
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
const ADBLOCK_INNER_KEY = "adblock:info:to-dom",
  ADBLOCK_OUTER_KEY = "adblock:info:to-content",
  ADBLOCK_REACT_INNER_KEY = "adblock:info:to-inner-dom",
  ADBLOCK_REACT_OUTER_KEY = "adblock:info:to-react";
class ADBlockDOMConnector extends ADBlockAsyncEventEmitter {
  constructor(e, t) {
    super(), this.reservedTasks = {}, this.tasks = {}, this.innerKey = e, this.outerKey = t, window.addEventListener("message", async e => {
      if (e.source === window && e?.data?.type === this.innerKey) {
        var e = JSON.parse(e.data.text),
          t = e.type,
          s = e.data;
        if ("basic" === t) {
          var r = s.type;
          if (this.tasks[r]) try {
            this.tasks[r](s.data)
          } catch (e) {
            console.error(e)
          }
        } else if ("with_response" === t) {
          r = s.type;
          if (this.tasks[r]) {
            var n = {};
            try {
              var a = await this.tasks[r](s.data);
              n.success = !0, n.result = a
            } catch (e) {
              console.error(e), n.success = !1, n.error = {
                error: e?.error || e?.toString?.(),
                stack: e?.stack,
                type: e?.type
              }
            }
            this.emit({
              type: "response",
              id: e.id,
              result: n
            })
          }
        } else if ("response" === t) {
          r = e.id, s = e.result;
          try {
            s.success ? this.reservedTasks[r]?.[0]?.(s.result) : this.reservedTasks[r]?.[1]?.(s.error)
          } catch (e) {
            console.error(e)
          } finally {
            delete this.reservedTasks[r]
          }
        }
      }
    })
  }
  emit({
    type: e,
    id: t,
    result: s,
    data: r
  }) {
    window.postMessage({
      type: this.outerKey,
      text: JSON.stringify({
        type: e,
        id: t,
        data: r,
        result: s
      })
    }, "*")
  }
  send(r, n = {}) {
    return new Promise(async (e, t) => {
      var s = `${Date.now()}_${Math.random()}_` + Math.random();
      this.reservedTasks[s] = [e, t], this.emit({
        type: "with_response",
        id: s,
        data: {
          type: r,
          data: n
        }
      })
    })
  }
  registerTask(e, t) {
    this.tasks[e] = t
  }
}
class ADBlockDOM {
  registerTasks() {
    this.domConnector.registerTask("isLoggedIn", () => this._isLoggedIn()), this.domConnector.registerTask("getText", ({
      module: e,
      name: t
    }) => this._getText(e, t)), this.domConnector.registerTask("getUser", () => this._getUser()), this.domConnector.registerTask("checkResponse", ({
      threadId: e
    }) => this._checkResponse(e)), this.domConnector.registerTask("getInfo", () => this._getInfo()), this.domConnector.registerTask("switchAccount", ({
      id: e
    }) => this._switchAccount({
      id: e
    })), this.domConnector.registerTask("enterSymbol", ({
      symbol: e
    }) => this._enterSymbol({
      symbol: e
    })), this.domConnector.registerTask("enterMessage", ({
      text: e
    }) => this._enterMessage({
      text: e
    })), this.domConnector.registerTask("sendMessage", () => this._sendMessage()), this.domConnector.registerTask("sendImage", (data) => this._sendImage(data)), this.domConnector.registerTask("getMessageInput", () => this._getMessageInput()), this.domConnector.registerTask("injectIntoChat", () => this._injectIntoChat()), this.domConnector.registerTask("getLastMessages", () => this._getLastMessages()), this.domConnector.registerTask("getLastMessagesUnsafe", () => this._getLastMessagesUnsafe()), this.domConnector.registerTask("preTaskHooks", () => this._preTaskHooks()), this.domConnector.registerTask("getUserByUsername", ({
      username: e
    }) => this._getUserByUsername(e)), this.domConnector.registerTask("inputSearch", ({
      username: e
    }) => this._inputSearch({
      username: e
    })), this.domConnector.registerTask("getUserFromContacts", ({
      username: e
    }) => this._getUserFromContacts({
      username: e
    })), this.domConnector.registerTask("openUser", ({
      username: e,
      userId: t
    }) => this._openUser({
      username: e,
      userId: t
    })), this.domConnector.registerTask("findUserInDialogWithoutClick", ({
      username: e,
      userId: t
    }) => this._findUserInDialogWithoutClick({
      username: e,
      userId: t
    })), this.domConnector.registerTask("logSendMessageButtonSeen", ({
      isFollowing: e,
      userId: t
    }) => this._logSendMessageButtonSeen({
      isFollowing: e,
      userId: t
    })), this.domConnector.registerTask("openDirect", ({
      isFollowing: e,
      userId: t
    }) => this._openDirect({
      isFollowing: e,
      userId: t
    })), this.domConnector.registerTask("importCredentials", ({
      indexedDb: e,
      localStorage: t,
      sessionStorage: s
    }) => this._importCredentials({
      indexedDb: e,
      localStorage: t,
      sessionStorage: s
    })), this.domConnector.registerTask("exportCredentials", () => this._exportCredentials()), this.domConnector.registerTask("getReactTree", () => this._getReactTree()), this.domConnector.registerTask("debugRequire", ({
      name: e,
      chain: t,
      method: s
    }) => this._debugRequire({
      name: e,
      chain: t,
      method: s
    })), this.domConnector.registerTask("debugReact", ({
      chain: e
    }) => this._debugReact({
      chain: e
    })), this.domConnector.registerTask("switchAccountFromDirect", ({
      id: e
    }) => this._switchAccountFromDirect({
      id: e
    })), this.domConnector.registerTask("switchAccountFromIndex", ({
      id: e
    }) => this._switchAccountFromIndex({
      id: e
    })), this.domConnector.registerTask("getFollowers", ({
      id: e,
      username: t,
      limit: s
    }) => this._getFollowers({
      id: e,
      username: t,
      limit: s
    })), this.domConnector.registerTask("getFollowing", ({
      id: e,
      username: t,
      limit: s
    }) => this._getFollowing({
      id: e,
      username: t,
      limit: s
    })), this.domConnector.registerTask("openChatFromProfile", ({
      id: e,
      username: t
    }) => this._openChatFromProfile({
      id: e,
      username: t
    })), this.domConnector.registerTask("getAllMessages", () => this._getAllMessages()), this.domConnector.registerTask("getUserThread", ({
      username: e
    }) => this._getUserThread({
      username: e
    })), this.domConnector.registerTask("getDebugMessages", () => this._getDebugMessages()), this.domConnector.registerTask("getConsoleLogs", () => this._getConsoleLogs()), this.domConnector.registerTask("detectInstagramError", () => this._detectInstagramError()), this.domConnector.registerTask("checkResponseFromDOM", ({
      sinceMs: e
    } = {}) => this._checkResponseFromDOM({
      sinceMs: e
    })), this.domConnector.registerTask("checkOutgoingMessageSentFromDOM", ({
      dateBeforeSend: e
    }) => this._checkOutgoingMessageSentFromDOM({
      dateBeforeSend: e
    })), this.domConnector.registerTask("navigateToInbox", () => this._navigateToInbox()), this.domReactConnector.registerTask("sleep", ({
      time: e
    }) => this.sleep(e)), this.domReactConnector.registerTask("log", ({
      data: e,
      type: t
    }) => this.log({
      data: e,
      type: t
    }))
  }
  log({
    data: e,
    type: t
  }) {
    this.domConnector.emit({
      type: "basic",
      data: {
        type: "log",
        data: {
          type: t,
          data: e
        }
      }
    })
  }
  _getConsoleLogs() {
    return consoleMessages
  }
  constructor() {
    this.domConnector = new ADBlockDOMConnector(ADBLOCK_INNER_KEY, ADBLOCK_OUTER_KEY), this.domReactConnector = new ADBlockDOMConnector(ADBLOCK_REACT_INNER_KEY, ADBLOCK_REACT_OUTER_KEY), this.registerTasks(), this.lastMessages = null, this._modules = {}
  }
  _debugReact({
    chain: e
  }) {
    return this.domReactConnector.send("debug", {
      chain: e
    })
  }
  async _debugRequire({
    name: e,
    chain: t,
    method: s
  }) {
    let r = null;
    if ("importDefault" === s && (r = await this._importDefault(e)), "importNamespace" === s && (r = await this._importNamespace(e)), !(r = "require" === s ? require(e) : r)) throw new Error("Unknown method");
    for (var {
        type: n,
        value: a,
        args: o = []
      }
      of t) r = r[a], "execute" === n && (r = r(...o));
    return r
  }
  _inputSearch({
    username: e
  }) {
    return this.domReactConnector.send("inputSearch", {
      username: e
    })
  }
  _getMessageInput() {
    return document.querySelector('div[contenteditable="true"]').__lexicalTextContent
  }
  trickState() {
    try {
      Object.defineProperty(document, "hasFocus", {
        get() {
          return () => !0
        },
        configurable: true
      });
      Object.defineProperty(document, "hidden", {
        get() {
          return !1
        },
        configurable: true
      });
    } catch (err) {}
    {
      var t = document,
        s = "visibilitychange";
      let e;
      "createEvent" in document ? (e = document.createEvent("Event")).initEvent(s, !0, !0) : "Event" in window && (e = new Event(s, {
        bubbles: !0,
        cancelable: !0
      })), t.dispatchEvent(e)
    } {
      var t = "onfocusin" in (s = window) ? "focusin" : "focus",
        r = "onfocusin" in s;
      let e;
      "createEvent" in document ? (e = document.createEvent("Event")).initEvent(t, r, !0) : "Event" in window && (e = new Event(t, {
        bubbles: r,
        cancelable: !0
      })), s.focus(), s.dispatchEvent(e)
    } {
      t = window, r = "pageshow";
      let e;
      "createEvent" in document ? (e = document.createEvent("Event")).initEvent(r, !0, !0) : "Event" in window && (e = new Event(r, {
        bubbles: !0,
        cancelable: !0
      })), t.dispatchEvent(e)
    }
  }
  async _getFollowers({
    id: e,
    username: t,
    limit: s
  }) {
    return this.domReactConnector.send("getFollowers", {
      id: e,
      username: t,
      limit: s
    })
  }
  async _getAllMessages() {
    return this.domReactConnector.send("getAllMessages", {})
  }
  async _getUserThread({
    username: e
  }) {
    return this.domReactConnector.send("getUserThread", {
      username: e
    })
  }
  async _getDebugMessages() {
    return this.domReactConnector.send("getDebugMessages", {})
  }
  async _openChatFromProfile({
    id: e,
    username: t
  }) {
    return this.domReactConnector.send("openChatFromProfile", {
      id: e,
      username: t
    })
  }
  async _getFollowing({
    id: e,
    username: t,
    limit: s
  }) {
    return this.domReactConnector.send("getFollowing", {
      id: e,
      username: t,
      limit: s
    })
  }
  async _getReactTree() {
    return this.domReactConnector.send("getReactTree", {})
  }
  async _detectInstagramError() {
    return this.domReactConnector.send("detectInstagramError", {})
  }
  async _preTaskHooks() {
    await this._checkNotificationModalAndClick(), await this.domReactConnector.send("preTaskHooks", {})
  }
  async _checkNotificationModalAndClick() {
    try {
      await this.domReactConnector.send("checkNotificationModalAndClick", {})
    } catch (e) {
      console.error(e)
    }
  }
  async _getUserInSearchWindow({
    userId: t,
    username: s
  }) {
    var r = await this.domReactConnector.send("findSearchResult", {});
    this.log({ type: "[searchWindow] findSearchResult (live fibers) returned", data: { username: s, resultCount: r?.length ?? 0 } });
    if (r?.length) {
      let e = r.filter(e => "user" === e.type).find(({
        candidate: e
      }) => s ? e.subtext === s : e.igid === t);
      if (e) this.log({ type: "[searchWindow] Matched via live fibers (primary path)", data: { username: s, threadId: e?.candidate?.id ?? null } });
      if (!e && s) {
        this.log({ type: "[searchWindow] No fiber match — trying server_search_results fallback (fail-soft)", data: { username: s } });
        const n = await this.domReactConnector.send("alternativeSearchResultsMapping", {
          username: s
        });
        n && (e = r.filter(e => "user" === e.type).find(({
          candidate: e
        }) => String(e.igid) === String(n.resultIgid)));
        if (e) this.log({ type: "[searchWindow] Matched via server_search_results fallback", data: { username: s, threadId: e?.candidate?.id ?? null } });
      }
      if (!e) this.log({ type: "[searchWindow] No match found in this pass", data: { username: s } });
      return e
    }
  }
  async _clickOnUserIdDialogButton({
    userId: t,
    username: s,
    skipOpenDialog: r
  }) {
    for (let e = 0; e < 10; e++) {
      var n = await this._getUserInSearchWindow({
        userId: t,
        username: s
      });
      if (n) {
        await this.domReactConnector.send("clickOnUser", {
          userId: n.candidate.igid,
          username: s
        });
        await this.sleep(5e3);
        if (!r) {
          // F3: honor the result — a failed clickChat used to be swallowed by
          // the comma-operator chain and callers believed the thread opened.
          const chatOpened = await this.domReactConnector.send("clickChat", {});
          await this.sleep(5e3);
          if (!chatOpened) {
            this.log({ type: "clickChat failed after selecting user", data: { username: s } });
            return !1;
          }
        }
        return !0;
      }
      await this.sleep(1e3);
    }
    return !1;
  }
  async _clickOnUserIdAndGetDialogButton({
    userId: t,
    username: s
  }) {
    for (let e = 0; e < 10; e++) {
      var r = await this._getUserInSearchWindow({
        userId: t,
        username: s
      });
      if (r) return await this.domReactConnector.send("clickOnUser", {
        userId: r.candidate.igid,
        username: s
      }), await this.sleep(5e3), r;
      await this.sleep(1e3)
    }
    return null
  }
  async _openUser({
    username: e
  }) {
    if (!await this.domReactConnector.send("clickDialogButton", {})) throw new ExtensionError({
      type: "open_search_popup_error",
      message: "Error while opening the popup"
    });
    if (await this.sleep(5e3), !await this.domReactConnector.send("enterUsername", {
        username: e
      })) throw new ExtensionError({
      type: "user_search_error",
      message: "Error while entering username"
    });
    if (await this.sleep(5e3), await this._clickOnUserIdDialogButton({
        username: e
      })) return !0;
    if (this.log({
        type: "User was not found in dialog in first attempt",
        data: {}
      }), !await this.domReactConnector.send("enterUsername", {
        username: "instagra"
      })) throw new ExtensionError({
      type: "user_search_error",
      message: "Error while entering username"
    });
    if (await this.sleep(2e3), !await this.domReactConnector.send("enterUsername", {
        username: e
      })) throw new ExtensionError({
      type: "user_search_error",
      message: "Error while entering username"
    });
    if (await this.sleep(5e3), await this._clickOnUserIdDialogButton({
        username: e
      })) return !0;
    throw new ExtensionError({
      type: "user_click_error",
      message: "User was not found in popup"
    })
  }
  async _findUserInDialogWithoutClick({
    username: e
  }) {
    try {
      this.log({ type: "[findUserInDialog] Opening search dialog", data: { username: e } });
      if (!await this.domReactConnector.send("clickDialogButton", {})) throw new ExtensionError({
        type: "open_search_popup_error",
        message: "Error while opening the popup"
      });
      this.log({ type: "[findUserInDialog] Dialog opened, typing username", data: { username: e } });
      if (await this.sleep(5e3), !await this.domReactConnector.send("enterUsername", {
          username: e
        })) throw new ExtensionError({
        type: "user_search_error",
        message: "Error while entering username"
      });
      await this.sleep(5e3);
      this.log({ type: "[findUserInDialog] Reading search results (attempt 1)", data: { username: e } });
      var t = await this._clickOnUserIdAndGetDialogButton({
        username: e
      });
      if (t) {
        this.log({ type: "[findUserInDialog] Match found (attempt 1)", data: { username: e, threadId: t?.candidate?.id ?? null } });
        return t;
      }
      if (this.log({
          type: "User was not found in dialog in first attempt",
          data: {}
        }), !await this.domReactConnector.send("enterUsername", {
          username: "instagra"
        })) throw new ExtensionError({
        type: "user_search_error",
        message: "Error while entering username"
      });
      if (await this.sleep(2e3), !await this.domReactConnector.send("enterUsername", {
          username: e
        })) throw new ExtensionError({
        type: "user_search_error",
        message: "Error while entering username"
      });
      await this.sleep(5e3);
      this.log({ type: "[findUserInDialog] Reading search results (attempt 2)", data: { username: e } });
      t = await this._clickOnUserIdAndGetDialogButton({
        username: e
      });
      if (t) {
        this.log({ type: "[findUserInDialog] Match found (attempt 2)", data: { username: e, threadId: t?.candidate?.id ?? null } });
        return t;
      }
      this.log({ type: "[findUserInDialog] User not found after 2 attempts — throwing", data: { username: e } });
      throw new ExtensionError({
        type: "user_click_error",
        message: "User was not found in popup"
      })
    } finally {
      // Always close the search dialog, on success OR throw, so a failed
      // follow-up can never leave a box open and stack another on the next retry.
      try {
        await this.domReactConnector.send("closeOpenDialogModal", {});
        this.log({ type: "[findUserInDialog] Search dialog closed (finally)", data: { username: e } });
      } catch (_e) {
        this.log({ type: "[findUserInDialog] closeOpenDialogModal failed (non-fatal)", data: { username: e, error: _e?.toString?.() } });
      }
    }
  }
  _enterSymbol({
    symbol: a
  }) {
    const MAX_RETRIES = 3;
    const attemptInsert = (retryCount) => {
      return new Promise(async (t, e) => {
        const s = setTimeout(() => {
            if (retryCount < MAX_RETRIES) {
              clearTimeout(s);
              attemptInsert(retryCount + 1).then(t, e);
            } else {
              e(new Error("Stuck"))
            }
          }, 15e3),
          r = document.querySelector('div[contenteditable="true"]'),
          n = await this._importNamespace("Lexical");
        if (!r || !r.__lexicalEditor) {
          clearTimeout(s);
          if (retryCount < MAX_RETRIES) {
            await new Promise(res => setTimeout(res, 2e3));
            attemptInsert(retryCount + 1).then(t, e);
          } else {
            e(new Error("Stuck"))
          }
          return;
        }
        r.__lexicalEditor.focus(() => {
          r.__lexicalEditor.update(() => {
            var e = 13 === a.charCodeAt(0) ? n.$createLineBreakNode(a) : n.$createTextNode(a);
            n.$insertNodes([e]), clearTimeout(s), t()
          })
        })
      })
    };
    return attemptInsert(0);
  }
  async _waitForEditable(e, t = 15e3) {
    for (var s = Date.now(); !e.isEditable();) {
      if (Date.now() - s > t) throw new Error("Stuck");
      await new Promise((e) => setTimeout(e, 150));
    }
  }
  async _enterMessage({
    text: e
  }) {
    const t = await this._importNamespace("Lexical"),
      n = document.querySelector('div[contenteditable="true"]')?.__lexicalEditor;
    if (!n) throw new Error("Stuck");
    await this._waitForEditable(n);
    // RESCUE SIGNAL: full-text match only. A prefix check here once allowed
    // early-return after 16 chars — silently truncating long messages.
    const norm = x => String(x ?? "").replace(/\s+/g, " ").trim();
    const inputHasText = () => {
      const box = document.querySelector('div[contenteditable="true"]');
      return !!box && norm(box.textContent) === norm(e);
    };
    var s = r => new Promise((e, s) => {
      const a = setTimeout(() => {
        s(new Error("Stuck"))
      }, 15e3);
      n.update(() => {
        try {
          r(), clearTimeout(a), e()
        } catch (e) {
          clearTimeout(a), s(e)
        }
      })
    });
    await s(() => t.$getRoot().clear());
    await new Promise((e, t) => {
      const s = setTimeout(() => {
        t(new Error("Stuck"))
      }, 15e3);
      n.focus(() => {
        clearTimeout(s), e()
      })
    });
    for (const r of e) {
      if (inputHasText()) return;
      let ok = !1;
      for (let a = 0; a < 3 && !ok; a++) {
        try {
          await s(() => {
            var e = r.charCodeAt(0),
              e = 13 === e || 10 === e ? t.$createLineBreakNode() : t.$createTextNode(r);
            t.$insertNodes([e])
          }), ok = !0
        } catch (err) {
          if (2 === a) throw err;
          await new Promise(e => setTimeout(e, 300))
        }
      }
      await new Promise(e => setTimeout(e, Math.floor(101 * Math.random()) + 50))
    }
  }
  async _sendMessage() {
    var e = new CustomEvent("keydown", {
        bubbles: !0,
        cancelable: !0
      }),
      e = (e.cancelBubble = !1, e.returnValue = !0, e.key = "Enter", e.keyCode = 13, e.which = 13, e.charCode = 13, e.shiftKey = !1, e.ctrlKey = !1, e.metaKey = !1, new window.KeyboardEvent("keydown", e)),
      t = document.querySelector('div[contenteditable="true"]');
    // Wait for the composer to be mounted & ready before pressing Enter.
    // On slow connections it can be null mid-transition (e.g. while an image preview
    // is still uploading), which used to throw and drop the message/image.
    for (var _start = Date.now(); (!t || !t.__lexicalEditor) && Date.now() - _start < 15e3;) {
      await new Promise((r) => setTimeout(r, 150));
      t = document.querySelector('div[contenteditable="true"]');
    }
    if (!t || !t.__lexicalEditor) throw new Error("Composer not ready");
    var s = await this._importNamespace("Lexical");
    t.__lexicalEditor.dispatchCommand(s.KEY_ENTER_COMMAND, e)
  }
  async _sendImage({ buffer, type }) {
    console.log("[DmDroid DOM] _sendImage called", { bufferLen: buffer?.length, type });
    if (!buffer || !type) {
      console.error("[DmDroid DOM] _sendImage: missing buffer or type!");
      return;
    }
    try {
      const uint8Array = new Uint8Array(buffer);
      const blob = new Blob([uint8Array], { type });
      const filename = "image" + (type.includes("png") ? ".png" : ".jpg");
      const file = new File([blob], filename, { type, lastModified: Date.now() });
      console.log("[DmDroid DOM] File created:", { name: filename, size: blob.size, type });
      
      // Strategy 1: Try to find existing file input
      let fileInput = document.querySelector('input[type="file"]');
      
      if (!fileInput) {
        console.log("[DmDroid DOM] No file input found, clicking image button to mount it...");
        // Click the image/gallery button in the DM chat bar to mount the hidden file input
        const imageButtons = document.querySelectorAll('div[role="button"] svg, button svg');
        for (const svg of imageButtons) {
          const pathEl = svg.querySelector('path');
          if (!pathEl) continue;
          const d = pathEl.getAttribute('d') || '';
          // Instagram's image/gallery icon typically has these path segments
          if (d.includes('18.5') || d.includes('7.5') || d.includes('photo') || svg.getAttribute('aria-label')?.toLowerCase()?.includes('photo') || svg.closest('[aria-label]')?.getAttribute('aria-label')?.toLowerCase()?.includes('photo')) {
            const btn = svg.closest('div[role="button"], button');
            if (btn) {
              console.log("[DmDroid DOM] Found image button, clicking...");
              btn.click();
              await new Promise(r => setTimeout(r, 1000));
              break;
            }
          }
        }
        // Also try aria-label based approach
        const addPhotoBtn = document.querySelector('[aria-label*="photo" i], [aria-label*="image" i], [aria-label*="gallery" i], [aria-label*="Add Photo" i]');
        if (addPhotoBtn && !document.querySelector('input[type="file"]')) {
          console.log("[DmDroid DOM] Found aria-label photo button, clicking...");
          addPhotoBtn.click();
          await new Promise(r => setTimeout(r, 1000));
        }
        fileInput = document.querySelector('input[type="file"]');
      }
      
      if (fileInput) {
        console.log("[DmDroid DOM] File input found! Setting files...", { accept: fileInput.accept });
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        fileInput.files = dataTransfer.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        fileInput.dispatchEvent(new Event('input', { bubbles: true }));
        console.log("[DmDroid DOM] File input change event dispatched");
      } else {
        console.warn("[DmDroid DOM] No file input found. Trying clipboard paste fallback...");
        // Strategy 2: Clipboard paste fallback
        try {
          const messageInput = document.querySelector('div[role="textbox"], div[contenteditable="true"]');
          if (messageInput) {
            messageInput.focus();
            const clipboardData = new DataTransfer();
            clipboardData.items.add(file);
            const pasteEvent = new ClipboardEvent('paste', {
              bubbles: true,
              cancelable: true,
              clipboardData: clipboardData
            });
            messageInput.dispatchEvent(pasteEvent);
            console.log("[DmDroid DOM] Clipboard paste event dispatched");
          } else {
            console.error("[DmDroid DOM] No textbox found for clipboard fallback either!");
          }
        } catch(pasteErr) {
          console.error("[DmDroid DOM] Clipboard paste fallback failed:", pasteErr);
        }
      }
    } catch(err) {
      console.error("[DmDroid DOM] Image injection failed:", err);
    }
  }
  async _getText(e, t) {
    e = await this._importNamespace(e);
    if (e) return (t = t.split(".").reduce((e, t) => (e ?? {})[t], e))?.props?.content?.[0] ?? t
  }
  async _isLoggedIn() {
    return (await this._importNamespace("polarisIsUserLoggedIn")).isUserLoggedIn()
  }
  async _formatMessages(e) {
    var t = await this._importDefault("bs_caml_int64"),
      s = await this._importNamespace("I64");
    return {
      senderId: t.to_string(s.of_string(e[10][1])),
      text: e[0]
    }
  }
  async _parseMessages(e) {
    if (Array.isArray(e)) {
      if (5 === e[0] && "upsertMessage" === e[1]) return [await this._formatMessages(e.slice(2))];
      var t = [];
      for (const s of e) t.push(...await this._parseMessages(s));
      return t
    }
    return []
  }
  async _getLastMessages() {
    var e = await this.domReactConnector.send("getMessages", {});
    const t = await this._importDefault("bs_caml_int64");
    return e.map(e => ({
      senderId: t.to_string(e.senderId),
      text: e.text
    }))
  }
  async prepareMessage(t) {
    var s = {},
      r = await this._importDefault("bs_caml_int64");
    for (const n in t) {
      let e = t[n];
      "i64" === e._tag && (e = r.to_string(e.value)), s[n] = e
    }
    return s
  }
  async _getLastMessagesUnsafe() {
    for (let e = 0; e < 10; e++) {
      var t = await this.domReactConnector.send("getMessagesUnsafe", {});
      if (t.length) {
        var s = [];
        for (const r of t) s.push(await this.prepareMessage(r));
        return s
      }
      await this.sleep(1e3)
    }
    return []
  }
  async _injectIntoChat() {
    var e = await this._importNamespace("IGDOverLSMqttChannel"),
      t = await this._importNamespace("LSPlatformDeviceId");
    e.getInstance(t.getDeviceIdForProviderType("ephemeral")).subscribe("/ls_resp", async e => {
      e = JSON.parse(e).payload, e = JSON.parse(e).step, e = await this._parseMessages(e);
      e.length && (this.lastMessages = e)
    })
  }
  async _checkResponse(e) {
    const t = await this._importNamespace("PolarisConsumerReduxStore").createConsumerStore(),
      s = await this._getUser();
    await this._importNamespace("PolarisDirectActionLoadThread").loadThread(e, {})(t.dispatch, t.getState);
    var r = t.getState().direct.threads.get(e),
      n = r.items.map(e => t.getState().direct.messages.get(e)),
      r = r.items[0];
    try {
      var a = await this._importNamespace("PolarisDirectLogger"),
        o = await this._importNamespace("PolarisDirectActionMarkSeen"),
        i = await this._importNamespace("PolarisDirectActionUpdateMediaSharesInThread");
      a.DirectLogger.logDirectClientEvent("direct_inbox_thread_impression", (await this._importNamespace("PolarisDirectLogger")).DIRECT_CONTAINER_MODULES.direct_inbox, {
        thread_id: e
      }), o.markSeen(e, r)(t.dispatch), i.updateMediaSharesInThread(e)(t.dispatch, t.getState)
    } catch (e) {
      console.error(e)
    }
    return !!n.find(({
      user_id: e
    }) => e !== s.id)
  }
  async _getUserById(e) {
    var t = await this._importNamespace("PolarisConsumerReduxStore"),
      s = await this._importNamespace("polarisUserSelectors"),
      t = t.createConsumerStore();
    return s.getUserById(t.getState(), e)
  }
  async _getUserByUsername(t) {
    try {
      var e = (await (await this._importNamespace("PolarisInstajax")).get_UNTYPED("https://www.instagram.com/api/v1/users/web_profile_info/?username=" + t)).data;
      return e.user
    } catch (e) {
      t = e?.statusCode;
      if (404 === t) throw Object.assign(e, { type: "user_not_found" });
      if (429 === t) throw Object.assign(e, { type: "rate_limited" });
      if (401 === t || 403 === t) throw Object.assign(e, { type: "auth_error" });
      throw e;
    }
  }
  async _importNamespace(t) {
    for (let e = 0; e < 15; e++) {
      var s = importNamespace(t);
      if (s) return s;
      await this.sleep(1e3)
    }
    throw new Error("Module not found")
  }
  async _importDefault(t) {
    for (let e = 0; e < 15; e++) {
      var s = importDefault(t);
      if (s) return s;
      await this.sleep(1e3)
    }
    throw new Error("Module not found")
  }
  async _getUser() {
    if (!(await this._importNamespace("PolarisConfig"))?.getViewerData_DO_NOT_USE?.()?.username) {
      const {
        id: s,
        username: e,
        profilePictureUrl: n
      } = await this.domReactConnector.send("getUser", {});
      return {
        username: e.startsWith("@") ? e.substring(1) : e,
        profile_pic_url: n,
        id: s
      }
    }
    let {
      username: e,
      profile_pic_url: t,
      id: s
    } = (await this._importNamespace("PolarisConfig")).getViewerData_DO_NOT_USE();
    var r;
    return "Instagram User" === e && (r = await this.domReactConnector.send("getUser", {}), e = r.username), {
      username: e.startsWith("@") ? e.substring(1) : e,
      profile_pic_url: t,
      id: s
    }
  }
  async _getInfo() {
    var e = await this._getUser();
    return {
      accounts: [{
        instagram_id: parseInt(e.id),
        username: e.username
      }],
      currentUser: e,
      oneTapLogin: !1
    }
  }
  sleep(t) {
    return t < 2e4 ? this.domConnector.send("sleep", {
      time: t
    }) : new Promise(e => setTimeout(e, t))
  }
  async _clickSwitchButton() {
    var e = document.querySelectorAll("span"),
      t = await this._getText("PolarisAuthStrings", "SWITCH_CTA_TEXT");
    for (const s of e) s.checkVisibility({
      checkOpacity: !0,
      checkVisibilityCSS: !0
    }) && t.trim() === s.innerHTML && s.click()
  }
  async _logSendMessageButtonSeen({
    isFollowing: e,
    userId: t
  }) {
    return await this._logOpenDirect({
      action: "button_impression",
      isFollowing: e,
      userId: t
    }), !0
  }
  async _logOpenDirect({
    action: e,
    isFollowing: t,
    userId: s
  }) {
    const r = await this._getUser();
    (await this._importDefault("PolarisInstagramProfileActionFalcoEvent")).log(function() {
      return {
        action: e,
        click_point: "message_button",
        containermodule: "profile",
        follow_status: t ? "following" : "not_following",
        ig_userid: r.id,
        profile_user_id: s
      }
    })
  }
  async _openDirect({
    isFollowing: e,
    userId: t
  }) {
    var s = (await this._importNamespace("PolarisConsumerReduxStore")).createConsumerStore();
    await this._logOpenDirect({
      action: "button_click",
      isFollowing: e,
      userId: t
    }), await (await this._importNamespace("PolarisDirectActionMessageFromProfile")).messageFromProfile(t)(s.dispatch, s.getState)
  }
  _importCredentials({
    indexedDb: e,
    localStorage: t,
    sessionStorage: s
  }) {
    return (new AccountDataKeeper).importCredentials({
      indexedDb: e,
      localStorage: t,
      sessionStorage: s
    })
  }
  _exportCredentials() {
    return (new AccountDataKeeper).exportCredentials()
  }
  async _switchAccountFromDirect({
    id: e
  }) {
    await this.domReactConnector.send("switchAccountFromDirect", {
      id: e
    })
  }
  async _switchAccountFromIndex({
    id: e
  }) {
    await this.domReactConnector.send("switchAccountFromIndex", {
      id: e
    })
  }
  async _getUserFromContacts({
    username: e
  }) {
    return this.domReactConnector.send("getUserFromContacts", {
      username: e
    })
  }
  async _checkResponseFromDOM({
    sinceMs: e = null
  } = {}) {
    return this.domReactConnector.send("checkResponseFromDOM", {
      sinceMs: e
    })
  }
  async _checkOutgoingMessageSentFromDOM({
    dateBeforeSend: e
  }) {
    return this.domReactConnector.send("checkOutgoingMessageSentFromDOM", {
      dateBeforeSend: e
    })
  }
  async _navigateToInbox() {
    var e = window.importNamespace?.("PolarisNavigationUtils");
    return !!e?.openURL && (e.openURL("/direct/inbox/"), !0)
  }
  async _switchAccount({
    id: e
  }) {
    const t = (await this._importNamespace("PolarisConsumerReduxStore")).createConsumerStore();
    if (this._getUser().id === e) return !1;
    var s = (await this._importNamespace("PolarisOneTapLoginStorage")).getLoginNonces()[e];
    if (!s) return !1;
    const r = s.nonce;
    if (!r) return !1;
    await this._clickSwitchButton(), await this.sleep(5e3);
    const n = await this._importNamespace("PolarisLoginActionOneTapLogin"),
      a = () => n.switchAccountLogin({
        userId: e,
        loginNonce: r,
        retry: a
      })(t.dispatch);
    return a(), !0
  }
}
class AccountDataKeeper {
  importFromJsonString(o, i) {
    return new Promise((r, t) => {
      var e = new Set(o.objectStoreNames);
      if (0 === e.size) r(null);
      else {
        const s = Array.from(e),
          n = o.transaction(s, "readwrite"),
          a = (n.onerror = e => t(e), JSON.parse(i));
        Object.keys(a).forEach(e => {
          s.includes(e) || delete a[e]
        }), 0 === Object.keys(a).length && r(null), s.forEach(t => {
          let s = 0;
          var e = Array.from(a[t] || []);
          a[t] && 0 < e.length ? e.forEach(e => {
            e = n.objectStore(t).add(e);
            e.onsuccess = () => {
              ++s === a[t].length && (delete a[t], 0 === Object.keys(a).length) && r(null)
            }, e.onerror = e => {
              console.log(e)
            }
          }) : a[t] && (delete a[t], 0 === Object.keys(a).length) && r(null)
        })
      }
    })
  }
  exportToJsonString(s) {
    return new Promise((r, t) => {
      const n = {};
      var e = new Set(s.objectStoreNames);
      if (0 === e.size) r(JSON.stringify(n));
      else {
        const a = Array.from(e),
          o = s.transaction(a, "readonly");
        o.onerror = e => t(e), a.forEach(t => {
          const s = [];
          o.objectStore(t).openCursor().onsuccess = e => {
            e = e.target.result;
            e ? (s.push(e.value), e.continue()) : (n[t] = s, a.length === Object.keys(n).length && r(JSON.stringify(n)))
          }
        })
      }
    })
  }
  clearDatabase(o) {
    return new Promise((s, r) => {
      var e = new Set(o.objectStoreNames);
      const n = e.size;
      if (0 === n) s(null);
      else {
        e = Array.from(e);
        const a = o.transaction(e, "readwrite");
        a.onerror = e => r(e);
        let t = 0;
        e.forEach(function(e) {
          a.objectStore(e).clear().onsuccess = () => {
            ++t === n && s(null)
          }
        })
      }
    })
  }
  async exportCredentials() {
    return {
      indexedDb: await this.exportIndexedDb(),
      localStorage: await this.getLocalStorage(),
      sessionStorage: await this.getSessionStorage()
    }
  }
  async importCredentials({
    indexedDb: e,
    localStorage: t,
    sessionStorage: s
  }) {
    return await this.clearIndexedDb(), await this.importIndexedDb(e), await this.clearLocalStorage(), await this.setLocalStorage(t), await this.clearSessionStorage(), await this.setSessionStorage(s), !0
  }
  async openIndexedDBConnection(r) {
    return new Promise((t, e) => {
      const s = indexedDB.open(r);
      s.onsuccess = function(e) {
        t(e.target.result)
      }, s.onerror = function() {
        e(s.error)
      }
    })
  }
  async exportIndexedDb() {
    var e, t = {};
    for ({
        name: e
      }
      of await indexedDB.databases()) {
      var s = await this.openIndexedDBConnection(e);
      t[e] = await this.exportToJsonString(s)
    }
    return t
  }
  async clearIndexedDb() {
    var e;
    for ({
        name: e
      }
      of await indexedDB.databases()) {
      var t = await this.openIndexedDBConnection(e);
      await this.clearDatabase(t)
    }
  }
  async importIndexedDb(e) {
    for (const s in e) {
      var t = await this.openIndexedDBConnection(s);
      await this.importFromJsonString(t, e[s])
    }
  }
  getLocalStorage() {
    return JSON.stringify(window.localStorage)
  }
  setLocalStorage(e) {
    var t = JSON.parse(e);
    for (const s in t) window.localStorage.setItem(s, t[s])
  }
  clearLocalStorage() {
    return window.localStorage.clear()
  }
  getSessionStorage() {
    return JSON.stringify(window.sessionStorage)
  }
  setSessionStorage(e) {
    var t = JSON.parse(e);
    for (const s in t) window.sessionStorage.setItem(s, t[s])
  }
  clearSessionStorage() {
    return window.sessionStorage.clear()
  }
  async getCacheStorage() {
    var e = {};
    for (const a of await window.caches.keys()) {
      var t = await window.caches.open(a),
        s = (e[a] = {}, await t.keys());
      for (const o of s) {
        var r = new URL(o.url),
          r = o.url.replace(r.origin, ""),
          n = await t.match(r);
        e[a][r] = await n.json()
      }
    }
    return JSON.stringify(e)
  }
  async cleanCacheStorage() {
    for (const s of await window.caches.keys()) {
      var e = await window.caches.open(s);
      for (const r of await e.keys()) {
        var t = new URL(r.url),
          t = r.url.replace(t.origin, "");
        await e.delete(t)
      }
    }
  }
  async setCacheStorage(e) {
    var t = JSON.parse(e);
    for (const r in t) {
      var s = await window.caches.open(r);
      for (const n in t[r]) s.put(n, new Response(JSON.stringify(t[r][n])))
    }
  }
}
new ADBlockDOM;
class ExtensionError extends Error {
  constructor({
    message: e,
    type: t
  }) {
    super(e), this.message = e, this.type = t
  }
}
const consoleMessages = {
    log: [],
    info: [],
    warn: [],
    error: [],
    debug: []
  },
  originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug
  };

function processArguments(e) {
  return e.filter(e => "string" == typeof e || e instanceof Error || e && "string" == typeof e.message && "string" == typeof e.stack).map(e => "string" == typeof e ? e : e instanceof Error || e && "string" == typeof e.message && "string" == typeof e.stack ? {
    errorMessage: e.message,
    errorStack: e.stack
  } : void 0)
}

function addConsoleMessage(e, t) {
  var t = processArguments(t);
  0 !== t.length && (t = {
    type: e,
    timestamp: (new Date).toISOString(),
    message: t
  }, consoleMessages[e].push(t), 10 < consoleMessages[e].length) && consoleMessages[e].shift()
}
console.log = function(...e) {
  addConsoleMessage("log", e), originalConsole.log.apply(console, e)
}, console.info = function(...e) {
  addConsoleMessage("info", e), originalConsole.info.apply(console, e)
}, console.warn = function(...e) {
  addConsoleMessage("warn", e), originalConsole.warn.apply(console, e)
}, console.error = function(...e) {
  addConsoleMessage("error", e), originalConsole.error.apply(console, e)
}, console.debug = function(...e) {
  addConsoleMessage("debug", e), originalConsole.debug.apply(console, e)
};
