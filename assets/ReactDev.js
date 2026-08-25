!(function () {
  class o {
    static rand(e, t) {
      return ((e = Math.ceil(e)), (t = Math.floor(t)), Math.floor(Math.random() * (t - e + 1)) + e);
    }
  }
  class l extends Error {
    constructor({ message: e, type: t }) {
      (super(e), (this.message = e), (this.type = t));
    }
  }
  const a = 60111,
    c = "Symbol(react.concurrent_mode)",
    m = "Symbol(react.context)",
    d = "Symbol(react.async_mode)";
  const h = "Symbol(react.profiler)",
    u = "Symbol(react.provider)",
    p = 60108,
    f = "Symbol(react.strict_mode)";
  const n = Symbol.for("react.element"),
    i = Symbol.for("react.portal"),
    g = Symbol.for("react.fragment"),
    _ = Symbol.for("react.strict_mode"),
    y = Symbol.for("react.profiler"),
    w = Symbol.for("react.provider"),
    b = Symbol.for("react.context"),
    O = Symbol.for("react.server_context"),
    D = Symbol.for("react.forward_ref"),
    S = Symbol.for("react.suspense"),
    T = Symbol.for("react.suspense_list"),
    C = Symbol.for("react.memo"),
    v = Symbol.for("react.lazy");
  (Symbol.for("react.scope"),
    Symbol.for("react.debug_trace_mode"),
    Symbol.for("react.offscreen"),
    Symbol.for("react.legacy_hidden"),
    Symbol.for("react.cache"));
  var e = Symbol.for("react.tracing_marker");
  (Symbol.for("react.default_value"), Symbol.for("react.memo_cache_sentinel"), Symbol.iterator);
  const r = b,
    s = w;
  n;
  const k = D,
    P = g,
    I = v,
    R = C,
    M = i,
    F = y,
    L = _,
    x = S,
    W = T,
    A = e;
  class N {
    constructor(e, t, r) {
      ((this._element = e), (this._tree = t), (this._isRoot = r));
    }
    _buildTreeFromFiberNode(t) {
      if (!t) return null;
      var r = {
        props: t.memoizedProps ? Object.keys(t.memoizedProps) : void 0,
        state: t.memoizedState ? Object.keys(t.memoizedState) : void 0,
        type: this._tree.getDisplayNameForFiber(t),
        classes: t.stateNode?.classList?.length ? Array.from(t.stateNode.classList) : void 0,
      };
      if (t.child) {
        let e = t.child;
        for (r.children = []; e; ) {
          var s = this._buildTreeFromFiberNode(e);
          (s && r.children.push(s), (e = e.sibling));
        }
      }
      return r;
    }
    toJSON() {
      var e = this._buildTreeFromFiberNode(this._element);
      return JSON.stringify(e);
    }
    _recursiveSearchNew(e, t) {
      return this._isRoot ? this._recursiveSearchSync(t) : this._recursiveSearchOld(e, t);
    }
    _recursiveSearchSync(e) {
      var t,
        r = [];
      for ([t] of this._tree.fiberToIDMap)
        t && -1 < this._tree.getDisplayNameForFiber(t)?.indexOf(e) && r.push(new N(t, this._tree));
      return r;
    }
    _recursiveSearch(e, t) {
      var r = [];
      return (
        -1 < this._tree.getDisplayNameForFiber(e)?.indexOf(t) && r.push(new N(e, this._tree)),
        e.child && r.push(...this._recursiveSearch(e.child, t)),
        e.sibling && r.push(...this._recursiveSearch(e.sibling, t)),
        r
      );
    }
    _recursiveSearchV2(t, r) {
      if (!t) return [];
      var s = [];
      if ((-1 < this._tree.getDisplayNameForFiber(t)?.indexOf(r) && s.push(new N(t, this._tree)), t.child)) {
        let e = t.child;
        for (; e; ) {
          var n = this._recursiveSearchV2(e, r);
          (n.length && s.push(...n), (e = e.sibling));
        }
      }
      return s;
    }
    findOne(e) {
      return this._recursiveSearchV2(this._element, e)[0];
    }
    findMany(e) {
      return this._recursiveSearchV2(this._element, e);
    }
    get element() {
      return this._element;
    }
  }
  class t extends class {
    constructor() {
      ((this._listeners = {}), (this._onceListeners = {}));
    }
    on(e, t) {
      (this._listeners[e] || (this._listeners[e] = []), this._listeners[e].push(t));
    }
    once(e, t) {
      (this._onceListeners[e] || (this._onceListeners[e] = []), this._onceListeners[e].push(t));
    }
    emit(e, ...t) {
      var r = [...(this._listeners[e] ?? []), ...(this._onceListeners[e] ?? [])];
      return ((this._onceListeners[e] = []), Promise.allSettled(r.map((e) => e(...t))));
    }
  } {
    constructor() {
      (super(),
        (this.reservedTasks = {}),
        (this.tasks = {}),
        window.addEventListener("message", async (e) => {
          if (e.source === window && "adblock:info:to-react" === e?.data?.type) {
            var e = JSON.parse(e.data.text),
              t = e.type,
              r = e.data;
            if ("basic" === t) {
              var s = r.type;
              if (this.tasks[s])
                try {
                  this.tasks[s](r.data);
                } catch (e) {
                  console.error(e);
                }
            } else if ("with_response" === t) {
              s = r.type;
              if (this.tasks[s]) {
                var n = {};
                try {
                  var o = await this.tasks[s](r.data);
                  ((n.success = !0), (n.result = o));
                } catch (e) {
                  (console.error(e),
                    (n.success = !1),
                    (n.error = { error: e?.error || e?.toString?.(), stack: e?.stack, type: e?.type }));
                }
                this.emit({ type: "response", id: e.id, result: n });
              }
            } else if ("response" === t) {
              ((s = e.id), (r = e.result));
              try {
                r.success ? this.reservedTasks[s]?.[0]?.(r.result) : this.reservedTasks[s]?.[1]?.(r.error);
              } catch (e) {
                console.error(e);
              } finally {
                delete this.reservedTasks[s];
              }
            }
          }
        }));
    }
    emit({ type: e, id: t, result: r, data: s }) {
      window.postMessage(
        { type: "adblock:info:to-inner-dom", text: JSON.stringify({ type: e, id: t, data: s, result: r }) },
        "*",
      );
    }
    send(s, n = {}) {
      return new Promise(async (e, t) => {
        var r = `${Date.now()}_${Math.random()}_` + Math.random();
        ((this.reservedTasks[r] = [e, t]), this.emit({ type: "with_response", id: r, data: { type: s, data: n } }));
      });
    }
    registerTask(e, t) {
      this.tasks[e] = t;
    }
  }
  const z = new (class {
    constructor() {
      ((this.fiberToIDMap = new Map()),
        (this.idToArbitraryFiberMap = new Map()),
        (this.uidCounter = 0),
        (this.currentRootID = -1),
        (this.mightBeOnTrackedPath = !1),
        (this.cachedDisplayNames = new WeakMap()),
        (this.rootDisplayNameCounter = new Map()),
        (this.rootPseudoKeys = new Map()),
        (this.ReactTypeOfWork = {
          CacheComponent: 24,
          ClassComponent: 1,
          ContextConsumer: 9,
          ContextProvider: 10,
          CoroutineComponent: -1,
          CoroutineHandlerPhase: -1,
          DehydratedSuspenseComponent: 18,
          ForwardRef: 11,
          Fragment: 7,
          FunctionComponent: 0,
          HostComponent: 5,
          HostPortal: 4,
          HostRoot: 3,
          HostHoistable: 26,
          HostSingleton: 27,
          HostText: 6,
          IncompleteClassComponent: 17,
          IndeterminateComponent: 2,
          LazyComponent: 16,
          LegacyHiddenComponent: 23,
          MemoComponent: 14,
          Mode: 8,
          OffscreenComponent: 22,
          Profiler: 12,
          ScopeComponent: 21,
          SimpleMemoComponent: 15,
          SuspenseComponent: 13,
          SuspenseListComponent: 19,
          TracingMarkerComponent: 25,
          YieldComponent: -1,
        }));
    }
    get root() {
      return this._root;
    }
    getUID() {
      return ++this.uidCounter;
    }
    getOrGenerateFiberID(e) {
      let t = null;
      if (this.fiberToIDMap.has(e)) t = this.fiberToIDMap.get(e);
      else {
        const s = e["alternate"];
        null !== s && this.fiberToIDMap.has(s) && (t = this.fiberToIDMap.get(s));
      }
      var r = (t = null === t ? this.getUID() : t);
      this.fiberToIDMap.has(e) || (this.fiberToIDMap.set(e, r), this.idToArbitraryFiberMap.set(r, e));
      const s = e["alternate"];
      return (null === s || this.fiberToIDMap.has(s) || this.fiberToIDMap.set(s, r), r);
    }
    getTypeSymbol(e) {
      e = "object" == typeof e && null !== e ? e.$$typeof : e;
      return "symbol" == typeof e ? e.toString() : e;
    }
    resolveFiberType(e) {
      switch (this.getTypeSymbol(e)) {
        case 60115:
        case "Symbol(react.memo)":
          return this.resolveFiberType(e.type);
        case 60112:
        case "Symbol(react.forward_ref)":
          return e.render;
        default:
          return e;
      }
    }
    typeOf(e) {
      if ("object" == typeof e && null !== e) {
        var t = e.$$typeof;
        switch (t) {
          case n:
            var r = e.type;
            switch (r) {
              case g:
              case y:
              case _:
              case S:
              case T:
                return r;
              default:
                var s = r && r.$$typeof;
                switch (s) {
                  case O:
                  case b:
                  case D:
                  case v:
                  case C:
                  case w:
                    return s;
                  default:
                    return t;
                }
            }
          case i:
            return t;
        }
      }
    }
    getDisplayName(e, t = "Anonymous") {
      var r = this.cachedDisplayNames.get(e);
      if (null != r) return r;
      let s = t;
      return (
        "string" == typeof e.displayName
          ? (s = e.displayName)
          : "string" == typeof e.name && "" !== e.name && (s = e.name),
        this.cachedDisplayNames.set(e, s),
        s
      );
    }
    getDisplayNameForReactElement(e) {
      switch (this.typeOf(e)) {
        case r:
          return "ContextConsumer";
        case s:
          return "ContextProvider";
        case k:
          return "ForwardRef";
        case P:
          return "Fragment";
        case I:
          return "Lazy";
        case R:
          return "Memo";
        case M:
          return "Portal";
        case F:
          return "Profiler";
        case L:
          return "StrictMode";
        case x:
          return "Suspense";
        case W:
          return "SuspenseList";
        case A:
          return "TracingMarker";
        default:
          var t = e["type"];
          return "string" == typeof t
            ? t
            : "function" == typeof t
              ? getDisplayName(t, "Anonymous")
              : null != t
                ? "NotImplementedInDevtools"
                : "Element";
      }
    }
    getWrappedDisplayName(e, t, r, s) {
      return e.displayName || `${r}(${this.getDisplayName(t, s)})`;
    }
    getDisplayNameForFiber(e) {
      if (!e) return null;
      var { elementType: t, type: r, tag: s } = e;
      let n = r,
        o = ("object" == typeof r && null !== r && (n = this.resolveFiberType(r)), null);
      switch (s) {
        case this.ReactTypeOfWork.CacheComponent:
          return "Cache";
        case this.ReactTypeOfWork.ClassComponent:
        case this.ReactTypeOfWork.IncompleteClassComponent:
          return this.getDisplayName(n);
        case this.ReactTypeOfWork.FunctionComponent:
        case this.ReactTypeOfWork.IndeterminateComponent:
          return this.getDisplayName(n);
        case this.ReactTypeOfWork.ForwardRef:
          return this.getWrappedDisplayName(t, n, "ForwardRef", "Anonymous");
        case this.ReactTypeOfWork.HostRoot:
          var i = e.stateNode;
          return null != i && null !== i._debugRootType ? i._debugRootType : null;
        case this.ReactTypeOfWork.HostComponent:
        case this.ReactTypeOfWork.HostSingleton:
        case this.ReactTypeOfWork.HostHoistable:
          return r;
        case this.ReactTypeOfWork.HostPortal:
        case this.ReactTypeOfWork.HostText:
          return null;
        case this.ReactTypeOfWork.Fragment:
          return "Fragment";
        case this.ReactTypeOfWork.LazyComponent:
          return "Lazy";
        case this.ReactTypeOfWork.MemoComponent:
        case this.ReactTypeOfWork.SimpleMemoComponent:
          return this.getWrappedDisplayName(t, n, "Memo", "Anonymous");
        case this.ReactTypeOfWork.SuspenseComponent:
          return "Suspense";
        case this.ReactTypeOfWork.LegacyHiddenComponent:
          return "LegacyHidden";
        case this.ReactTypeOfWork.OffscreenComponent:
          return "Offscreen";
        case this.ReactTypeOfWork.ScopeComponent:
          return "Scope";
        case this.ReactTypeOfWork.SuspenseListComponent:
          return "SuspenseList";
        case this.ReactTypeOfWork.Profiler:
          return "Profiler";
        case this.ReactTypeOfWork.TracingMarkerComponent:
          return "TracingMarker";
        default:
          switch (this.getTypeSymbol(r)) {
            case a:
            case c:
            case d:
              return null;
            case 60109:
            case u:
              return `${(o = e.type._context || e.type.context).displayName || "Context"}.Provider`;
            case 60110:
            case m:
            case "Symbol(react.server_context)":
              return `${(o = e.type._context || e.type).displayName || "Context"}.Consumer`;
            case p:
            case f:
              return null;
            case 60114:
            case h:
              return `Profiler(${e.memoizedProps.id})`;
            case 60119:
            case "Symbol(react.scope)":
              return "Scope";
            default:
              return null;
          }
      }
    }
    getDisplayNameForRoot(e) {
      let t = null,
        r = null,
        s = e.child;
      for (let e = 0; e < 3 && null !== s; e++) {
        var n = this.getDisplayNameForFiber(s);
        if ((null !== n && ("function" == typeof s.type ? (t = n) : null === r && (r = n)), null !== t)) break;
        s = s.child;
      }
      return t || r || "Anonymous";
    }
    setRootPseudoKey(e, t) {
      var t = this.getDisplayNameForRoot(t),
        r = this.rootDisplayNameCounter.get(t) || 0,
        t = (this.rootDisplayNameCounter.set(t, r + 1), t + ":" + r);
      this.rootPseudoKeys.set(e, t);
    }
    getElementTypeForFiber(e) {
      var { type: t, tag: e } = e;
      switch (e) {
        case this.ReactTypeOfWork.ClassComponent:
        case this.ReactTypeOfWork.IncompleteClassComponent:
          return 1;
        case this.ReactTypeOfWork.FunctionComponent:
        case this.ReactTypeOfWork.IndeterminateComponent:
          return 5;
        case this.ReactTypeOfWork.ForwardRef:
          return 6;
        case this.ReactTypeOfWork.HostRoot:
          return 11;
        case this.ReactTypeOfWork.HostComponent:
        case this.ReactTypeOfWork.HostHoistable:
        case this.ReactTypeOfWork.HostSingleton:
          return 7;
        case this.ReactTypeOfWork.HostPortal:
        case this.ReactTypeOfWork.HostText:
        case this.ReactTypeOfWork.Fragment:
          return 9;
        case this.ReactTypeOfWork.MemoComponent:
        case this.ReactTypeOfWork.SimpleMemoComponent:
          return 8;
        case this.ReactTypeOfWork.SuspenseComponent:
          return 12;
        case this.ReactTypeOfWork.SuspenseListComponent:
          return 13;
        case this.ReactTypeOfWork.TracingMarkerComponent:
          return 14;
        default:
          switch (this.getTypeSymbol(t)) {
            case a:
            case c:
            case d:
              return 9;
            case 60109:
            case u:
              return 2;
            case 60110:
            case m:
              return 2;
            case p:
            case f:
              return 9;
            case 60114:
            case h:
              return 10;
            default:
              return 9;
          }
      }
    }
    shouldFilterFiber(e) {
      var { _debugSource: e, tag: t, type: r, key: s } = e;
      switch (t) {
        case this.ReactTypeOfWork.DehydratedSuspenseComponent:
          return !0;
        case this.ReactTypeOfWork.HostPortal:
        case this.ReactTypeOfWork.HostText:
        case this.ReactTypeOfWork.LegacyHiddenComponent:
        case this.ReactTypeOfWork.OffscreenComponent:
          return !0;
        case this.ReactTypeOfWork.HostRoot:
          return !1;
        case this.ReactTypeOfWork.Fragment:
          return null === s;
        default:
          switch (this.getTypeSymbol(r)) {
            case a:
            case c:
            case d:
            case p:
            case f:
              return !0;
          }
      }
      if (null != e && 0 < hideElementsWithPaths.size) {
        var n = e["fileName"];
        for (const o of hideElementsWithPaths) if (o.test(n)) return !0;
      }
      return !1;
    }
    getFiberIDUnsafe(e) {
      return this.fiberToIDMap.has(e) || ((e = e.alternate), null !== e && this.fiberToIDMap.has(e))
        ? this.fiberToIDMap.get(e)
        : null;
    }
    getFiberIDThrows(e) {
      var t = this.getFiberIDUnsafe(e);
      if (null !== t) return t;
      throw Error(`Could not find ID for Fiber "${this.getDisplayNameForFiber(e) || ""}"`);
    }
    getFiberFlags(e) {
      return void 0 !== e.flags ? e.flags : e.effectTag;
    }
    didFiberRender(e, t) {
      switch (t.tag) {
        case this.ReactTypeOfWork.ClassComponent:
        case this.ReactTypeOfWork.FunctionComponent:
        case this.ReactTypeOfWork.ContextConsumer:
        case this.ReactTypeOfWork.MemoComponent:
        case this.ReactTypeOfWork.SimpleMemoComponent:
        case this.ReactTypeOfWork.ForwardRef:
          return 1 == (1 & this.getFiberFlags(t));
        default:
          return e.memoizedProps !== t.memoizedProps || e.memoizedState !== t.memoizedState || e.ref !== t.ref;
      }
    }
    unmountFiberChildrenRecursively(e) {
      var t = e.tag === this.ReactTypeOfWork.SuspenseComponent && null !== e.memoizedState;
      let r = e.child;
      for (t && ((e = (t = e.child) ? t.sibling : null), (r = e ? e.child : null)); null !== r; )
        (null !== r.return && this.unmountFiberChildrenRecursively(r), (r = r.sibling));
    }
    updateFiberRecursively(r, s, e, n) {
      var t = r.tag === this.ReactTypeOfWork.SuspenseComponent;
      let o = !1;
      var i,
        a = t && null !== s.memoizedState,
        t = t && null !== r.memoizedState;
      if (a && t) {
        var l = r.child,
          l = l ? l.sibling : null,
          c = s.child,
          c = c ? c.sibling : null;
        null != l && null != c && this.updateFiberRecursively(l, c, r, n) && (o = !0);
      } else if (a && !t) {
        l = r.child;
        (null !== l && this.mountFiberRecursively(l, r, !0, n), (o = !0));
      } else if (!a && t) {
        this.unmountFiberChildrenRecursively(s);
        ((c = r.child), (l = c ? c.sibling : null));
        null != l && (this.mountFiberRecursively(l, r, !0, n), (o = !0));
      } else if (r.child !== s.child) {
        let e = r.child,
          t = s.child;
        for (; e; )
          (e.alternate
            ? ((i = e.alternate), this.updateFiberRecursively(e, i, r, n) && (o = !0), i !== t && (o = !0))
            : (this.mountFiberRecursively(e, r, !1, n), (o = !0)),
            (e = e.sibling),
            o || null === t || (t = t.sibling));
        null !== t && (o = !0);
      }
      return (o, !1);
    }
    mountFiberRecursively(e, t, r, s) {
      let n = e;
      for (; null !== n; ) {
        this.getOrGenerateFiberID(n);
        var o = n.tag === this.ReactTypeOfWork.SuspenseComponent;
        if (o)
          if (null !== n.memoizedState) {
            ((o = n.child), (o = o ? o.sibling : null), (o = o ? o.child : null));
            null !== o && this.mountFiberRecursively(o, n, !0, s);
          } else {
            let e = null;
            (-1 === this.ReactTypeOfWork.OffscreenComponent ? (e = n.child) : null !== n.child && (e = n.child.child),
              null !== e && this.mountFiberRecursively(e, n, !0, s));
          }
        else null !== n.child && this.mountFiberRecursively(n.child, n, !0, s);
        n = r ? n.sibling : null;
      }
    }
    removeRootPseudoKey(e) {
      var t = this.rootPseudoKeys.get(e);
      if (void 0 === t) throw new Error("Expected root pseudo key to be known.");
      var t = t.slice(0, t.lastIndexOf(":")),
        r = this.rootDisplayNameCounter.get(t);
      if (void 0 === r) throw new Error("Expected counter to be known.");
      (1 < r ? this.rootDisplayNameCounter.set(t, r - 1) : this.rootDisplayNameCounter.delete(t),
        this.rootPseudoKeys.delete(e));
    }
    handleCommitFiberRoot(e, t) {
      var r,
        s = e.current,
        n = s.alternate;
      ((this.currentRootID = this.getOrGenerateFiberID(s)),
        (this._root = e.current),
        !n ||
        ((e = null != n.memoizedState && null != n.memoizedState.element && !0 !== n.memoizedState.isDehydrated),
        (r = null != s.memoizedState && null != s.memoizedState.element && !0 !== s.memoizedState.isDehydrated),
        !e && r)
          ? (this.setRootPseudoKey(this.currentRootID, s), this.mountFiberRecursively(s, null, !1, !1))
          : e && r
            ? this.updateFiberRecursively(s, n, null, !1)
            : e && !r && this.removeRootPseudoKey(this.currentRootID),
        (this.currentRootID = -1));
    }
    getTree() {
      return this.fiberToIDMap;
    }
  })();
  function B(o) {
    if (o.hasOwnProperty("__REACT_DEVTOOLS_GLOBAL_HOOK__")) return;
    let r = console,
      e = {};
    for (const g in console) e[g] = console[g];
    let s = null;
    function n({ hideConsoleLogsInStrictMode: o, browserTheme: i }) {
      if (null === s) {
        const t = {};
        ((s = () => {
          for (const e in t)
            try {
              r[e] = t[e];
            } catch (e) {}
        }),
          ["error", "group", "groupCollapsed", "info", "log", "trace", "warn"].forEach((s) => {
            try {
              const n = (t[s] = r[s].__REACT_DEVTOOLS_STRICT_MODE_ORIGINAL_METHOD__ || r[s]);
              var e = (...t) => {
                if (!o) {
                  let e;
                  switch (s) {
                    case "warn":
                      e = "light" === i ? "rgba(250, 180, 50, 0.75)" : "rgba(250, 180, 50, 0.5)";
                      break;
                    case "error":
                      e = "light" === i ? "rgba(250, 123, 130, 0.75)" : "rgba(250, 123, 130, 0.5)";
                      break;
                    default:
                      e = "light" === i ? "rgba(125, 125, 125, 0.75)" : "rgba(125, 125, 125, 0.5)";
                  }
                  if (!e) throw Error("Console color is not defined");
                  n(
                    ...((t = t),
                    (r = "color: " + e),
                    null == t ||
                    0 === t.length ||
                    ("string" == typeof t[0] && t[0].match(/([^%]|^)(%c)/g)) ||
                    void 0 === r
                      ? t
                      : "string" == typeof t[0] && t[0].match(/([^%]|^)((%%)*)(%([oOdisf]))/g)
                        ? ["%c" + t[0], r, ...t.slice(1)]
                        : [
                            t.reduce((e, t, r) => {
                              switch ((0 < r && (e += " "), typeof t)) {
                                case "string":
                                case "boolean":
                                case "symbol":
                                  return e + "%s";
                                case "number":
                                  return e + (Number.isInteger(t) ? "%i" : "%f");
                                default:
                                  return e + "%o";
                              }
                            }, "%c"),
                            r,
                            ...t,
                          ]),
                  );
                }
                var r;
              };
              (((e.__REACT_DEVTOOLS_STRICT_MODE_ORIGINAL_METHOD__ = n).__REACT_DEVTOOLS_STRICT_MODE_OVERRIDE_METHOD__ =
                e),
                (r[s] = e));
            } catch (e) {}
          }));
      }
    }
    let i = 0;
    let a = !1;
    const l = [],
      c = [];
    function m(e) {
      e = e.stack.split("\n");
      return 1 < e.length ? e[1] : null;
    }
    const d = {},
      h = new Map(),
      u = {},
      p = new Map();
    var t = new Map();
    const f = {
      rendererInterfaces: h,
      listeners: u,
      backends: t,
      renderers: p,
      emit: function (e, t) {
        u[e] && u[e].map((e) => e(t));
      },
      getFiberRoots: function (e) {
        var t = d;
        return (t[e] || (t[e] = new Set()), t[e]);
      },
      inject: function (e) {
        var t,
          r = ++i,
          s =
            (p.set(r, e),
            a
              ? "deadcode"
              : (function (e) {
                  try {
                    if ("string" == typeof e.version) return 0 < e.bundleType ? "development" : "production";
                    var t,
                      r = Function.prototype.toString;
                    if (e.Mount && e.Mount._renderNewRootComponent)
                      return 0 !== (t = r.call(e.Mount._renderNewRootComponent)).indexOf("function")
                        ? "production"
                        : -1 !== t.indexOf("storedMeasure")
                          ? "development"
                          : -1 !== t.indexOf("should be a pure function")
                            ? -1 === t.indexOf("NODE_ENV") &&
                              -1 === t.indexOf("development") &&
                              -1 === t.indexOf("true") &&
                              (-1 !== t.indexOf("nextElement") || -1 !== t.indexOf("nextComponent"))
                              ? "unminified"
                              : "development"
                            : -1 !== t.indexOf("nextElement") || -1 !== t.indexOf("nextComponent")
                              ? "unminified"
                              : "outdated";
                  } catch (e) {}
                  return "production";
                })(e)),
          n =
            (o.hasOwnProperty("__REACT_DEVTOOLS_CONSOLE_FUNCTIONS__") &&
              (({ registerRendererWithConsole: n, patchConsoleUsingWindowValues: t } =
                o.__REACT_DEVTOOLS_CONSOLE_FUNCTIONS__),
              "function" == typeof n) &&
              "function" == typeof t &&
              (n(e), t()),
            o.__REACT_DEVTOOLS_ATTACH__);
        return (
          "function" == typeof n && ((t = n(f, r, e, o)), f.rendererInterfaces.set(r, t)),
          f.emit("renderer", { id: r, renderer: e, reactBuildType: s }),
          r
        );
      },
      on: function (e, t) {
        (u[e] || (u[e] = []), u[e].push(t));
      },
      off: function (e, t) {
        u[e] && (-1 !== (t = u[e].indexOf(t)) && u[e].splice(t, 1), u[e].length || delete u[e]);
      },
      sub: function (e, t) {
        return (f.on(e, t), () => f.off(e, t));
      },
      supportsFiber: !0,
      checkDCE: function (e) {
        try {
          -1 < Function.prototype.toString.call(e).indexOf("^_^") &&
            ((a = !0),
            setTimeout(function () {
              throw new Error(
                "React is running in production mode, but dead code elimination has not been applied. Read how to correctly configure React for production: https://reactjs.org/link/perf-use-production-build",
              );
            }));
        } catch (e) {}
      },
      onCommitFiberUnmount: function (e, t) {
        null != (e = h.get(e)) && e.handleCommitFiberUnmount(t);
      },
      onCommitFiberRoot: function (e, t, r) {
        var e = f.getFiberRoots(e),
          s = t.current,
          n = e.has(t),
          s = null == s.memoizedState || null == s.memoizedState.element;
        n || s ? n && s && e.delete(t) : e.add(t);
        try {
          z.handleCommitFiberRoot(t, r);
        } catch (e) {
          console.error(e);
        }
      },
      onPostCommitFiberRoot: function (e, t) {
        null != (e = h.get(e)) && e.handlePostCommitFiberRoot(t);
      },
      setStrictMode: function (e, t) {
        null != (e = h.get(e))
          ? t
            ? e.patchConsoleForStrictMode()
            : e.unpatchConsoleForStrictMode()
          : t
            ? n({
                hideConsoleLogsInStrictMode: !0 === window.__REACT_DEVTOOLS_HIDE_CONSOLE_LOGS_IN_STRICT_MODE__,
                browserTheme: window.__REACT_DEVTOOLS_BROWSER_THEME__,
              })
            : null !== s && (s(), (s = null));
      },
      getInternalModuleRanges: function () {
        return c;
      },
      registerInternalModuleStart: function (e) {
        null !== (e = m(e)) && l.push(e);
      },
      registerInternalModuleStop: function (e) {
        var t;
        0 < l.length && ((t = l.pop()), null !== (e = m(e))) && c.push([t, e]);
      },
    };
    (Object.defineProperty(o, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
      configurable: !1,
      enumerable: !1,
      get() {
        return f;
      },
    }),
      f);
  }
  if (
    (new (class {
      registerTasks() {
        (this.innerDomConnector.registerTask("clickDialogButton", () => this._clickDialogButton()),
          this.innerDomConnector.registerTask("findSearchResult", () => this._findSearchResult()),
          this.innerDomConnector.registerTask("clickChat", () => this._clickChat()),
          this.innerDomConnector.registerTask("test1", ({ id: e }) => this._test1(e)),
          this.innerDomConnector.registerTask("getMessages", () => this._getMessages()),
          this.innerDomConnector.registerTask("getReactTree", () => this._getReactTree()),
          this.innerDomConnector.registerTask("getMessagesUnsafe", () => this._getMessagesUnsafe()),
          this.innerDomConnector.registerTask("checkNotificationModalAndClick", () =>
            this._checkNotificationModalAndClick(),
          ),
          this.innerDomConnector.registerTask("enterUsername", ({ username: e }) =>
            this._enterUsername({ username: e }),
          ),
          this.innerDomConnector.registerTask("inputSearch", ({ username: e }) => this._inputSearch({ username: e })),
          this.innerDomConnector.registerTask("getUserFromContacts", ({ username: e }) =>
            this._getUserFromContacts({ username: e }),
          ),
          this.innerDomConnector.registerTask("debug", ({ chain: e }) => this._debug({ chain: e })),
          this.innerDomConnector.registerTask("clickOnUser", ({ threadId: e, userId: t }) =>
            this._clickOnUser({ threadId: e, userId: t }),
          ),
          this.innerDomConnector.registerTask("switchAccountFromDirect", ({ id: e }) =>
            this._switchAccountFromDirect({ id: e }),
          ),
          this.innerDomConnector.registerTask("switchAccountFromIndex", ({ id: e }) =>
            this._switchAccountFromIndex({ id: e }),
          ),
          this.innerDomConnector.registerTask("getFollowers", ({ username: e, id: t, limit: r }) =>
            this._getFollowers({ username: e, id: t, limit: r }),
          ),
          this.innerDomConnector.registerTask("getFollowing", ({ username: e, id: t, limit: r }) =>
            this._getFollowing({ username: e, id: t, limit: r }),
          ),
          this.innerDomConnector.registerTask("openChatFromProfile", ({ username: e, id: t }) =>
            this._openChatFromProfile({ username: e, id: t }),
          ),
          this.innerDomConnector.registerTask("getUser", () => this._getUser()),
          this.innerDomConnector.registerTask("preTaskHooks", () => this._preTaskHooks()),
          this.innerDomConnector.registerTask("getAllMessages", () => this._getAllMessages()),
          this.innerDomConnector.registerTask("checkResponseFromDOM", ({ sinceMs: e } = {}) =>
            this._checkResponseFromDOM({ sinceMs: e }),
          ),
          this.innerDomConnector.registerTask("checkOutgoingMessageSentFromDOM", ({ text: e, dateBeforeSend: t }) =>
            this._checkOutgoingMessageSentFromDOM({ text: e, dateBeforeSend: t }),
          ),
          this.innerDomConnector.registerTask("getDebugMessages", () => this._getDebugMessages()),
          this.innerDomConnector.registerTask("closeOpenDialogModal", () => this._closeOpenDialogModal()),
          this.innerDomConnector.registerTask("getUserThread", ({ username: e }) =>
            this._getUserThread({ username: e }),
          ),
          this.innerDomConnector.registerTask("alternativeSearchResultsMapping", ({ username: e }) =>
            this._alternativeSearchResultsMapping({ username: e }),
          ),
          this.innerDomConnector.registerTask("detectInstagramError", () => this._detectInstagramError()));
      }
      constructor(e) {
        ((this._tree = e), (this.innerDomConnector = new t()), this.registerTasks(), setTimeout(() => {}, 5e3));
      }
      async _debug({ chain: e }) {
        let t = this.root;
        for (var { type: r, value: s, args: n = [] } of e) ((t = t[s]), "execute" === r && (t = t(...n)));
        let o = "No result";
        try {
          o = JSON.stringify(o);
        } catch (e) {
          o = Object.keys(o);
        }
        return o;
      }
      async _test1(t) {
        var e = this.root.findOne("MWPBaseThreadList.react").element.memoizedState.memoizedState[1][0];
        (await e.runInTransaction(function (e) {
          return require("LSVerifyThreadRowExists")(
            t,
            require("I64").of_int32(1),
            require("I64").of_int32(1),
            require("LSFactory")(e),
          );
        }, "readwrite"),
          this.root
            .findOne("IGDThreadListNewMessageDialogButton.react")
            .element.memoizedState.memoizedState[0].openInbox(
              { clientThreadKey: t, threadKey: t, threadType: [0, 1] },
              "inboxNewMessage",
            ),
          await this.sleep(5e3),
          console.log(this.root.findOne("IGDOpenThreadContainer.react")),
          await this.sleep(5e3),
          console.log(
            await require("ReQL").toArrayAsync(require("ReQL").fromTableAscending(e.table("messages")).getKeyRange(t)),
          ));
      }
      checkObj(e) {
        if (e && "object" == typeof e)
          for (const t in e) {
            if (-1 < t?.indexOf?.("openInbox")) return !0;
            if (e[t] && "object" == typeof e[t]) return this.checkObj(e[t]);
          }
        return !1;
      }
      _recursiveSearch(e) {
        var t = [];
        return (e?.memoizedProps && this.checkObj(e.memoizedProps)) ||
          (e?.memoizedState && this.checkObj(e.memoizedState))
          ? e
          : (e.child && t.push(...this._recursiveSearch(e.child)),
            e.sibling && t.push(...this._recursiveSearch(e.sibling)),
            e.return && t.push(...this._recursiveSearch(e.return)),
            t);
      }
      sleep(t) {
        return t < 2e4 ? this.innerDomConnector.send("sleep", { time: t }) : new Promise((e) => setTimeout(e, t));
      }
      get root() {
        return new N(this._tree.root, this._tree, !0);
      }
      async _checkNotificationModalAndClick() {
        var e = this.root.findOne("PolarisNotificationsScreenModal.react");
        e && (await e.element?.memoizedProps?.onClose?.(), await this.sleep(2e3));
      }
      async _getReactTree() {
        return this.root.toJSON();
      }
      _detectInstagramError() {
        return Boolean(this.root.findOne("PolarisHttp500UnexpectedErrorPage.react"));
      }
      async _clickDialogButton() {
        var e;
        location.href.includes("instagram.com/direct/t/") &&
          (e = document.querySelector('[href="/direct/inbox/"]')) &&
          (e.click(), await this.sleep(2e3));
        for (let e = 0; e < 10; e++) {
          if (
            this.root.findOne("IGDThreadListNewMessageDialogButton.react")?.findOne("BaseButton.react")?.element?.return
              ?.memoizedProps?.onClick
          )
            return (
              this.root
                .findOne("IGDThreadListNewMessageDialogButton.react")
                .findOne("BaseButton.react")
                .element.return.memoizedProps.onClick(),
              !0
            );
          await this.sleep(1e3);
        }
        for (let e = 0; e < 3; e++) {
          if (
            this.root.findOne("IGDThreadListNewMessageDialogButton.react")?.findOne("BaseButton.react")?.element
              ?.memoizedProps?.onClick
          )
            return (
              this.root
                .findOne("IGDThreadListNewMessageDialogButton.react")
                .findOne("BaseButton.react")
                .element.memoizedProps.onClick(),
              !0
            );
          await this.sleep(1e3);
        }
        for (let e = 0; e < 3; e++) {
          if (
            this.root.findOne("IGDThreadListNewMessageDialogEntrypointProvider")?.findOne("CometPressable.react")
              ?.element?.memoizedProps?.onPress
          )
            return (
              this.root
                .findOne("IGDThreadListNewMessageDialogEntrypointProvider")
                .findOne("CometPressable.react")
                .element.memoizedProps.onPress(),
              !0
            );
          await this.sleep(1e3);
        }
        for (let e = 0; e < 3; e++) {
          if (
            this.root.findOne("IGDThreadListNewMessageDialogButton")?.findOne("IGDSIconButton.react")?.element
              ?.memoizedProps?.onClick
          )
            return (
              this.root
                .findOne("IGDThreadListNewMessageDialogButton")
                .findOne("IGDSIconButton.react")
                .element.memoizedProps.onClick(),
              !0
            );
          await this.sleep(1e3);
        }
        var t = [
          "New message",
          "Nuevo mensaje",
          "Nouvelle conversation",
          "Neue Nachricht",
          "Nova mensagem",
          "Nuovo messaggio",
          "Nieuw bericht",
        ]
          .map((e) => `[aria-label="${e}"]`)
          .join(", ");
        for (let e = 0; e < 3; e++) {
          var r = document.querySelector(t);
          if (r?.parentNode) return (r.parentNode.click(), !0);
          await this.sleep(1e3);
        }
        return !1;
      }
      _findDialog() {
        var e = this.root.findOne("IGDThreadListNewMessageDialog.react");
        return e || this.root.findOne("IGDOmniPickerGQLDialog.react") || null;
      }
      _findSearchResultsList() {
        var e = this.root.findOne("IGDAWContactSearchResultList.react");
        return e || this.root.findOne("IGDOmniPickerSearchResultsList.react") || null;
      }
      async _enterUsername({ username: t }) {
        for (let e = 0; e < 10 && !this._findDialog(); e++) await this.sleep(1e3);
        var e = this._findDialog();
        if (!e) throw new Error("TextBox was not found");
        if (e.findOne("PolarisDOMListener.react")?.element?.sibling?.sibling?.memoizedProps?.onChange)
          return (
            e
              .findOne("PolarisDOMListener.react")
              .element.sibling.sibling.memoizedProps.onChange({ target: { value: t } }),
            !0
          );
        var r =
          e.findOne("IGDirectSearchUserContainerTokenField") || e.findOne("IGDirectV3SearchUserContainerTokenField");
        if (r)
          try {
            var s = r.findOne("IGDSBox.react").findOne("IGDSBox.react").element.child.child.child.child.sibling;
            if (!s) {
              var n = e.findOne("IGDSTextInput.react");
              if (n?.element?.memoizedProps?.onChange)
                return (n.element.memoizedProps.onChange({ target: { value: t } }), !0);
              throw new Error("tokenField chain broken and no IGDSTextInput found");
            }
            for (let e = 0; e < t.length; ++e)
              (s.memoizedProps.onChange({ target: { value: t.substring(0, e + 1) } }),
                await this.sleep(o.rand(50, 150)));
            return !0;
          } catch (e) {}
        r = document.querySelector(
          '[aria-label="New message"] input[name="queryBox"], [role="dialog"] input[placeholder="Search..."]',
        );
        return (
          !!r &&
          (Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(r, t),
          r.dispatchEvent(new Event("input", { bubbles: !0 })),
          !0)
        );
      }
      _findSearchResult() {
        try {
          var e = (
            this.root.findOne("IGDAWContactSearchResultList.react")?.findMany("IGDContactSearchResult.react") ?? []
          ).map((e) => e.element.memoizedProps.candidate);
          if (e.length) return e;
        } catch (e) {}
        try {
          var t = (
            this.root
              .findOne("IGDAWContactSearchResultList.react")
              ?.findMany("IGDSupershareContactSearchResult.react") ?? []
          ).map((e) => e.element.memoizedProps.candidate);
          if (t.length) return t;
        } catch (e) {}
        try {
          var r =
              this.root
                .findOne("IGDAWContactSearchResultList.react")
                ?.findOne("IGDSBox.react")
                ?.findOne("IGDSBox.react")?.element?.return?.memoizedProps?.children?.[0] ?? [],
            s = [];
          for (const l of r) s.push(l.props.candidate);
          if (s.length) return s;
        } catch (e) {}
        try {
          var n = this.root.findOne("IGDAWContactSearchResultList.react")?.findMany("IGDSListItem.react") ?? [];
          if (n.length) {
            var o = n
              .map((e) => {
                return e.element.memoizedProps?.title?.props?.candidate || e.element.return?.memoizedProps?.candidate;
              })
              .filter((e) => e);
            if (o.length) return o;
          }
        } catch (e) {}
        try {
          var i = this.root.findOne("IGDAWContactSearchResultList.react"),
            a = this.root.findOne("IGDOmniPickerSearchResultsList.react");
          let e = [];
          if (
            (e = (e =
              !(e = a ? (a.findMany("IGDRecipientUserListItem") ?? []) : e).length && i
                ? (i.findMany("IGDRecipientUserListItem") ?? [])
                : e).length
              ? e
              : (this.root.findMany("IGDRecipientUserListItem") ?? [])).length
          )
            return e.map((e) => {
              var t = e.element.memoizedProps?.recipientFragmentRef?.__id?.split(":")?.[1],
                { displayName: e, username: r } = this._getRecipientListItemText({ item: e });
              return { type: "user", candidate: { subtext: r, igid: t, displayName: e } };
            });
        } catch (e) {}
        return [];
      }
      _getRecipientListItemText({ item: e }) {
        const t = (e) =>
            String(e || "")
              .replace(/\s+/g, " ")
              .trim(),
          r = (e) => (e ? (e.stateNode instanceof HTMLElement ? e.stateNode : r(e.child)) : null);
        ((e = r(e.element)), (e = e?.closest?.('[role="option"]') || e));
        if (!e) return { displayName: null, username: null };
        var s = String(e.innerText || "")
          .split(/\n+/)
          .map(t)
          .filter(Boolean)
          .filter((e) => "Verified" !== e);
        if (2 <= s.length) return { displayName: s[0], username: s[1] };
        const n = [];
        return (
          e.querySelectorAll("span").forEach((e) => {
            e = t(e.textContent)
              .replace(/\bVerified\b/g, "")
              .trim();
            e && !n.includes(e) && n.push(e);
          }),
          { displayName: n[0] || null, username: n[1] || n[0] || null }
        );
      }
      async _alternativeSearchResultsMapping({ username: t }) {
        // Fail soft: server_search_results is an IG in-memory ReStore table that
        // may not exist (no search populated it, IG relocated it, or hooks didn't
        // inject cleanly). _getDatabase -> _findReStoreTable THROWS when missing;
        // an unhandled throw here used to kill the whole task before the search
        // dialog was closed, stacking search boxes across retries. Returning null
        // instead lets the primary fiber read (findSearchResult) win. Mirrors the
        // existing catch in _getUserFromContacts.
        try {
          const r = await this._importDefault("bs_caml_int64");
          return (await this._getDatabase("server_search_results"))
            .map((e) => this._formatData({ data: e, bs_caml_int64: r }))
            .find((e) => e.contextLine === t);
        } catch (e) {
          return (console.warn("[ColdDMs] _alternativeSearchResultsMapping: ReStore unavailable, returning null", e), null);
        }
      }
      async _clickOnUser({ threadId: t, userId: r }) {
        try {
          let e = this.root.findOne("IGDAWContactSearchResultList.react")?.findMany("IGDContactSearchResult.react");
          if (
            (e = e?.length
              ? e
              : this.root
                  .findOne("IGDAWContactSearchResultList.react")
                  ?.findMany("IGDSupershareContactSearchResult.react"))?.length
          )
            for (const d of e)
              if (
                (t && d.element.memoizedProps.candidate.candidate.id === t) ||
                (r && d.element.memoizedProps.candidate.candidate.igid === r)
              ) {
                if (d.findOne("BaseButton.react")?.element?.memoizedProps?.onClick)
                  return (d.findOne("BaseButton.react").element.memoizedProps.onClick(), !0);
                if (d.findOne("WebPressable.react")?.element?.memoizedProps?.onClick)
                  return (d.findOne("WebPressable.react").element.memoizedProps.onClick(), !0);
                if (d.findOne("CometPressable.react")?.element?.memoizedProps?.onPress)
                  return (d.findOne("CometPressable.react").element.memoizedProps.onPress(), !0);
              }
        } catch (e) {}
        try {
          var e = this.root
            .findOne("IGDAWContactSearchResultList.react")
            ?.findOne("IGDSBox.react")
            ?.findOne("IGDSBox.react")?.element?.return?.memoizedProps?.children?.[0];
          if (e)
            for (const h of e)
              if ((t && h.props.candidate.candidate.id === t) || (r && h.props.candidate.candidate.igid === r))
                return (h.props.onPress(), !0);
        } catch (e) {}
        try {
          for (const u of this.root.findOne("IGDAWContactSearchResultList.react")?.findMany("IGDSListItem.react") ??
            []) {
            var s = u.element.memoizedProps?.title?.props?.candidate || u.element.return?.memoizedProps?.candidate;
            if (s) {
              var n = s?.candidate?.igid,
                o = s?.candidate?.id;
              if ((r && String(n) === String(r)) || (t && String(o) === String(t))) {
                if (u.element.memoizedProps?.onPress)
                  return (u.element.memoizedProps.onPress({ preventDefault() {}, stopPropagation() {} }), !0);
                var i =
                  u.findOne("CometPressable.react") || u.findOne("WebPressable.react") || u.findOne("BaseButton.react");
                if (i?.element?.memoizedProps?.onPress)
                  return (i.element.memoizedProps.onPress({ preventDefault() {}, stopPropagation() {} }), !0);
                if (i?.element?.memoizedProps?.onClick) return (i.element.memoizedProps.onClick(), !0);
              }
            }
          }
        } catch (e) {}
        try {
          var a = this.root.findOne("IGDOmniPickerSearchResultsList.react"),
            l = this.root.findOne("IGDAWContactSearchResultList.react");
          let e = [];
          for (const p of (e = (e =
            !(e = a ? (a.findMany("IGDRecipientUserListItem") ?? []) : e).length && l
              ? (l.findMany("IGDRecipientUserListItem") ?? [])
              : e).length
            ? e
            : (this.root.findMany("IGDRecipientUserListItem") ?? []))) {
            var c = p.element.memoizedProps?.recipientFragmentRef?.__id?.split(":")?.[1];
            if (r && String(c) === String(r)) {
              var m = p.findOne("CometPressable.react");
              if (m?.element?.memoizedProps?.onPress)
                return (m.element.memoizedProps.onPress({ preventDefault() {}, stopPropagation() {} }), !0);
            }
          }
        } catch (e) {}
        throw new Error("Not Found");
      }
      _getState() {
        var e = this.root.findOne("PolarisAppWrapper.react");
        if (e) return e.element.memoizedProps?.store?.getState?.();
        throw new Error("No wrapper");
      }
      async _getUser() {
        var e = this._getState();
        if (!e) throw new Error("No state");
        var t = e.users.viewerId;
        if (!t) throw new Error("No viewerId");
        e = e.users?.users?.toJSON?.();
        if (!e) throw new Error("No users in state");
        e = e[t];
        if (e) return e;
        throw new Error("No user in state");
      }
      async _getMessages() {
        for (let e = 0; e < 15 && !this.root.findMany("MWPBaseMessage.react").length; e++) await this.sleep(1e3);
        if (!this.root.findMany("MWPBaseMessage.react").length) throw new Error("No messages");
        var e = [];
        for (const t of this.root.findMany("MWPBaseMessage.react"))
          e.push({ senderId: t.element.memoizedProps.message.senderId, text: t.element.memoizedProps.message.text });
        return e;
      }
      async _preTaskHooks() {
        try {
          await this._closeModal();
        } catch (e) {
          console.error(e);
        }
        try {
          this.root.findOne("PolarisSearchBoxTextInput.react") && (await this._clickSearchMenu());
        } catch (e) {
          console.error(e);
        }
      }
      async _switchAccountFromIndex({ id: t }) {
        var e = this.root.findOne("PolarisFeedSidebarWrapper.next.react")?.findOne("IGDSButton.react");
        if (!e) throw new Error("No switch button");
        (await e.element.memoizedProps.onClick(), await this.sleep(5e3));
        for (let e = 0; e < 10; e++) {
          const s = this.root.findOne("PolarisSwitchAccountsModalLegacyBody.react").findMany("IGDSListItem.react");
          var r = s.find((e) => e.element.return?.memoizedProps?.userId === t.toString());
          if (r) return void r.element.return.memoizedProps.onClick();
          await this.sleep(1e3);
        }
        const s = this.root
          .findOne("PolarisSwitchAccountsModalLegacyBody.react")
          .findMany("IGDSListItem.react")
          .map((e) => e.element.return?.memoizedProps?.userId)
          .filter(Boolean);
        throw new Error("User was not found, found only: " + s.join(", "));
      }
      async _switchAccountFromDirect({ id: t }) {
        var e = this.root.findOne("IGDThreadListHeaderAccountSwitcher.react");
        if (!e) throw new Error("Switch accounts button was not found");
        (await e.findOne("BaseButton.react").element.memoizedProps.onClick(), await this.sleep(5e3));
        for (let e = 0; e < 10; e++) {
          var r = this.root
            .findMany("PolarisSwitchAccountsModalLegacyBody.react")
            .filter((e) => e.element.key === t.toString())?.[0];
          if (r) return void r.element.memoizedProps.onClick();
          await this.sleep(1e3);
        }
        e = this.root.findMany("PolarisSwitchAccountsModalLegacyBody.react").map((e) => e.element.key);
        throw new Error("User was not found, found only: " + e.join(", "));
      }
      async _clickSearchMenu() {
        for (let e = 0; e < 10; e++) {
          var t = this.root.findOne("PolarisSearchNavItem.react");
          if (t) return (await t.findOne("PolarisFastLink.react").element.memoizedProps.onClick(), !0);
          await this.sleep(1e3);
        }
        return !1;
      }
      async _waitForUserToOpen({ username: t }) {
        for (let e = 0; e < 10; e++) {
          if (this.root.findOne("PolarisProfilePageContent.react")?.element?.memoizedProps?.username === t) return !0;
          await this.sleep(1e3);
        }
        throw new Error("User page was not opened");
      }
      async _openUserFromSearch({ username: e, id: t }) {
        if (await this._clickSearchMenu())
          return (
            await this.sleep(5e3),
            this._inputUsersSearch({ username: e }),
            await this.sleep(2e3),
            this._searchClickOnUser({ id: t, username: e })
          );
        throw new l({ type: "open_search_menu_error", message: "Unable to find user" });
      }
      async _getFollowers({ username: e, id: t, limit: r }) {
        if (!(await this._openUserFromSearch({ username: e, id: t })))
          throw new l({ type: "search_user_click_error", message: "Unable to click user" });
        (await this._clickOnFollowers({ type: "followers" }), await this.sleep(5e3));
        e = await this._parseUserList({ limit: r });
        return (await this._closeModal(), e);
      }
      async _getFollowing({ username: e, id: t, limit: r }) {
        if (!(await this._openUserFromSearch({ username: e, id: t })))
          throw new l({ type: "search_user_click_error", message: "Unable to click user" });
        (await this._clickOnFollowers({ type: "following" }), await this.sleep(5e3));
        e = await this._parseUserList({ limit: r });
        return (await this._closeModal(), e);
      }
      _inputUsersSearch({ username: e }) {
        this.root.findOne("PolarisSearchBoxTextInput.react").element.memoizedProps.onChange({ target: { value: e } });
      }
      _getInstagramPressEvent() {
        return new (class {
          constructor(e) {
            for (const t in e) this[t] = e[t];
            ((this._targetInst = ""),
              (this._reactName = "onPointerDown"),
              (this.nativeEvent = e),
              (this.target = null),
              (this.currentTarget = null),
              (this.timeStamp = Date.now()),
              (this.isDefaultPrevented = () => !0),
              (this.isPropagationStopped = () => !0));
          }
          preventDefault() {}
          stopPropagation() {}
          persist() {}
          isPersistent() {}
        })(new PointerEvent("click"));
      }
      async _searchClickOnUser({ id: t, username: r }) {
        for (let e = 0; e < 10; e++) {
          var s,
            n = this.root.findMany("PolarisSearchResultUserItem.next.react");
          if (n.length)
            return (
              (s = (n = n.find((e) => e.element.memoizedProps.fragmentKey.pk === String(t))).findOne("BaseLink.react")),
              (n = n.findOne("WebPressable.react")),
              await s.element.memoizedProps.onHoverChange(!0),
              await this.sleep(100),
              await n.element.memoizedProps.onPress(this._getInstagramPressEvent()),
              await this._waitForUserToOpen({ username: r }),
              !0
            );
          await this.sleep(1e3);
        }
        return !1;
      }
      async _closeModal() {
        await this.root.findOne("IGDSDialog.react")?.element?.memoizedProps?.onClose?.();
      }
      async _clickOnFollowers({ type: e }) {
        if (!["following", "followers"].includes(e)) throw new Error("Unsupported type");
        var t = "followers" === e ? "FollowedBy" : "Follows";
        let r = null;
        for (let e = 0; e < 10; e++) {
          if (this.root.findOne(`Polaris${t}Statistic.react`)) {
            r = this.root.findOne(`Polaris${t}Statistic.react`);
            break;
          }
          await this.sleep(1e3);
        }
        if (!r) throw new l({ type: "open_followers_popup_error", message: t + " button was not found" });
        e = r.findOne("PressableText.react");
        if (!e) throw new l({ type: "open_followers_popup_error", message: t + " button is unpressable" });
        (await e.element.memoizedProps.onHoverStart(),
          await this.sleep(200),
          await e.element.memoizedProps.onPress(this._getInstagramPressEvent()));
      }
      _getFollowersIDsFromListV2() {
        var e = this.root.findMany("PolarisFollowerListItem.next.react");
        return e.length ? e.map((e) => e.element.memoizedProps.user.pk) : [];
      }
      async _parseUserListV1({ limit: n = 100 } = {}) {
        try {
          let s = this.root.findOne("PolarisUserList.react");
          for (let e = 0; e < 10; e++) {
            if (this.root.findOne("PolarisUserList.react")) {
              s = this.root.findOne("PolarisUserList.react");
              break;
            }
            await this.sleep(1e3);
          }
          for (let e = 0; e < 10 && !s.element.memoizedProps?.userIds?.length; e++) await this.sleep(1e3);
          if (!s.element.memoizedProps?.userIds?.length) throw new Error("Followers loading error");
          if (this.root.findOne("PolarisInfiniteScroll.react")?.element?.memoizedProps?.hasNext) {
            let t = s.element.memoizedProps.userIds.length,
              r = 0;
            for (let e = 0; e < 1e3; e++) {
              var o = this.root.findOne("PolarisInfiniteScroll.react");
              if (!o) break;
              await o.element.memoizedProps.handleLoadNext?.();
              for (let e = 0; e < 10; e++) {
                if (!(s.element.memoizedProps.userIds.length <= t)) break;
                await this.sleep(1e3);
              }
              if (
                (s.element.memoizedProps.userIds.length <= t
                  ? r++
                  : ((t = s.element.memoizedProps.userIds.length), (r = 0), await this.sleep(500)),
                s.element.memoizedProps.userIds.length >= n || 5 < r)
              )
                break;
            }
            var e,
              i = this._getState();
            if (i)
              return (
                (e = i.users.users.toJSON()),
                { result: Object.values(e).filter((e) => s.element.memoizedProps.userIds.includes(e.id)), limited: !1 }
              );
          } else {
            var t,
              r = this._getState();
            if (r)
              return (
                (t = r.users.users.toJSON()),
                { result: Object.values(t).filter((e) => s.element.memoizedProps.userIds.includes(e.id)), limited: !0 }
              );
          }
          throw new Error("No state");
        } catch (e) {
          throw new l({ type: "parsing_error", message: "Error while parsing list" });
        }
      }
      async _parseUserListV2({ limit: s = 100 } = {}) {
        try {
          for (let e = 0; e < 10; e++) {
            if (this._getFollowersIDsFromListV2().length) break;
            await this.sleep(1e3);
          }
          if (!this._getFollowersIDsFromListV2().length) throw new Error("Followers loading error");
          if (!this.root.findOne("PolarisInfiniteScroll.react")?.element?.memoizedProps?.hasNext) {
            var e = this._getFollowersIDsFromListV2();
            const a = this._getRelayDatabase();
            return { result: e.map((e) => a["XDTUserDict:" + e]).filter((e) => e), limited: !0 };
          }
          let t = this._getFollowersIDsFromListV2().length,
            r = 0;
          for (let e = 0; e < 1e3; e++) {
            var n = this.root.findOne("PolarisInfiniteScroll.react");
            if (!n) break;
            await n.element.memoizedProps.handleLoadNext?.();
            for (let e = 0; e < 10; e++) {
              if (!(this._getFollowersIDsFromListV2().length <= t)) break;
              await this.sleep(1e3);
            }
            if (
              (this._getFollowersIDsFromListV2().length <= t
                ? r++
                : ((t = this._getFollowersIDsFromListV2().length), (r = 0), await this.sleep(500)),
              this._getFollowersIDsFromListV2().length >= s || 5 < r)
            )
              break;
          }
          var o = this._getFollowersIDsFromListV2();
          const i = this._getRelayDatabase();
          return { result: o.map((e) => i["XDTUserDict:" + e]).filter((e) => e), limited: !1 };
        } catch (e) {
          throw new l({ type: "parsing_error", message: "Error while parsing list" });
        }
      }
      async _parseUserList({ limit: t = 100 }) {
        for (let e = 0; e < 10; e++) {
          if (this.root.findOne("PolarisUserList.react")) return this._parseUserListV1({ limit: t });
          await this.sleep(1e3);
        }
        return this._parseUserListV2({ limit: t });
      }
      async _openChatFromProfile({ username: e, id: t }) {
        if (!(await this._openUserFromSearch({ username: e, id: t }))) throw new Error("Unable to find user");
        await this.sleep(2e3);
        e = this.root.findOne("PolarisProfileDirectMessage.react");
        if (!e) throw new Error("User do not allow to send messages");
        t = e.findOne("BaseButton.react");
        if (!t) throw new Error("User do not allow to send messages");
        await t.element.memoizedProps.onClick();
        for (let e = 0; e < 10; e++) {
          if (this.root.findOne("PolarisDirectInbox.react")) return !0;
          await this.sleep(1e3);
        }
        throw new Error("Direct page is unavailable");
      }
      log({ data: e, type: t }) {
        this.innerDomConnector.emit({ type: "basic", data: { type: "log", data: { type: t, data: e } } });
      }
      prepareMessage(t) {
        var r = {};
        for (const s in t) {
          let e = t[s];
          ("i64" === e._tag && (e = { _tag: "i64", value: e }), (r[s] = e));
        }
        return r;
      }
      async _getMessagesUnsafe() {
        var e = [];
        for (const r of this.root.findMany("IGDMessageListTextMessageOffMsys.react")) {
          var t = r.element.memoizedProps.slideMessageRef;
          t?.id && e.push({ messageId: t.id });
        }
        return e;
      }
      async _importNamespace(t) {
        for (let e = 0; e < 15; e++) {
          var r = importNamespace(t);
          if (r) return r;
          await this.sleep(1e3);
        }
        throw new Error("Module not found");
      }
      async _importDefault(t) {
        for (let e = 0; e < 15; e++) {
          var r = importDefault(t);
          if (r) return r;
          await this.sleep(1e3);
        }
        throw new Error("Module not found");
      }
      async _getMessagesUnsafeV2(e) {
        var t = this.root.findOne("ReStoreProvider.react").element.memoizedProps.db,
          r = await this._importNamespace("ReQL"),
          s = await this._importDefault("bs_caml_int64"),
          n = [];
        for (const o of await r.toArrayAsync(r.fromTableAscending(t.tables.messages).getKeyRange(s.of_float(e))))
          n.push(this.prepareMessage(o.element.memoizedProps.message));
        return n;
      }
      _getRelayDatabase() {
        return this.root
          .findMany("react-relay/relay-hooks/RelayEnvironmentProvider")
          .find((e) => "PolarisRelayEnvironment" === e.element.memoizedProps.environment.configName)
          .element.memoizedProps.environment.getStore()
          .getSource()
          .toJSON();
      }
      async _findReStoreTable(t) {
        for (let e = 0; e < 20; e++) {
          var r = this.root.findOne("ReStoreProvider.react")?.element?.memoizedProps?.db?.tables?.[t];
          if (r) return r;
          await this.sleep(500);
        }
        throw new Error("ReStore table was not found: " + t);
      }
      async _getDatabase(e) {
        e = await this._findReStoreTable(e);
        return require("ReQL").toArrayAsync(require("ReQL").fromTableAscending(e));
      }
      async _getDatabaseIterator(e) {
        return (await this._findReStoreTable(e)).entries();
      }
      async _getUserFromContacts({ username: t }) {
        try {
          return (await this._getDatabase("contacts")).find((e) => e.secondaryName === t);
        } catch (e) {
          return (console.warn("[ColdDMs] _getUserFromContacts: ReStore unavailable, returning null", e), null);
        }
      }
      _formatData({ data: t, bs_caml_int64: r }) {
        var s = {};
        for (const n in t) {
          let e = t[n];
          ("i64" === e?._tag && (e = r.to_string(e)), (s[n] = e));
        }
        return s;
      }
      _getUsersByBadge() {
        var e = [];
        for (const t of this.root.findMany("LSContactVerificationBadge"))
          t?.element?.memoizedProps?.contact && e.push(t.element.memoizedProps.contact);
        return e;
      }
      async _getUserThread({ username: t }) {
        var r = await this._importDefault("bs_caml_int64"),
          s = await this._getDatabaseIterator("contacts");
        let n;
        for (let e = 0; e < 1e4; e++) {
          var { done: o, value: i } = s.next();
          if (o) break;
          o = this._formatData({ data: i[1], bs_caml_int64: r });
          if (o.secondaryName === t) {
            n = o;
            break;
          }
        }
        if (n) {
          var a = n.id,
            l = await this._getDatabaseIterator("messages"),
            c = [];
          for (let e = 0; e < 1e4; e++) {
            var { done: m, value: d } = l.next();
            if (m) break;
            m = this._formatData({ data: d[1], bs_caml_int64: r });
            m.threadKey === n.id && c.push(m);
          }
          var h = await this._getDatabaseIterator("ig_contact_info");
          let t;
          for (let e = 0; e < 1e4; e++) {
            var { done: u, value: p } = h.next();
            if (u) break;
            u = this._formatData({ data: p[1], bs_caml_int64: r });
            if (u.contactId === a) {
              t = u;
              break;
            }
          }
          if (!t) {
            var f = await this._getDatabaseIterator("server_search_results");
            for (let e = 0; e < 1e4; e++) {
              var { done: g, value: _ } = f.next();
              if (g) break;
              g = this._formatData({ data: _[1], bs_caml_int64: r });
              g.resultId === a && (t = { contactId: g.resultId, igId: g.resultIgid });
            }
          }
          return {
            username: n?.secondaryName,
            instagram_id: t?.igId,
            contact_reachability_status_type: n?.contactReachabilityStatusType,
            thread_key: a,
            messages: c,
          };
        }
      }
      async _getAllMessages() {
        try {
          return await this._getAllMessagesUnsafe();
        } catch (e) {
          return (console.warn("[ColdDMs] _getAllMessages: ReStore unavailable, returning empty", e), {});
        }
      }
      async _getAllMessagesUnsafe() {
        const t = await this._importDefault("bs_caml_int64");
        var e = (await this._getDatabase("messages")).map((e) => this._formatData({ data: e, bs_caml_int64: t })),
          r = (await this._getDatabase("contacts")).map((e) => this._formatData({ data: e, bs_caml_int64: t })),
          s = (await this._getDatabase("ig_contact_info")).map((e) => this._formatData({ data: e, bs_caml_int64: t })),
          n = (await this._getDatabase("server_search_results")).map((e) =>
            this._formatData({ data: e, bs_caml_int64: t }),
          ),
          o = this._getUsersByBadge().map((e) => this._formatData({ data: e, bs_caml_int64: t }));
        const i = r.reduce((e, t) => ((e[t.id] = t), e), {}),
          a = s.reduce((e, t) => ((e[t.contactId] = t), e), {}),
          l = o.reduce((e, t) => ((e[t.contactId] = t), e), {}),
          c = n.reduce((e, t) => ((e[t.resultId] = { contactId: t.resultId, igId: t.resultIgid }), e), {});
        var m,
          d,
          h = e.reduce((e, t) => {
            var r = i[t.senderId] ?? l[t.senderId],
              s = a[t.senderId] ?? c[t.senderId],
              n = i[t.threadKey] ?? l[t.threadKey],
              o = a[t.threadKey] ?? c[t.threadKey];
            return (
              r &&
                s &&
                n &&
                o &&
                ((r = { ...t, username: r?.secondaryName, instagram_id: s?.igId }),
                e[n.secondaryName] ||
                  (e[n.secondaryName] = {
                    username: n?.secondaryName,
                    instagram_id: o?.igId,
                    contact_reachability_status_type: n?.contactReachabilityStatusType,
                    thread_key: t.threadKey,
                    messages: [],
                  }),
                e[n.secondaryName].messages.push(r)),
              e
            );
          }, {});
        for (const u in h) h[u].messages.sort((e, t) => Number(t.timestampMs) - Number(e.timestampMs));
        for (const p of (await this._getDatabase("threads")).map((e) =>
          this._formatData({ data: e, bs_caml_int64: t }),
        )) {
          var existing = Object.values(h).find((e) => e.thread_key === p.threadKey);
          if (existing) {
            existing.lastSeenAt = p.lastSeenAt ?? p.last_seen_at ?? null;
            existing.lastActivityAt = p.lastActivityAt ?? p.last_activity_at ?? null;
            existing.seenState = p.seenState ?? p.seen_state ?? null;
          } else {
            m = i[p.threadKey] ?? l[p.threadKey];
            d = a[p.threadKey] ?? c[p.threadKey];
            if (m && d) {
              h[m.secondaryName] = {
                username: m?.secondaryName,
                instagram_id: d?.igId,
                contact_reachability_status_type: m?.contactReachabilityStatusType,
                thread_key: p.threadKey,
                lastSeenAt: p.lastSeenAt ?? p.last_seen_at ?? null,
                lastActivityAt: p.lastActivityAt ?? p.last_activity_at ?? null,
                seenState: p.seenState ?? p.seen_state ?? null,
                messages: [],
              };
            }
          }
        }
        return h;
      }
      _getAllMessagesFromDOM() {
        var e = [];
        try {
          for (const c of this.root.findMany("IGDMessageListRowOffMsys")) {
            const m = (c.element.memoizedProps ?? {}).currentMessageRef ?? {};
            var t = m.__id?.replace("SlideMessage:", "") ?? null,
              r = m.timestamp_ms ?? null,
              s = m.sender_fbid ?? null,
              n = m.sender?.user_dict?.__id?.split(":")[1] ?? null,
              o = (() => {
                try {
                  var e = m.__fragmentOwner?.identifier ?? "";
                  return JSON.parse(e.slice(e.indexOf("{"))).thread_fbid ?? null;
                } catch {
                  return null;
                }
              })(),
              i = c.findOne("MWXMessageBaseMessageListText"),
              a = i?.element?.memoizedProps?.text ?? null,
              l = i?.element?.memoizedProps?.outgoing ?? null;
            e.push({
              sender_fbid: s,
              sender_user_id: n,
              timestamp_ms: r,
              message_id: t,
              thread_fbid: o,
              outgoing: l,
              text: a,
            });
          }
        } catch (e) {
          console.warn("[ColdDMs] _getAllMessagesFromDOM error", e);
        }
        return e;
      }
      _checkResponseFromDOM({ sinceMs: _sinceMs = null } = {}) {
        var e = this._getAllMessagesFromDOM();
        // Anchor = the newest OUTGOING message. A reply only counts if it is
        // newer than this anchor. When sinceMs is provided (the ts of the send
        // we're guarding), use whichever is more recent so a stale inbound
        // message from before our send can't be misread as a fresh reply.
        const t = e
          .filter((e) => !0 === e.outgoing && e.timestamp_ms)
          .sort((e, t) => Number(t.timestamp_ms) - Number(e.timestamp_ms))[0];
        const _anchorMs = Math.max(
          t ? Number(t.timestamp_ms) : 0,
          _sinceMs != null ? Number(_sinceMs) : 0,
        );
        // Require an anchor: either an outgoing message exists, or sinceMs was
        // supplied. Without one we can't distinguish a fresh reply from history.
        if (!t && _sinceMs == null) return null;
        return (
          (e = e
            .filter((e) => !1 === e.outgoing && e.text && e.timestamp_ms)
            .sort((e, t) => Number(t.timestamp_ms) - Number(e.timestamp_ms))
            .find((e) => Number(e.timestamp_ms) > _anchorMs))
            ? { text: e.text }
            : null
        );
      }
      _checkOutgoingMessageSentFromDOM({ dateBeforeSend: t }) {
        return this._getAllMessagesFromDOM().some(
          (e) => !0 === e.outgoing && e.text && e.timestamp_ms && Number(e.timestamp_ms) >= Number(t),
        );
      }
      async _getDebugMessages() {
        try {
          const t = await this._importDefault("bs_caml_int64");
          return {
            users: (await this._getDatabase("contacts")).map((e) => this._formatData({ data: e, bs_caml_int64: t })),
            contacts: (await this._getDatabase("ig_contact_info")).map((e) =>
              this._formatData({ data: e, bs_caml_int64: t }),
            ),
          };
        } catch (e) {
          return (
            console.warn("[ColdDMs] _getDebugMessages: ReStore unavailable, returning empty", e),
            { users: [], contacts: [] }
          );
        }
      }
      async _closeOpenDialogModal() {
        var e = this._findDialog();
        if (e) return e.element?.memoizedProps?.onClose?.();
      }
      async _clickChat() {
        var t = this._findDialog();
        if (t) {
          for (let e = 0; e < 10; e++) {
            var r = t.findMany("IGDSBox.react"),
              r = r[r.length - 1];
            if (r) {
              r = r.findOne("CometPressable.react");
              if (r) return (r.element.memoizedProps.onPress({ preventDefault() {}, stopPropagation() {} }), !0);
            }
            await this.sleep(1e3);
          }
          for (let e = 0; e < 3; e++) {
            var s = t.findMany("CometPressable.react"),
              s = s[s.length - 1];
            if (s) return (s.element.memoizedProps.onPress({ preventDefault() {}, stopPropagation() {} }), !0);
            await this.sleep(1e3);
          }
        }
        return !1;
      }
      _inputSearch({ username: e }) {
        this.root.findOne("PolarisSearchBoxTextInput.react").element.memoizedProps.onChange({ target: { value: e } });
      }
      async _collectAllMessages() {
        return {
          messages: await this._getAllMessages(),
          debugMessages: await this._getDebugMessages(),
          timestamp: new Date().toISOString(),
        };
      }
    })(z),
    window.hasOwnProperty("__REACT_DEVTOOLS_GLOBAL_HOOK__"))
  ) {
    e = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    const E = e.onCommitFiberRoot;
    e.onCommitFiberRoot = function (e, t, r) {
      e = E?.call(this, e, t, r);
      try {
        z.handleCommitFiberRoot(t, r);
      } catch (e) {
        console.error("[ColdDMS] handleCommitFiberRoot patch error:", e);
      }
      return e;
    };
  } else {
    (B(window),
      window.__REACT_DEVTOOLS_GLOBAL_HOOK__.on("renderer", function ({ reactBuildType: e }) {
        window.postMessage(
          { source: "react-devtools-detector", payload: { type: "react-renderer-attached", reactBuildType: e } },
          "*",
        );
      }),
      (window.__REACT_DEVTOOLS_GLOBAL_HOOK__.nativeObjectCreate = Object.create),
      (window.__REACT_DEVTOOLS_GLOBAL_HOOK__.nativeMap = Map),
      (window.__REACT_DEVTOOLS_GLOBAL_HOOK__.nativeWeakMap = WeakMap),
      (window.__REACT_DEVTOOLS_GLOBAL_HOOK__.nativeSet = Set));
    e = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    (e.sub("renderer-attached", (...e) => console.log(...e)),
      e.sub("mount", (...e) => console.log(...e)),
      e.sub("unmount", (...e) => console.log(...e)),
      e.sub("update", (...e) => console.log(...e)),
      e.sub("root", (...e) => console.log(...e)),
      e.sub("rootCommitted", (...e) => console.log(...e)),
      e.sub("updateProfileTimes", (...e) => console.log(...e)));
  }
})();
