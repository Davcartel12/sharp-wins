/* ═══════════════════════════════════════════════════════════
   app.js — SPA core for Sharp Wins
   Loads Firebase ONCE, watches auth, keeps balance in memory.
   Other modules read window.SW (shared state) and call SW.* helpers.
═══════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var FIREBASE_CONFIG = {
    apiKey: "AIzaSyCfqyOvjQ33sv1NLn5o3w9UYd3Qdf4NzwI",
    authDomain: "sharp-wins.firebaseapp.com",
    projectId: "sharp-wins",
    storageBucket: "sharp-wins.firebasestorage.app",
    messagingSenderId: "877621154657",
    appId: "1:877621154657:web:29260f71f290bbdff0ef75"
  };

  // Shared state every view/module can read.
  var SW = window.SW = {
    ready: false,        // Firebase loaded + first auth check done
    user: null,          // firebase user or null
    uid: null,
    profile: null,       // cached user doc { displayName, balance, ... }
    balance: 0,
    db: null,
    auth: null,
    _balanceListeners: []  // callbacks fired when balance changes
  };

  function loadScript(src) {
    return new Promise(function (res, rej) {
      var existing = [].find.call(document.scripts, function (s) { return s.src === src; });
      if (existing) { res(); return; }
      var s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  function waitFor(check, timeout) {
    return new Promise(function (resolve, reject) {
      var t0 = Date.now();
      (function poll() {
        if (check()) return resolve();
        if (Date.now() - t0 > (timeout || 8000)) return reject(new Error("SDK load timeout"));
        setTimeout(poll, 40);
      })();
    });
  }

  var _fbReady = null;
  function ensureFirebase() {
    if (_fbReady) return _fbReady;
    _fbReady = (async function () {
      if (!window.firebase || !firebase.initializeApp) {
        await loadScript("https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js");
        await waitFor(function () { return window.firebase && firebase.initializeApp; });
      }
      var jobs = [];
      if (!firebase.auth) {
        jobs.push(loadScript("https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js")
          .then(function () { return waitFor(function () { return !!firebase.auth; }); }));
      }
      if (!firebase.firestore) {
        jobs.push(loadScript("https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js")
          .then(function () { return waitFor(function () { return !!firebase.firestore; }); }));
      }
      if (jobs.length) await Promise.all(jobs);
      if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      try { firebase.firestore().settings({ experimentalAutoDetectLongPolling: true, merge: true }); } catch (e) {}
      try { await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL); } catch (e) {}
      SW.auth = firebase.auth();
      SW.db = firebase.firestore();
      return firebase;
    })();
    return _fbReady;
  }
  SW.ensureFirebase = ensureFirebase;

  /* ── Formatting ── */
  SW.fmt = function (n) { return "$" + Number(n || 0).toFixed(2); };

  /* ── Balance: cached in localStorage for instant paint, then live ── */
  function cachedBalance() {
    try {
      var v = localStorage.getItem("sw_balance");
      return v == null ? null : Number(v);
    } catch (e) { return null; }
  }
  function setBalance(n) {
    SW.balance = Number(n || 0);
    try { localStorage.setItem("sw_balance", String(SW.balance)); } catch (e) {}
    SW._balanceListeners.forEach(function (cb) { try { cb(SW.balance); } catch (e) {} });
  }
  SW.setBalance = setBalance;
  SW.onBalance = function (cb) {
    SW._balanceListeners.push(cb);
    cb(SW.balance);  // fire immediately with current
  };

  /* ── Profile / ensure user doc (mirrors sw-account ensureUserProfile) ── */
  async function ensureUserProfile(user) {
    var ref = SW.db.collection("users").doc(user.uid);
    var snap = await ref.get();
    if (!snap.exists) {
      var name = user.displayName || (user.email ? user.email.split("@")[0] : "Player");
      await ref.set({
        uid: user.uid, displayName: name, displayNameLower: name.toLowerCase(),
        balance: 100, demo: true, wins: 0, losses: 0, totalWinnings: 0,
        photoURL: "", friends: [],
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      snap = await ref.get();
    }
    return snap.data();
  }

  async function refreshProfile() {
    if (!SW.uid) return null;
    var snap = await SW.db.collection("users").doc(SW.uid).get();
    SW.profile = snap.exists ? snap.data() : null;
    if (SW.profile) setBalance(SW.profile.balance || 0);
    return SW.profile;
  }
  SW.refreshProfile = refreshProfile;

  /* ── Data helpers (mirror sw-account.js) ── */
  SW.getLeaderboard = async function () {
    var qs = await SW.db.collection("users").orderBy("totalWinnings", "desc").limit(100).get();
    var entries = [], rank = 0;
    qs.forEach(function (d) {
      var u = d.data(); rank++;
      entries.push({
        uid: d.id, rank: rank,
        displayName: u.displayName || "Player",
        photoURL: u.photoURL || "",
        wins: u.wins || 0, losses: u.losses || 0,
        totalWinnings: u.totalWinnings || 0
      });
    });
    return entries;
  };

  SW.getTransactions = async function (uid) {
    var qs = await SW.db.collection("transactions").where("uid", "==", uid).limit(200).get();
    var out = [];
    qs.forEach(function (d) {
      var t = d.data();
      out.push({
        id: d.id, type: t.type || "", delta: Number(t.delta || 0),
        description: t.description || "", source: t.source || "", method: t.method || "",
        createdAt: t.createdAt && t.createdAt.toMillis ? t.createdAt.toMillis() : 0
      });
    });
    out.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    return out;
  };

  SW.getNotifications = async function (uid) {
    var qs = await SW.db.collection("notifications").where("uid", "==", uid).limit(100).get();
    var out = [];
    qs.forEach(function (d) {
      var n = d.data();
      out.push({
        id: d.id, type: n.type || "", title: n.title || "", message: n.message || "",
        read: !!n.read,
        createdAt: n.createdAt && n.createdAt.toMillis ? n.createdAt.toMillis() : 0
      });
    });
    out.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    return out;
  };

  SW.markNotificationsRead = async function (uid) {
    try {
      var qs = await SW.db.collection("notifications").where("uid", "==", uid).where("read", "==", false).limit(100).get();
      var batch = SW.db.batch();
      qs.forEach(function (d) { batch.update(d.ref, { read: true }); });
      await batch.commit();
    } catch (e) {}
  };

  /* ── Sign out ── */
  SW.signOut = function () {
    try { localStorage.removeItem("sw_balance"); } catch (e) {}
    if (SW.auth) SW.auth.signOut();
    location.hash = "#/home";
  };

  /* ── Boot ── */
  SW.boot = function (onReady) {
    // Paint cached balance instantly (before network)
    var cb = cachedBalance();
    if (cb != null) SW.balance = cb;

    // Start the router IMMEDIATELY so the UI is never blank,
    // even if Firebase is slow or fails.
    if (onReady) {
      try { onReady(SW); } catch (e) { console.error("onReady(initial) failed", e); }
    }

    ensureFirebase().then(function () {
      SW.auth.onAuthStateChanged(async function (user) {
        SW.user = user || null;
        SW.uid = user ? user.uid : null;
        if (user) {
          try { SW.profile = await ensureUserProfile(user); } catch (e) { SW.profile = null; }
          if (SW.profile) setBalance(SW.profile.balance || 0);
        } else {
          SW.profile = null;
          setBalance(0);
        }
        SW.ready = true;
        // Auth state changed — let the shell update chrome and re-render current view
        if (SW._onAuth) { try { SW._onAuth(SW); } catch (e) {} }
      });
    }).catch(function (e) {
      console.error("Firebase boot failed", e);
      SW.ready = true;
      if (SW._onAuth) { try { SW._onAuth(SW); } catch (e2) {} }
    });
  };

  // Shell registers a callback to re-run when auth resolves/changes.
  SW.onAuth = function (cb) { SW._onAuth = cb; };
})();