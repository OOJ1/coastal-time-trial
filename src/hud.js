/* =========================================================================
 * hud.js — 速度 + 圈速 m:ss.mmm；8 个检查点 + 车型极限时间防抄近道 / 刷圈
 * 每辆车一份计时槽，检查点状态由 CR.Check 按车保存。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var Hud = CR.Hud = {};
  var el = {}, last = {};
  /* 每辆车一份计时槽：running / time / prevS / hold / lastTime / rejected。
     切驾驶权时只换 S 引用，互不覆盖，也不会因为 prevS 串车而误判冲线。 */
  function makeSession() {
    return { running: false, time: 0, prevS: 0, hold: 0, lastTime: 0, rejected: '', passed: 0 };
  }
  var sessions = [makeSession(), makeSession()];
  var S = sessions[0];
  /* 氮气条：只在整数百分比变化时写一次 transform，绝不读布局、不写 innerHTML */
  var nosPct = -1, nosDim = false;
  /* 联机：上一圈记过的服务端成绩（秒）。服务端只在冲线时更新 lastLap，
     值变了才说明跑完了一圈，避免 15Hz 快照把同一圈写进榜好几次。 */
  var netLap = [0, 0];

  /* 时间格式化统一由 record.js 提供（CR.fmtTime），避免两处实现漂移 */
  function fmt(t) { return CR.fmtTime(t); }
  function set(k, text) {
    if (last[k] === text) return;
    last[k] = text;
    if (el[k]) el[k].textContent = text;
  }

  Hud.create = function () {
    Hud.resetSessions();
    ['speed', 'time', 'last'].forEach(function (k) { el[k] = document.getElementById('hud-' + k); });
    el.nosBar = document.getElementById('nosBar');
    Hud.ready = true;
    return Hud;
  };

  /* 冲线结算：检查点必须全过、圈速不得快于车型物理极限，否则不计成绩。
     结算这一刻把通过数快照进 S.passed：冲线后紧接着会 reset 检查点，
     上报若再去读全局状态就会拿到 0（曾经因此把所有成绩都判成无效）。 */
  function settle(S, car) {
    var ms = Math.round(S.time * 1000);
    var chk = CR.Check;
    S.passed = chk.passed(car);
    if (!chk.complete(car)) {
      S.rejected = '漏检查点 ' + S.passed + '/' + CR.CFG.CHECK_COUNT;
      return false;
    }
    if (ms < chk.lapLimit(car)) {
      S.rejected = '圈速异常';
      return false;
    }
    S.rejected = '';
    return true;
  }

  Hud.update = function (dt) {
    if (!Hud.ready) return;
    var st = CR.Car.state, L = CR.Track.L, s = st.s;
    var car = CR.Car.active | 0;
    var chk = CR.Check;

    /* 每帧推进检查点（横向范围覆盖全可行驶区，走草地/蹭护栏都算通过） */
    if (chk) chk.update(car, s, st.lat, L);

    /* 正向冲线 */
    if (S.prevS > 0.8 * L && s < 0.2 * L) {
      var completed = false;
      if (!S.running) { S.running = true; S.time = 0; }
      else if (chk && settle(S, car)) {
        S.lastTime = S.time; S.hold = 3.5; S.time = 0;
        completed = true;
      } else {
        S.time = 0;
      }
      /* 下一圈重新计检查点，避免沿用上一圈的通过状态 */
      if (chk) chk.reset(car);
      /* 只广播事件：彩条模块自己管 CD，圈速状态机不受任何影响 */
      if (CR.Confetti) CR.Confetti.trigger(completed);
      /* 排行榜：双榜按车型分开，每完成一圈都记一条。
         检查点通过数用结算时快照的 S.passed，不依赖 reset 之后的状态。 */
      if (completed && CR.Record) CR.Record.submit(S.lastTime, car, S.passed);
    }
    if (S.running) S.time += dt;
    S.prevS = s;
    if (S.hold > 0) S.hold -= dt;

    var kmh = Math.round(Math.abs(st.speed) * 3.6);
    set('speed', kmh < 10 ? '00' + kmh : (kmh < 100 ? '0' + kmh : '' + kmh));
    set('time', fmt(S.time));
    set('last', S.rejected ? ('✕ ' + S.rejected)
             : (S.hold > 0 ? ('LAST  ' + fmt(S.lastTime)) : ''));

    /* 氮气细线：百分比整数变化才写 transform（合成层属性，不触发布局）；
       低电量（低于 REARM 且没在烧）时整条变淡，靠 CSS transition 过渡，不闪烁。 */
    var bar = el.nosBar;
    if (bar) {
      var pct = Math.round(st.nitro * 100);
      if (pct !== nosPct) {
        nosPct = pct;
        bar.style.transform = 'scaleX(' + (pct * 0.01).toFixed(2) + ')';
      }
      var dim = !st.nitroActive && st.nitro < CR.NITRO.REARM;
      if (dim !== nosDim) { nosDim = dim; bar.className = dim ? 'dim' : ''; }
    }
  };

  /* 联机：计时 / 检查点 / 冲线以服务端为准，本地不再跑圈速判定，
     只把速度、氮气和快照里的本圈时间刷到 HUD 上（否则联机时速度表停在 000）。 */
  Hud.updateNet = function (m) {
    if (!Hud.ready) return;
    var st = CR.Car.state;
    var kmh = Math.round(Math.abs(st.speed) * 3.6);
    set('speed', kmh < 10 ? '00' + kmh : (kmh < 100 ? '0' + kmh : '' + kmh));
    var me = null;
    if (m && m.players) {
      for (var i = 0; i < m.players.length; i++) if (m.players[i].id === CR.Net.id) me = m.players[i];
    }
    if (me) {
      set('time', fmt(me.lapTime || 0));
      set('last', me.best > 0 ? ('BEST  ' + fmt(me.best / 1000)) : '');
      /* 联机圈速由服务端判定：冲线时快照里的 lastLap 会变。
         之前联机完全不调 Record.submit —— 跑得再快，榜上也不会有任何成绩，
         也不会上报到 /api/game/score。检查点由服务端把关，这里直接按全过上报。 */
      var car = CR.Car.active | 0;
      /* 服务端 lastLap 是毫秒（rooms.js 里 Math.round((raceTime - lapStart) * 1000)），
         而 Record.submit() 收秒 —— 单位错了会记成天文数字的圈速。 */
      var lapMs = Number(me.lastLap) || 0;
      if (lapMs > 0 && lapMs !== netLap[car]) {
        netLap[car] = lapMs;
        if (CR.Record) CR.Record.submit(lapMs / 1000, car, CR.CFG.CHECK_COUNT);
      }
    }
    var bar = el.nosBar;
    if (bar) {
      var pct = Math.round(st.nitro * 100);
      if (pct !== nosPct) { nosPct = pct; bar.style.transform = 'scaleX(' + (pct * 0.01).toFixed(2) + ')'; }
      var dim = !st.nitroActive && st.nitro < CR.NITRO.REARM;
      if (dim !== nosDim) { nosDim = dim; bar.className = dim ? 'dim' : ''; }
    }
  };

  /* 重新开始一局（ENTER）：只清「当前驾驶车」的计时槽与该车的记录锁，另一辆保留 */  Hud.restart = function () {
    netLap[CR.Car.active | 0] = 0;
    S.running = false; S.time = 0; S.rejected = '';
    S.hold = 0; S.lastTime = 0;
    S.prevS = CR.Car.state.s;
    if (CR.Check) CR.Check.reset(CR.Car.active | 0);
    last.speed = last.time = last.last = null;   /* 下一帧强制重写文本 */
    if (CR.Record) CR.Record.newSession(CR.Car.active | 0);
  };

  /* 换车 = 目标车新的一局：把该车计时槽整个清零。
     直接按 carId 操作 sessions[k]，不依赖当前 S 指向哪辆车（Garage 会在
     调用本函数之后才切 CR.Car.state / Hud.setActive）。 */
  Hud.resetCar = function (i) {
    var k = ((Number(i) || 0) % 2 + 2) % 2;
    netLap[k] = 0;
    sessions[k] = makeSession();
    sessions[k].prevS = CR.Car.states && CR.Car.states[k] ? CR.Car.states[k].s : 0;
    if (CR.Check) CR.Check.reset(k);
    last.speed = last.time = last.last = null;
    nosPct = -1;
  };

  /* 切驾驶权：换计时槽，并把 prevS 对齐到该车当前位置，避免误判冲线 */
  Hud.setActive = function (i) {
    S = sessions[((i % 2) + 2) % 2];
    S.prevS = CR.Car.states[((i % 2) + 2) % 2].s;
    last.speed = last.time = last.last = null;
    nosPct = -1;
  };
  /* 原地重置两个槽：不能整体换数组，否则 Hud.state（外部诊断引用）会指向旧数组 */
  Hud.resetSessions = function () {
    for (var k = 0; k < sessions.length; k++) sessions[k] = makeSession();
    netLap = [0, 0];
    if (CR.Check) CR.Check.resetAll();
    S = sessions[0];
    S.prevS = CR.Car.state ? CR.Car.state.s : 0;
    last.speed = last.time = last.last = null;
    nosPct = -1;
  };
  Hud.state = sessions;
})();
