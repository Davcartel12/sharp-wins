/* ═══════════════════════════════════════════════════════════
   sw-account.js  —  Client-side account layer (NO Cloud Functions)
   Replaces createUserProfile / getBalance / getUserProfile.
   Writes the user doc directly to Firestore with the client SDK.
   Demo money only. Load AFTER firebase-app/auth/firestore compat SDKs.
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

  var STARTING_DEMO_BALANCE = 100;

  function loadScript(src) {
    return new Promise(function (res, rej) {
      var existing = [].find.call(document.scripts, function (s) { return s.src === src; });
      if (existing) { res(); return; }
      var s = document.createElement("script");
      s.src = src; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  var _ready = null;
  function _waitFor(check, timeout) {
    return new Promise(function (resolve, reject) {
      var t0 = Date.now();
      (function poll() {
        if (check()) return resolve();
        if (Date.now() - t0 > (timeout || 8000)) return reject(new Error("Firebase SDK load timeout"));
        setTimeout(poll, 50);
      })();
    });
  }

  function ensureFirebase() {
    if (_ready) return _ready;
    _ready = (async function () {
      if (!window.firebase || !firebase.initializeApp) {
        await loadScript("https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js");
        await _waitFor(function () { return window.firebase && firebase.initializeApp; });
      }
      // Auth and Firestore both depend only on app, so load them together.
      var jobs = [];
      if (!firebase.auth) {
        jobs.push(loadScript("https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js")
          .then(function () { return _waitFor(function () { return !!firebase.auth; }); }));
      }
      if (!firebase.firestore) {
        jobs.push(loadScript("https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js")
          .then(function () { return _waitFor(function () { return !!firebase.firestore; }); }));
      }
      if (jobs.length) await Promise.all(jobs);
      if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      try {
        firebase.firestore().settings({ experimentalAutoDetectLongPolling: true, merge: true });
      } catch (e) { /* settings already applied */ }
      try { await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL); } catch (e) {}
      return firebase;
    })();
    return _ready;
  }

  function emailName(email) {
    return (email && typeof email === "string") ? email.split("@")[0] : "Player";
  }

  /* Create the user's Firestore doc if it doesn't exist. Safe to call on
     every sign-in — it only writes when missing. */
  async function ensureUserProfile(user) {
    await ensureFirebase();
    var db = firebase.firestore();
    var uid = user.uid;
    var ref = db.collection("users").doc(uid);
    var snap = await ref.get();

    if (snap.exists) return snap.data();

    var displayName = user.displayName || emailName(user.email);
    var profile = {
      uid: uid,
      displayName: displayName,
      displayNameLower: displayName.toLowerCase(),
      email: user.email || "",
      balance: STARTING_DEMO_BALANCE,
      demo: true,
      wins: 0,
      losses: 0,
      totalWinnings: 0,
      friends: [],
      friendRequestsSent: [],
      friendRequestsReceived: [],
      blocked: [],
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    await ref.set(profile);

    // Welcome-bonus transaction (best-effort; ignore if it fails)
    try {
      await db.collection("transactions").add({
        uid: uid,
        type: "deposit",
        delta: STARTING_DEMO_BALANCE,
        balanceBefore: 0,
        balanceAfter: STARTING_DEMO_BALANCE,
        description: "Welcome bonus — $" + STARTING_DEMO_BALANCE + " demo balance",
        source: "demo",
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (e) { /* non-critical */ }

    return profile;
  }

  async function getProfile(uid) {
    await ensureFirebase();
    var snap = await firebase.firestore().collection("users").doc(uid).get();
    return snap.exists ? snap.data() : null;
  }

  /* Read the user's notifications, newest first.
     Uses a simple uid-only query (no composite index needed) and sorts here. */
  async function getNotifications(uid) {
    await ensureFirebase();
    var db = firebase.firestore();
    var out = [];
    var qs = await db.collection("notifications").where("uid", "==", uid).limit(100).get();
    qs.forEach(function (d) {
      var n = d.data();
      out.push({
        id: d.id,
        type: n.type || "system",
        title: n.title || "",
        message: n.message || "",
        read: !!n.read,
        createdAt: n.createdAt && n.createdAt.toMillis ? n.createdAt.toMillis() : 0
      });
    });
    out.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    return out;
  }

  async function getBalance(uid) {
    var p = await getProfile(uid);
    return p ? (p.balance || 0) : 0;
  }

  /* Update the user's own profile (displayName, optional photoURL).
     Keeps displayNameLower in sync so friend search keeps working. */
  async function updateProfile(uid, displayName, photoURL) {
    await ensureFirebase();
    var db = firebase.firestore();
    var name = (displayName || "").trim();
    if (!name) throw new Error("Username can't be empty.");
    var update = {
      displayName: name,
      displayNameLower: name.toLowerCase(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    if (typeof photoURL === "string" && photoURL) update.photoURL = photoURL;
    await db.collection("users").doc(uid).update(update);
    return { displayName: name };
  }

  /* Top players by totalWinnings (all-time; period is accepted but ignored
     for now since user docs only store lifetime totals). */
  async function getLeaderboard(period, myUid) {
    await ensureFirebase();
    var db = firebase.firestore();
    var entries = [];
    var qs = await db.collection("users")
      .orderBy("totalWinnings", "desc")
      .limit(100).get();
    var rank = 0;
    qs.forEach(function (d) {
      var u = d.data();
      rank++;
      entries.push({
        uid: d.id, rank: rank,
        displayName: u.displayName || "Player",
        photoURL: u.photoURL || "",
        wins: u.wins || 0, losses: u.losses || 0,
        totalWinnings: u.totalWinnings || 0
      });
    });
    return entries;
  }

  /* Read the user's transaction history, newest first (uid-only query, no index). */
  async function getTransactions(uid) {
    await ensureFirebase();
    var db = firebase.firestore();
    var out = [];
    var qs = await db.collection("transactions").where("uid", "==", uid).limit(200).get();
    qs.forEach(function (d) {
      var t = d.data();
      out.push({
        id: d.id,
        type: t.type || "",
        delta: Number(t.delta || 0),
        description: t.description || "",
        source: t.source || "",
        method: t.method || "",
        createdAt: t.createdAt && t.createdAt.toMillis ? t.createdAt.toMillis() : 0
      });
    });
    out.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    return out;
  }

  /* ─────────── FRIENDS SYSTEM (client-side, no Cloud Functions) ───────────
     Uses a "friendRequests" collection of docs: { from, to, status, ... }
     and a "friendships" collection: { users:[a,b], a, b }.
     Blocks live in "blocks": { by, target }.
  ───────────────────────────────────────────────────────────────────────── */

  // Prefix search by displayNameLower. Excludes self, current friends, blocked.
  async function searchUsers(myUid, queryText) {
    await ensureFirebase();
    var db = firebase.firestore();
    var q = (queryText || "").trim().toLowerCase();
    if (!q) return [];

    var snap = await db.collection("users")
      .orderBy("displayNameLower")
      .startAt(q)
      .endAt(q + "\uf8ff")
      .limit(20).get();

    // Gather my relationships to label each result
    var state = await getFriendsData(myUid);
    var friendIds = {};   state.friends.forEach(function (f) { friendIds[f.uid] = true; });
    var sentIds = {};     state.pending.forEach(function (p) { if (p.direction === "sent") sentIds[p.uid] = true; });
    var recvIds = {};     state.pending.forEach(function (p) { if (p.direction === "received") recvIds[p.uid] = true; });
    var blockedIds = {};  state.blocked.forEach(function (b) { blockedIds[b.uid] = true; });

    var out = [];
    snap.forEach(function (d) {
      if (d.id === myUid) return;            // not myself
      if (blockedIds[d.id]) return;          // hide blocked
      var u = d.data();
      var status = friendIds[d.id] ? "friend"
                 : sentIds[d.id]   ? "sent"
                 : recvIds[d.id]   ? "received"
                 : "none";
      out.push({
        uid: d.id,
        displayName: u.displayName || "Player",
        photoURL: u.photoURL || "",
        wins: u.wins || 0, losses: u.losses || 0, totalWinnings: u.totalWinnings || 0,
        status: status
      });
    });
    return out;
  }

  async function _userBrief(uid) {
    var u = await getProfile(uid);
    return {
      uid: uid,
      displayName: (u && u.displayName) || "Player",
      photoURL: (u && u.photoURL) || "",
      wins: (u && u.wins) || 0,
      losses: (u && u.losses) || 0,
      totalWinnings: (u && u.totalWinnings) || 0
    };
  }

  // Returns { friends:[], pending:[{...,direction}], blocked:[] }
  async function getFriendsData(myUid) {
    await ensureFirebase();
    var db = firebase.firestore();
    var friends = [], pending = [], blocked = [];

    // Friendships where I'm a participant
    var fSnap = await db.collection("friendships").where("users", "array-contains", myUid).get();
    var friendUids = [];
    fSnap.forEach(function (d) {
      var other = d.data().a === myUid ? d.data().b : d.data().a;
      if (other) friendUids.push(other);
    });

    // Pending requests I sent
    var sentSnap = await db.collection("friendRequests")
      .where("from", "==", myUid).where("status", "==", "pending").get();
    var sentUids = [];
    sentSnap.forEach(function (d) { sentUids.push(d.data().to); });

    // Pending requests I received
    var recvSnap = await db.collection("friendRequests")
      .where("to", "==", myUid).where("status", "==", "pending").get();
    var recvUids = [];
    recvSnap.forEach(function (d) { recvUids.push(d.data().from); });

    // Blocks I made
    var bSnap = await db.collection("blocks").where("by", "==", myUid).get();
    var blockUids = [];
    bSnap.forEach(function (d) { blockUids.push(d.data().target); });

    // Hydrate names
    var i;
    for (i = 0; i < friendUids.length; i++) friends.push(await _userBrief(friendUids[i]));
    for (i = 0; i < sentUids.length; i++)   { var s = await _userBrief(sentUids[i]); s.direction = "sent"; pending.push(s); }
    for (i = 0; i < recvUids.length; i++)   { var r = await _userBrief(recvUids[i]); r.direction = "received"; pending.push(r); }
    for (i = 0; i < blockUids.length; i++)  blocked.push(await _userBrief(blockUids[i]));

    return { friends: friends, pending: pending, blocked: blocked };
  }

  function _reqId(a, b) { return a + "_" + b; }

  async function sendFriendRequest(myUid, targetUid) {
    await ensureFirebase();
    var db = firebase.firestore();
    if (myUid === targetUid) throw new Error("You can't add yourself.");
    await db.collection("friendRequests").doc(_reqId(myUid, targetUid)).set({
      from: myUid, to: targetUid, status: "pending",
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    // Notify the recipient
    try {
      var me = await getProfile(myUid);
      await db.collection("notifications").add({
        uid: targetUid, type: "alert", title: "New Friend Request",
        message: ((me && me.displayName) || "Someone") + " sent you a friend request.",
        read: false, createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (e) {}
  }

  async function acceptFriendRequest(myUid, fromUid) {
    await ensureFirebase();
    var db = firebase.firestore();
    // The request doc is from fromUid -> me
    await db.collection("friendRequests").doc(_reqId(fromUid, myUid)).update({ status: "accepted" });
    // Create the friendship (sorted pair so the id is stable)
    var pair = [myUid, fromUid].sort();
    await db.collection("friendships").doc(pair[0] + "_" + pair[1]).set({
      users: pair, a: pair[0], b: pair[1],
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  async function declineFriendRequest(myUid, fromUid) {
    await ensureFirebase();
    var db = firebase.firestore();
    await db.collection("friendRequests").doc(_reqId(fromUid, myUid)).update({ status: "declined" });
  }

  async function blockUser(myUid, targetUid) {
    await ensureFirebase();
    var db = firebase.firestore();
    await db.collection("blocks").doc(_reqId(myUid, targetUid)).set({
      by: myUid, target: targetUid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    // Remove any friendship / pending requests between us
    try {
      var pair = [myUid, targetUid].sort();
      await db.collection("friendships").doc(pair[0] + "_" + pair[1]).delete();
    } catch (e) {}
    try { await db.collection("friendRequests").doc(_reqId(myUid, targetUid)).delete(); } catch (e) {}
    try { await db.collection("friendRequests").doc(_reqId(targetUid, myUid)).delete(); } catch (e) {}
  }

  async function unblockUser(myUid, targetUid) {
    await ensureFirebase();
    await firebase.firestore().collection("blocks").doc(_reqId(myUid, targetUid)).delete();
  }

  /* ─────────── CHALLENGES (friend 1v1 invites) ───────────
     challenges doc: { from, fromName, to, toName, stake, status, roomId }
     status: pending → accepted | rejected | cancelled
  ──────────────────────────────────────────────────────── */
  async function sendChallenge(myUid, myName, targetUid, targetName, stake) {
    await ensureFirebase();
    var db = firebase.firestore();
    if (myUid === targetUid) throw new Error("You can't challenge yourself.");
    stake = Number(stake) || 1;
    // Check challenger can afford it
    var me = await getProfile(myUid);
    if (!me || Number(me.balance || 0) < stake) throw new Error("Insufficient balance for that stake.");

    var ref = await db.collection("challenges").add({
      from: myUid, fromName: myName || "Player",
      to: targetUid, toName: targetName || "Player",
      stake: stake, status: "pending", roomId: null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return ref.id;
  }

  // Recipient accepts: deduct BOTH players' stakes, create a lobby room, link it.
  async function acceptChallenge(myUid, myName, challengeId) {
    await ensureFirebase();
    var db = firebase.firestore();
    var cRef = db.collection("challenges").doc(challengeId);
    var cSnap = await cRef.get();
    if (!cSnap.exists) throw new Error("Challenge no longer exists.");
    var c = cSnap.data();
    if (c.status !== "pending") throw new Error("Challenge already handled.");
    if (c.to !== myUid) throw new Error("Not your challenge.");

    var stake = Number(c.stake) || 1;

    // Deduct my stake
    var meRef = db.collection("users").doc(myUid);
    var meSnap = await meRef.get();
    var myBal = meSnap.exists ? Number(meSnap.data().balance || 0) : 0;
    if (myBal < stake) throw new Error("Insufficient balance to accept.");
    await meRef.update({ balance: myBal - stake, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });

    // Deduct challenger's stake
    var fromRef = db.collection("users").doc(c.from);
    var fromSnap = await fromRef.get();
    var fromBal = fromSnap.exists ? Number(fromSnap.data().balance || 0) : 0;
    // (If challenger can't afford anymore, refund me and abort)
    if (fromBal < stake) {
      await meRef.update({ balance: myBal, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      await cRef.update({ status: "cancelled" });
      throw new Error("Challenger no longer has enough balance.");
    }
    await fromRef.update({ balance: fromBal - stake, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });

    // Create the shared room in LOBBY state. Challenger = player1 (X).
    var roomRef = await db.collection("rooms").add({
      stake: stake, pot: stake * 2, status: "lobby",
      player1: c.from, player1Name: c.fromName,
      player2: myUid, player2Name: myName || "Player",
      board: ["","","","","","","","",""], turn: c.from, winner: null,
      isChallenge: true, lobbyUntil: Date.now() + 10000,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    await cRef.update({ status: "accepted", roomId: roomRef.id });
    return { roomId: roomRef.id, stake: stake };
  }

  async function rejectChallenge(myUid, challengeId) {
    await ensureFirebase();
    var db = firebase.firestore();
    var cRef = db.collection("challenges").doc(challengeId);
    var cSnap = await cRef.get();
    if (!cSnap.exists) return;
    if (cSnap.data().to !== myUid) return;
    await cRef.update({ status: "rejected" });
  }

  /* ─────────── SUPPORT CHAT ───────────
     supportMessages doc: { uid, from:'user'|'admin', text, createdAt }
  ─────────────────────────────────────── */
  async function sendSupportMessage(uid, text, from) {
    await ensureFirebase();
    var db = firebase.firestore();
    var t = (text || "").trim();
    if (!t) throw new Error("Message is empty.");
    await db.collection("supportMessages").add({
      uid: uid,
      from: from || "user",
      text: t.slice(0, 2000),
      read: false,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }

  // Real-time listener for a user's own support thread.
  // Returns the unsubscribe function.
  function listenSupport(uid, callback) {
    var unsub = function () {};
    ensureFirebase().then(function () {
      var db = firebase.firestore();
      unsub = db.collection("supportMessages")
        .where("uid", "==", uid)
        .onSnapshot(function (qs) {
          var msgs = [];
          qs.forEach(function (d) {
            var m = d.data();
            msgs.push({
              id: d.id, from: m.from || "user", text: m.text || "",
              createdAt: m.createdAt && m.createdAt.toMillis ? m.createdAt.toMillis() : 0
            });
          });
          msgs.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
          callback(msgs);
        }, function (err) { callback([], err); });
    });
    return function () { unsub(); };
  }

  /* ADMIN: live list of all support threads, grouped by user, newest first.
     Returns unsubscribe. Each thread: { uid, lastText, lastFrom, lastAt, count }.
     Resolves display names from the users collection (cached). */
  var _nameCache = {};
  async function _resolveName(uid) {
    if (_nameCache[uid] !== undefined) return _nameCache[uid];
    try {
      var s = await firebase.firestore().collection("users").doc(uid).get();
      _nameCache[uid] = s.exists ? (s.data().displayName || "Player") : "Unknown";
    } catch (e) { _nameCache[uid] = "Unknown"; }
    return _nameCache[uid];
  }
  function listenAllSupportThreads(callback) {
    var unsub = function () {};
    ensureFirebase().then(function () {
      var db = firebase.firestore();
      unsub = db.collection("supportMessages")
        .onSnapshot(async function (qs) {
          var byUser = {};
          qs.forEach(function (d) {
            var m = d.data();
            var u = m.uid; if (!u) return;
            var at = m.createdAt && m.createdAt.toMillis ? m.createdAt.toMillis() : 0;
            if (!byUser[u]) byUser[u] = { uid: u, lastText: "", lastFrom: "", lastAt: 0, count: 0 };
            byUser[u].count++;
            if (at >= byUser[u].lastAt) { byUser[u].lastAt = at; byUser[u].lastText = m.text || ""; byUser[u].lastFrom = m.from || "user"; }
          });
          var threads = Object.keys(byUser).map(function (k) { return byUser[k]; });
          // resolve names
          await Promise.all(threads.map(async function (t) { t.name = await _resolveName(t.uid); }));
          threads.sort(function (a, b) { return (b.lastAt || 0) - (a.lastAt || 0); });
          callback(threads);
        }, function (err) { callback([], err); });
    });
    return function () { unsub(); };
  }

  /* Add demo balance (client-side). Caps total at $10,000 and logs a
     transaction. Demo money only — never use this pattern for real cash. */
  async function topUpDemo(uid, amountUsd, method) {
    await ensureFirebase();
    var db = firebase.firestore();
    var ref = db.collection("users").doc(uid);
    var snap = await ref.get();
    if (!snap.exists) throw new Error("Profile not found. Please sign in again.");

    var current = Number(snap.data().balance || 0);
    var add = Number(amountUsd);
    if (!(add > 0)) throw new Error("Enter a valid amount.");

    var MAX = 10000;
    var next = Math.min(current + add, MAX);
    if (current >= MAX) throw new Error("Demo balance is already at the maximum.");

    await ref.update({
      balance: next,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    try {
      await db.collection("transactions").add({
        uid: uid,
        type: "deposit",
        delta: next - current,
        balanceBefore: current,
        balanceAfter: next,
        description: "Demo top-up via " + (method || "demo"),
        source: "demo",
        method: method || "demo",
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (e) { /* non-critical */ }

    // Write a notification so it appears on the notifications page
    try {
      await db.collection("notifications").add({
        uid: uid,
        type: "deposit",
        title: "Deposit Successful",
        message: "Your deposit of $" + (next - current).toFixed(2) + " via " + (method || "demo") + " was successful. New balance: $" + next.toFixed(2) + ".",
        read: false,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (e) { /* non-critical */ }

    return { balance: next, added: next - current };
  }

  async function topUpReal(uid, amountUsd, method, identifier, txReference) {
    await ensureFirebase();
    var db = firebase.firestore();
    var ref = db.collection("users").doc(uid);
    var snap = await ref.get();
    if (!snap.exists) throw new Error("Profile not found. Please sign in again.");

    var current = Number(snap.data().balance || 0);
    var add = Number(amountUsd);
    if (!(add > 0)) throw new Error("Enter a valid amount.");

    var next = current + add;

    await ref.update({
      balance: next,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    try {
      await db.collection("transactions").add({
        uid: uid,
        type: "deposit",
        delta: add,
        balanceBefore: current,
        balanceAfter: next,
        description: "Deposit of $" + add.toFixed(2) + " via " + method + " (Ref: " + identifier + ")",
        source: "real",
        method: method,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (e) { /* non-critical */ }

    try {
      await db.collection("notifications").add({
        uid: uid,
        type: "deposit",
        title: "Deposit Successful",
        message: "Your deposit of $" + add.toFixed(2) + " via " + method + " was successful. New balance: $" + next.toFixed(2) + ".",
        read: false,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (e) { /* non-critical */ }

    return { balance: next, added: add };
  }

  // Expose a tiny API for the pages to use.
  window.SWAccount = {
    ensureFirebase: ensureFirebase,
    ensureUserProfile: ensureUserProfile,
    getProfile: getProfile,
    updateProfile: updateProfile,
    getNotifications: getNotifications,
    getTransactions: getTransactions,
    getLeaderboard: getLeaderboard,
    getBalance: getBalance,
    topUpDemo: topUpDemo,
    topUpReal: topUpReal,
    searchUsers: searchUsers,
    getFriendsData: getFriendsData,
    sendFriendRequest: sendFriendRequest,
    acceptFriendRequest: acceptFriendRequest,
    declineFriendRequest: declineFriendRequest,
    blockUser: blockUser,
    unblockUser: unblockUser,
    sendChallenge: sendChallenge,
    acceptChallenge: acceptChallenge,
    rejectChallenge: rejectChallenge,
    sendSupportMessage: sendSupportMessage,
    listenSupport: listenSupport,
    listenAllSupportThreads: listenAllSupportThreads,
    STARTING_DEMO_BALANCE: STARTING_DEMO_BALANCE
  };
})();
