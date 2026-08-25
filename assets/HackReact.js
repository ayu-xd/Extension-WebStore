const t = document.createElement("script");
t.src = chrome.runtime.getURL("assets/ReactDev.js"), t.async = !1, t.onload = function() {
  this.remove()
}, document.documentElement.appendChild(t);
