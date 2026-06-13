/* views/friends.js — Phase 1 stub */
(function () {
  window.SW_VIEWS.friends = {
    render: function () {
      return '<div style="padding:90px 18px 24px;max-width:520px;margin:0 auto;">' +
        '<h1 style="font-size:1.8rem;font-weight:900;margin-bottom:8px;">Friends</h1>' +
        '<p style="color:#9ba0a8;">Stub view. The real friends system arrives in Phase 3. ' +
        'Top bar + balance stayed put — no reload happened.</p>' +
        '<p style="margin-top:14px;color:#4ade80;font-weight:700;">Balance still in memory: ' + SW.fmt(SW.balance) + '</p>' +
        '<button onclick="SW_NAV(\'home\')" style="margin-top:16px;padding:12px 18px;border:none;border-radius:12px;background:rgba(30,144,255,0.15);color:#e9f6ff;font-weight:800;cursor:pointer;">← Home</button>' +
        '</div>';
    }
  };
})();
