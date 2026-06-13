/* views/notifications.js — real notifications (exact design + logic) */
(function () {
  var _allNotifs = [], _readSet = new Set(), _filter = 'all';

  function esc(s){ return String(s||'').replace(/[&<>"']/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];}); }
  function fmtTime(ms){
    if(!ms) return '';
    var diff=Date.now()-ms;
    if(diff<60000) return 'Just now';
    if(diff<3600000) return Math.floor(diff/60000)+'m ago';
    if(diff<86400000) return Math.floor(diff/3600000)+'h ago';
    if(diff<604800000) return Math.floor(diff/86400000)+'d ago';
    return new Date(ms).toLocaleDateString([], {month:'short',day:'numeric'});
  }
  var iconMap={ win:{cls:'win',icon:'fa-trophy'}, deposit:{cls:'deposit',icon:'fa-wallet'}, loss:{cls:'loss',icon:'fa-face-sad-tear'}, alert:{cls:'alert',icon:'fa-triangle-exclamation'}, system:{cls:'system',icon:'fa-gear'}, default:{cls:'system',icon:'fa-bell'} };
  function getIconInfo(n){ var type=(n.type||'').toLowerCase(); return iconMap[type]||iconMap.default; }

  function loadReadSet(){
    try { var arr=JSON.parse(localStorage.getItem('sw_read_notifs')||'[]'); _readSet=new Set(arr); } catch(e){ _readSet=new Set(); }
  }
  function saveReadSet(){ try { localStorage.setItem('sw_read_notifs', JSON.stringify([..._readSet])); } catch(e){} }

  function renderList(){
    var list=document.getElementById('notifList'); if(!list) return;
    var countEl=document.getElementById('unreadCount'), markBtn=document.getElementById('markAllBtn');
    var items=_allNotifs;
    if(_filter==='unread') items=items.filter(function(n){return !_readSet.has(n.id);});
    else if(_filter!=='all') items=items.filter(function(n){return (n.type||'').toLowerCase()===_filter;});
    var unreadCount=_allNotifs.filter(function(n){return !_readSet.has(n.id);}).length;
    if(countEl) countEl.innerHTML = unreadCount>0?('<span>'+unreadCount+'</span> unread'):'All caught up';
    if(markBtn) markBtn.style.display = unreadCount>0?'block':'none';
    if(!items.length){ list.innerHTML='<div class="empty-state"><i class="fa-solid fa-bell-slash"></i><p>'+(_filter==='unread'?'No unread notifications.':'No notifications here yet.')+'</p></div>'; return; }
    list.innerHTML = items.map(function(n){
      var info=getIconInfo(n), unread=!_readSet.has(n.id);
      return '<div class="notif-card'+(unread?' unread':'')+'" onclick="SW_notifRead(\''+esc(n.id)+'\', this)">'+
        '<div class="notif-icon '+info.cls+'"><i class="fa-solid '+info.icon+'"></i></div>'+
        '<div class="notif-body"><div class="notif-title">'+esc(n.title)+'</div>'+
        '<div class="notif-msg">'+esc(n.message)+'</div>'+
        '<div class="notif-time">'+fmtTime(n.createdAt)+'</div></div></div>';
    }).join('');
  }

  window.SW_notifRead = function(id, card){
    if(!_readSet.has(id)){ _readSet.add(id); saveReadSet(); if(card) card.classList.remove('unread'); renderList(); }
  };
  window.SW_notifMarkAll = function(){ _allNotifs.forEach(function(n){_readSet.add(n.id);}); saveReadSet(); renderList(); };
  window.SW_notifFilter = function(btn){
    document.querySelectorAll('.ftab').forEach(function(b){b.classList.remove('active');});
    btn.classList.add('active'); _filter=btn.dataset.filter; renderList();
  };

  function showSkeletons(){
    var list=document.getElementById('notifList'); if(!list) return;
    var s=''; for(var i=0;i<5;i++){ s+='<div class="notif-card" style="pointer-events:none;"><div class="skeleton" style="width:44px;height:44px;border-radius:13px;flex-shrink:0;"></div><div style="flex:1;display:flex;flex-direction:column;gap:6px;"><div class="skeleton" style="width:60%;height:13px;border-radius:6px;"></div><div class="skeleton" style="width:90%;height:11px;border-radius:6px;"></div></div></div>'; }
    list.innerHTML=s;
  }

  async function load(){
    loadReadSet();
    showSkeletons();
    try {
      _allNotifs = await SW.getNotifications(SW.uid);
      renderList();
    } catch(e){
      var list=document.getElementById('notifList');
      if(list) list.innerHTML='<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>Could not load notifications.</p></div>';
    }
  }

  window.SW_VIEWS.notifications = {
    render: function(){
      if(!SW.user) return '<div class="container"><div class="empty-state"><i class="fa-solid fa-user-lock"></i><p>Sign in to see notifications</p></div></div>';
      return '<div class="container nf-page">'+
        '<div class="filter-tabs">'+
          '<button class="ftab active" data-filter="all" onclick="SW_notifFilter(this)">All</button>'+
          '<button class="ftab" data-filter="unread" onclick="SW_notifFilter(this)">Unread</button>'+
          '<button class="ftab" data-filter="win" onclick="SW_notifFilter(this)">Wins</button>'+
          '<button class="ftab" data-filter="deposit" onclick="SW_notifFilter(this)">Deposits</button>'+
          '<button class="ftab" data-filter="alert" onclick="SW_notifFilter(this)">Alerts</button>'+
          '<button class="ftab" data-filter="system" onclick="SW_notifFilter(this)">System</button>'+
        '</div>'+
        '<div class="list-header"><div class="unread-count" id="unreadCount"></div>'+
        '<button class="mark-all-btn" id="markAllBtn" onclick="SW_notifMarkAll()" style="display:none;">Mark all as read</button></div>'+
        '<div id="notifList"></div>'+
      '</div>';
    },
    init: function(){ if(SW.user) load(); }
  };
})();