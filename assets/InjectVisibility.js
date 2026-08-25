function injectDOM() {
  var e = document.createElement("script");
  e.src = chrome.runtime.getURL("assets/HackVisibility.js"), e.async = !1, e.onload = function() {
    this.remove()
  }, document.documentElement.appendChild(e)
}
injectDOM();
