/* =========================================================================
 * gearbox.js — MP4/4 专属 6 速变速箱（自动 / 手动可随时切换）
 *
 *   · 仅对当前驾驶 MP4/4（Garage.active===1）生效，原厂车完全不参与。
 *   · 换挡算法在 gearbox-core.js（纯逻辑，浏览器与服务端共用同一份）。
 *     本文件只负责：输入 → 核心、HUD 显示、模式切换与记忆。
 *   · 两种模式：
 *       自动 —— 核心按「相邻档推力交叉点」选档，带 10% 降档滞回 + 0.24s 驻留；
 *       手动 —— 键盘 E 升档 / Q 降档；手柄 A 升档 / X 降档（手刹改到 RB）。
 *   · 切换：键盘 G、手柄 L3（左摇杆按下）、或直接点 HUD 上的「自动/手动」标签。
 *     玩家手动切过一次后，模式以玩家选择为准并写入 localStorage；
 *     从未切过时，接手柄默认手动、没手柄默认自动。
 *   · 换档有 0.12s 断油 + 震动；HUD 会提示升/降档时机。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var G = CR.Gear = {};
  var Core = CR.GearCore;

  G.RATIOS = Core.RATIOS;
  G.ready = false;
  G.visible = false;
  G.userSet = false;      /* 玩家亲手切过模式后，不再跟随手柄连接状态 */
  G.onToggle = null;      /* 切换回调：main.js 用它把模式同步给服务端 */

  var LS_KEY = 'cr.gearMode';
  var core = Core.create({ gear: 3 });

  /* gear / manual 是核心状态的视图；manual 也允许赋值（等价 setManual） */
  Object.defineProperty(G, 'gear', {
    get: function () { return core.gear; },
    enumerable: true
  });
  Object.defineProperty(G, 'manual', {
    get: function () { return core.manual; },
    set: function (on) { G.setManual(on, true); },
    enumerable: true
  });

  var el = null, elNum = null, elHint = null, elTag = null;
  var flashT = 0, msgT = 0, msg = '';

  /* 氮气时每档极速按 NITRO.VMAX / engineVmax 缩放，与 car.js 完全一致 */
  function boostScale() {
    var t = CR.Car && CR.Car.tune;
    var base = (t && t.engineVmax) || 68;
    var vmax = (CR.NITRO && CR.NITRO.VMAX) || base;
    return vmax / base;
  }

  G.spec = function () { return core.spec(); };

  G.isMP44 = function () {
    return !!(CR.Garage && CR.Garage.active === 1 && CR.Car && CR.Car.active === 1);
  };

  /* 切驾驶权瞬间同步档位 HUD 显隐，不等下一帧 */
  G.sync = function () {
    var on = G.isMP44();
    if (G.visible !== on) {
      G.visible = on;
      if (el) el.style.display = on ? '' : 'none';
    }
    if (on) { paint(); paintHint(); }
  };

  G.setManual = function (on, silent) {
    on = !!on;
    if (!core.setManual(on)) return false;
    G.userSet = true;
    try { window.localStorage.setItem(LS_KEY, on ? 'manual' : 'auto'); } catch (e) { /* 隐私模式忽略 */ }
    msg = on ? '手动挡' : '自动挡';
    msgT = 1.4;
    if (!silent && G.onToggle) { try { G.onToggle(on); } catch (e) { /* 联机未连接时忽略 */ } }
    paint();
    return true;
  };
  G.toggle = function () { return G.setManual(!core.manual); };

  function shift(dir) {
    if (!G.isMP44()) return false;
    var st = CR.Car && CR.Car.state;
    var v = st ? st.vf : 0;
    var boost = !!(st && st.nitroActive);
    var ok = dir > 0 ? core.up() : core.down(v, boost);
    if (!ok) return false;
    flashT = 0.55; msgT = 0;
    if (CR.Pad && CR.Pad.buzz) CR.Pad.buzz(0.16, 0.28, 90);
    /* 换档音效：手动档每次换档都响 */
    if (CR.Audio && CR.Audio.shift) CR.Audio.shift(dir);
    paint(); paintHint();
    return true;
  }
  G.up = function () { return shift(1); };
  G.down = function () { return shift(-1); };
  /* 复位 / 重开 / 联机开赛：回到 1 档（手动挡也能干净起步） */
  G.reset = function () {
    core.reset();
    flashT = 0; msgT = 0;
    paint(); paintHint();
  };

  /* input 传当前驾驶输入（main.js 每帧传），用于判断给油 / 滑行 / 手刹 */
  G.step = function (dt, input) {
    if (flashT > 0) flashT = Math.max(0, flashT - dt);
    if (msgT > 0) msgT = Math.max(0, msgT - dt);
    if (!G.isMP44()) {
      if (G.visible) { G.visible = false; if (el) el.style.display = 'none'; }
      return;
    }
    if (!G.visible) { G.visible = true; if (el) el.style.display = ''; }

    /* 从未手动设置过：有手柄默认手动、没手柄默认自动。
       断手柄后自动挡会按当前速度自己找档，不需要手动改档。 */
    if (!G.userSet) {
      var padOn = !!(CR.Pad && CR.Pad.connected);
      if (padOn !== core.manual) {
        core.setManual(padOn);
        if (padOn && Math.abs(CR.Car.state.vf) < 1) core.gear = 1;   /* 静止时切手动从 1 档起步 */
        paint();
      }
    }

    var st = CR.Car.state;
    core.setBoostScale(boostScale());
    core.step(dt, st.vf, {
      throttle: input ? (input.throttle || 0) : 1,
      boost: !!st.nitroActive,
      handbrake: !!(input && input.handbrake)
    });
    paint();
    paintHint();
  };

  function paint() {
    if (!elNum) return;
    var txt = '' + core.gear;
    if (elNum.textContent !== txt) elNum.textContent = txt;
    var cls = 'gear-box' + (flashT > 0 ? ' flash' : '') + (core.manual ? ' manual' : ' auto');
    if (el.className !== cls) el.className = cls;
    if (elTag) {
      var tag = core.manual ? '手动' : '自动';
      if (elTag.textContent !== tag) elTag.textContent = tag;
      elTag.title = core.manual ? '手动挡 · 点此或按 G 切回自动' : '自动挡 · 点此或按 G 切到手动';
    }
  }

  function paintHint() {
    if (!elHint) return;
    var st = CR.Car.state, vf = Math.abs(st.vf), boost = !!st.nitroActive;
    var txt = '';
    if (msgT > 0) txt = msg;
    else if (core.manual) {
      if (core.gear < Core.RATIOS.length && vf >= core.shiftPoint(core.gear - 1, boost) * 0.97) txt = '↑ 升档';
      else if (core.gear > 1 && vf <= core.shiftPoint(core.gear - 2, boost) * 0.90) txt = '↓ 降档';
    } else {
      txt = 'G 切换';
    }
    if (elHint.textContent !== txt) elHint.textContent = txt;
  }

  G.diag = function () {
    return {
      gear: core.gear, manual: core.manual, cut: +core.cut.toFixed(3),
      dwell: +core.dwell.toFixed(3), shifts: core.shifts, userSet: G.userSet,
      boostScale: +boostScale().toFixed(4)
    };
  };

  G.init = function () {
    var style = document.createElement('style');
    style.textContent = [
      '.gear-box{position:absolute;right:200px;bottom:150px;z-index:20;display:flex;',
      'align-items:baseline;gap:7px;pointer-events:none;color:#eef1f5;padding:5px 10px;',
      'border-radius:10px;background:rgba(12,16,24,.42);border:1px solid rgba(255,255,255,.12);',
      '-webkit-backdrop-filter:blur(5px);backdrop-filter:blur(5px);',
      'font:12px/1 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;',
      'text-shadow:0 2px 8px rgba(0,0,0,.8);transition:opacity .2s ease}',
      '.gear-box .gear-tag{pointer-events:auto;cursor:pointer;user-select:none;',
      'font-size:9px;letter-spacing:.16em;opacity:.62;padding:2px 5px;border-radius:5px;',
      'border:1px solid rgba(255,255,255,.18);transition:border-color .15s,opacity .15s}',
      '.gear-box .gear-tag:hover{opacity:1;border-color:#e8a24a}',
      '.gear-box.manual .gear-tag{color:#ffcf8b;border-color:rgba(232,162,74,.55);opacity:.9}',
      '.gear-box .gear-num{font-size:30px;font-weight:300;letter-spacing:.02em;',
      'font-variant-numeric:tabular-nums;transition:transform .12s ease,color .12s ease}',
      '.gear-box .gear-lab{font-size:9px;letter-spacing:.12em;opacity:.62}',
      '.gear-box .gear-hint{min-width:52px;font-size:10px;color:#ffcf8b;letter-spacing:.06em}',
      '.gear-box.flash .gear-num{transform:scale(1.22);color:#ffcf8b}',
      '@media (max-width:820px){.gear-box{right:150px;bottom:100px}.gear-box .gear-num{font-size:22px}}'
    ].join('');
    document.head.appendChild(style);

    el = document.createElement('div');
    el.className = 'gear-box';
    el.style.display = 'none';
    el.innerHTML = '<span class="gear-tag" role="button">自动</span><span class="gear-num">3</span>' +
                   '<span class="gear-lab">档</span><span class="gear-hint"></span>';
    document.body.appendChild(el);
    elNum = el.querySelector('.gear-num');
    elHint = el.querySelector('.gear-hint');
    elTag = el.querySelector('.gear-tag');
    if (elTag) {
      elTag.addEventListener('click', function (e) {
        e.preventDefault();
        G.toggle();
        /* 点完把焦点还给页面，别让空格/回车误触按钮 */
        try { elTag.blur(); } catch (err) {}
      });
    }

    /* 记忆上次选择；没有记录时按「有没有手柄」在 step 里给默认值 */
    try {
      var saved = window.localStorage.getItem(LS_KEY);
      if (saved === 'manual' || saved === 'auto') {
        core.setManual(saved === 'manual');
        G.userSet = true;
      }
    } catch (e) { /* 忽略 */ }
    core.reset();               /* 起步统一 1 档 */

    G.ready = true;
    paint();
    return G;
  };
})();
