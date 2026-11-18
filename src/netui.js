/* =========================================================================
 * netui.js — 联机大厅 / 房间 / 倒计时 / 结算 UI
 *   流程：大厅建房/加入 → 进房立刻选车 → 全员选完自动 5 秒倒计时 → 开赛
 *   全部用 CR.Net 的消息驱动；不碰物理、不碰现有 HUD 的计时逻辑。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var U = CR.NetUI = {};
  var root = null, rankEl = null, resultEl = null, countEl = null, statusEl = null, notesEl = null;

  /* 更新公告内容：发版时只改这里 */
  var NOTES = [
    { h: '修正版改动', items: [
      '发车格改成两列错位排布：开局两车相距 4 米，不再叠在一起。',
      '修掉联机时「车头掰不动」：开赛瞬间本地车与服务器强制对齐，转向不再被位置校正抢走。',
      '对手车朝向与本车一致，头顶昵称照常显示；退出重进也不会跑偏。'
    ]},
    { h: '选车与展示', items: [
      '选车界面换成不透明暖色主题，车辆展示重做：暖色布光、车底柔和阴影、选中车拉近放大。',
      '单机选车不再限时，看够了再点确认。'
    ]},
    { h: '联机流程', items: [
      '进房立刻选车，全员选完后自动 5 秒倒计时开赛，不再需要准备和房主点开始。',
      '大厅拆成「创建房间 / 加入房间」两张卡片，房号可以一键复制。',
      '对手车头顶显示昵称，自己的名字是金色并带「你」。'
    ]},
    { h: '手感与性能', items: [
      'MP4/4 支持自动 / 手动挡切换：G 或手柄 L3；手动挡 E 升 Q 降（手柄 A / X）。',
      '联机 HUD 改用服务端数据，速度表和本圈时间正常刷新。',
      '开启 gzip 后首屏从约 30 秒降到几秒。'
    ]},
    { h: '已知问题', items: [
      '无碰撞：两辆车可以互相穿过。',
      '房间存在内存里，服务重启会清空；掉线保留座位 15 秒。',
      '手机端可以玩，但还没做触屏换挡按钮，建议先用键盘或手柄。'
    ]}
  ];
  var lastPhase = '', lastRoom = null, picking = false;

  function el(tag, cls, text) {
    var d = document.createElement(tag);
    if (cls) d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  }
  function html(str) {
    var d = document.createElement('div');
    d.innerHTML = str;
    return d.firstChild;
  }
  function carName(i) {
    return (CR.Car && CR.Car.TUNES && CR.Car.TUNES[i]) ? CR.Car.TUNES[i].name : ('车' + i);
  }

  U.create = function () {
    root = document.getElementById('net-ui');
    if (!root) return U;

    /* 右上角入口：单机时是「联机」，进房 / 比赛中变成「退出房间」。
       不新增按钮是为了不和触屏工具条、HUD、博客右上角的退出按钮抢位置。 */
    var btn = el('button', 'net-entry', '联机');
    btn.type = 'button';
    btn.id = 'net-entry';
    var quitArmed = 0;
    function inRoom() {
      return !!(CR.Net && CR.Net.online && CR.Net.state !== 'offline');
    }
    function refreshEntry() {
      var txt = inRoom() ? '退出房间' : '联机';
      if (!quitArmed && btn.textContent !== txt) btn.textContent = txt;
    }
    function leaveRoom() {
      quitArmed = 0; refreshEntry();
      if (!CR.Net) return;
      try { CR.Net.leave(); } catch (e) {}
      CR.Net.state = 'offline';
      if (btn) { quitArmed = 0; btn.textContent = '联机'; }
      /* 把联机预测留下的车 / 计时恢复成单机起点 */
      if (CR.Rivals && CR.Rivals.hideAll) CR.Rivals.hideAll();
      if (CR.Car && CR.Car.reset) CR.Car.reset(false);
      if (CR.Gear && CR.Gear.reset) CR.Gear.reset();
      if (CR.Hud && CR.Hud.restart) CR.Hud.restart();
      if (CR.Cam && CR.Cam.snap) CR.Cam.snap();
      U.showLobby();
      U.toast('已退出房间');
    }
    btn.addEventListener('click', function () {
      if (!inRoom()) { U.toggle(); return; }
      /* 二次确认：比赛中误点一下就退房、成绩全丢，代价太大 */
      if (quitArmed && Date.now() - quitArmed < 3500) { leaveRoom(); return; }
      quitArmed = Date.now();
      btn.textContent = '确认退出?';
      setTimeout(function () { quitArmed = 0; refreshEntry(); }, 3500);
    });
    document.body.appendChild(btn);

    /* 实时名次 */
    rankEl = el('div', 'net-rank');
    rankEl.id = 'net-rank';
    rankEl.style.display = 'none';
    document.body.appendChild(rankEl);

    /* 开赛倒计时（全屏居中大数字） */
    countEl = el('div', 'net-count');
    countEl.id = 'net-count';
    countEl.style.display = 'none';
    document.body.appendChild(countEl);

    /* 更新公告面板 */
    notesEl = el('div', 'net-notes');
    notesEl.id = 'net-notes';
    notesEl.style.display = 'none';
    document.body.appendChild(notesEl);

    /* 结算面板 */
    resultEl = el('div', 'net-result');
    resultEl.id = 'net-result';
    resultEl.style.display = 'none';
    document.body.appendChild(resultEl);

    if (CR.Net) {
      CR.Net.on('error', function (e) {
        U.toast(e || '网络错误');
        if (root && root.style.display !== 'none') U.showLobby();
      });
      CR.Net.on('event', onEvent);
      CR.Net.on('state', function (s) {
        refreshEntry();
        if (s === 'offline') U.showLobby();
      });
      /* room / snapshot 不触发 state 事件，这里也要同步入口按钮文字 */
      CR.Net.on('room', function (m) { refreshEntry(); renderRoom(m); });
      CR.Net.on('result', function (r) { refreshEntry(); renderResult(r); });
      var lastConnSig = '';
      CR.Net.on('snapshot', function (s) { refreshEntry(); renderLive(s);
        /* 房间面板用快照里的 connected 兜底刷新：掉线时服务端只把 connected 置 false，
           room 消息未必及时广播；快照是 15Hz 的，只有「在线状态」变化时才重建一次面板。 */
        if (s && s.players && lastRoom && CR.Net.state === 'room') {
          var sig = s.players.map(function (p) { return p.id + ':' + (p.connected === false ? 0 : 1); }).join(',');
          if (sig !== lastConnSig) {
            lastConnSig = sig;
            /* 快照不带 canStart，用同一套口径现算：只数在线玩家 */
            var onlineNow = s.players.filter(function (p) { return p.connected !== false; });
            var ph = s.phase || lastRoom.phase;
            var cs = (ph === 'lobby' || ph === 'result') && onlineNow.length >= 2 &&
                     onlineNow.every(function (p) { return !!p.ready; });
            var merged = Object.assign({}, lastRoom, {
              players: s.players, phase: ph, canStart: cs
            });
            renderRoom(merged);
          }
        }
      });
    }
    U.ready = true;
    return U;
  };

  U.toast = function (msg) {
    if (!root) return;
    var t = el('div', 'net-toast', msg);
    root.appendChild(t);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2600);
  };

  U.toggle = function () {
    if (!root) return;
    if (root.style.display === 'none' || !root.style.display) U.showLobby();
    else { root.style.display = 'none'; }
  };

  function clear() { while (root.firstChild) root.removeChild(root.firstChild); }
  function show() { root.style.display = ''; }

  /* ---------------- 大厅：创建 / 加入 两张明显区分的卡片 ---------------- */
  U.showLobby = function () {
    if (!root) return;
    clear(); show();
    hideCountdown();
    if (resultEl) resultEl.style.display = 'none';
    lastRoom = null;

    root.appendChild(el('div', 'net-title', '黄昏海岸 · 联机竞速'));
    root.appendChild(el('div', 'net-sub', '无碰撞 · 房间制 · 测试二号版本 v' + CR.VERSION));

    var nameRow = el('div', 'net-row');
    var nameIn = html('<input class="net-input" maxlength="12" placeholder="昵称（对手会看到）">');
    nameIn.value = CR.Net.name() || '';
    nameIn.addEventListener('change', function () { CR.Net.setName(nameIn.value); });
    nameRow.appendChild(el('span', 'net-label', '昵称'));
    nameRow.appendChild(nameIn);
    root.appendChild(nameRow);

    /* --- 创建房间 --- */
    var createCard = el('div', 'net-card create');
    createCard.appendChild(el('div', 'net-card-k', '创建房间'));
    createCard.appendChild(el('div', 'net-card-d', '生成 6 位房号，发给朋友即可加入'));
    var lapsRow = el('div', 'net-row tight');
    var lapsIn = html('<select class="net-input"><option value="1">1 圈</option><option value="3" selected>3 圈</option><option value="5">5 圈</option></select>');
    lapsRow.appendChild(el('span', 'net-label', '圈数'));
    lapsRow.appendChild(lapsIn);
    createCard.appendChild(lapsRow);
    var bCreate = el('button', 'net-btn primary', '创建房间');
    bCreate.type = 'button';
    bCreate.addEventListener('click', function () {
      bCreate.textContent = '连接中…'; bCreate.disabled = true;
      CR.Net.setName(nameIn.value);
      CR.Net.whenReady(function () {
        bCreate.disabled = false; bCreate.textContent = '创建房间';
        CR.Net.create({ laps: Number(lapsIn.value), public: true });
      });
    });
    createCard.appendChild(bCreate);
    root.appendChild(createCard);

    /* --- 加入房间 --- */
    var joinCard = el('div', 'net-card join');
    joinCard.appendChild(el('div', 'net-card-k', '加入房间'));
    joinCard.appendChild(el('div', 'net-card-d', '输入朋友发来的 6 位房号'));
    var codeRow = el('div', 'net-row tight');
    var codeIn = html('<input class="net-input net-code-in" maxlength="6" placeholder="例如 K7M2QP" autocomplete="off" spellcheck="false">');
    codeIn.addEventListener('input', function () {
      codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
    codeRow.appendChild(codeIn);
    joinCard.appendChild(codeRow);
    var bJoin = el('button', 'net-btn', '加入房间');
    bJoin.type = 'button';
    bJoin.addEventListener('click', function () {
      var code = codeIn.value.trim().toUpperCase();
      if (code.length !== 6) {
        U.toast('请输入 6 位房号');
        codeIn.focus();
        return;
      }
      bJoin.textContent = '连接中…'; bJoin.disabled = true;
      CR.Net.setName(nameIn.value);
      CR.Net.whenReady(function () {
        bJoin.disabled = false; bJoin.textContent = '加入房间';
        CR.Net.join(code);
      });
    });
    codeIn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); bJoin.click(); }
    });
    joinCard.appendChild(bJoin);
    root.appendChild(joinCard);

    var notesLink = el('button', 'net-link', '更新公告 · 测试二号');
    notesLink.type = 'button';
    notesLink.addEventListener('click', function () { U.showNotes(true); });
    root.appendChild(notesLink);

    var offline = el('button', 'net-link', '返回单机');
    offline.type = 'button';
    offline.addEventListener('click', function () {
      if (CR.Net.online) CR.Net.disconnect();
      root.style.display = 'none';
    });
    root.appendChild(offline);

    /* 新版本第一次打开大厅时自动弹一次公告 */
    U.showNotes(false);
  };

  function closeNotes() {
    if (notesEl) notesEl.style.display = 'none';
    if (root) root.style.display = '';
    try { window.localStorage.setItem('cr.notesVer', CR.VERSION); } catch (e) {}
  }
  U.showNotes = function (force) {
    if (!notesEl) return;
    try {
      if (!force && window.localStorage.getItem('cr.notesVer') === CR.VERSION) return;
    } catch (e) {}
    notesEl.innerHTML = '';
    notesEl.appendChild(el('div', 'net-title', '更新公告'));
    notesEl.appendChild(el('div', 'net-notes-ver', '测试二号版本 · v' + CR.VERSION));
    NOTES.forEach(function (sec) {
      notesEl.appendChild(el('div', 'net-notes-h', sec.h));
      var ul = document.createElement('ul');
      ul.className = 'net-notes-list';
      sec.items.forEach(function (t) { ul.appendChild(el('li', '', t)); });
      notesEl.appendChild(ul);
    });
    var ok = el('button', 'net-btn primary', '知道了');
    ok.type = 'button';
    ok.addEventListener('click', closeNotes);
    notesEl.appendChild(ok);
    /* 公告盖在大厅上时先收起大厅，避免两层文字透出来 */
    if (root) root.style.display = 'none';
    notesEl.style.display = '';
  };

  /* ---------------- 房间：进房先选车，全员选完自动倒计时 ---------------- */
  function renderRoom(m) {
    lastRoom = m;
    if (notesEl) notesEl.style.display = 'none';   /* 进房/开赛一律收起公告 */
    if (!root) return;
    if (CR.Net && CR.Net.syncGear) CR.Net.syncGear();

    /* 倒计时 / 比赛中只要刷新状态文字，不再重开选车 */
    if (m.phase === 'countdown') { showRoom(m); return; }
    if (m.phase === 'racing') { root.style.display = 'none'; return; }

    var me = null;
    for (var i = 0; i < m.players.length; i++) if (m.players[i].id === CR.Net.id) me = m.players[i];
    if (me && me.ready) { showRoom(m); return; }

    if (picking) return;
    if (CR.CarSelect && CR.CarSelect.diag().open) { root.style.display = 'none'; return; }
    if (!CR.CarSelect || !CR.CarSelect.ready) { showRoom(m); return; }

    picking = true;
    root.style.display = 'none';
    CR.CarSelect.open('net', function (car) {
      picking = false;
      root.style.display = '';
      /* 比赛中服务端会拒绝换车，本地也绝不能先切模型/物理 */
      if (CR.Net && CR.Net.state === 'racing') {
        U.toast('比赛进行中不能换车');
      } else {
        if (CR.Net && CR.Net.selectCar) CR.Net.selectCar(car);
        if (CR.Garage && CR.Garage.setActive) CR.Garage.setActive(car);
      }
      if (lastRoom) showRoom(lastRoom);
    });
  }

  function showRoom(m) {
    if (!root) return;
    if (resultEl) resultEl.style.display = 'none';
    clear(); show();
    statusEl = null;

    root.appendChild(el('div', 'net-title', '房间 ' + m.code));
    root.appendChild(el('div', 'net-sub', m.laps + ' 圈 · 无碰撞竞速 · 测试二号'));

    var codeBox = el('div', 'net-code');
    codeBox.appendChild(el('span', 'net-code-v', m.code));
    var copy = el('button', 'net-btn mini', '复制房号');
    copy.type = 'button';
    copy.addEventListener('click', function () {
      var done = function () { copy.textContent = '已复制'; setTimeout(function () { copy.textContent = '复制房号'; }, 1500); };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(m.code).then(done, function () { U.toast('房号：' + m.code); });
        } else { U.toast('房号：' + m.code); }
      } catch (e) { U.toast('房号：' + m.code); }
    });
    codeBox.appendChild(copy);
    root.appendChild(codeBox);

    var list = el('div', 'net-players');
    var readyCount = 0;
    m.players.forEach(function (p) {
      if (p.ready) readyCount++;
      var off = (p.connected === false);
      var row = el('div', 'net-player' + (p.id === CR.Net.id ? ' me' : '') + (off ? ' off' : ''));
      var left = el('span', 'net-pname', p.name || ('玩家 ' + p.id));
      if (p.id === CR.Net.id) left.appendChild(el('i', 'net-badge me', '你'));
      if (p.id === m.host) left.appendChild(el('i', 'net-badge', '房主'));
      if (off) left.appendChild(el('i', 'net-badge off', '掉线'));
      row.appendChild(left);
      var right = el('span', 'net-tag' + (off ? ' off' : ''),
        off ? '重连中…' : ((carName(p.car)) + ' · ' + (p.ready ? '已选车' : '选择中…')));
      row.appendChild(right);
      list.appendChild(row);
    });
    root.appendChild(list);

    statusEl = el('div', 'net-status');
    root.appendChild(statusEl);
    updateStatus(m);

    var acts = el('div', 'net-actions');
    /* 开赛只由房主手动触发：全员选完车后按钮才可点。
       旧版是选完就自动 5 秒倒计时，房主没法控制节奏（比如等朋友接个电话）。 */
    var canStart = (m.canStart !== undefined) ? !!m.canStart
                 : (m.players.filter(function (x) { return x.connected !== false; }).length >= 2 &&
                    m.players.every(function (x) { return x.ready; }));
    var isHost = m.host === CR.Net.id;
    if (m.phase === 'lobby' || m.phase === 'result' || m.phase === undefined) {
      if (isHost) {
        /* 和服务端 canStart() 保持同一套口径：只统计 connected 的玩家，
           否则会出现「提示全员已就位、按钮却说还差 0 人且点不动」。 */
        var online = m.players.filter(function (x) { return x.connected !== false; });
        var waiting = online.filter(function (x) { return !x.ready; });
        var offline = m.players.filter(function (x) { return x.connected === false; });
        var why = canStart ? '' : (online.length < 2
          ? (' · 仅 ' + online.length + ' 人在线')
          : (' · 还差 ' + waiting.length + ' 人'));
        var bStart = el('button', 'net-btn' + (canStart ? ' primary' : ''),
          '开始比赛' + why);
        bStart.type = 'button';
        /* 不用 disabled：禁用按钮点下去毫无反馈，房主会以为「点了没用」。
           改成可点 + 说明原因，永远知道差什么。 */
        bStart.addEventListener('click', function () {
          if (!canStart) {
            if (online.length < 2) {
              U.toast(offline.length
                ? ('有 ' + offline.length + ' 人掉线，等他们重连（或至少 2 人在线）')
                : '至少需要 2 人才能开始');
            } else if (waiting.some(function (x) { return x.id === CR.Net.id; })) U.toast('你自己还没选车');
            else U.toast('还有 ' + waiting.length + ' 人没选车：' +
                         waiting.map(function (x) { return x.name || ('玩家 ' + x.id); }).join('、'));
            return;
          }
          if (!CR.Net || !CR.Net.start) return;
          bStart.disabled = true;
          bStart.textContent = '正在开始…';
          CR.Net.start();
          /* 服务端拒绝时只回 error、不广播 room，按钮会永久卡在「正在开始…」，
             看起来就是「点了完全没反应」。2.5 秒没进倒计时就自己恢复。 */
          setTimeout(function () {
            if (bStart.textContent === '正在开始…') {
              bStart.disabled = false;
              bStart.textContent = '开始比赛';
            }
          }, 2500);
        });
        acts.appendChild(bStart);
      } else {
        acts.appendChild(el('span', 'net-wait',
          canStart ? '全员已就位，等待房主开始…' : '等待其他玩家选车…'));
      }
    }
    var bLeave = el('button', 'net-btn', '离开房间');
    bLeave.type = 'button';
    bLeave.addEventListener('click', function () {
      CR.Net.leave(); U.showLobby();
    });
    acts.appendChild(bLeave);
    root.appendChild(acts);
  }

  function updateStatus(m) {
    if (!statusEl) return;
    /* 只算在线玩家：掉线的人不算「已就位」，否则会出现
       「提示全员已就位、按钮点不动」这种自相矛盾。 */
    var online = m.players.filter(function (p) { return p.connected !== false; });
    var offN = m.players.length - online.length;
    var total = online.length, ready = 0;
    for (var i = 0; i < total; i++) if (online[i].ready) ready++;
    var txt;
    if (m.phase === 'countdown') txt = Math.max(1, Math.ceil(m.countdown || 0)) + ' 秒后开始';
    else if (total < 2) txt = offN
      ? ('有 ' + offN + ' 人掉线，等待重连…')
      : '等待对手加入（至少 2 人）';
    else if (ready >= total) txt = ((m.host === CR.Net.id)
      ? '全员已就位，点「开始比赛」开赛'
      : '全员已就位，等待房主开始…') + (offN ? ('　（' + offN + ' 人掉线）') : '');
    else txt = '等待其他玩家选车（' + ready + '/' + total + '）';
    if (statusEl.textContent !== txt) statusEl.textContent = txt;
  }

  function onEvent(e) {
    if (!root) return;
    if (e.kind === 'start') {
      root.style.display = 'none';
      if (notesEl) notesEl.style.display = 'none';
      hideCountdown();
      U.toast('比赛开始');
    } else if (e.kind === 'result') { /* result 消息会单独处理 */ }
    else if (e.kind === 'join') U.toast(e.name + ' 加入房间');
    else if (e.kind === 'leave') U.toast(e.name + ' 离开房间');
    else if (e.kind === 'reconnect') U.toast(e.name + ' 已重连');
  }

  function hideCountdown() {
    if (countEl) countEl.style.display = 'none';
  }

  function renderLive(s) {
    /* 开赛倒计时：全屏大数字 */
    if (s.phase === 'countdown') {
      if (countEl) {
        var n = Math.max(1, Math.ceil(s.countdown || 0));
        if (countEl.textContent !== String(n)) countEl.textContent = n;
        countEl.style.display = '';
      }
      if (lastRoom) { lastRoom.countdown = s.countdown; lastRoom.phase = s.phase; updateStatus(lastRoom); }
      if (rankEl) rankEl.style.display = 'none';
      lastPhase = s.phase;
      return;
    }
    hideCountdown();
    if (!rankEl) return;
    if (s.phase !== 'racing') {
      rankEl.style.display = 'none';
      lastPhase = s.phase;
      return;
    }
    lastPhase = s.phase;
    if (root && root.style.display !== 'none') root.style.display = 'none';
    var me = null;
    for (var i = 0; i < s.players.length; i++) if (s.players[i].id === CR.Net.id) me = s.players[i];
    if (!me) return;
    rankEl.style.display = '';
    var total = s.players.filter(function (p) { return !p.finished; }).length;
    var rank = me.rank || (me.finished ? me.rank : total);
    var txt = me.finished ? ('已完赛 · 第 ' + rank + ' 名')
      : (rank + ' / ' + total + '　圈 ' + (me.lap + 1) + '/' + s.laps);
    if (rankEl._t !== txt) { rankEl._t = txt; rankEl.textContent = txt; }
  }

  function renderResult(m) {
    if (!resultEl) return;
    resultEl.innerHTML = '';
    resultEl.appendChild(el('div', 'net-title', '比赛结算'));
    var mine = CR.Net.device ? CR.Net.device() : '';
    m.rows.forEach(function (r) {
      var row = el('div', 'net-player' + (r.device === mine ? ' me' : ''));
      row.appendChild(el('span', '', r.rank + '   ' + r.name));
      row.appendChild(el('span', 'net-tag', r.finished ? CR.fmtTime(r.time) : 'DNF'));
      resultEl.appendChild(row);
    });
    resultEl.appendChild(el('div', 'net-tip', '12 秒后回到房间，可重新选车'));
    resultEl.style.display = '';
    if (rankEl) rankEl.style.display = 'none';
    setTimeout(function () { resultEl.style.display = 'none'; }, 12000);
  }

  U.hideResult = function () { if (resultEl) resultEl.style.display = 'none'; };
  U.diag = function () {
    return {
      ready: !!U.ready, visible: root ? root.style.display : 'none',
      picking: picking, lastRoom: lastRoom ? lastRoom.code : '',
      phase: lastRoom ? lastRoom.phase : ''
    };
  };
})();
