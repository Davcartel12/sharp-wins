/* views/transaction.js — real transaction history (exact design + logic) */
(function () {
  var transactions = [], currentFilter = 'all';

  function txKind(tx){
    var type=(tx.type||'').toLowerCase();
    var text=(type+' '+(tx.description||'')).toLowerCase();
    var delta=Number(tx.delta||0);
    if(type==='deposit'||text.indexOf('deposit')>=0) return 'deposit';
    if(type==='admin_adjustment'&&delta<0) return 'withdraw';
    if(text.indexOf('withdraw')>=0) return 'withdraw';
    if(type==='stake'||text.indexOf('stake')>=0||text.indexOf('challenge')>=0) return 'activity';
    return delta<0?'withdraw':'activity';
  }
  function txTitle(tx){
    var type=(tx.type||'').toLowerCase();
    var text=(type+' '+(tx.description||'')).toLowerCase();
    var delta=Number(tx.delta||0);
    if(type==='deposit'&&tx.source==='admin') return 'Admin Deposit';
    if(type==='admin_adjustment') return delta<0?'Admin Deduction':'Admin Credit';
    if(text.indexOf('deposit')>=0) return 'Deposit';
    if(text.indexOf('withdraw')>=0) return 'Withdrawal';
    if(text.indexOf('refund')>=0) return 'Room Refund';
    if(text.indexOf('win')>=0) return 'Game Win';
    if(delta<0) return 'Room Entry';
    return 'Wallet Activity';
  }
  function fmtDate(ms){ if(!ms) return ''; return new Date(ms).toLocaleString([], {year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }

  window.SW_txFilter = function(f){
    currentFilter=f;
    ['all','deposit','withdraw'].forEach(function(t){ var el=document.getElementById('tab-'+t); if(el) el.classList.toggle('active', t===f); });
    render();
  };

  function render(){
    var list=document.getElementById('txList'); if(!list) return;
    var filtered = currentFilter==='all'?transactions:transactions.filter(function(t){return t.kind===currentFilter;});
    if(!filtered.length){ list.innerHTML='<div class="empty-state"><i class="fa-solid fa-receipt"></i><p>No transactions here yet</p></div>'; return; }
    list.innerHTML = filtered.map(function(t){
      var isPos=t.amount>0;
      var iconClass=isPos?'dep':'with';
      var iconEl=t.isAdmin?'fa-shield-halved':(isPos?'fa-arrow-down':'fa-arrow-up');
      var adminBadge=t.isAdmin?'<span style="display:inline-flex;align-items:center;gap:4px;background:rgba(30,144,255,.15);border:1px solid rgba(30,144,255,.3);color:#00b0ff;font-size:9px;font-weight:800;padding:2px 7px;border-radius:20px;margin-left:6px;letter-spacing:.5px;vertical-align:middle;"><i class="fa-solid fa-shield-halved" style="font-size:8px;"></i> ADMIN</span>':'';
      return '<div class="tx-card" style="'+(t.isAdmin&&isPos?'border-color:rgba(30,144,255,0.25);':'')+'">'+
        '<div class="tx-icon-wrap '+iconClass+'" style="'+(t.isAdmin?(isPos?'background:rgba(30,144,255,.15);border-color:rgba(30,144,255,.3);color:#00b0ff;':''):'')+'"><i class="fa-solid '+iconEl+'"></i></div>'+
        '<div class="tx-body"><div class="tx-title">'+t.title+adminBadge+'</div>'+
        '<div class="tx-meta"><i class="fa-solid fa-credit-card" style="opacity:.5;margin-right:5px;font-size:10px;"></i>'+t.method+'</div></div>'+
        '<div class="tx-right"><div class="tx-amount '+(isPos?'pos':'neg')+'">'+(isPos?'+':'')+'$'+Math.abs(t.amount).toFixed(2)+'</div>'+
        '<div class="tx-date">'+t.date+'</div></div></div>';
    }).join('');
  }

  async function load(){
    var list=document.getElementById('txList');
    if(list) list.innerHTML='<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i><p>Loading transactions...</p></div>';
    try {
      var txns = await SW.getTransactions(SW.uid);
      transactions = (txns||[]).map(function(tx){
        var delta=Number(tx.delta||tx.amount||0);
        return { kind:txKind(tx), title:txTitle(tx), method:tx.description||tx.type||'Sharp Wins', amount:delta, date:fmtDate(tx.createdAt), isAdmin:(tx.source==='admin'||(tx.type||'').indexOf('admin')===0) };
      });
      render();
    } catch(e){
      if(list) list.innerHTML='<div class="empty-state"><i class="fa-solid fa-triangle-exclamation"></i><p>Could not load transactions</p></div>';
    }
  }

  window.SW_VIEWS.transaction = {
    render: function(){
      if(!SW.user) return '<div class="container"><div class="empty-state"><i class="fa-solid fa-user-lock"></i><p>Sign in to see transactions</p></div></div>';
      return '<div class="container tx-page">'+
        '<div class="page-header"><h1><i class="fa-solid fa-receipt"></i> <span class="gradient-text">Transactions</span></h1>'+
        '<p>Your deposit & withdrawal history</p></div>'+
        '<div class="filter-tabs">'+
          '<div class="tab active" id="tab-all" onclick="SW_txFilter(\'all\')">All</div>'+
          '<div class="tab" id="tab-deposit" onclick="SW_txFilter(\'deposit\')">Deposits</div>'+
          '<div class="tab" id="tab-withdraw" onclick="SW_txFilter(\'withdraw\')">Withdrawals</div>'+
        '</div>'+
        '<div class="tx-list" id="txList"></div>'+
      '</div>';
    },
    init: function(){ if(SW.user) load(); }
  };
})();