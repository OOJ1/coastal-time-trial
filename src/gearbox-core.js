/* =========================================================================
 * gearbox-core.js — 换挡逻辑的唯一实现（浏览器 + Node 权威服务端共用）
 *
 * 这里只有纯数学，不碰 DOM、不碰 THREE，所以 server/physics.js 可以把它和
 * rng/track/car 一起塞进 vm 沙箱，保证联机时两端换挡完全一致。
 *
 * 自动挡思路（与旧版「按 cap 百分比线性阈值」不同）：
 *   每档的可用推力 ≈ torque × [1 - (v / cap)²]（就是 car.js 里的纵向模型）。
 *   让相邻两档推力相等的速度叫「换挡点」：低于它低档更快，高于它高档更快。
 *   自动挡就按这个点升档，并按 10% 滞回降档 —— 既不会提前升档丢扭矩，
 *   也不会在换挡点附近来回抖。再叠一个 0.24s 驻留，避免连续跳档。
 *   滑行（不给油）不升档，只逐级降档；手刹期间锁档，别打断漂移。
 *
 * 氮气：car.js 会把每档极速按 NITRO.VMAX / engineVmax 缩放。核心用同一个
 *   系数算换挡点，所以氮气中的档位依旧有意义（旧版氮气会无视档位）。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR = window.CR || {};
  var Core = CR.GearCore = {};

  /* 6 档：torque 越大起步越猛，cap 为该档推力归零速度 (m/s) */
  Core.RATIOS = [
    { n: 1, torque: 1.70, cap: 26 },
    { n: 2, torque: 1.42, cap: 40 },
    { n: 3, torque: 1.20, cap: 54 },
    { n: 4, torque: 1.04, cap: 68 },
    { n: 5, torque: 0.92, cap: 82 },
    { n: 6, torque: 0.82, cap: 98 }
  ];

  /* 两档推力相等时的速度：solve  ta*(1-(v/ca)²) = tb*(1-(v/cb)²)
     i 为 0 基下标，比较第 i 档与第 i+1 档。 */
  function shiftPoint(R, i, boostScale, boost) {
    var a = R[i], b = R[i + 1];
    if (!b) return a.cap;
    var ca = boost ? a.cap * boostScale : a.cap;
    var cb = boost ? b.cap * boostScale : b.cap;
    var k = a.torque / (ca * ca) - b.torque / (cb * cb);
    if (k <= 1e-9) return ca;               /* 高档没有优势：一直用到该档极限 */
    var v2 = (a.torque - b.torque) / k;
    if (!isFinite(v2) || v2 <= 0) return 0;
    return Math.sqrt(v2);
  }
  Core.shiftPoint = function (i, boostScale, boost) {
    return shiftPoint(Core.RATIOS, i, boostScale || 1, !!boost);
  };

  /* opts: { ratios, boostScale, manual, gear, cut, coastCut, dwell, downHyst } */
  Core.create = function (opts) {
    opts = opts || {};
    var R = opts.ratios || Core.RATIOS;
    var boostScale = opts.boostScale || 1;
    var cutTime = opts.cut != null ? opts.cut : 0.12;        /* 换档断油 */
    var coastCut = opts.coastCut != null ? opts.coastCut : 0.05;
    var dwellTime = opts.dwell != null ? opts.dwell : 0.24;  /* 两次自动换档间隔 */
    var downHyst = opts.downHyst != null ? opts.downHyst : 0.90;

    var g = {
      gear: opts.gear || 3,     /* 1-based */
      cut: 0,                   /* 断油剩余秒数 */
      dwell: 0,                 /* 自动换档冷却 */
      manual: !!opts.manual,
      shifts: 0                 /* 累计换档次数（调试用） */
    };

    function point(i, boost) { return shiftPoint(R, i, boostScale, boost); }

    /* 氮气缩放系数由调用方提供（car.js 用 NITRO.VMAX / engineVmax） */
    g.setBoostScale = function (s) {
      if (isFinite(s) && s > 0) boostScale = s;
      return boostScale;
    };
    g.getBoostScale = function () { return boostScale; };

    g.capOf = function (i, boost) {
      var c = R[i].cap;
      return boost ? c * boostScale : c;
    };
    /* 该档在当前速度下还剩多少推力（0 表示已经到该档极限） */
    g.thrust = function (i, v, boost) {
      var c = g.capOf(i, boost);
      var k = 1 - (v / c) * (v / c);
      return k > 0 ? R[i].torque * k : 0;
    };
    g.shiftPoint = function (i, boost) { return point(i, boost); };

    function cutFor(throttle) {
      return throttle > 0.05 ? cutTime : coastCut;
    }
    function shiftTo(to, throttle) {
      if (to === g.gear || to < 1 || to > R.length) return false;
      g.gear = to;
      g.cut = cutFor(throttle);
      g.dwell = dwellTime;
      g.shifts++;
      return true;
    }

    g.spec = function () {
      var r = R[g.gear - 1];
      return { torque: r.torque, cap: r.cap, cut: g.cut > 0 ? 0.18 : 1, n: r.n };
    };

    /* 手动：升档随时可以；降档加超转保护（目标档极速的 1.02 倍以内） */
    g.up = function () {
      if (!g.manual || g.gear >= R.length) return false;
      return shiftTo(g.gear + 1, 1);
    };
    g.down = function (v, boost) {
      if (!g.manual || g.gear <= 1) return false;
      if (v != null && Math.abs(v) > g.capOf(g.gear - 2, boost) * 1.02) return false;
      return shiftTo(g.gear - 1, 1);
    };

    g.setManual = function (on) {
      on = !!on;
      if (on === g.manual) return false;
      g.manual = on;
      g.dwell = 0;
      if (!on) g.cut = 0;       /* 切回自动立刻恢复动力，别留半截断油 */
      return true;
    };
    g.toggle = function () { return g.setManual(!g.manual); };

    /* 每帧/每 tick 调用一次（在物理推进之后，与客户端顺序一致）
       v 传带符号的纵向速度（倒车为负）；o: { throttle: 0..1, boost, handbrake } */
    g.step = function (dt, v, o) {
      if (g.cut > 0) g.cut = Math.max(0, g.cut - dt);
      if (g.dwell > 0) g.dwell = Math.max(0, g.dwell - dt);
      if (g.manual) return;

      o = o || {};
      var boost = !!o.boost;
      var throttle = (o.throttle == null) ? 1 : o.throttle;
      v = v || 0;

      /* 倒车：固定 1 档，别按绝对速度往上升档 */
      if (v < -0.5) {
        if (g.gear !== 1) { g.gear = 1; g.cut = 0; g.dwell = dwellTime * 0.5; }
        return;
      }
      v = Math.abs(v);
      /* 手刹锁档：漂移中断油会破坏姿态 */
      if (o.handbrake) return;

      /* 停住/倒车 → 一档，起步扭矩最大 */
      if (v < 1.0) {
        if (g.gear !== 1) { g.gear = 1; g.cut = 0; g.dwell = dwellTime * 0.5; }
        return;
      }
      /* 速度已超过当前档极速（该档已完全断油）：立刻升一档，不等驻留。
         切自动 / 开氮气（cap 缩放）时会遇到，避免白白空转 0.24s。 */
      if (g.gear < R.length && v >= g.capOf(g.gear - 1, boost) * 0.999) {
        shiftTo(g.gear + 1, throttle);
        return;
      }
      if (g.dwell > 0) return;

      /* 升档：当前档推力已低于高一档（给一点点提前量，避免正好卡在临界点） */
      if (g.gear < R.length && v >= point(g.gear - 1, boost) * 1.005) {
        shiftTo(g.gear + 1, throttle);
        return;
      }
      /* 降档：留 10% 滞回 */
      if (g.gear > 1 && v <= point(g.gear - 2, boost) * downHyst) {
        shiftTo(g.gear - 1, throttle);
      }
    };

    g.reset = function () {
      g.gear = 1; g.cut = 0; g.dwell = 0;
    };

    return g;
  };
})();
