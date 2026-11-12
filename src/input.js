/* =========================================================================
 * input.js — 白名单按键 / 左为正转向 / CR.autoInput 外部接管口
 * 氮气按键：Input.NITRO_KEY（可一键改成 'KeyN' 或挂触屏按钮，见 setNitroKey）
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var Input = CR.Input = {};
  var USED = {
    KeyW: 1, KeyA: 1, KeyS: 1, KeyD: 1,
    ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1,
    Space: 1, KeyC: 1, KeyR: 1, KeyM: 1, Enter: 1, NumpadEnter: 1,
    ShiftLeft: 1, ShiftRight: 1
  };
  var keys = {}, edges = {};
  Input.USED = USED;
  Input.state = { throttle: 0, brake: 0, steer: 0, handbrake: 0, nitro: 0 };

  /* 触屏持续量：取值与键盘完全同构，read() 里做 OR 合并后写进同一个 state。
     touch.js 只写这里，不碰物理/相机/HUD/音效，桌面端全 0 → 行为零变化。 */
  Input.touch = { throttle: 0, brake: 0, steer: 0, handbrake: 0, nitro: 0 };
  Input.clearTouch = function () {
    var t = Input.touch;
    t.throttle = t.brake = t.steer = t.handbrake = t.nitro = 0;
  };
  /* 一次性动作复用既有的 edges → Input.consume 通道（main.js 无需改动） */
  Input.press = function (code) { if (code) edges[code] = true; };

  /* 氮气键位：一律用 e.code 判断（不用 e.key / shiftKey）。
     默认左右 Shift 都算；改成单键只需 Input.setNitroKey('KeyN')。
     触屏按钮：按住时把 Input.touchNitro 置 1 即可，与键盘等效。 */
  Input.touchNitro = 0;
  Input.NITRO_KEY = ['ShiftLeft', 'ShiftRight'];
  Input.setNitroKey = function (code) {
    var list = (typeof code === 'string') ? [code] : (code || []);
    Input.NITRO_KEY = list.slice();
    for (var i = 0; i < list.length; i++) if (list[i]) USED[list[i]] = 1;
    return Input.NITRO_KEY;
  };

  Input.init = function () {
    window.addEventListener('keydown', function (e) {
      if (USED[e.code]) e.preventDefault();
      if (!keys[e.code] && !e.repeat) edges[e.code] = true;
      keys[e.code] = true;
    }, { passive: false });
    window.addEventListener('keyup', function (e) {
      if (USED[e.code]) e.preventDefault();
      keys[e.code] = false;
    }, { passive: false });
    /* 失焦：清空所有按键与全部触屏按住状态，避免"回到页面还在烧氮气" */
    window.addEventListener('blur', function () {
      keys = {}; edges = {}; Input.touchNitro = 0;
      Input.clearTouch();
      if (CR.Touch && CR.Touch.releaseAll) CR.Touch.releaseAll();
      Input.read();
    });
    Input.ready = true;
  };

  Input.read = function () {
    var s = Input.state, nk = Input.NITRO_KEY, i, n = 0, t = Input.touch;
    s.throttle = ((keys.KeyW || keys.ArrowUp) || t.throttle) ? 1 : 0;
    s.brake = ((keys.KeyS || keys.ArrowDown) || t.brake) ? 1 : 0;
    /* 左为正：A/← = +1，D/→ = -1；触屏同样 +1 左 / -1 右，键盘优先 */
    var ks = ((keys.KeyA || keys.ArrowLeft) ? 1 : 0) - ((keys.KeyD || keys.ArrowRight) ? 1 : 0);
    s.steer = ks || t.steer || 0;
    s.handbrake = (keys.Space || t.handbrake) ? 1 : 0;
    for (i = 0; i < nk.length; i++) if (keys[nk[i]]) n++;
    /* Input.touchNitro 保留为旧的外部接管口，与新的 Input.touch.nitro 等价 */
    s.nitro = (n > 0 || Input.touchNitro || t.nitro) ? 1 : 0;
    return s;
  };
  Input.consume = function (code) {
    if (edges[code]) { edges[code] = false; return true; }
    return false;
  };
})();
