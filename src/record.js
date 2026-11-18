/* =========================================================================
 * record.js — 双榜单排行榜（每辆车一份本机 TOP 5）
 *
 * 规则（本次修订：每圈都记）：
 *   · **每完成一圈都记一条成绩**，不再只记本局首次冲线。每辆车各有一份
 *     独立的 TOP 5，按圈速升序，超出 5 条时最慢的一条被挤掉。
 *   · 榜单按当前驾驶的车切换显示，标题带车型名，不同调校的车不混排；
 *     最近一圈用暖橙高亮，没进 TOP 5 时补一行「·  m:ss.mmm」。
 *   · 「重新开始一局」仍存在（ENTER / 换车），但现在只清计时与高亮，
 *     **不再有任何记录锁**：换车回原点计时、ENTER 回原点计时都保持原样。
 *   · 存储 key 为 cr.lb.v2；旧 cr.lb.v1（无车型字段）全部归入车 0。
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
  var KEY = 'cr.lb.v2', LEGACY_KEY = 'cr.lb.v1', MAX = 5, CARS = 2;

  var boards = [[], []];                     /* boards[car] = [{t:ms, ts:epoch}] 升序 */
  var curMs = [-1, -1];                     /* 每辆车「最近一圈」成绩，-1 = 还没冲线 */
  var submits = [0, 0];                     /* 每辆车累计提交次数（诊断用） */
  var active = 0;                           /* 当前显示 / 当前驾驶的车 */
  var el = null, rows = [], label = null;

  function norm(i) { return ((Number(i) || 0) % CARS + CARS) % CARS; }
  function carName(i) {
    try { return CR.Car.TUNES[i].name || ('车型 ' + (i + 1)); }
    catch (e) { return '车型 ' + (i + 1); }
  }
  function clean(a) {
    if (!a || !a.length) return [];
    return a.filter(function (e) { return e && isFinite(e.t) && e.t > 0; })
            .sort(function (x, y) { return x.t - y.t; })
            .slice(0, MAX);
  }

  function load() {
    var raw = null;
    try {
      if (typeof window !== 'undefined' && window.localStorage) raw = window.localStorage.getItem(KEY);
    } catch (e) { raw = null; }
    boards = [[], []];
    if (raw) {
      try {
        var v2 = JSON.parse(raw);
        var src = (v2 && v2.boards) ? v2.boards : (Array.isArray(v2) ? v2 : null);
        if (src) {
          for (var i = 0; i < CARS; i++) boards[i] = clean(src[i]);
          return;                       /* v2 已存在，不做迁移 */
        }
      } catch (e) { /* 损坏的 v2 → 往下走旧数据迁移 */ }
    }
    /* 旧版只有一张无车型标签的榜：按"历史成绩归原厂车"处理，并立刻写成 v2 */
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        var old = window.localStorage.getItem(LEGACY_KEY);
        if (old) {
          boards[0] = clean(JSON.parse(old));
          save();
        }
      }
    } catch (e) { /* 旧数据损坏/不可读：忽略，不影响游戏 */ }
  }
  function save() {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(KEY, JSON.stringify({ v: 2, boards: boards }));
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
    if (label) {
      var title = 'TOP · ' + carName(active);
      if (label.textContent !== title) label.textContent = title;
    }
    var list = boards[active], top = list.slice(0, MAX);
    var cur = curMs[active];
    var inList = cur > 0 && top.some(function (e) { return e.t === cur; });
    var n = 0, i;
    for (i = 0; i < top.length; i++) {
      setRow(n++, (i + 1) + '  ' + CR.fmtTime(top[i].t / 1000), top[i].t === cur);
    }
    /* 最近一圈没进 TOP 5 时单独补一行，保证这次成绩永远看得见 */
    if (cur > 0 && !inList) setRow(n++, '·  ' + CR.fmtTime(cur / 1000), true);
    for (i = n; i < rows.length; i++) {
      if (rows[i].style.display !== 'none') rows[i].style.display = 'none';
    }
    el.style.display = (n > 0) ? '' : 'none';
  }

  R.create = function (dom) {
    el = dom || document.getElementById('hud-board');
    label = null;
    if (el) {
      label = el.querySelector ? el.querySelector('.lb-h') : null;
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
    active = norm(CR.Car && typeof CR.Car.active === 'number' ? CR.Car.active : 0);
    curMs = [-1, -1];   /* 新页面：清掉「最近一圈」高亮，历史榜保留 */
    submits = [0, 0];
    load();
    render();
    return R;
  };

  /* 切驾驶权：只切换显示哪张榜，不动任何数据 */
  R.setActive = function (i) {
    active = norm(i);
    render();
    return active;
  };
  R.active = function () { return active; };

  /* 冲线后把成绩报到博客后端（同源 fetch），本地双榜仍作为离线兜底保留。
     每圈都会上报一次；身份与分数由服务端判定/换算。 */
  /* checks 由调用方在结算那一刻快照传入；不传时才回退读全局状态。
     冲线流程里检查点会被立即 reset，回退读会拿到 0，别依赖它。 */
  function reportScore(ms, car, checks) {
    try {
      var ls = window.localStorage;
      /* 上报时带上检查点通过数与圈速合法性，服务端据此二次拦截抄近道/伪造 */
      var passed = (typeof checks === 'number')
        ? checks
        : (CR.Check ? CR.Check.passed(car) : CR.CFG.CHECK_COUNT);
      var lapValid = ms >= (CR.Check ? CR.Check.lapLimit(car) : 0) &&
                     passed >= CR.CFG.CHECK_COUNT;
      if (!lapValid) {
        /* 别再静默丢弃：留一条日志，否则这类问题完全没有线索可查 */
        console.warn('[game] 成绩未上报：圈速 ' + ms + 'ms，检查点 ' +
                     passed + '/' + CR.CFG.CHECK_COUNT);
        return;
      }
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
        body: JSON.stringify({ time_ms: ms, car: car, nickname: nickname, device: device,
                               checkpoints: passed, lap_valid: lapValid })
      }).then(function () {
        /* 通知父页面刷新排行榜；独立全屏版 parent === self，收不到也无妨 */
        try { window.parent.postMessage({ type: 'ooji-game-score' }, '*'); } catch (e) {}
      }).catch(function () { /* 离线 / 接口异常：不影响本地榜单和游戏 */ });
    } catch (e) { /* localStorage 被禁用时静默跳过上报 */ }
  }

  /* 每完成一圈都记一条：没有「一局只记一次」的锁。
     carId 由 Hud 在冲线那一刻显式传入，缺省时回退到当前显示的车。
     榜单只保留最快的 MAX 条，慢成绩会被挤掉（但仍可通过返回值看到本次成绩）。 */
  R.submit = function (sec, carId, checks) {
    var id = norm(carId === undefined ? active : carId);
    if (!isFinite(sec) || sec <= 0) return { accepted: false, reason: 'invalid', car: id };
    curMs[id] = Math.round(sec * 1000);
    submits[id]++;
    var list = boards[id];
    var prevBest = list.length ? list[0].t : Infinity;
    list.push({ t: curMs[id], ts: Date.now() });
    list.sort(function (a, b) { return a.t - b.t; });
    if (list.length > MAX) list = list.slice(0, MAX);
    boards[id] = list;
    save();
    render();
    reportScore(curMs[id], id, checks);
    var rank = 0;
    for (var i = 0; i < list.length; i++) if (list[i].t === curMs[id]) { rank = i + 1; break; }
    return {
      accepted: true, rank: rank, inTop: rank > 0,
      best: curMs[id] < prevBest, t: curMs[id], car: id, submits: submits[id]
    };
  };

  /* 重新开始一局（ENTER / 换车）：只清该车的「最近一圈」高亮，
     两张榜的历史成绩都保留；记录不再受任何锁限制。 */
  R.newSession = function (carId) {
    var id = norm(carId === undefined ? active : carId);
    curMs[id] = -1;
    render();
    return id;
  };

  R.entries = function (carId) { return boards[norm(carId === undefined ? active : carId)].slice(); };
  /* 兼容旧诊断口：规则已改为每圈都记，不再存在「已记录」锁，恒返回 false */
  R.sessionDone = function () { return false; };
  R.reset = function () {
    boards = [[], []];
    curMs = [-1, -1];
    submits = [0, 0];
    save();
    render();
  };
  R.diag = function () {
    var each = [];
    for (var i = 0; i < CARS; i++) {
      each.push({
        car: i, name: carName(i), n: boards[i].length,
        best: boards[i].length ? boards[i][0].t : -1,
        cur: curMs[i], submits: submits[i],
        sessionDone: false,   /* 废弃字段，保留只为兼容旧诊断脚本 */
        list: boards[i].map(function (e) { return e.t; })
      });
    }
    var c = each[active];
    return {
      active: active, cars: each,
      /* 兼容旧诊断脚本：下列字段仍指向当前车 */
      n: c.n, best: c.best, cur: c.cur, sessionDone: false,
      list: c.list
    };
  };
})();
