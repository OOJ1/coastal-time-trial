/* =========================================================================
 * fpview.js — 第一人称视角调节面板
 *
 * 相机参数集中在 Cam.fp（camera.js 读它），本模块只负责 UI / 持久化：
 *   · 快捷键 F / 手柄 R3(右摇杆按下) / 触屏「调视角」按钮 开关面板
 *   · 拖动滑块即时生效，设置写 localStorage，刷新后仍在
 *   · 「恢复默认」一键还原；不影响追车 / 远景两档
 * 面板 DOM 与样式由本模块动态注入，两个 HTML 只需引入本脚本。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var V = CR.FPView = {};
  var KEY = 'coastal.fpview.v1';
  V.open = false;
  V.panel = null;

  /* 参数定义：key / 显示名 / 范围 / 步长 / 默认值 / 单位 / 说明 */
  var FIELDS = [
    { k: 'eyeHeight', n: '眼高',       min: 0.5,  max: 2.5,  step: 0.01, def: 1.18, u: 'm',  d: '驾驶位视点离车底的高度' },
    { k: 'side',      n: '左右位置',   min: -0.8, max: 0.8,  step: 0.01, def: 0.33, u: 'm',  d: '正=左舵，负=右舵，0=居中' },
    { k: 'forward',   n: '前后位置',   min: -0.8, max: 2.0,  step: 0.01, def: 0.35, u: 'm',  d: '往前可避开风挡框，往后能看到车头' },
    { k: 'pitch',     n: '视线俯仰',   min: -12,  max: 12,   step: 0.1,  def: -0.5, u: '°',  d: '负=低头看路面，正=抬头看远处' },
    { k: 'fov',        n: '基础视野',   min: 45,   max: 100,  step: 1,    def: 68,   u: '°',  d: '静止时的 FOV，速度越快会再自动加宽' },
    { k: 'fovSpeed',  n: '速度视野',   min: 0,    max: 25,   step: 0.5,  def: 10,   u: '°',  d: '极速时额外增加的 FOV' },
    { k: 'fovBoost',   n: '氮气视野',   min: 0,    max: 20,   step: 0.5,  def: 7,    u: '°',  d: '点氮气时的额外 FOV' },
    { k: 'roll',       n: '过弯侧倾',   min: 0,    max: 0.25, step: 0.005,def: 0.08, u: '',   d: '随横摆角速度的镜头滚转强度' },
    { k: 'lookAhead',  n: '视线距离',   min: 8,    max: 80,   step: 1,    def: 30,   u: 'm',  d: '看向车头前方多远处' },
    { k: 'near',       n: '近平面裁剪', min: 0.01, max: 1,    step: 0.01, def: 0.25, u: 'm',  d: '越小看到越多近处车身；太大车头会被切掉' }
  ];

  function defaults() {
    var o = {};
    FIELDS.forEach(function (f) { o[f.k] = f.def; });
    return o;
  }
  V.defaults = defaults;

  function clampField(f, v) {
    v = Number(v);
    if (!isFinite(v)) return f.def;
    return Math.max(f.min, Math.min(f.max, v));
  }

  V.load = function () {
    var fp = CR.Cam.fp, o = defaults();
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        FIELDS.forEach(function (f) {
          if (saved && typeof saved[f.k] === 'number') o[f.k] = clampField(f, saved[f.k]);
        });
      }
    } catch (e) { /* 隐私模式 / 禁用存储：用默认值，不影响游戏 */ }
    FIELDS.forEach(function (f) { fp[f.k] = o[f.k]; });
  };
  V.save = function () {
    try { localStorage.setItem(KEY, JSON.stringify(CR.Cam.fp)); } catch (e) {}
  };
  V.reset = function () {
    var d = defaults();
    FIELDS.forEach(function (f) { CR.Cam.fp[f.k] = d[f.k]; });
    V.save(); syncSliders();
  };

  var sliderEls = {};
  function syncSliders() {
    FIELDS.forEach(function (f) {
      var row = sliderEls[f.k];
      if (!row) return;
      row.input.value = CR.Cam.fp[f.k];
      row.val.textContent = format(f, CR.Cam.fp[f.k]);
    });
  }
  function format(f, v) {
    var s = (f.step < 0.01) ? v.toFixed(3) : (f.step < 1 ? v.toFixed(2) : v.toFixed(1));
    return s + (f.u ? ' ' + f.u : '');
  }

  function buildPanel() {
    var style = document.createElement('style');
    style.textContent = [
      '#fpv-panel{position:absolute;right:18px;top:56px;z-index:40;width:288px;max-height:calc(100vh - 72px);',
      'overflow-y:auto;box-sizing:border-box;padding:12px 15px 10px;border-radius:14px;',
      'background:rgba(12,16,24,.88);border:1px solid rgba(255,255,255,.18);',
      '-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);color:#eef1f5;',
      'font:12px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;',
      'box-shadow:0 12px 40px rgba(0,0,0,.45);display:none}',
      '#fpv-panel.on{display:block}',
      '#fpv-panel h3{margin:0 0 3px;font-size:13px;font-weight:600;letter-spacing:.08em}',
      '#fpv-panel .fpv-sub{opacity:.6;font-size:10px;margin-bottom:12px;letter-spacing:.04em}',
      '.fpv-row{margin-bottom:7px}',
      '.fpv-row .fpv-lab{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:3px}',
      '.fpv-row .fpv-lab b{font-weight:500}',
      '.fpv-row .fpv-lab i{font-style:normal;opacity:.85;color:#ffcf8b;font-variant-numeric:tabular-nums}',
      '.fpv-row .fpv-tip{opacity:.45;font-size:9.5px;margin-top:2px}',
      '.fpv-row input[type=range]{width:100%;height:16px;margin:0;accent-color:#e8a24a;cursor:pointer}',
      '#fpv-panel .fpv-btns{display:flex;gap:8px;margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.12)}',
      '#fpv-panel .fpv-btns button{flex:1;padding:7px 4px;font:11px/1 inherit;color:#fff;cursor:pointer;',
      'background:rgba(255,255,255,.09);border:1px solid rgba(255,255,255,.2);border-radius:8px}',
      '#fpv-panel .fpv-btns button:hover{background:rgba(232,162,74,.32)}',
      '#fpv-toggle-hint{opacity:.55;font-size:9.5px;margin-top:8px;text-align:center}'
    ].join('');
    document.head.appendChild(style);

    var p = document.createElement('div');
    p.id = 'fpv-panel';
    var html = '<h3>第一人称视角调节</h3><div class="fpv-sub">按 C 切到「第一人称」后生效 · 拖动即时预览</div>';
    FIELDS.forEach(function (f) {
      html += '<div class="fpv-row"><div class="fpv-lab"><b>' + f.n + '</b><i data-v="' + f.k + '"></i></div>' +
              '<input type="range" data-k="' + f.k + '" min="' + f.min + '" max="' + f.max +
              '" step="' + f.step + '"><div class="fpv-tip">' + f.d + '</div></div>';
    });
    html += '<div class="fpv-btns"><button id="fpv-reset">恢复默认</button><button id="fpv-close">关闭面板</button></div>' +
            '<div id="fpv-toggle-hint">F / 手柄 R3 / 触屏「调视角」开关</div>';
    p.innerHTML = html;
    document.body.appendChild(p);
    V.panel = p;

    FIELDS.forEach(function (f) {
      var input = p.querySelector('input[data-k="' + f.k + '"]');
      var val = p.querySelector('i[data-v="' + f.k + '"]');
      sliderEls[f.k] = { input: input, val: val };
      input.addEventListener('input', function () {
        var v = clampField(f, input.value);
        CR.Cam.fp[f.k] = v;
        val.textContent = format(f, v);
        V.save();
      });
      /* 滑块聚焦时方向键归滑块，不要把油门/转向也一起触发 */
      input.addEventListener('keydown', function (e) { e.stopPropagation(); });
    });
    p.querySelector('#fpv-reset').addEventListener('click', V.reset);
    p.querySelector('#fpv-close').addEventListener('click', function () { V.setOpen(false); });
  }

  V.setOpen = function (on) {
    V.open = !!on;
    if (V.panel) V.panel.classList.toggle('on', V.open);
    if (V.open) syncSliders();
  };
  V.toggle = function () { V.setOpen(!V.open); return V.open; };

  V.init = function () {
    if (!CR.Cam || !CR.Cam.fp) return V;
    V.load();
    buildPanel();
    V.ready = true;
    return V;
  };
})();
