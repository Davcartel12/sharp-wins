/* views/deposit.js — manual crypto deposit flow for Sharp Wins
   Flow: pick coin → show address + QR + 15-min countdown →
         user enters amount + txid (+ optional screenshot URL) →
         creates a PENDING doc in the `deposits` collection.
   The client NEVER writes balance. Admin approval credits balance
   (see admin approveTx → increment(amount)).

   Deposit doc shape (must match admin loadDeposits/approveTx):
     { uid, email, amount, coin, txid, proofUrl, network,
       status:'pending', createdAt }
═══════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  /* ─────────────────────────────────────────────────────────
     ⚠️  EDIT THESE: paste your real wallet addresses + QR images.
     - address: the on-chain receiving address you control.
     - qr:      path/URL to a QR image of that address (upload e.g.
                btc-qr.png next to index.html, or paste a data/URL).
     If qr is left "", the view auto-generates a QR from the address
     using a public QR image service as a fallback.
  ───────────────────────────────────────────────────────────── */
  var COINS = {
    BTC: {
      label: "Bitcoin",
      ticker: "BTC",
      network: "Bitcoin (on-chain)",
      address: "PASTE_YOUR_BTC_ADDRESS_HERE",
      qr: "",                       // e.g. "btc-qr.png"
      explorer: "https://www.blockchain.com/explorer/transactions/btc/",
      color: "#f7931a",
      icon: "fa-brands fa-bitcoin"
    },
    USDT: {
      label: "Tether USD",
      ticker: "USDT",
      network: "Tron (TRC20)",
      address: "PASTE_YOUR_USDT_TRC20_ADDRESS_HERE",
      qr: "",                       // e.g. "usdt-qr.png"
      explorer: "https://tronscan.org/#/transaction/",
      color: "#26a17b",
      icon: "fa-solid fa-dollar-sign"
    },
    ETH: {
      label: "Ethereum",
      ticker: "ETH",
      network: "Ethereum (ERC20)",
      address: "PASTE_YOUR_ETH_ADDRESS_HERE",
      qr: "",                       // e.g. "eth-qr.png"
      explorer: "https://etherscan.io/tx/",
      color: "#627eea",
      icon: "fa-brands fa-ethereum"
    }
  };

  var WINDOW_MS = 15 * 60 * 1000;   // 15 minutes
  var _timer = null;
  var _deadline = 0;
  var _selectedCoin = null;

  function qrSrc(coin) {
    if (coin.qr) return coin.qr;
    // Fallback: render a QR from the address via a public image service.
    return "https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=" +
      encodeURIComponent(coin.address);
  }

  /* ── Step 1: pick a coin ── */
  function coinGridHtml() {
    return Object.keys(COINS).map(function (k) {
      var c = COINS[k];
      return '<div class="dep-coin" onclick="SW_depPick(\'' + k + '\')">' +
        '<div class="dep-coin-ico" style="color:' + c.color + '"><i class="' + c.icon + '"></i></div>' +
        '<div class="dep-coin-meta">' +
          '<div class="dep-coin-name">' + c.label + '</div>' +
          '<div class="dep-coin-net">' + c.network + '</div>' +
        '</div>' +
        '<i class="fa-solid fa-chevron-right dep-coin-arrow"></i>' +
      '</div>';
    }).join("");
  }

  /* ── Step 2: pay screen (address + QR + countdown + form) ── */
  function payHtml(coinKey) {
    var c = COINS[coinKey];
    var addrSet = c.address && c.address.indexOf("PASTE_") !== 0;
    return '<div class="dep-pay">' +
      '<button class="dep-back" onclick="SW_depReset()"><i class="fa-solid fa-arrow-left"></i> Choose another coin</button>' +

      '<div class="dep-coin-head" style="border-color:' + c.color + '33;">' +
        '<div class="dep-coin-ico" style="color:' + c.color + '"><i class="' + c.icon + '"></i></div>' +
        '<div><div class="dep-coin-name">' + c.label + ' (' + c.ticker + ')</div>' +
        '<div class="dep-coin-net">' + c.network + '</div></div>' +
      '</div>' +

      '<div class="dep-timer-wrap">' +
        '<div class="dep-timer-label">Window closes in</div>' +
        '<div class="dep-timer" id="depTimer">15:00</div>' +
      '</div>' +

      (addrSet
        ? '<div class="dep-qr"><img src="' + qrSrc(c) + '" alt="' + c.ticker + ' address QR" ' +
            'onerror="this.style.display=\'none\'"></div>' +
          '<div class="dep-addr-label">Send ' + c.ticker + ' to this address</div>' +
          '<div class="dep-addr-row">' +
            '<code id="depAddr" class="dep-addr">' + c.address + '</code>' +
            '<button class="dep-copy" onclick="SW_depCopy()"><i class="fa-solid fa-copy"></i></button>' +
          '</div>' +
          '<div class="dep-net-warn"><i class="fa-solid fa-triangle-exclamation"></i> ' +
            'Send only <b>' + c.ticker + '</b> over <b>' + c.network + '</b>. ' +
            'Wrong network = lost funds.</div>'
        : '<div class="dep-net-warn" style="margin-top:6px;"><i class="fa-solid fa-triangle-exclamation"></i> ' +
            'Wallet address not configured yet. Add your ' + c.ticker + ' address in deposit.js.</div>'
      ) +

      '<div class="dep-form">' +
        '<div class="dep-field">' +
          '<label>Amount sent (USD value)</label>' +
          '<input id="depAmount" type="number" inputmode="decimal" min="1" step="0.01" placeholder="e.g. 25.00">' +
        '</div>' +
        '<div class="dep-field">' +
          '<label>Transaction ID / hash</label>' +
          '<input id="depTxid" type="text" autocomplete="off" placeholder="Paste the txid from your wallet">' +
        '</div>' +
        '<div class="dep-field">' +
          '<label>Screenshot URL <span class="dep-opt">(optional)</span></label>' +
          '<input id="depProof" type="url" autocomplete="off" placeholder="Link to a screenshot of the transfer">' +
        '</div>' +
        '<div class="dep-err" id="depErr"></div>' +
        '<button class="dep-submit" id="depSubmitBtn" onclick="SW_depSubmit(\'' + coinKey + '\')">' +
          '<i class="fa-solid fa-paper-plane"></i> I\'ve sent it — submit for review</button>' +
        '<p class="dep-note">Your balance is credited <b>after</b> we confirm the transaction ' +
          'on-chain. This is manual and usually quick during business hours.</p>' +
      '</div>' +
    '</div>';
  }

  function startCountdown() {
    _deadline = Date.now() + WINDOW_MS;
    if (_timer) clearInterval(_timer);
    tick();
    _timer = setInterval(tick, 1000);
  }
  function tick() {
    var el = document.getElementById("depTimer");
    if (!el) { if (_timer) { clearInterval(_timer); _timer = null; } return; }
    var left = _deadline - Date.now();
    if (left <= 0) {
      el.textContent = "Expired";
      el.classList.add("expired");
      var btn = document.getElementById("depSubmitBtn");
      // Allow late submit (chain confirms regardless), just warn.
      if (_timer) { clearInterval(_timer); _timer = null; }
      return;
    }
    var m = Math.floor(left / 60000);
    var s = Math.floor((left % 60000) / 1000);
    el.textContent = m + ":" + (s < 10 ? "0" : "") + s;
    if (left < 60000) el.classList.add("low");
  }

  /* ── Window handlers ── */
  window.SW_depPick = function (coinKey) {
    if (!SW.user) { window.SW_PENDING_NAV = "deposit"; openSignInModal(); return; }
    _selectedCoin = coinKey;
    var host = document.getElementById("depBody");
    if (host) host.innerHTML = payHtml(coinKey);
    startCountdown();
  };

  window.SW_depReset = function () {
    _selectedCoin = null;
    if (_timer) { clearInterval(_timer); _timer = null; }
    var host = document.getElementById("depBody");
    if (host) host.innerHTML = coinGridHtml();
  };

  window.SW_depCopy = function () {
    var c = COINS[_selectedCoin]; if (!c) return;
    var done = function () { if (window.showToast) showToast("✓ Address copied"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(c.address).then(done).catch(function () {
        legacyCopy(c.address); done();
      });
    } else { legacyCopy(c.address); done(); }
  };
  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
  }

  window.SW_depSubmit = async function (coinKey) {
    var c = COINS[coinKey]; if (!c) return;
    var errEl = document.getElementById("depErr");
    function err(msg) { if (errEl) { errEl.textContent = msg; errEl.classList.add("show"); } }
    if (errEl) { errEl.textContent = ""; errEl.classList.remove("show"); }

    if (!SW.user) { window.SW_PENDING_NAV = "deposit"; openSignInModal(); return; }

    var amount = parseFloat(document.getElementById("depAmount").value);
    var txid = (document.getElementById("depTxid").value || "").trim();
    var proof = (document.getElementById("depProof").value || "").trim();

    if (!amount || amount <= 0) { err("Enter the amount you sent."); return; }
    if (amount > 100000) { err("Amount looks too large. Contact support for big deposits."); return; }
    if (!txid || txid.length < 6) { err("Paste the transaction ID from your wallet."); return; }

    var btn = document.getElementById("depSubmitBtn");
    btn.disabled = true;
    var prev = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Submitting…';

    try {
      await SW.ensureFirebase();
      await SW.db.collection("deposits").add({
        uid: SW.user.uid,
        email: SW.user.email || (SW.profile && SW.profile.displayName) || "",
        amount: amount,
        coin: c.ticker,
        network: c.network,
        txid: txid,
        proofUrl: proof || "",
        status: "pending",
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      // Optional: log a pending transaction for the user's own history.
      try {
        await SW.db.collection("transactions").add({
          uid: SW.user.uid, type: "deposit", amount: amount, coin: c.ticker,
          status: "pending", description: c.ticker + " deposit — awaiting confirmation",
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      } catch (e) {}

      if (_timer) { clearInterval(_timer); _timer = null; }
      var host = document.getElementById("depBody");
      if (host) host.innerHTML = successHtml(amount, c);
    } catch (e) {
      btn.disabled = false; btn.innerHTML = prev;
      err("Could not submit: " + (e.message || e.code || "try again"));
    }
  };

  function successHtml(amount, c) {
    return '<div class="dep-success">' +
      '<div class="dep-success-ico"><i class="fa-solid fa-circle-check"></i></div>' +
      '<h2>Deposit submitted</h2>' +
      '<p>We received your <b>$' + Number(amount).toFixed(2) + '</b> ' + c.ticker +
        ' deposit request. Once we confirm it on-chain, your balance is credited ' +
        'and you\'ll get a notification.</p>' +
      '<div class="dep-success-actions">' +
        '<button onclick="SW_NAV(\'transaction\')"><i class="fa-solid fa-receipt"></i> View status</button>' +
        '<button class="ghost" onclick="SW_NAV(\'home\')">Back home</button>' +
      '</div>' +
    '</div>';
  }

  /* ── Styles (scoped) ── */
  function styles() {
    return '<style id="depStyles">' +
      '.dep-page{padding:84px 16px 96px;max-width:520px;margin:0 auto;}' +
      '.dep-head{margin-bottom:18px;}' +
      '.dep-head h1{font-size:1.7rem;font-weight:900;display:flex;align-items:center;gap:10px;}' +
      '.dep-head p{color:#9ba0a8;font-size:.9rem;margin-top:4px;}' +
      '.dep-coin{display:flex;align-items:center;gap:14px;background:rgba(255,255,255,.04);' +
        'border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:16px;margin-bottom:12px;cursor:pointer;transition:.15s;}' +
      '.dep-coin:hover{background:rgba(255,255,255,.07);transform:translateY(-1px);}' +
      '.dep-coin-ico{font-size:26px;width:44px;height:44px;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(255,255,255,.05);border-radius:12px;flex-shrink:0;}' +
      '.dep-coin-meta{flex:1;}' +
      '.dep-coin-name{font-weight:800;font-size:15px;}' +
      '.dep-coin-net{color:#9ba0a8;font-size:12px;margin-top:2px;}' +
      '.dep-coin-arrow{color:#9ba0a8;}' +
      '.dep-back{background:none;border:none;color:#7dc8ff;font-weight:700;font-size:13px;cursor:pointer;' +
        'display:flex;align-items:center;gap:8px;margin-bottom:14px;padding:4px 0;}' +
      '.dep-coin-head{display:flex;align-items:center;gap:14px;border:1px solid;border-radius:16px;padding:14px;margin-bottom:16px;}' +
      '.dep-timer-wrap{text-align:center;margin-bottom:18px;}' +
      '.dep-timer-label{color:#9ba0a8;font-size:12px;text-transform:uppercase;letter-spacing:1px;}' +
      '.dep-timer{font-size:2rem;font-weight:900;font-variant-numeric:tabular-nums;color:#4ade80;margin-top:2px;}' +
      '.dep-timer.low{color:#f59e0b;}' +
      '.dep-timer.expired{color:#ff4d4f;font-size:1.2rem;}' +
      '.dep-qr{display:flex;justify-content:center;margin-bottom:14px;}' +
      '.dep-qr img{width:200px;height:200px;border-radius:16px;background:#fff;padding:10px;}' +
      '.dep-addr-label{text-align:center;color:#9ba0a8;font-size:12px;margin-bottom:8px;}' +
      '.dep-addr-row{display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.05);' +
        'border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:10px 12px;margin-bottom:12px;}' +
      '.dep-addr{flex:1;font-size:12px;word-break:break-all;color:#e9f6ff;font-family:monospace;}' +
      '.dep-copy{background:rgba(30,144,255,.15);border:none;color:#7dc8ff;border-radius:10px;' +
        'padding:10px 12px;cursor:pointer;flex-shrink:0;}' +
      '.dep-net-warn{background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.25);color:#f59e0b;' +
        'font-size:12px;border-radius:12px;padding:10px 12px;margin-bottom:16px;line-height:1.4;}' +
      '.dep-form{margin-top:8px;}' +
      '.dep-field{margin-bottom:14px;}' +
      '.dep-field label{display:block;font-size:13px;font-weight:700;margin-bottom:6px;}' +
      '.dep-opt{color:#9ba0a8;font-weight:400;}' +
      '.dep-field input{width:100%;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);' +
        'border-radius:12px;padding:13px 14px;color:#e9f6ff;font-size:14px;}' +
      '.dep-field input:focus{outline:none;border-color:rgba(30,144,255,.5);}' +
      '.dep-err{color:#ff6b6b;font-size:13px;margin-bottom:10px;display:none;}' +
      '.dep-err.show{display:block;}' +
      '.dep-submit{width:100%;background:linear-gradient(135deg,#1e90ff,#00b0ff);border:none;color:#fff;' +
        'font-weight:800;font-size:15px;border-radius:14px;padding:15px;cursor:pointer;display:flex;' +
        'align-items:center;justify-content:center;gap:8px;}' +
      '.dep-submit:disabled{opacity:.6;cursor:default;}' +
      '.dep-note{color:#9ba0a8;font-size:12px;text-align:center;margin-top:12px;line-height:1.5;}' +
      '.dep-success{text-align:center;padding:30px 10px;}' +
      '.dep-success-ico{font-size:60px;color:#4ade80;margin-bottom:16px;}' +
      '.dep-success h2{font-size:1.4rem;font-weight:900;margin-bottom:10px;}' +
      '.dep-success p{color:#9ba0a8;font-size:.9rem;line-height:1.6;margin-bottom:22px;}' +
      '.dep-success-actions{display:flex;flex-direction:column;gap:10px;}' +
      '.dep-success-actions button{padding:14px;border:none;border-radius:14px;font-weight:800;cursor:pointer;' +
        'background:linear-gradient(135deg,#1e90ff,#00b0ff);color:#fff;display:flex;align-items:center;' +
        'justify-content:center;gap:8px;}' +
      '.dep-success-actions button.ghost{background:rgba(255,255,255,.07);color:#e9f6ff;}' +
    '</style>';
  }

  window.SW_VIEWS.deposit = {
    render: function () {
      if (!SW.user) {
        return '<div class="container"><div class="empty-state" style="padding:90px 18px;">' +
          '<i class="fa-solid fa-user-lock"></i><p>Sign in to deposit</p>' +
          '<button onclick="openSignInModal()" style="margin-top:14px;padding:12px 20px;border:none;' +
          'border-radius:12px;background:linear-gradient(135deg,#1e90ff,#00b0ff);color:#fff;font-weight:800;cursor:pointer;">Sign In</button>' +
          '</div></div>';
      }
      return styles() +
        '<div class="dep-page">' +
          '<div class="dep-head"><h1><i class="fa-solid fa-wallet"></i> Deposit</h1>' +
          '<p>Choose a coin, send to the address shown, then submit your transaction for review.</p></div>' +
          '<div id="depBody">' + coinGridHtml() + '</div>' +
        '</div>';
    },
    init: function () { /* grid is already rendered; nothing async needed */ },
    cleanup: function () { if (_timer) { clearInterval(_timer); _timer = null; } }
  };
})();
