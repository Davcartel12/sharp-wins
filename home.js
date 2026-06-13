/* views/home.js — real home: tournament card + rooms grid + slider (exact design) */
(function () {
  var ROOMS = [
    { amount: 1,   img: "d1.png" },
    { amount: 2,   img: "d2.png" },
    { amount: 5,   img: "d3.png" },
    { amount: 10,  img: "d4.png" },
    { amount: 20,  img: "d5.png" },
    { amount: 50,  img: "d6.png" },
    { amount: 100, img: "d7.png" },
    { amount: 200, img: "d8.png" }
  ];
  var TOURNAMENT_IMAGES = ["s2.png", "s1.png", "s3.png", "d4.png", "d6.png"];
  var _slideTimer = null;

  async function enterRoom(stakeAmount) {
    if (!SW.user) { window.SW_PENDING_NAV = "room/" + stakeAmount; openSignInModal(); return; }
    try {
      var bal = SW.balance;
      if (bal < stakeAmount) { showToast("\u274c Need $" + stakeAmount + " to enter. Please deposit."); return; }
    } catch (e) {}
    SW_NAV("room/" + stakeAmount);
  }
  window.SW_enterRoom = enterRoom;

  window.SW_VIEWS.home = {
    render: function () {
      var cards = ROOMS.map(function (r) {
        return '<div class="room-card" onclick="SW_enterRoom(' + r.amount + ')">' +
          '<img src="' + r.img + '">' +
          '<h2>$' + r.amount + ' Room</h2>' +
          '<p>Win $' + (r.amount * 2) + '</p>' +
        '</div>';
      }).join("");

      return (
        '<div class="container">' +
          '<div class="tournament-card" onclick="SW_GUARD(\'tournament\') && SW_NAV(\'tournament\')">' +
            '<div class="tournament-slider">' +
              '<img id="tournamentImage" src="https://i.supaimg.com/b46262ab-f4cb-4e81-90a8-8877409d447a.png">' +
            '</div>' +
            '<div class="tournament-info">' +
              '<h2><i class="fa-solid fa-trophy"></i> Tournament</h2>' +
              '<p>10 Players \u2022 Winner Takes All</p>' +
            '</div>' +
          '</div>' +
          '<div class="rooms-grid" id="roomsGrid">' + cards + '</div>' +
        '</div>'
      );
    },
    init: function () {
      var img = document.getElementById("tournamentImage");
      var idx = 0;
      if (_slideTimer) clearInterval(_slideTimer);
      if (img) {
        _slideTimer = setInterval(function () {
          img.style.opacity = "0";
          img.style.transform = "translateX(-20px)";
          setTimeout(function () {
            idx = (idx + 1) % TOURNAMENT_IMAGES.length;
            img.src = TOURNAMENT_IMAGES[idx];
            img.style.transform = "translateX(0)";
            img.style.opacity = "1";
          }, 600);
        }, 5000);
      }
    },
    cleanup: function () {
      if (_slideTimer) { clearInterval(_slideTimer); _slideTimer = null; }
    }
  };
})();
