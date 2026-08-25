{
  window.requestAnimationFrame = e => {
    setTimeout(() => e?.(), 0)
  }, window.requestIdleCallback = e => {
    e?.()
  };
  try {
    Object.defineProperty(document, "hasFocus", {
      get() {
        return () => !0
      },
      configurable: true
    });
  } catch (err) {}
  Document.prototype.hasFocus = new Proxy(Document.prototype.hasFocus, {
    apply(e, t, n) {
      return Reflect.apply(e, t, n)
    }
  });
  const a = e => {
      e.preventDefault(), e.stopPropagation(), e.stopImmediatePropagation()
    },
    b = (
      (() => {
        try {
          Object.defineProperty(document, "visibilityState", {
            get() { return "visible" }, configurable: true
          });
          Object.defineProperty(document, "webkitVisibilityState", {
            get() { return "visible" }, configurable: true
          });
          Object.defineProperty(document, "hidden", {
            get() { return !1 }, configurable: true
          });
          Object.defineProperty(document, "webkitHidden", {
            get() { return !1 }, configurable: true
          });
        } catch(e) {}
      })(),
      document.addEventListener("visibilitychange", e => a(e), !0),
      document.addEventListener("webkitvisibilitychange", e => a(e), !0),
      window.addEventListener("pagehide", e => { a(e) }, !0),
      e => { if (e.target === document || e.target === window) return a(e) }
    ),
    c = (document.addEventListener("focus", b, !0), window.addEventListener("focus", b, !0), e => {
      if (e.target === document || e.target === window) return a(e)
    });
  document.addEventListener("blur", c, !0), window.addEventListener("blur", c, !0), window.addEventListener("mouseleave", e => {
    if (e.target === document || e.target === window) return a(e)
  }, !0)
}
