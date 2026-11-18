/* =========================================================================
 * loader.js — 完整加载动画的调度器（零素材、纯 CSS 视觉在 index.html）
 *
 *   · 把 main.js 的一次性同步 start() 拆成「按帧推进」的阶段队列；
 *   · 每执行完一个阶段就更新进度 / 文案，并渲染一帧当前场景（L.preview），
 *     让地形 → 雪山/海 → 公路 → 植被 → 车辆 → 后处理逐步出现在半透明遮罩后面；
 *   · 阶段之间至少让出一帧 + 90ms，保证 CSS 动画与进度条真的能动；
 *   · 全部完成后显示「准备就绪」再淡出，才把控制权交回主循环。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var L = CR.Loader = {};
  L.ready = false;
  L.done = false;
  L.preview = null;                 /* main.js 注入：渲染当前已加载的场景 */

  var el = {}, stages = [], idx = 0, records = [], t0 = 0, finish = null;
  var MIN_TICK = 90;                /* 每阶段最小可见时长（ms） */

  function q(id) { return document.getElementById(id); }

  L.create = function () {
    document.documentElement.classList.add('ld-loading');
    el.root = q('hud-boot');
    el.bar = q('ld-bar');
    el.pct = q('ld-pct');
    el.stage = q('ld-stage');
    if (el.root) el.root.classList.remove('gone', 'error', 'ready');
    L.ready = !!el.root;
    t0 = performance.now();
    L.done = false;
    return L;
  };

  L.setStage = function (i, label) {
    var total = Math.max(1, stages.length);
    var p = Math.round(Math.min(1, i / total) * 100);
    if (el.bar) el.bar.style.width = p + '%';
    if (el.pct) el.pct.textContent = (p < 10 ? '0' : '') + p + '%';
    if (el.stage && label) {
      if (el.stage.textContent !== label) {
        el.stage.classList.remove('flip');
        /* 强制回流，让同一条文案也能重放淡入动画 */
        void el.stage.offsetWidth;
        el.stage.textContent = label;
        el.stage.classList.add('flip');
      }
    }
  };

  function step() {
    if (idx >= stages.length) return complete();
    var s = stages[idx], a = performance.now();
    try { if (s.run) s.run(); } catch (e) { return L.fail(e); }
    var ms = performance.now() - a;
    records.push({ label: s.label, ms: +ms.toFixed(1) });
    idx++;
    L.setStage(idx, idx < stages.length ? stages[idx].label : '准备就绪');
    /* 渲染当前场景：加载期间背景里的世界是逐阶段长出来的 */
    if (L.preview) { try { L.preview(); } catch (e) { /* 预览失败不阻断加载 */ } }
    var wait = Math.max(0, MIN_TICK - ms);
    setTimeout(function () { requestAnimationFrame(step); }, wait);
  }

  function complete() {
    L.done = true;
    L.setStage(stages.length, '准备就绪');
    if (el.root) el.root.classList.add('ready');
    setTimeout(function () {
      document.documentElement.classList.remove('ld-loading');
      if (el.root) el.root.classList.add('gone');
      /* 黑层一开始淡出就启动主循环：开场镜头与黑场淡出同步，不露出默认相机 */
      if (finish) finish();
      setTimeout(function () {
        if (el.root) el.root.style.display = 'none';
      }, 760);
    }, 420);
  }

  L.fail = function (e) {
    L.done = false;
    if (el.root) {
      el.root.className = 'error';
      el.root.innerHTML = '<strong>启动失败</strong><pre></pre>';
      var pre = el.root.querySelector('pre');
      if (pre) pre.textContent = String((e && e.stack) || e);
    }
    if (window.console) console.error('[Coastal]', e);
  };

  L.run = function (list, onDone) {
    stages = list || [];
    idx = 0; records = []; finish = onDone || null;
    L.create();
    L.setStage(0, stages.length ? stages[0].label : '准备中');
    requestAnimationFrame(step);
    return L;
  };

  /* 验收 / 调试口：阶段名、每阶段耗时、总耗时、是否完成 */
  L.diag = function () {
    return {
      done: L.done, stage: idx, total: stages.length,
      elapsed: Math.round(performance.now() - t0),
      records: records.slice()
    };
  };
})();
