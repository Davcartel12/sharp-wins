/* ═══════════════════════════════════════════════════════════
   router.js — tiny hash router for the SPA
   Views register themselves in window.SW_VIEWS[name] = { render, init?, cleanup? }
   Routes:  #/home  #/friends  #/leaderboard  #/room/5  etc.
═══════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  window.SW_VIEWS = window.SW_VIEWS || {};
  var currentView = null;     // the active view object
  var currentName = null;

  function parseHash() {
    var raw = (location.hash || "#/home").replace(/^#\/?/, ""); // "room/5"
    var parts = raw.split("/").filter(Boolean);
    var name = parts[0] || "home";
    var param = parts[1] || null;   // e.g. stake for rooms, roomId join etc.
    return { name: name, param: param, query: parseQuery() };
  }

  function parseQuery() {
    // support #/room/5?room=abc
    var h = location.hash || "";
    var qi = h.indexOf("?");
    var out = {};
    if (qi >= 0) {
      h.slice(qi + 1).split("&").forEach(function (pair) {
        var kv = pair.split("=");
        out[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || "");
      });
    }
    return out;
  }

  async function mount() {
    var r = parseHash();
    // strip query from param if present
    if (r.param && r.param.indexOf("?") >= 0) r.param = r.param.split("?")[0];

    var view = window.SW_VIEWS[r.name] || window.SW_VIEWS["home"];

    // Tear down previous view's listeners, if any
    if (currentView && currentView.cleanup) {
      try { currentView.cleanup(); } catch (e) { console.warn("cleanup error", e); }
    }

    var mainEl = document.getElementById("view");
    if (!mainEl) return;

    // Render new view's HTML
    try {
      mainEl.innerHTML = (view.render ? view.render(r) : "<p style='padding:24px'>Empty view.</p>");
    } catch (e) {
      mainEl.innerHTML = "<p style='padding:24px;color:#ff6b6b'>View failed to render.</p>";
      console.error("render error", e);
    }

    currentView = view;
    currentName = r.name;

    // Highlight active bottom-nav item
    highlightNav(r.name);

    // Run the view's init (data loading, listeners) AFTER html is in place
    if (view.init) {
      try { await view.init(r); } catch (e) { console.error("init error", e); }
    }

    // Scroll to top on navigation
    window.scrollTo(0, 0);
  }

  function highlightNav(name) {
    document.querySelectorAll(".nav-item[data-route]").forEach(function (el) {
      el.classList.toggle("active", el.getAttribute("data-route") === name);
    });
  }

  // Programmatic navigation helper
  window.SW_NAV = function (path) {
    if (path.charAt(0) !== "#") path = "#/" + path.replace(/^\/?/, "");
    if (location.hash === path) { mount(); } else { location.hash = path; }
  };

  window.addEventListener("hashchange", mount);
  window.SW_ROUTER_START = mount;   // shell calls this once after boot
  window.SW_ROUTER_REMOUNT = mount; // re-render current route (e.g. after auth resolves)
})();