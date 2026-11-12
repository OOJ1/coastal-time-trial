/* =========================================================================
 * record.js — 排行榜（本机 top 5）
 * 规则：一局只记一条——**本局首次冲过终点线**的圈速；之后在同一局里再跑出的
 *       圈速只更新 LAST，不会覆盖或追加记录。只有"重新开始一局"（Enter）
 *       才会开新的一局，下一次冲线才允许再记一条。
 * 存储：localStorage（不可用时退化为内存，不影响游戏）。
 * 同时提供 CR.fmtTime（hud 与排行榜共用同一套 m:ss.mmm 格式化）。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;

  /* m:ss.mmm，入参为秒 */
  CR.fmtTime = function (t) {
    if (!isFinite(t) || t < 0) t = 0;
    var m = Math.floor(t / 60), s = Math.floor(t % 60);
    var ms = Math.floor((t - Math.floor(t)) * 1000);
    return m + ':' + (s < 10 ? '0' : '') + s + '.' + (ms < 100 ? '0' : '') + (ms < 10 ? '0' : '') + ms;
  };

  var R = CR.Record = {};
  var KEY = 'cr.lb.v1', MAX = 5;

  var list = [];              /* [{t:ms, ts:epoch}] 升序 */
  var sessionDone = false;    /* 本局是否已经记过一条 */
  var curMs = -1;             /* 本局记录值（ms），-1 表示还没冲线 */
  var el = null, rows = [];

  function load() {
    try {
      var raw = (typeof window !== 'undefined' && window.localStorage) ? window.localStorage.getItem(KEY) : null;
      if (!raw) return;
      var a = JSON.parse(raw);
      if (!a || !a.length) return;
      list = a.filter(function (e) { return e && isFinite(e.t) && e.t > 0; })
              .sort(function (x, y) { return x.t - y.t; })
              .slice(0, MAX);
    } catch (e) { list = []; }
  }
  function save() {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(KEY, JSON.stringify(list));
      }
    } catch (e) { /* 隐私模式 / file:// 限制：静默退化为内存 */ }
  }

  function setRow(i, text, isNew) {
    var r = rows[i];
    if (!r) return;
    if (r._t !== text) { r._t = text; r.textContent = text; }
    var cn = isNew ? 'lb new' : 'lb';
    if (r.className !== cn) r.className = cn;
    if (r.style.display) r.style.display = '';
  }

  function render() {
    if (!el) return;
    var top = list.slice(0, MAX);
    var inList = curMs > 0 && top.some(function (e) { return e.t === curMs; });
    var n = 0, i;
    for (i = 0; i < top.length; i++) {
      setRow(n++, (i + 1) + '  ' + CR.fmtTime(top[i].t / 1000), top[i].t === curMs);
    }
    /* 本局成绩没进前 5 时单独补一行，保证"记录"永远看得见 */
    if (curMs > 0 && !inList) setRow(n++, '·  ' + CR.fmtTime(curMs / 1000), true);
    for (i = n; i < rows.length; i++) {
      if (rows[i].style.display !== 'none') rows[i].style.display = 'none';
    }
    el.style.display = (n > 0) ? '' : 'none';
  }

  R.create = function (dom) {
    el = dom || document.getElementById('hud-board');
    if (el) {
      /* 幂等：重复 create（或换容器）时先摘掉上一批行，避免叠出两套 */
      if (el.removeChild) {
        for (var k = 0; k < rows.length; k++) {
          try { el.removeChild(rows[k]); } catch (e) { /* 已不在树上 */ }
        }
      }
      rows = [];
      for (var i = 0; i <= MAX; i++) {
        var d = document.createElement('div');
        d.className = 'lb';
        d.style.display = 'none';
        el.appendChild(d);
        rows.push(d);
      }
    }
    sessionDone = false;   /* create 即"新的一局"（页面刚起来） */
    curMs = -1;
    load();
    render();
    return R;
  };

  /* 冲线后把成绩报到博客后端（同源 fetch），本地 top5 仍作为离线兜底保留。
     身份与分数由服务端判定/换算，这里只带圈速、昵称与设备 ID。 */
  function reportScore(ms) {
    try {
      var ls = window.localStorage;
      var nickname = (ls && ls.getItem('ooji-game-nickname')) || '';
      var device = (ls && ls.getItem('ooji-device-id')) || '';
      if (!device) {
        device = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
          : 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2);
        if (ls) ls.setItem('ooji-device-id', device);
      }
      fetch('/api/game/score', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ time_ms: ms, nickname: nickname, device: device })
      }).then(function () {
        /* 通知父页面刷新排行榜；独立全屏版 parent === self，收不到也无妨 */
        try { window.parent.postMessage({ type: 'ooji-game-score' }, '*'); } catch (e) {}
      }).catch(function () { /* 离线 / 接口异常：不影响本地榜单和游戏 */ });
    } catch (e) { /* localStorage 被禁用时静默跳过上报 */ }
  }

  /* 本局首次冲线：只接受一次；之后同局再冲线直接忽略 */
  R.submit = function (sec) {
    if (sessionDone) return { accepted: false, reason: 'session-done' };
    if (!isFinite(sec) || sec <= 0) return { accepted: false, reason: 'invalid' };
    sessionDone = true;
    curMs = Math.round(sec * 1000);
    var prevBest = list.length ? list[0].t : Infinity;
    list.push({ t: curMs, ts: Date.now() });
    list.sort(function (a, b) { return a.t - b.t; });
    if (list.length > MAX) list = list.slice(0, MAX);
    save();
    render();
    reportScore(curMs);
    var rank = 0;
    for (var i = 0; i < list.length; i++) if (list[i].t === curMs) { rank = i + 1; break; }
    return { accepted: true, rank: rank, best: curMs < prevBest, t: curMs };
  };

  /* 重新开始一局：只解除"本局已记录"的锁，历史榜单保留 */
  R.newSession = function () {
    sessionDone = false;
    curMs = -1;
    render();
  };

  R.entries = function () { return list.slice(); };
  R.sessionDone = function () { return sessionDone; };
  R.reset = function () { list = []; curMs = -1; sessionDone = false; save(); render(); };
  R.diag = function () {
    return {
      n: list.length, best: list.length ? list[0].t : -1,
      cur: curMs, sessionDone: sessionDone,
      list: list.map(function (e) { return e.t; })
    };
  };
})();
