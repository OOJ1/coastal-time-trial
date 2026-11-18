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
    Space: 1, KeyC: 1, KeyR: 1, KeyM: 1, KeyF: 1, Enter: 1, NumpadEnter: 1,
    KeyV: 1,                       /* 单机换车 */
    KeyE: 1, KeyQ: 1, KeyG: 1,
    ShiftLeft: 1, ShiftRight: 1
  };
  var keys = {}, edges = {};
  Input.USED = USED;
  Input.state = { throttle: 0, brake: 0, steer: 0, handbrake: 0, nitro: 0 };

  /* 触屏持续量：取值与键盘完全同构，read() 里做 OR 合并后写进同一个 state。
     touch.js 只写这里，不碰物理/相机/HUD/音效，桌面端全 0 → 行为零变化。 */
  Input.touch = { throttle: 0, brake: 0, steer: 0, handbrake: 0, nitro: 0 };

  /* 手柄持续量（gamepad.js 写）：throttle / brake 是 0..1 的模拟量，
     steer 是 -1..+1（左为正），handbrake / nitro 仍是 0|1。
     没接手柄时全 0，read() 里与键盘、触屏取最大值合并 → 三种输入共用同一套物理。 */
  Input.pad = { throttle: 0, brake: 0, steer: 0, handbrake: 0, nitro: 0 };
  Input.clearPad = function () {
    var p = Input.pad;
    p.throttle = p.brake = p.steer = p.handbrake = p.nitro = 0;
  };
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
    /* 焦点在输入框（房号 / 昵称）时不能抢键：房号是 6 位字母，
       W/A/S/D/C/R/M/F/G/E/Q/V 全在本项目的按键表里，不隔离的话
       preventDefault 会把字符直接吞掉 —— 表现为「房间号打不进去」。 */
    function isTyping(e) {
      var t = e && e.target;
      if (!t || t === document || t === window) return false;
      var tag = (t.tagName || '').toUpperCase();
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
    }
    window.addEventListener('keydown', function (e) {
      if (isTyping(e)) return;                 /* 只放行，不记录、不拦截 */
      if (USED[e.code]) e.preventDefault();
      if (!keys[e.code] && !e.repeat) edges[e.code] = true;
      keys[e.code] = true;
    }, { passive: false });
    window.addEventListener('keyup', function (e) {
      /* 这里不能因为焦点在输入框就跳过：否则「按着 W 点进输入框再松手」
         会让 keys[KeyW] 永远停在 true，车一路加速。只清状态，不拦截。 */
      if (!isTyping(e) && USED[e.code]) e.preventDefault();
      keys[e.code] = false;
    }, { passive: false });
    /* 失焦：清空所有按键与全部触屏/手柄按住状态，避免"回到页面还在烧氮气" */
    window.addEventListener('blur', function () {
      keys = {}; edges = {}; Input.touchNitro = 0;
      Input.clearTouch();
      if (Input.clearPad) Input.clearPad();
      if (CR.Touch && CR.Touch.releaseAll) CR.Touch.releaseAll();
      Input.read();
    });
    Input.ready = true;
  };

  Input.read = function () {
    var s = Input.state, nk = Input.NITRO_KEY, i, n = 0, t = Input.touch, p = Input.pad;
    /* 键盘是 0|1，手柄扳机是 0..1：取最大值合并，数字输入仍等价于原来的 OR */
    s.throttle = Math.max((keys.KeyW || keys.ArrowUp) ? 1 : 0, t.throttle || 0, p.throttle || 0);
    s.brake = Math.max((keys.KeyS || keys.ArrowDown) ? 1 : 0, t.brake || 0, p.brake || 0);
    /* 左为正：A/← = +1，D/→ = -1；触屏 +1 左 / -1 右；手柄是连续量。
       优先级：键盘（数字、绝对）> 摇杆/触屏（谁偏得多听谁的）。 */
    var ks = ((keys.KeyA || keys.ArrowLeft) ? 1 : 0) - ((keys.KeyD || keys.ArrowRight) ? 1 : 0);
    if (ks) s.steer = ks;
    else s.steer = (Math.abs(p.steer || 0) > Math.abs(t.steer || 0)) ? (p.steer || 0) : (t.steer || 0);
    s.handbrake = (keys.Space || t.handbrake || p.handbrake) ? 1 : 0;
    for (i = 0; i < nk.length; i++) if (keys[nk[i]]) n++;
    /* Input.touchNitro 保留为旧的外部接管口，与新的 Input.touch.nitro 等价 */
    s.nitro = (n > 0 || Input.touchNitro || t.nitro || p.nitro) ? 1 : 0;
    return s;
  };
  Input.consume = function (code) {
    if (edges[code]) { edges[code] = false; return true; }
    return false;
  };
})();
