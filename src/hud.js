/* =========================================================================
 * hud.js — 速度 + 圈速 m:ss.mmm；半程检查点防止抄近道 / 倒车刷圈
 * 无最佳圈、无圈数、无排名、无存档。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var Hud = CR.Hud = {};
  var el = {}, last = {};
  var S = { running: false, time: 0, checkpoint: false, prevS: 0, hold: 0, lastTime: 0 };
  /* 氮气条：只在整数百分比变化时写一次 transform，绝不读布局、不写 innerHTML */
  var nosPct = -1, nosDim = false;

  /* 时间格式化统一由 record.js 提供（CR.fmtTime），避免两处实现漂移 */
  function fmt(t) { return CR.fmtTime(t); }
  function set(k, text) {
    if (last[k] === text) return;
    last[k] = text;
    if (el[k]) el[k].textContent = text;
  }

  Hud.create = function () {
    ['speed', 'time', 'last'].forEach(function (k) { el[k] = document.getElementById('hud-' + k); });
    el.nosBar = document.getElementById('nosBar');
    Hud.ready = true;
    return Hud;
  };

  Hud.update = function (dt) {
    if (!Hud.ready) return;
    var st = CR.Car.state, L = CR.Track.L, s = st.s;

    /* 半程检查点 */
    if (s > 0.45 * L && s < 0.55 * L) S.checkpoint = true;
    /* 正向冲线 */
    if (S.prevS > 0.8 * L && s < 0.2 * L) {
      var completed = false;
      if (!S.running) { S.running = true; S.time = 0; }
      else if (S.checkpoint) {
        S.lastTime = S.time; S.hold = 3.5; S.time = 0; S.checkpoint = false;
        completed = true;
      }
      /* 只广播事件：彩条模块自己管 CD，圈速状态机不受任何影响 */
      if (CR.Confetti) CR.Confetti.trigger(completed);
      /* 排行榜：一局只收"首次冲线"这一条，之后同局再冲线 Record 自己会拒。
         这里不判断是否刷新，规则完全由 Record 管。 */
      if (completed && CR.Record) CR.Record.submit(S.lastTime);
    }
    if (S.running) S.time += dt;
    S.prevS = s;
    if (S.hold > 0) S.hold -= dt;

    var kmh = Math.round(Math.abs(st.speed) * 3.6);
    set('speed', kmh < 10 ? '00' + kmh : (kmh < 100 ? '0' + kmh : '' + kmh));
    set('time', fmt(S.time));
    set('last', S.hold > 0 ? ('LAST  ' + fmt(S.lastTime)) : '');

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

  /* 重新开始一局：清计时/检查点，并给排行榜解锁（下一次冲线才会再记一条） */
  Hud.restart = function () {
    S.running = false; S.time = 0; S.checkpoint = false;
    S.hold = 0; S.lastTime = 0;
    S.prevS = CR.Car.state.s;
    last.speed = last.time = last.last = null;   /* 下一帧强制重写文本 */
    if (CR.Record) CR.Record.newSession();
  };

  Hud.state = S;
})();
