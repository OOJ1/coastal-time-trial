/* =========================================================================
 * touch.js — 触屏控制层（第 20 个经典 script）
 *
 * 职责只有一件：把 DOM 上的「按住 / 点击」翻译成 Input.touch 与 Input.press。
 * 物理、相机、HUD、音效、圈速、后处理一律不碰；触屏取值与键盘完全同构
 * （throttle / brake / nitro / handbrake = 0|1，steer = -1|0|+1，左为正），
 * 因此桌面与移动共用同一套 Input.read() → Car.step，手感与规则完全一致。
 *
 * 一次性动作（视角/复位/重开/音效）走既有的 edges → Input.consume 通道，
 * main.js 一行都不用改，也不会产生第二套状态源。
 *
 * 兼容：PointerEvent（iOS 13+ / Android Chrome / 现代 WebView）优先，
 *       Touch Events（旧 Android WebView / 老 iOS Safari）兜底；
 *       多指用 pointerId / touch identifier 引用计数，任何一指抬起都不会
 *       误清掉另一指仍按住的油门。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var Touch = CR.Touch = {};
  var Input = CR.Input;

  var root = null, enabled = false;
  var held = { left: 0, right: 0, gas: 0, brake: 0, nitro: 0, drift: 0 };
  var pointers = {};          /* id -> { act, el } */

  /* 是否「以触摸为主输入」的设备。
     关键：不能用 `maxTouchPoints > 0` / `'ontouchstart' in window` 当主判据 ——
     带触摸屏的 Win 笔记本、某些桌面 Chrome 也会满足这两条，结果桌面上凭空多出
     一排手机按钮。以 `(pointer: coarse)`（主指针是否粗指针）为准：
     · 手机 / 平板：主指针就是手指 → coarse=true；
     · 触屏笔记本：鼠标是主指针 → fine=true、coarse=false（即使有触摸屏）。 */
  function isTouch() {
    try {
      if (window.matchMedia) {
        /* 手指是主输入（手机 / 平板） */
        if (window.matchMedia('(pointer: coarse)').matches) return true;
        /* 鼠标是主输入 → 桌面，即使机器带触摸屏也绝不能显示手机按钮 */
        if (window.matchMedia('(pointer: fine)').matches) return false;
        /* 极少数设备只有触摸、没有 fine/coarse 信息 */
        var none = window.matchMedia('(pointer: none)');
        var anyCoarse = window.matchMedia('(any-pointer: coarse)');
        if (none.matches && anyCoarse.matches) return true;
      }
    } catch (e) { /* 老浏览器没有 matchMedia，走下面的能力检测 */ }
    /* 老浏览器兜底：必须有触摸能力，且真的是小屏（不是桌面窗口缩小） */
    var w = window.innerWidth || 9999, h = window.innerHeight || 9999;
    return (('ontouchstart' in window) || (navigator.maxTouchPoints > 0)) && Math.min(w, h) < 600;
  }

  function sync() {
    if (!Input || !Input.touch) return;
    var t = Input.touch;
    t.throttle = held.gas > 0 ? 1 : 0;
    t.brake = held.brake > 0 ? 1 : 0;
    t.steer = (held.left > 0 ? 1 : 0) - (held.right > 0 ? 1 : 0);  /* 左为正，与 A/← 一致 */
    t.handbrake = held.drift > 0 ? 1 : 0;
    t.nitro = held.nitro > 0 ? 1 : 0;
  }

  function down(act, id, el) {
    if (!(act in held) || pointers[id]) return;
    pointers[id] = { act: act, el: el };
    held[act]++;
    if (el) el.classList.add('down');
    sync();
  }

  function up(id) {
    var p = pointers[id];
    if (!p) return;
    delete pointers[id];
    held[p.act] = Math.max(0, held[p.act] - 1);
    if (held[p.act] === 0 && p.el) p.el.classList.remove('down');
    sync();
  }

  /* 失焦 / 进后台 / 验收脚本复位：把所有按住状态与按钮高亮一次性清干净 */
  Touch.releaseAll = function () {
    for (var k in held) if (held.hasOwnProperty(k)) held[k] = 0;
    for (var id in pointers) {
      if (pointers.hasOwnProperty(id) && pointers[id].el) pointers[id].el.classList.remove('down');
    }
    pointers = {};
    if (Input && Input.clearTouch) Input.clearTouch();
  };

  function bind(el) {
    var act = el.getAttribute('data-act');
    var key = el.getAttribute('data-key');
    if (!act && !key) return;

    if (window.PointerEvent) {
      el.addEventListener('pointerdown', function (e) {
        e.preventDefault();                       /* 不滚动、不缩放、不弹长按菜单 */
        if (key) { if (Input) Input.press(key); return; }
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* 老 WebView 没有 */ }
        down(act, 'p' + e.pointerId, el);
      }, { passive: false });
      el.addEventListener('pointerup', function (e) { up('p' + e.pointerId); }, { passive: false });
      el.addEventListener('pointercancel', function (e) { up('p' + e.pointerId); }, { passive: false });
      el.addEventListener('lostpointercapture', function (e) { up('p' + e.pointerId); }, { passive: false });
    } else {
      /* Touch Events 兜底：changedTouches 逐个记账，支持多指同按 */
      el.addEventListener('touchstart', function (e) {
        e.preventDefault();
        if (key) { if (Input) Input.press(key); return; }
        for (var i = 0; i < e.changedTouches.length; i++) {
          down(act, 't' + e.changedTouches[i].identifier, el);
        }
      }, { passive: false });
      var end = function (e) {
        e.preventDefault();
        for (var i = 0; i < e.changedTouches.length; i++) {
          up('t' + e.changedTouches[i].identifier);
        }
      };
      el.addEventListener('touchend', end, { passive: false });
      el.addEventListener('touchcancel', end, { passive: false });
    }
    /* 极旧的 WebView 只发鼠标事件时也能用；桌面 pointer:fine 下控件是隐藏的 */
    el.addEventListener('mousedown', function (e) {
      if (window.PointerEvent || key) return;
      down(act, 'm', el);
    });
    el.addEventListener('mouseup', function () { if (!window.PointerEvent) up('m'); });
  }

  Touch.init = function () {
    root = document.getElementById('touch-ui');
    if (!root) { Touch.ready = true; return Touch; }
    enabled = isTouch();
    /* 绑定一次就够：按钮默认 display:none，桌面不会触发；即使运行中切成触屏也直接可用。 */
    var els = root.querySelectorAll('[data-act],[data-key]');
    for (var i = 0; i < els.length; i++) bind(els[i]);
    /* 全局保险：指针在按钮外抬起 / 被系统取消，也要释放，避免油门卡住 */
    if (window.PointerEvent) {
      window.addEventListener('pointerup', function (e) { up('p' + e.pointerId); });
      window.addEventListener('pointercancel', function (e) { up('p' + e.pointerId); });
    }
    window.addEventListener('blur', Touch.releaseAll);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) Touch.releaseAll();
    });
    /* 显示与否只由 class 控制。
       媒体查询变化时（旋转屏 / 外接鼠标 / 设备切换）同步更新，
       避免桌面被误判后一直留着手机按钮。 */
    function applyMode() {
      enabled = isTouch();
      document.documentElement.classList.toggle('tc-on', enabled);
      if (!enabled && Input && Input.touch) {
        /* 从触屏切回桌面时别把按住的油门/刹车留在输入里 */
        Input.clearTouch();
        Touch.releaseAll();
      }
    }
    applyMode();
    try {
      var mq = window.matchMedia('(pointer: coarse)');
      if (mq.addEventListener) mq.addEventListener('change', applyMode);
      else if (mq.addListener) mq.addListener(applyMode);
    } catch (e) {}
    window.addEventListener('resize', applyMode);

    Touch.ready = true;
    return Touch;
  };

  /* 只读诊断口：无头验收可以直接核对「按住 → 状态」的映射 */
  Touch.diag = function () {
    return {
      enabled: enabled, ready: !!Touch.ready,
      held: { left: held.left, right: held.right, gas: held.gas,
              brake: held.brake, nitro: held.nitro, drift: held.drift },
      state: (Input && Input.touch) ? {
        throttle: Input.touch.throttle, brake: Input.touch.brake, steer: Input.touch.steer,
        handbrake: Input.touch.handbrake, nitro: Input.touch.nitro
      } : null
    };
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', Touch.init);
  else Touch.init();
})();
