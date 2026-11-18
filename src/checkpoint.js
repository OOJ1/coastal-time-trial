/* =========================================================================
 * checkpoint.js — 沿赛道弧长均分的检查点，按顺序逐一通过才算完成一圈
 *
 * · 位置：(k+0.5)/N · L，k=0..N-1，避开起终线（跨线判定不受影响）。
 * · 横向覆盖：CFG.CHECK_LAT_MIN .. CHECK_LAT_MAX，覆盖车辆能走的全部范围
 *   （外侧护栏 -5.8、内侧软限 +10.5，两端各留 2m 余量）。
 * · 判定用「跨越 + 邻域」双保险：正常帧必然跨过窗口；极低帧率或瞬移回退时
 *   邻域兜底，不会因一次大步长跳过而永久卡住。
 * · 每辆车一份状态，换车/重开独立重置。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var CP = CR.Check = {};
  var C = CR.CFG;

  function blank() { return { next: 0, prevS: 0, started: false }; }
  var slots = [blank(), blank()];

  function norm(i) { return ((Number(i) || 0) % 2 + 2) % 2; }
  function gateS(k, L) { return (k + 0.5) * L / C.CHECK_COUNT; }
  function ringDist(a, b, L) {
    var d = Math.abs(a - b);
    return Math.min(d, L - d);
  }

  /* 每帧调用：按当前弧长推进检查点指针 */
  CP.update = function (car, s, lat, L) {
    var k = norm(car), st = slots[k];
    if (!st.started) { st.prevS = s; st.started = true; return st; }
    if (st.next >= C.CHECK_COUNT || !L) { st.prevS = s; return st; }

    var target = gateS(st.next, L);
    var inLat = lat >= C.CHECK_LAT_MIN && lat <= C.CHECK_LAT_MAX;
    /* 正向且步长合理（≤ 窗口宽度×2）才算真实经过；瞬移/抄近道的大跳不计。
       s 回绕（L→0）按环形距离还原成正向小步。 */
    var ds = s - st.prevS;
    if (ds < -L * 0.5) ds += L;           // 跨起线回绕
    /* 最坏情况：15fps 下 71m/s 也只前进 4.7m/帧，48m 上限足够宽松；
       抄近道的瞬移一次跨 500m 以上，必然超过上限被拒。 */
    var forward = ds >= 0 && ds <= C.CHECK_GATE_HALF * 4;
    var crossed = forward && st.prevS <= target + C.CHECK_GATE_HALF &&
                            s >= target - C.CHECK_GATE_HALF;
    var near = forward && ringDist(s, target, L) <= C.CHECK_GATE_HALF;

    if (inLat && (crossed || near)) st.next++;
    st.prevS = s;
    return st;
  };

  CP.passed = function (car) { return slots[norm(car)].next; };
  CP.complete = function (car) { return slots[norm(car)].next >= C.CHECK_COUNT; };
  CP.reset = function (car) { slots[norm(car)] = blank(); };
  CP.resetAll = function () { slots = [blank(), blank()]; };

  CP.lapLimit = function (car) { return C.LAP_LIMIT_MS[norm(car)] || C.LAP_LIMIT_MS[0]; };

  CP.diag = function () {
    return slots.map(function (s) { return { next: s.next, prevS: s.prevS, started: s.started }; });
  };
})();
