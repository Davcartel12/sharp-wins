/* ═══════════════════════════════════════════════════════════
   views/room.js — Sharp Wins live 1v1 Tic-Tac-Toe (Firestore-only)
   ───────────────────────────────────────────────────────────
   Flow:
     1. Tap a $X room -> join queue/{stake}/waiting/{uid}
     2. When an opponent is waiting at the same stake, the player with
        the LOWER uid wins the race and creates matches/{matchId} in a
        transaction: deducts BOTH stakes into match.pot, clears queue.
     3. Both clients listen to matches/{matchId} and play.
        Each move writes board[i] + flips turn + sets a fresh 15s deadline.
     4. Win  -> winner's client runs settleMatch (pays pot, bumps stats).
        Draw -> auto-rematch: board clears, random first player, pot rolls.
        Timeout (15s) -> opponent claims forfeit win.

   SECURITY: All money math is enforced by firestore.rules against the
   locked match.pot. This file only proposes writes; rules approve them.
   Nothing here can mint money — the rules are the server.

   Scoped: this file is self-contained. CSS is injected once (sw-game-css)
   so app.css is never touched. Reads window.SW from app.js.
═══════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var MOVE_SECONDS = 15;
  var FUND_SECONDS = 15;   // time for BOTH players to stake before self-refund
  var WIN_LINES = [
    [0,1,2],[3,4,5],[6,7,8],   // rows
    [0,3,6],[1,4,7],[2,5,8],   // cols
    [0,4,8],[2,4,6]            // diags
  ];

  // Per-mount state (reset on every enter, torn down in cleanup)
  var state = {
    stake: 0,
    matchId: null,
    unsub: null,         // firestore match listener unsubscriber
    queueUnsub: null,    // queue listener unsubscriber
    match: null,         // latest match snapshot data
    mySeat: null,        // "X" or "O"
    phase: "idle",       // idle | queue | playing | over
    tickTimer: null,     // setInterval handle for the countdown
    fundTimer: null,     // setInterval handle for the funding countdown
    settling: false,     // guard so we settle only once
    creating: false,     // guard so we create a match only once
    leftQueue: false
  };

  /* ── CSS injected once ───────────────────────────────────── */
  function ensureCss() {
    if (document.getElementById("sw-game-css")) return;
    var s = document.createElement("style");
    s.id = "sw-game-css";
    s.textContent = [
      ".g-wrap{max-width:520px;margin:0 auto;padding:88px 18px 24px;display:flex;flex-direction:column;gap:18px;align-items:center;text-align:center;}",
      ".g-title{font-size:1.6rem;font-weight:900;background:linear-gradient(135deg,var(--accent-2),var(--accent));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}",
      ".g-pot{font-size:.92rem;color:var(--muted);font-weight:700;}",
      ".g-pot b{color:#4ade80;}",
      /* status / queue */
      ".g-status{width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:18px;font-weight:700;color:var(--white);}",
      ".g-spin{display:inline-block;width:34px;height:34px;border:3px solid rgba(30,144,255,.25);border-top-color:var(--accent);border-radius:50%;animation:g-rot .8s linear infinite;margin-bottom:10px;}",
      "@keyframes g-rot{to{transform:rotate(360deg);}}",
      /* players bar */
      ".g-players{display:flex;align-items:center;justify-content:space-between;width:100%;gap:10px;}",
      ".g-pl{flex:1;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:10px 8px;transition:.2s;}",
      ".g-pl.turn{border-color:var(--accent);box-shadow:0 0 16px rgba(30,144,255,.4);background:rgba(30,144,255,.08);}",
      ".g-pl-name{font-weight:800;font-size:.82rem;color:var(--white);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      ".g-pl-mark{font-size:1.2rem;font-weight:900;margin-top:2px;}",
      ".g-pl-mark.x{color:var(--accent-2);}",
      ".g-pl-mark.o{color:#ff6b6b;}",
      ".g-vs{font-weight:900;color:var(--muted);font-size:.8rem;flex-shrink:0;}",
      /* timer */
      ".g-timer{font-size:.9rem;font-weight:800;color:var(--white);}",
      ".g-timer.low{color:#ff6b6b;}",
      ".g-timerbar{width:100%;height:6px;border-radius:6px;background:rgba(255,255,255,.08);overflow:hidden;}",
      ".g-timerbar > i{display:block;height:100%;background:linear-gradient(90deg,var(--accent-2),var(--accent));width:100%;transition:width 1s linear;}",
      ".g-timerbar.low > i{background:#ff6b6b;}",
      /* board */
      ".g-board{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;width:100%;max-width:340px;aspect-ratio:1/1;}",
      ".g-cell{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:2.6rem;font-weight:900;cursor:pointer;transition:.15s;user-select:none;}",
      ".g-cell:hover:not(.filled){background:rgba(30,144,255,.1);border-color:var(--accent);}",
      ".g-cell.filled{cursor:default;}",
      ".g-cell.x{color:var(--accent-2);text-shadow:0 0 18px rgba(0,176,255,.5);}",
      ".g-cell.o{color:#ff6b6b;text-shadow:0 0 18px rgba(255,107,107,.5);}",
      ".g-cell.win{background:rgba(74,222,128,.15);border-color:#4ade80;}",
      ".g-cell.disabled{pointer-events:none;}",
      ".g-cell.pop{animation:g-pop .2s ease;}",
      "@keyframes g-pop{from{transform:scale(.5);opacity:0;}to{transform:scale(1);opacity:1;}}",
      /* result */
      ".g-result{width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:22px;}",
      ".g-result h2{font-size:1.5rem;font-weight:900;margin-bottom:6px;}",
      ".g-result.win h2{color:#4ade80;}",
      ".g-result.lose h2{color:#ff6b6b;}",
      ".g-result p{color:var(--muted);font-size:.9rem;}",
      ".g-result .amt{font-size:1.1rem;font-weight:900;margin-top:8px;}",
      ".g-result .amt.pos{color:#4ade80;}",
      ".g-result .amt.neg{color:#ff6b6b;}",
      /* buttons */
      ".g-btn{margin-top:6px;padding:13px 22px;border:none;border-radius:14px;font-weight:800;font-size:.92rem;cursor:pointer;font-family:inherit;transition:.2s;}",
      ".g-btn.primary{background:linear-gradient(135deg,var(--accent-2),var(--accent));color:#fff;box-shadow:0 0 18px rgba(30,144,255,.4);}",
      ".g-btn.ghost{background:rgba(255,255,255,.06);color:var(--white);border:1px solid rgba(255,255,255,.12);}",
      ".g-btn:active{transform:scale(.97);}",
      ".g-rematch-note{color:var(--muted);font-size:.82rem;margin-top:4px;}"
    ].join("");
    document.head.appendChild(s);
  }

  /* ── Small helpers ───────────────────────────────────────── */
  function $(id) { return document.getElementById(id); }
  function db() { return SW.db; }
  function FieldValue() { return firebase.firestore.FieldValue; }
  function now() { return Date.now(); }
  function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(c){return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c];}); }

  // Deadline as ms epoch. We store deadline as a number (client-set) so the
  // countdown is simple; rules validate forfeits using the SAME stored number.
  function freshDeadline() { return now() + MOVE_SECONDS * 1000; }

  function winnerOf(board) {
    for (var i = 0; i < WIN_LINES.length; i++) {
      var L = WIN_LINES[i], a = board[L[0]];
      if (a && a === board[L[1]] && a === board[L[2]]) return { mark: a, line: L };
    }
    if (board.every(function (c) { return c; })) return { mark: "draw", line: null };
    return null;
  }

  function myUid() { return SW.uid; }
  function oppUid() {
    if (!state.match) return null;
    return state.match.players.filter(function (u) { return u !== myUid(); })[0] || null;
  }
  function seatOf(uid) {
    var s = state.match && state.match.seats;
    if (!s) return null;
    return s.X === uid ? "X" : (s.O === uid ? "O" : null);
  }
  function isMyTurn() {
    return state.match && state.match.status === "active" && state.match.turn === state.mySeat;
  }

  /* ════════════════════════════════════════════════════════
     MATCHMAKING
  ════════════════════════════════════════════════════════ */

  async function joinQueue(stake) {
    state.phase = "queue";
    state.leftQueue = false;
    var uid = myUid();
    var qref = db().collection("queue").doc(String(stake)).collection("waiting").doc(uid);

    // Pre-check: balance must cover the stake (rules also enforce on match create)
    if (SW.balance < stake) {
      renderError("You need " + SW.fmt(stake) + " to play this room. Please deposit.");
      return;
    }

    try {
      await qref.set({
        uid: uid,
        displayName: (SW.profile && SW.profile.displayName) || "Player",
        photoURL: (SW.profile && SW.profile.photoURL) || "",
        stake: stake,
        createdAt: FieldValue().serverTimestamp(),
        ts: now()
      });
    } catch (e) {
      renderError("Could not join the queue. Please try again.");
      return;
    }

    watchQueue(stake);
  }

  function watchQueue(stake) {
    var col = db().collection("queue").doc(String(stake)).collection("waiting");
    state.queueUnsub = col.orderBy("ts", "asc").limit(10).onSnapshot(function (qs) {
      if (state.phase !== "queue") return;
      var waiting = [];
      qs.forEach(function (d) { waiting.push(d.data()); });

      // Am I matched into a match already? (opponent may have created it)
      checkForMyMatch(stake);

      // Find an opponent (anyone that isn't me)
      var opp = waiting.filter(function (w) { return w.uid !== myUid(); })[0];
      if (!opp) return;

      // Deterministic creator: lower uid creates the match (avoids double-create)
      if (myUid() < opp.uid && !state.creating && !state.matchId) {
        createMatch(stake, opp);
      }
      // The higher uid just waits for checkForMyMatch to pick up the new match.
    }, function (err) {
      // listener error — fall back to a one-shot poll later if needed
      console.warn("queue listen error", err);
    });
  }

  // Poll for a match that already lists me (created by the opponent).
  var _lastMatchScan = 0;
  async function checkForMyMatch(stake) {
    if (state.matchId) return;
    if (now() - _lastMatchScan < 800) return; // throttle
    _lastMatchScan = now();
    try {
      var qs = await db().collection("matches")
        .where("players", "array-contains", myUid())
        .where("status", "in", ["funding", "active"])
        .limit(5).get();
      var found = null;
      qs.forEach(function (d) {
        var m = d.data();
        if (m.stake === stake && !found) found = { id: d.id, data: m };
      });
      if (found) {
        leaveQueue(stake);
        attachMatch(found.id);
      }
    } catch (e) { /* index/permission — ignore, creator path still works */ }
  }

  // Create the match in the FUNDING phase. No money moves here — the creator
  // only writes the match doc (allowed: they are a participant). Each player
  // then stakes their OWN balance via fundMatch(), keeping every user-doc write
  // strictly self-only. Once both funded, the match flips to "active".
  async function createMatch(stake, opp) {
    state.creating = true;
    var meUid = myUid();
    var oppUidLocal = opp.uid;
    var matchRef = db().collection("matches").doc();

    // Random first seat assignment (persisted; rematch re-randomizes later)
    var iAmX = Math.random() < 0.5;
    var seats = iAmX
      ? { X: meUid, O: oppUidLocal }
      : { X: oppUidLocal, O: meUid };

    var funded = {};
    funded[meUid] = false;
    funded[oppUidLocal] = false;

    try {
      await matchRef.set({
        stake: stake,
        pot: stake * 2,
        players: [meUid, oppUidLocal],
        seats: seats,
        names: {
          X: seats.X === meUid ? ((SW.profile && SW.profile.displayName) || "Player") : (opp.displayName || "Player"),
          O: seats.O === meUid ? ((SW.profile && SW.profile.displayName) || "Player") : (opp.displayName || "Player")
        },
        funded: funded,
        board: ["","","","","","","","",""],
        turn: "X",
        round: 1,
        status: "funding",
        winner: null,
        deadline: null,
        fundingDeadline: now() + FUND_SECONDS * 1000,
        createdBy: meUid,
        createdAt: FieldValue().serverTimestamp(),
        updatedAt: FieldValue().serverTimestamp()
      });

      // Remove both from queue (best-effort)
      cleanupQueueEntry(stake, meUid);
      cleanupQueueEntry(stake, oppUidLocal);

      leaveQueue(stake);
      attachMatch(matchRef.id);
    } catch (e) {
      state.creating = false;
      console.warn("createMatch failed", e);
    }
  }

  // Stake MY OWN balance and flip MY OWN funded flag. If this write sees the
  // opponent already funded, the same transaction flips status -> active and
  // starts the move clock. Strictly self-only on the user doc.
  var _funding = false, _fundedThisMatch = false;
  async function fundMatch() {
    if (_funding || _fundedThisMatch) return;
    var m = state.match;
    if (!m || m.status !== "funding") return;
    if (m.players.indexOf(myUid()) < 0) return;
    if (m.funded && m.funded[myUid()] === true) { _fundedThisMatch = true; return; }
    _funding = true;

    var stake = Number(m.stake || 0);
    if (SW.balance < stake) {
      _funding = false;
      renderError("Your balance dropped below " + SW.fmt(stake) + ". Please deposit.");
      return;
    }

    var matchRef = db().collection("matches").doc(state.matchId);
    var meRef = db().collection("users").doc(myUid());

    try {
      await db().runTransaction(async function (tx) {
        var mSnap = await tx.get(matchRef);
        if (!mSnap.exists) throw new Error("gone");
        var cur = mSnap.data();
        if (cur.status !== "funding") throw new Error("not-funding");
        if (cur.funded && cur.funded[myUid()] === true) throw new Error("already-funded");

        var meSnap = await tx.get(meRef);
        if (!meSnap.exists) throw new Error("no-user");
        var bal = Number(meSnap.data().balance || 0);
        if (bal < stake) throw new Error("insufficient");

        // Flip my funded flag; detect if opponent is already in.
        var newFunded = Object.assign({}, cur.funded);
        newFunded[myUid()] = true;
        var oppId = cur.players.filter(function (u) { return u !== myUid(); })[0];
        var bothIn = newFunded[oppId] === true;

        // Deduct MY stake from MY doc only.
        tx.update(meRef, { balance: bal - stake, lastMatchId: state.matchId, updatedAt: FieldValue().serverTimestamp() });

        var matchPatch = { funded: newFunded, updatedAt: FieldValue().serverTimestamp() };
        if (bothIn) {
          matchPatch.status = "active";
          matchPatch.turn = "X";
          matchPatch.deadline = freshDeadline();
        }
        tx.update(matchRef, matchPatch);
      });

      _fundedThisMatch = true;
      SW.setBalance(SW.balance - stake);
    } catch (e) {
      _funding = false;
      if (String(e.message).indexOf("insufficient") >= 0) {
        renderError("Your balance dropped below " + SW.fmt(stake) + ". Please deposit.");
        return;
      }
      if (["not-funding","already-funded","gone"].indexOf(String(e.message)) < 0) {
        console.warn("fundMatch failed", e);
      }
    }
  }

  // Self-refund when the opponent never funded before fundingDeadline.
  // Credits MY OWN balance back by the stake and marks the match cancelled.
  // Strictly self-only on the user doc; rules verify deadline + my funded state.
  var _refunding = false, _refundedThisMatch = false;
  async function selfRefund() {
    if (_refunding || _refundedThisMatch) return;
    var m = state.match;
    if (!m || m.status !== "funding") return;
    if (!(m.funded && m.funded[myUid()] === true)) return;   // I never funded — nothing to refund
    if (!m.fundingDeadline || now() <= m.fundingDeadline) return;
    _refunding = true;

    var stake = Number(m.stake || 0);
    var matchRef = db().collection("matches").doc(state.matchId);
    var meRef = db().collection("users").doc(myUid());

    try {
      await db().runTransaction(async function (tx) {
        var mSnap = await tx.get(matchRef);
        if (!mSnap.exists) throw new Error("gone");
        var cur = mSnap.data();
        if (cur.status !== "funding") throw new Error("not-funding");      // started or already cancelled
        if (!(cur.funded && cur.funded[myUid()] === true)) throw new Error("not-funded");
        if (!cur.fundingDeadline || now() <= cur.fundingDeadline) throw new Error("too-early");

        var meSnap = await tx.get(meRef);
        var bal = Number((meSnap.exists ? meSnap.data().balance : 0) || 0);

        tx.update(meRef, { balance: bal + stake, lastMatchId: state.matchId, updatedAt: FieldValue().serverTimestamp() });
        tx.update(matchRef, {
          status: "cancelled",
          cancelledBy: myUid(),
          cancelledAt: FieldValue().serverTimestamp(),
          updatedAt: FieldValue().serverTimestamp()
        });
      });

      _refundedThisMatch = true;
      SW.setBalance(SW.balance + stake);
      writeRefundReceipts(stake);
      renderRefunded(stake);
    } catch (e) {
      _refunding = false;
      if (["not-funding","not-funded","too-early","gone"].indexOf(String(e.message)) < 0) {
        console.warn("selfRefund failed", e);
      }
    }
  }

  function cleanupQueueEntry(stake, uid) {
    db().collection("queue").doc(String(stake)).collection("waiting").doc(uid)
      .delete().catch(function () {});
  }

  function leaveQueue(stake) {
    if (state.leftQueue) return;
    state.leftQueue = true;
    if (state.queueUnsub) { try { state.queueUnsub(); } catch (e) {} state.queueUnsub = null; }
    cleanupQueueEntry(stake, myUid());
  }

  /* ════════════════════════════════════════════════════════
     LIVE MATCH
  ════════════════════════════════════════════════════════ */

  function attachMatch(matchId) {
    state.matchId = matchId;
    state.phase = "playing";
    // Reset per-match guards for this fresh match
    _funding = false; _fundedThisMatch = false;
    _refunding = false; _refundedThisMatch = false;
    _lossRecorded = false;
    state.settling = false;
    var ref = db().collection("matches").doc(matchId);
    state.unsub = ref.onSnapshot(function (snap) {
      if (!snap.exists) return;
      state.match = snap.data();
      state.mySeat = seatOf(myUid());
      renderMatch();
      maybeAutoResolve();
      // If the match is settled and I didn't win, self-report my loss (once).
      if (state.match.status === "settled" && state.match.winner !== myUid()) {
        recordMyLoss();
      }
    }, function (err) {
      console.warn("match listen error", err);
    });
  }

  // After every snapshot, see if the game needs funding / settling / rematch / forfeit.
  function maybeAutoResolve() {
    var m = state.match;
    if (!m) return;

    // ── FUNDING PHASE ──
    if (m.status === "funding") {
      // Stake my own balance if I haven't yet.
      if (!(m.funded && m.funded[myUid()] === true)) {
        fundMatch();
      }
      // If the opponent never funded and the deadline passed, refund myself.
      if (m.fundingDeadline && now() > m.fundingDeadline + 500) {
        selfRefund();
      }
      return;
    }

    if (m.status === "cancelled") { renderRefunded(Number(m.stake || 0)); return; }

    if (m.status !== "active") return;

    var result = winnerOf(m.board);

    if (result && result.mark !== "draw") {
      // Someone has 3 in a row. The winner's client settles.
      var winnerSeat = result.mark;
      if (winnerSeat === state.mySeat) settleWin(winnerSeat);
      return;
    }

    if (result && result.mark === "draw") {
      // Draw -> auto-rematch. The current X seat triggers the reset
      // (deterministic single writer) so we don't double-write.
      if (state.mySeat === "X") rematch();
      return;
    }

    // No result yet — check the move clock for a forfeit.
    if (m.deadline && now() > m.deadline + 1200) {
      // The player whose turn it is has run out of time. The OTHER player claims.
      var stalledSeat = m.turn;
      if (stalledSeat !== state.mySeat) claimForfeit();
    }
  }

  async function makeMove(i) {
    var m = state.match;
    if (!m || m.status !== "active") return;
    if (!isMyTurn()) return;
    if (m.board[i]) return;

    var ref = db().collection("matches").doc(state.matchId);
    var newBoard = m.board.slice();
    newBoard[i] = state.mySeat;
    var nextTurn = state.mySeat === "X" ? "O" : "X";

    // Optimistic paint
    paintCell(i, state.mySeat, true);

    try {
      await db().runTransaction(async function (tx) {
        var s = await tx.get(ref);
        if (!s.exists) throw new Error("gone");
        var cur = s.data();
        if (cur.status !== "active") throw new Error("not-active");
        if (cur.turn !== state.mySeat) throw new Error("not-your-turn");
        if (cur.board[i]) throw new Error("cell-taken");
        tx.update(ref, {
          board: newBoard,
          turn: nextTurn,
          deadline: freshDeadline(),
          updatedAt: FieldValue().serverTimestamp()
        });
      });
    } catch (e) {
      // Roll back optimistic paint by re-rendering from authoritative state
      renderMatch();
    }
  }
  window.SW_cell = function (i) { makeMove(i); };

  async function rematch() {
    var ref = db().collection("matches").doc(state.matchId);
    // Randomize who goes first next round
    var firstX = Math.random() < 0.5;
    var m = state.match;
    var newSeats = firstX
      ? { X: m.seats.X, O: m.seats.O }
      : { X: m.seats.O, O: m.seats.X };
    var newNames = firstX
      ? { X: m.names.X, O: m.names.O }
      : { X: m.names.O, O: m.names.X };
    try {
      await db().runTransaction(async function (tx) {
        var s = await tx.get(ref);
        if (!s.exists) return;
        var cur = s.data();
        if (cur.status !== "active") return;
        if (!winnerOf(cur.board) || winnerOf(cur.board).mark !== "draw") return; // still a draw?
        tx.update(ref, {
          board: ["","","","","","","","",""],
          seats: newSeats,
          names: newNames,
          turn: "X",
          round: (cur.round || 1) + 1,
          deadline: freshDeadline(),
          updatedAt: FieldValue().serverTimestamp()
        });
      });
    } catch (e) { console.warn("rematch failed", e); }
  }

  async function settleWin(winnerSeat) {
    if (state.settling) return;
    state.settling = true;
    var winnerUid = state.match.seats[winnerSeat];
    var loserUid = state.match.players.filter(function (u) { return u !== winnerUid; })[0];
    await settle(winnerUid, loserUid, "win");
  }

  async function claimForfeit() {
    if (state.settling) return;
    state.settling = true;
    var winnerUid = myUid();
    var loserUid = oppUid();
    await settle(winnerUid, loserUid, "forfeit");
  }

  // Settle path: the WINNER's client only. Writes ONLY the winner's own user
  // doc + the match doc — never the loser's doc. This keeps the security rule
  // strict ("you can only edit yourself"). The loser self-reports their loss
  // separately (see recordMyLoss), triggered when they observe status:settled.
  async function settle(winnerUid, loserUid, reason) {
    var matchRef = db().collection("matches").doc(state.matchId);
    var winRef = db().collection("users").doc(winnerUid);

    try {
      var paid = await db().runTransaction(async function (tx) {
        var mSnap = await tx.get(matchRef);
        if (!mSnap.exists) throw new Error("gone");
        var m = mSnap.data();
        if (m.status === "settled") return 0; // already paid — no-op

        // Verify the claim against the authoritative board
        if (reason === "win") {
          var r = winnerOf(m.board);
          if (!r || r.mark === "draw") throw new Error("no-winner");
          if (m.seats[r.mark] !== winnerUid) throw new Error("wrong-winner");
        } else if (reason === "forfeit") {
          if (!m.deadline || now() <= m.deadline + 1000) throw new Error("not-timed-out");
          // Derive the winner's seat from THIS transaction's data (m.seats),
          // not the cached snapshot — a draw-rematch may have swapped seats.
          var winnerSeatNow = m.seats.X === winnerUid ? "X" : (m.seats.O === winnerUid ? "O" : null);
          if (m.turn === winnerSeatNow) throw new Error("claimant-stalled"); // only the waiting player can claim
        }

        var pot = Number(m.pot || 0);
        var wSnap = await tx.get(winRef);
        var wBal = Number((wSnap.exists ? wSnap.data().balance : 0) || 0);
        var wWins = Number((wSnap.exists ? wSnap.data().wins : 0) || 0);
        var wTotal = Number((wSnap.exists ? wSnap.data().totalWinnings : 0) || 0);

        tx.update(matchRef, {
          status: "settled",
          winner: winnerUid,
          settleReason: reason,
          settledAt: FieldValue().serverTimestamp(),
          updatedAt: FieldValue().serverTimestamp()
        });
        tx.update(winRef, {
          balance: wBal + pot,
          wins: wWins + 1,
          totalWinnings: wTotal + (pot - m.stake), // net profit = pot minus own stake
          lastMatchId: state.matchId,              // rule reads this to validate payout
          updatedAt: FieldValue().serverTimestamp()
        });
        return pot;
      });

      if (paid > 0 && winnerUid === myUid()) {
        SW.setBalance(SW.balance + paid);
        writeWinReceipts(paid, reason); // best-effort tx + notif
      }
    } catch (e) {
      state.settling = false; // allow retry on next snapshot
      if (["no-winner","wrong-winner","not-timed-out","claimant-stalled"].indexOf(String(e.message)) < 0) {
        console.warn("settle failed", e);
      }
    }
  }

  // Loser self-reports their loss: writes ONLY their own user doc, exactly once
  // per match. Cosmetic stat — money already moved in the winner's settle.
  var _lossRecorded = false;
  async function recordMyLoss() {
    if (_lossRecorded) return;
    var m = state.match;
    if (!m || m.status !== "settled") return;
    if (m.winner === myUid()) return;                 // I won — not a loss
    if (m.players.indexOf(myUid()) < 0) return;       // not my match
    _lossRecorded = true;
    var meRef = db().collection("users").doc(myUid());
    try {
      await db().runTransaction(async function (tx) {
        var s = await tx.get(meRef);
        if (!s.exists) return;
        var d = s.data();
        // Idempotency guard: don't double-count if this match was already logged
        var last = d.lastLossMatchId || "";
        if (last === state.matchId) return;
        tx.update(meRef, {
          losses: Number(d.losses || 0) + 1,
          lastLossMatchId: state.matchId,
          updatedAt: FieldValue().serverTimestamp()
        });
      });
    } catch (e) { _lossRecorded = false; /* allow retry */ }
  }

  function writeWinReceipts(pot, reason) {
    var net = pot - state.match.stake;
    db().collection("transactions").add({
      uid: myUid(),
      type: "win",
      delta: pot,
      description: reason === "forfeit"
        ? "Opponent forfeited — $" + state.stake + " room"
        : "Won $" + state.stake + " room",
      source: "game",
      method: "Tic-Tac-Toe",
      matchId: state.matchId,
      createdAt: FieldValue().serverTimestamp()
    }).catch(function () {});
    db().collection("notifications").add({
      uid: myUid(),
      type: "win",
      title: "You won " + SW.fmt(net) + "!",
      message: reason === "forfeit"
        ? "Your opponent ran out of time in the $" + state.stake + " room."
        : "Nice — you took the $" + state.stake + " room.",
      read: false,
      createdAt: FieldValue().serverTimestamp()
    }).catch(function () {});
  }

  function writeRefundReceipts(stake) {
    db().collection("transactions").add({
      uid: myUid(),
      type: "refund",
      delta: stake,
      description: "Refund — opponent didn't join ($" + state.stake + " room)",
      source: "game",
      method: "Tic-Tac-Toe",
      matchId: state.matchId,
      createdAt: FieldValue().serverTimestamp()
    }).catch(function () {});
    db().collection("notifications").add({
      uid: myUid(),
      type: "system",
      title: "Stake refunded",
      message: "Your opponent didn't join the $" + state.stake + " room in time. Your " + SW.fmt(stake) + " was returned.",
      read: false,
      createdAt: FieldValue().serverTimestamp()
    }).catch(function () {});
  }

  /* Quit before a match exists (just leave queue and go home) */
  window.SW_quitQueue = function () {
    leaveQueue(state.stake);
    state.phase = "idle";
    SW_NAV("home");
  };

  /* ════════════════════════════════════════════════════════
     RENDERING
  ════════════════════════════════════════════════════════ */

  function shell(inner) {
    return '<div class="g-wrap">' +
      '<div class="g-title">' + SW.fmt(state.stake) + ' Room</div>' +
      '<div class="g-pot">Winner takes <b>' + SW.fmt(state.stake * 2) + '</b></div>' +
      inner +
    '</div>';
  }

  function setView(html) {
    var el = $("view");
    if (el) el.innerHTML = shell(html);
  }

  function renderQueue() {
    setView(
      '<div class="g-status">' +
        '<div class="g-spin"></div>' +
        '<div>Finding an opponent…</div>' +
        '<div style="color:var(--muted);font-weight:600;font-size:.85rem;margin-top:6px;">Matching you with another player at this stake.</div>' +
      '</div>' +
      '<button class="g-btn ghost" onclick="SW_quitQueue()">Cancel</button>'
    );
  }

  function renderError(msg) {
    state.phase = "over";
    setView(
      '<div class="g-status" style="color:#ff6b6b;">' + esc(msg) + '</div>' +
      '<button class="g-btn primary" onclick="SW_NAV(\'home\')">← Back to rooms</button>'
    );
  }

  function renderRefunded(stake) {
    stopTick();
    state.phase = "over";
    var m = state.match;
    var iFunded = m && m.funded && m.funded[myUid()] === true;
    var body = iFunded
      ? '<div class="g-result"><h2 style="color:var(--white);">Opponent didn\'t join</h2>' +
          '<p>No game took place, so your stake was returned.</p>' +
          '<div class="amt pos">+' + SW.fmt(stake || state.stake) + ' refunded</div></div>'
      : '<div class="g-result"><h2 style="color:var(--white);">Match cancelled</h2>' +
          '<p>This match didn\'t start. No money was taken.</p></div>';
    setView(
      body +
      '<button class="g-btn primary" onclick="SW_NAV(\'home\')">← Back to rooms</button>'
    );
  }

  function renderFunding() {
    var m = state.match;
    var iFunded = m.funded && m.funded[myUid()] === true;
    var oppId = m.players.filter(function (u) { return u !== myUid(); })[0];
    var oppFunded = m.funded && m.funded[oppId] === true;
    var oName = state.mySeat === "X" ? (m.names && m.names.O) : (m.names && m.names.X);

    setView(
      '<div class="g-status">' +
        '<div class="g-spin"></div>' +
        '<div>' + (iFunded ? "Waiting for " + esc(oName || "opponent") + " to join…" : "Joining the room…") + '</div>' +
        '<div style="color:var(--muted);font-weight:600;font-size:.85rem;margin-top:8px;">' +
          'You: ' + (iFunded ? '<span style="color:#4ade80;">staked ✓</span>' : 'staking…') +
          ' &nbsp;·&nbsp; Opponent: ' + (oppFunded ? '<span style="color:#4ade80;">staked ✓</span>' : 'waiting…') +
        '</div>' +
        '<div class="g-timer" id="gFundTimer" style="margin-top:12px;">Auto-refund in <span id="gFundSecs">' + FUND_SECONDS + '</span>s if they don\'t join</div>' +
      '</div>'
    );
    startFundTick();
  }

  function renderMatch() {
    var m = state.match;
    if (!m) return;

    if (m.status === "funding") { renderFunding(); return; }
    if (m.status === "cancelled") { renderRefunded(Number(m.stake || 0)); return; }
    if (m.status === "settled") { renderResult(); return; }

    var xName = (m.names && m.names.X) || "Player X";
    var oName = (m.names && m.names.O) || "Player O";
    var xTurn = m.turn === "X";

    var players =
      '<div class="g-players">' +
        '<div class="g-pl' + (xTurn ? ' turn' : '') + '">' +
          '<div class="g-pl-name">' + esc(xName) + (state.mySeat === "X" ? " (you)" : "") + '</div>' +
          '<div class="g-pl-mark x">X</div>' +
        '</div>' +
        '<div class="g-vs">VS</div>' +
        '<div class="g-pl' + (!xTurn ? ' turn' : '') + '">' +
          '<div class="g-pl-name">' + esc(oName) + (state.mySeat === "O" ? " (you)" : "") + '</div>' +
          '<div class="g-pl-mark o">O</div>' +
        '</div>' +
      '</div>';

    var turnLabel = isMyTurn()
      ? '<span style="color:#4ade80;">Your move</span>'
      : '<span style="color:var(--muted);">Opponent\'s move</span>';

    var timer =
      '<div class="g-timer" id="gTimer">' + turnLabel + ' · <span id="gSecs">' + MOVE_SECONDS + '</span>s</div>' +
      '<div class="g-timerbar" id="gBar"><i id="gBarFill"></i></div>';

    var cells = "";
    for (var i = 0; i < 9; i++) {
      var v = m.board[i];
      var cls = "g-cell" + (v ? " filled " + v.toLowerCase() : "");
      if (!isMyTurn() || v) cls += " disabled";
      cells += '<div class="' + cls + '" id="gc' + i + '" onclick="SW_cell(' + i + ')">' + (v || "") + '</div>';
    }

    var roundTag = (m.round && m.round > 1)
      ? '<div class="g-rematch-note">Round ' + m.round + ' · last round was a draw, pot rolled over</div>'
      : '';

    setView(players + timer + '<div class="g-board">' + cells + '</div>' + roundTag);
    startTick();
  }

  function paintCell(i, mark, pop) {
    var c = $("gc" + i);
    if (!c) return;
    c.textContent = mark;
    c.className = "g-cell filled " + mark.toLowerCase() + (pop ? " pop disabled" : " disabled");
  }

  function renderResult() {
    stopTick();
    state.phase = "over";
    var m = state.match;
    var iWon = m.winner === myUid();
    var pot = Number(m.pot || 0);
    var net = pot - Number(m.stake || 0);

    // Highlight winning line if it was a real 3-in-a-row win
    var result = winnerOf(m.board);
    var highlight = "";
    if (result && result.line) {
      highlight = '<div class="g-board" style="margin:0 auto 14px;">';
      for (var i = 0; i < 9; i++) {
        var v = m.board[i];
        var win = result.line.indexOf(i) >= 0;
        highlight += '<div class="g-cell filled ' + (v ? v.toLowerCase() : "") + (win ? " win" : "") + ' disabled">' + (v || "") + '</div>';
      }
      highlight += '</div>';
    }

    var body = iWon
      ? '<div class="g-result win">' +
          '<h2>🏆 You won!</h2>' +
          '<p>' + (m.settleReason === "forfeit" ? "Your opponent ran out of time." : "Three in a row — clean.") + '</p>' +
          '<div class="amt pos">+' + SW.fmt(net) + '</div>' +
        '</div>'
      : '<div class="g-result lose">' +
          '<h2>You lost</h2>' +
          '<p>' + (m.settleReason === "forfeit" ? "You ran out of time on your move." : "Opponent got three in a row.") + '</p>' +
          '<div class="amt neg">-' + SW.fmt(state.stake) + '</div>' +
        '</div>';

    setView(
      highlight + body +
      '<button class="g-btn primary" onclick="SW_NAV(\'room/' + state.stake + '\')">Play again</button>' +
      '<button class="g-btn ghost" onclick="SW_NAV(\'home\')">← Back to rooms</button>'
    );
  }

  /* ── Countdown ticker (visual only; truth is m.deadline) ── */
  function startTick() {
    stopTick();
    updateTick();
    state.tickTimer = setInterval(updateTick, 250);
  }
  function stopTick() {
    if (state.tickTimer) { clearInterval(state.tickTimer); state.tickTimer = null; }
    if (state.fundTimer) { clearInterval(state.fundTimer); state.fundTimer = null; }
  }
  function updateTick() {
    var m = state.match;
    if (!m || m.status !== "active" || !m.deadline) return;
    var remain = Math.max(0, m.deadline - now());
    var secs = Math.ceil(remain / 1000);
    var secEl = $("gSecs"), tEl = $("gTimer"), barWrap = $("gBar"), barFill = $("gBarFill");
    if (secEl) secEl.textContent = secs;
    var pct = Math.max(0, Math.min(100, (remain / (MOVE_SECONDS * 1000)) * 100));
    if (barFill) barFill.style.width = pct + "%";
    var low = secs <= 5;
    if (tEl) tEl.classList.toggle("low", low);
    if (barWrap) barWrap.classList.toggle("low", low);

    // If time fully elapsed, nudge a resolve check (snapshot may not have fired)
    if (remain <= 0) maybeAutoResolve();
  }

  /* ── Funding-phase countdown (drives self-refund) ── */
  function startFundTick() {
    if (state.fundTimer) { clearInterval(state.fundTimer); state.fundTimer = null; }
    updateFundTick();
    state.fundTimer = setInterval(updateFundTick, 250);
  }
  function updateFundTick() {
    var m = state.match;
    if (!m || m.status !== "funding" || !m.fundingDeadline) return;
    var remain = Math.max(0, m.fundingDeadline - now());
    var secs = Math.ceil(remain / 1000);
    var el = $("gFundSecs");
    if (el) el.textContent = secs;
    if (remain <= 0) maybeAutoResolve(); // triggers selfRefund when eligible
  }

  /* ════════════════════════════════════════════════════════
     VIEW REGISTRATION
  ════════════════════════════════════════════════════════ */
  window.SW_VIEWS.room = {
    render: function (r) {
      ensureCss();
      state.stake = Number(r && r.param) || 0;
      // Initial paint while we wait for auth/match to attach
      return shell('<div class="g-status"><div class="g-spin"></div><div>Loading room…</div></div>');
    },

    init: function (r) {
      ensureCss();
      // reset per-mount state (keep stake from render)
      var stake = Number(r && r.param) || state.stake || 0;
      state.stake = stake;
      state.matchId = null;
      state.match = null;
      state.mySeat = null;
      state.settling = false;
      state.creating = false;
      state.leftQueue = false;
      state.phase = "idle";

      if (!SW.user) {
        window.SW_PENDING_NAV = "room/" + stake;
        if (window.openSignInModal) openSignInModal();
        renderError("Sign in to enter the " + SW.fmt(stake) + " room.");
        return;
      }
      if (!stake) { renderError("Invalid room."); return; }
      if (SW.balance < stake) {
        renderError("You need " + SW.fmt(stake) + " to play this room. Please deposit.");
        return;
      }

      renderQueue();
      joinQueue(stake);
    },

    cleanup: function () {
      stopTick();
      if (state.unsub) { try { state.unsub(); } catch (e) {} state.unsub = null; }
      if (state.queueUnsub) { try { state.queueUnsub(); } catch (e) {} state.queueUnsub = null; }
      // If we bail while still queued (and not in a match), remove our queue entry
      if (state.phase === "queue" && !state.matchId) {
        cleanupQueueEntry(state.stake, myUid());
      }
      state.phase = "idle";
    }
  };
})();