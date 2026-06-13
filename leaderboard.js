/* views/leaderboard.js — real leaderboard (exact design + logic from leaderboard.html) */
(function () {
  function fmt(n){ return SW.fmt(n); }
  function escHtml(str){ return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function avatarUrl(name){
    var initials = encodeURIComponent((name||'?').substring(0,2).toUpperCase());
    return 'https://api.dicebear.com/7.x/initials/svg?seed='+initials+'&backgroundColor=1e3a5f&textColor=7dc8ff&fontSize=40';
  }

  function showSkeletons(){
    var podium=document.getElementById('podium'); if(podium){ podium.innerHTML='';
      [2,1,3].forEach(function(){
        podium.innerHTML += '<div class="podium-place">'+
          '<div class="podium-rank skeleton" style="width:36px;height:36px;"></div>'+
          '<div class="podium-avatar skeleton" style="border:none;"></div>'+
          '<div class="skeleton" style="width:90px;height:14px;border-radius:6px;"></div>'+
          '<div class="skeleton" style="width:70px;height:10px;border-radius:6px;"></div>'+
          '<div class="skeleton" style="width:60px;height:16px;border-radius:6px;"></div>'+
          '<div class="podium-base" style="border-color:rgba(255,255,255,.1);"></div></div>';
      });
    }
    var list=document.getElementById('lbList'); if(list){ list.innerHTML='';
      for(var i=0;i<6;i++){
        list.innerHTML += '<div class="lb-item skeleton-row" style="background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:14px 18px;display:flex;align-items:center;gap:14px;">'+
          '<div class="skeleton skel-rank"></div><div class="skeleton skel-ava"></div>'+
          '<div class="skel-info"><div class="skeleton skel-name"></div><div class="skeleton skel-stat"></div></div>'+
          '<div class="skeleton skel-amt"></div></div>';
      }
    }
  }

  function renderLeaderboard(entries){
    var uid = SW.uid;
    var podium=document.getElementById('podium'), list=document.getElementById('lbList'), banner=document.getElementById('myRankBanner');
    if(!podium||!list) return;
    podium.innerHTML=''; list.innerHTML='';
    if(!entries||entries.length===0){
      list.innerHTML='<div class="empty-state"><i class="fa-solid fa-ghost"></i><p>No data yet for this period.<br>Play a game to appear here!</p></div>';
      return;
    }
    var myEntry = uid ? entries.find(function(e){return e.uid===uid;}) : null;
    if(myEntry && uid && banner){
      document.getElementById('mrb-rank').textContent='#'+myEntry.rank;
      document.getElementById('mrb-name').textContent=myEntry.displayName;
      document.getElementById('mrb-wins').textContent=myEntry.wins+' Wins \u2022 '+myEntry.losses+' Losses';
      document.getElementById('mrb-earn').textContent=fmt(myEntry.totalWinnings);
      banner.classList.add('visible');
    } else if(banner){ banner.classList.remove('visible'); }

    var podiumOrder=[entries[1],entries[0],entries[2]].filter(Boolean);
    var medals={0:'\ud83e\udd48',1:'\ud83e\udd47',2:'\ud83e\udd49'};
    podiumOrder.forEach(function(player,visualIdx){
      var actualIdx = visualIdx===0?1:visualIdx===1?0:2;
      var isMe = uid && player.uid===uid;
      var wr = (player.wins+player.losses>0)?Math.round((player.wins/(player.wins+player.losses))*100)+'%':'\u2014';
      var src=(player.photoURL&&player.photoURL.length>5)?player.photoURL:avatarUrl(player.displayName);
      podium.innerHTML += '<div class="podium-place">'+
        '<div class="podium-rank">'+medals[actualIdx]+'</div>'+
        '<div class="podium-avatar-wrap">'+
          '<img class="podium-avatar" src="'+src+'" alt="'+escHtml(player.displayName)+'" onerror="this.src=\'https://api.dicebear.com/7.x/initials/svg?seed=??\'">'+
          (isMe?'<span class="you-badge">YOU</span>':'')+
        '</div>'+
        '<div class="podium-name">'+escHtml(player.displayName)+'</div>'+
        '<div class="podium-stats">'+player.wins+'W \u00b7 '+player.losses+'L \u00b7 '+wr+' WR</div>'+
        '<div class="podium-winnings">'+fmt(player.totalWinnings)+'</div>'+
        '<div class="podium-base"></div></div>';
    });

    if(entries.length<=3){
      list.innerHTML='<div class="empty-state" style="padding:30px 20px;"><p style="color:var(--muted);font-size:.9rem;">Only '+entries.length+' player'+(entries.length===1?'':'s')+' on the board yet.</p></div>';
      return;
    }
    entries.slice(3).forEach(function(player){
      var isMe = uid && player.uid===uid;
      var wr=(player.wins+player.losses>0)?Math.round((player.wins/(player.wins+player.losses))*100)+'%':'\u2014';
      var src=(player.photoURL&&player.photoURL.length>5)?player.photoURL:avatarUrl(player.displayName);
      var item=document.createElement('div');
      item.className='lb-item'+(isMe?' is-you':'');
      item.innerHTML='<div class="lb-rank">#'+player.rank+'</div>'+
        '<img class="lb-avatar" src="'+src+'" alt="'+escHtml(player.displayName)+'" onerror="this.src=\'https://api.dicebear.com/7.x/initials/svg?seed=??\'">'+
        '<div class="lb-info"><div class="lb-name">'+escHtml(player.displayName)+(isMe?'<span class="you-tag">YOU</span>':'')+'</div>'+
        '<div class="lb-stats">'+player.wins+' Wins \u00b7 '+player.losses+' Losses \u00b7 '+wr+' WR</div></div>'+
        '<div class="lb-winnings">'+fmt(player.totalWinnings)+'</div>';
      list.appendChild(item);
    });
  }

  window.SW_lbTab = function(el){
    document.querySelectorAll('.tab-btn').forEach(function(b){b.classList.remove('active');});
    el.classList.add('active');
    load();
  };

  async function load(){
    showSkeletons();
    try {
      var entries = await SW.getLeaderboard();
      renderLeaderboard(entries);
    } catch(e){
      var podium=document.getElementById('podium'); if(podium) podium.innerHTML='';
      var list=document.getElementById('lbList');
      if(list) list.innerHTML='<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>Could not load leaderboard.<br>Refresh and try again.</p></div>';
    }
  }

  window.SW_VIEWS.leaderboard = {
    render: function(){
      return '<div class="container lb-page">'+
        '<div class="page-header"><h1><i class="fa-solid fa-chart-bar"></i> <span class="gradient-text">Leaderboard</span></h1>'+
        '<p>Top players competing for glory and rewards</p></div>'+
        '<div class="lb-tabs">'+
          '<button class="tab-btn active" data-period="all" onclick="SW_lbTab(this)">All Time</button>'+
          '<button class="tab-btn" data-period="weekly" onclick="SW_lbTab(this)">This Week</button>'+
          '<button class="tab-btn" data-period="daily" onclick="SW_lbTab(this)">Today</button>'+
        '</div>'+
        '<div class="my-rank-banner" id="myRankBanner">'+
          '<div><div class="mrb-label">Your Rank</div><div class="mrb-rank" id="mrb-rank">\u2014</div></div>'+
          '<div><div class="mrb-name" id="mrb-name">\u2014</div><div class="mrb-wins" id="mrb-wins">\u2014 Wins \u2022 \u2014 Losses</div></div>'+
          '<div class="mrb-earn" id="mrb-earn">$0.00</div>'+
        '</div>'+
        '<div class="podium" id="podium"></div>'+
        '<div class="lb-list" id="lbList"></div>'+
      '</div>';
    },
    init: function(){ load(); }
  };
})();