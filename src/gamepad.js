/* =========================================================================
 * gamepad.js — Xbox / 标准手柄（Gamepad API，"standard" 映射）
 *
 * 职责只有一件：把摇杆 / 扳机 / 按键翻译成 CR.Input.pad 与 Input.press()。
 * 与 touch.js 完全同构 —— 物理、相机、HUD、音效、圈速、后处理一行都不用改。
 *
 *   RT 右扳机 → 油门（0..1 模拟量，轻踩就是小油门）
 *   LT 左扳机 → 刹车 / 倒车（0..1 模拟量）
 *   左摇杆 X  → 转向（左为正，死区 + 指数曲线，中心附近更细腻）
 *   十字键    → 转向 / 油门 / 刹车 的数字兜底
 *   A / RB    → 手刹漂移        B / LB → 氮气
 *   Y → 切视角   X、START → 原地复位   BACK → 音效开关
 *   MP4/4 手动挡：A 升档 / X 降档 / RB 手刹；L3 切换自动 ⇄ 手动
 *
 * 撞击（CR.Audio.hit）与氮气点火会顺带给一点点震动：CR.Pad.settings.rumble = false 可关。
 * 采样挂在 Input.read 之前（main.js 每帧调用一次），不新增 rAF，零额外延迟。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  if (!CR || !CR.Input) return;
  var Input = CR.Input;
  var Pad = CR.Pad = {};

  /* 手感参数：都在这里改 */
  Pad.settings = {
    stickDeadzone: 0.14,   /* 摇杆死区（百分比） */
    triggerDeadzone: 0.05, /* 扳机死区：轻碰不喷油 */
    expo: 1.35,            /* 转向曲线指数：1 = 线性，越大中心越细腻 */
    buttonThreshold: 0.5,  /* 数字按钮的按下判定 */
    rumble: true           /* 撞击 / 氮气震动 */
  };

  Pad.connected = false;
  Pad.active = false;
  Pad.name = '';
  Pad.pad = null;

  var getId = function (id) { return document.getElementById(id); };
  var prev = [];          /* 上一帧各按钮的按下状态（做边沿） */
  var idle = true;        /* 还没收到任何手柄输入 → 第一次按键时唤醒页面 */
  var badgeTimer = 0;

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }

  /* 死区 + 线性重映射：出死区从 0 平滑起，满量程仍是 1 */
  function dead(v, dz) {
    var a = Math.abs(v);
    if (a <= dz) return 0;
    var k = (a - dz) / (1 - dz);
    return (v < 0 ? -1 : 1) * (k > 1 ? 1 : k);
  }
  /* 指数曲线：中心附近细、满舵不变 */
  function expo(v) {
    var a = Math.abs(v);
    return (v < 0 ? -1 : 1) * Math.pow(a, Pad.settings.expo);
  }

  /* 优先取 "standard" 映射的那只手柄（Xbox 就是 standard），否则退回第一只 */
  function pick() {
    if (!navigator.getGamepads) return null;
    var pads, i, g, fallback = null;
    try { pads = navigator.getGamepads(); } catch (e) { return null; }
    if (!pads) return null;
    for (i = 0; i < pads.length; i++) {
      g = pads[i];
      if (!g || !g.connected) continue;
      if (g.mapping === 'standard') return g;
      if (!fallback) fallback = g;
    }
    return fallback;
  }

  function buzz(strong, weak, ms) {
    if (!Pad.settings.rumble || !Pad.pad || !Pad.pad.vibrationActuator) return;
    var p;
    try {
      p = Pad.pad.vibrationActuator.playEffect('dual-rumble', {
        duration: ms || 150, startDelay: 0,
        strongMagnitude: clamp01(strong), weakMagnitude: clamp01(weak)
      });
    } catch (e) { return; }
    if (p && p.catch) p.catch(function () {});
  }

  /* 第一次按键：撤掉启动遮罩 / iframe 里的"点击开始"层，别让鼠标继续被挡 */
  function wake() {
    try { window.focus(); } catch (e) {}
    var boot = getId('hud-boot');
    if (boot && boot.className !== 'error') boot.className = 'gone';
    var tap = getId('embed-tap');
    if (tap && tap.parentNode) tap.parentNode.removeChild(tap);
  }

  function shortName(id) {
    var s = String(id || '');
    if (/xbox/i.test(s)) return 'XBOX';
    if (/dualsense|dualshock|playstation|ps[345]/i.test(s)) return 'PS';
    if (/switch|joy-?con|pro controller/i.test(s)) return 'SWITCH';
    return '手柄';
  }

  function setConnected(on) {
    Pad.connected = !!on;
    if (!on) {
      Pad.pad = null;
      if (Input.clearPad) Input.clearPad();
      prev = [];
    }
    var badge = getId('pad-badge');
    var keys = getId('pad-keys');
    if (on) {
      if (keys) keys.hidden = false;
      if (badge) {
        badge.textContent = shortName(Pad.name) + ' 手柄已连接';
        badge.classList.add('on');
        clearTimeout(badgeTimer);
        badgeTimer = setTimeout(function () { badge.classList.remove('on'); }, 5200);
      }
      buzz(0.14, 0.22, 130);
    } else {
      if (keys) keys.hidden = true;
      if (badge) { clearTimeout(badgeTimer); badge.classList.remove('on'); }
      Pad.active = false;
    }
  }

  /* 撞击震动：包一层 Audio.hit，不改 main.js */
  /* 供变速箱换档时给一下短震 */
  Pad.buzz = buzz;

  function hookHit() {
    var A = CR.Audio;
    if (!A || A.__padHooked || typeof A.hit !== 'function') return;
    var base = A.hit;
    A.hit = function (acc) {
      var a = num(acc);
      buzz(0.3 + Math.min(0.6, a / 22), 0.22 + Math.min(0.5, a / 30), 170);
      return base.apply(A, arguments);
    };
    A.__padHooked = true;
  }

  var prevNitro = false;

  function poll() {
    var g = pick();
    if (!g) {
      if (Pad.connected) setConnected(false);
      return;
    }
    if (g.id && g.id !== Pad.name) Pad.name = g.id;
    Pad.pad = g;
    if (!Pad.connected) setConnected(true);
    Pad.active = true;

    var b = g.buttons || [], ax = g.axes || [];
    var S = Pad.settings;

    function val(i) {
      var k = b[i];
      if (!k) return 0;
      return (typeof k.value === 'number') ? k.value : (k.pressed ? 1 : 0);
    }
    function down(i) {
      var k = b[i];
      if (!k) return false;
      return !!k.pressed || val(i) > S.buttonThreshold;
    }
    /* 边沿：只在"这一帧按下、上一帧没按"时返回 true */
    function rise(i) {
      var on = down(i), was = !!prev[i];
      prev[i] = on;
      return on && !was;
    }

    /* 首次按键 → 唤醒（任何键都算，含扳机） */
    if (idle) {
      for (var wi = 0; wi < b.length; wi++) {
        if (down(wi)) { idle = false; wake(); break; }
      }
    }

    /* ---- 持续量 ---- */
    /* 少数驱动只给 pressed 不给 value：兜底按满量程算，别让油门"按下去不动" */
    var rtRaw = num(val(7)), ltRaw = num(val(6));
    if (!rtRaw && b[7] && b[7].pressed) rtRaw = 1;
    if (!ltRaw && b[6] && b[6].pressed) ltRaw = 1;
    var throttle = clamp01(dead(rtRaw, S.triggerDeadzone));                     /* RT */
    var brake = clamp01(dead(ltRaw, S.triggerDeadzone));                        /* LT */
    /* 摇杆往左（axes[0] 为负）= 左转；本游戏左为正，所以取反后再套曲线 */
    var steer = expo(-dead(num(ax[0]), S.stickDeadzone));                       /* 左摇杆 X */

    /* 十字键（数字兜底）：直接顶满，和摇杆取更强的那个 */
    if (down(12)) throttle = 1;                    /* ↑ */
    if (down(13)) brake = 1;                       /* ↓ */
    if (down(14)) steer = 1;                       /* ← 左 = +1 */
    if (down(15)) steer = -1;                      /* → 右 = -1 */

    /* MP4/4 的按键分配随「自动 / 手动」变化：
       手动 —— A 升档 / X 降档 / RB 手刹；
       自动 —— A 手刹 / RB 手刹，X 留空（避免误触复位）。
       L3（左摇杆按下）随时切换自动 ⇄ 手动；原厂车 A 手刹 / X 复位不变。 */
    var isMP = !!(CR.Gear && CR.Gear.ready && CR.Gear.isMP44());
    var manual = !!(isMP && CR.Gear.manual);
    var handbrake = ((manual ? 0 : down(0)) || down(5)) ? 1 : 0;  /* A(自动/原厂) / RB */
    var nitro = (down(1) || down(4)) ? 1 : 0;      /* B / LB */

    var p = Input.pad;
    p.throttle = throttle; p.brake = brake; p.steer = steer;
    p.handbrake = handbrake; p.nitro = nitro;

    /* ---- 一次性动作：走既有 edges → Input.consume 通道 ---- */
    if (rise(3)) Input.press('KeyC');                                  /* Y 视角 */
    if (rise(2)) {                                                    /* X：手动降档 / 原厂复位 */
      if (manual) CR.Gear.down(); else if (!isMP) Input.press('KeyR');
    }
    if (manual && rise(0)) CR.Gear.up();                              /* A：手动升档（自动挡下是手刹） */
    if (isMP && rise(10)) {                                           /* L3：自动 ⇄ 手动 */
      CR.Gear.toggle();
      if (Pad.buzz) Pad.buzz(0.12, 0.22, 70);
    }
    if (rise(9)) Input.press('KeyR');                                  /* START 复位 */
    if (rise(8)) Input.press('KeyM');                                  /* BACK 音效 */
    if (rise(11)) Input.press('KeyF');                                 /* R3 右摇杆按下 视角面板 */

    /* 氮气点火：给一下短震，不提速、不改物理 */
    if (nitro > 0 && !prevNitro) buzz(0.1, 0.34, 200);
    prevNitro = nitro > 0;

    hookHit();
  }

  /* 采样挂在 Input.read 之前：main.js 每帧读一次，物理拿到的就是本帧的手柄状态 */
  var read = Input.read;
  Input.read = function () { poll(); return read(); };

  if (window.addEventListener) {
    window.addEventListener('gamepadconnected', function (e) {
      /* 事件先到、帧后到：这里只做即时反馈，状态仍以 poll 为准 */
      if (e && e.gamepad && e.gamepad.id) Pad.name = e.gamepad.id;
    });
    window.addEventListener('gamepaddisconnected', function () {
      Pad.name = '';
      setConnected(false);
    });
  }

  Pad.poll = poll;
  /* 只读诊断口：无头验收可以直接核对"手柄 → state"的映射 */
  Pad.diag = function () {
    var p = Input.pad;
    return {
      connected: Pad.connected, name: Pad.name,
      pad: {
        throttle: p.throttle, brake: p.brake, steer: p.steer,
        handbrake: p.handbrake, nitro: p.nitro
      },
      state: {
        throttle: Input.state.throttle, brake: Input.state.brake, steer: Input.state.steer,
        handbrake: Input.state.handbrake, nitro: Input.state.nitro
      }
    };
  };
  Pad.ready = true;
})();
