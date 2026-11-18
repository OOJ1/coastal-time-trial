/* =========================================================================
 * carselect.js — 开局前的独立选车界面
 *   · 并排显示两辆车的 3D 模型（复用游戏内 root 的克隆，独立材质染色）
 *   · 左右两列显示两车的真实调校数值（从 CR.Car.TUNES 读取）
 *   · 10 秒倒计时，超时自动确认当前选中项；默认选中第二辆车（MP4/4）
 *   · 确认后回调调用方（单机 → 开场镜头；联机 → 房间准备流程）
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var S = CR.CarSelect = {};
  var LIMIT = 10, limit = LIMIT;   /* limit=0 表示不限时（单机） */

  var root = null, canvas = null, timerBar = null, timerNum = null, confirmBtn = null;
  var cards = [], statRows = [];
  var renderer = null, scene = null, camera = null, previews = [];
  var selected = 1, remain = LIMIT, onConfirm = null, raf = 0, last = 0;
  var timerWrap = null, tipEl = null;
  var openFlag = false;

  /* 把调校数值映射成 0..1 的条形长度，口径固定写在下面，便于对照 */
  var STATS = [
    { key: '极速', pick: function (t) { return t.engineVmax; }, max: 105, fmt: function (t) { return Math.round(t.engineVmax * 3.6) + ' km/h'; } },
    { key: '加速', pick: function (t) { return t.engineThrust; }, max: 24, fmt: function (t) { return t.engineThrust.toFixed(1) + ' m/s²'; } },
    { key: '抓地', pick: function (t) { return t.gripNormal; }, max: 32, fmt: function (t) { return t.gripNormal.toFixed(1); } },
    { key: '过弯', pick: function (t) { return t.maxLatNormal; }, max: 55, fmt: function (t) { return t.maxLatNormal.toFixed(0); } },
    { key: '转向', pick: function (t) { return t.steerCap; }, max: 1.2, fmt: function (t) { return t.steerCap.toFixed(2); } },
    { key: '越野', pick: function (t) { return 0.65 - t.offroadDrag; }, max: 0.65, fmt: function (t) { return '阻力 ' + t.offroadDrag.toFixed(2); } }
  ];

  function q(id) { return document.getElementById(id); }

  /* 车底柔和阴影：径向渐变贴图，暖色背景上比深色圆盘自然 */
  var shadowTex = null;
  function makeShadowTexture() {
    if (shadowTex) return shadowTex;
    var c = document.createElement('canvas');
    c.width = c.height = 256;
    var g = c.getContext('2d');
    var grad = g.createRadialGradient(128, 128, 6, 128, 128, 120);
    grad.addColorStop(0, 'rgba(66,38,16,0.55)');
    grad.addColorStop(0.5, 'rgba(66,38,16,0.28)');
    grad.addColorStop(1, 'rgba(74,44,20,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 256);
    shadowTex = new THREE.CanvasTexture(c);
    return shadowTex;
  }

  /* 预览场景：两辆车并排，缓慢左右摆动；克隆主场景的 root，材质独立拷贝后染色 */
  function buildPreview() {
    if (renderer || !canvas) return;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setClearColor(0x000000, 0);
      scene = new THREE.Scene();
      camera = new THREE.PerspectiveCamera(26, canvas.clientWidth / Math.max(1, canvas.clientHeight), 0.1, 100);
      camera.position.set(0, 1.35, 7.7);
      camera.lookAt(0, 0.5, 0);

      /* 暖色布光：暖白环境 + 主光 + 补光 + 橙色轮廓光，贴近黄昏海岸的感觉 */
      scene.add(new THREE.HemisphereLight(0xfff4e4, 0xa9743f, 1.0));
      var key = new THREE.DirectionalLight(0xffd9ae, 2.15);
      key.position.set(3.2, 6, 4.5);
      scene.add(key);
      var fill = new THREE.DirectionalLight(0xffffff, 0.55);
      fill.position.set(-4.5, 2.6, 3.2);
      scene.add(fill);
      var rim = new THREE.DirectionalLight(0xff8a4a, 1.25);
      rim.position.set(-1.5, 3.2, -5);
      scene.add(rim);

      var roots = CR.Car && CR.Car.roots;
      for (var i = 0; i < 2; i++) {
        var src = roots && roots[i];
        var clone = src ? src.clone(true) : new THREE.Group();
        /* 材质逐个克隆，避免改色影响主场景里的真车 */
        clone.traverse(function (o) {
          if (!o.isMesh || !o.material) return;
          var mats = Array.isArray(o.material) ? o.material : [o.material];
          var out = [];
          for (var k = 0; k < mats.length; k++) {
            var m = mats[k].clone();
            if (m.color && m.color.r > 0.42 && m.color.g > 0.42 && m.color.b > 0.42) {
              m.color.setHex(i === 0 ? 0x6fb7ff : 0xff7a4d);
            }
            if (m.emissive) m.emissiveIntensity = 0;
            out.push(m);
          }
          o.material = Array.isArray(o.material) ? out : out[0];
          o.castShadow = false; o.receiveShadow = false;
        });
        clone.position.set(i === 0 ? -2.15 : 2.15, 0, 0);
        clone.rotation.y = -0.55;
        scene.add(clone);
        previews.push(clone);
        /* 每人一块柔和落地阴影 */
        var sh = new THREE.Mesh(
          new THREE.PlaneGeometry(5.6, 5.6),
          new THREE.MeshBasicMaterial({ map: makeShadowTexture(), transparent: true, depthWrite: false, opacity: 0.95 })
        );
        sh.rotation.x = -Math.PI / 2;
        sh.position.set(clone.position.x, 0.012, 0);
        scene.add(sh);
        clone.userData.shadow = sh;
      }
    } catch (e) {
      renderer = null;
      if (window.console) console.warn('[CarSelect] 预览不可用：', e && e.message);
    }
  }

  function resize() {
    if (!renderer || !canvas) return;
    var w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h || (canvas.width === w && canvas.height === h)) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function render(now) {
    if (!openFlag) return;
    raf = requestAnimationFrame(render);
    var dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
    last = now;
    if (limit > 0) {
      remain -= dt;
      if (remain <= 0) { remain = 0; updateTimer(); confirm(); return; }
      updateTimer();
    }

    if (!renderer) return;
    resize();
    for (var i = 0; i < previews.length; i++) {
      var on = i === selected;
      var targetScale = on ? 1.06 : 0.84;
      var s = previews[i].scale.x + (targetScale - previews[i].scale.x) * Math.min(1, dt * 8);
      previews[i].scale.setScalar(s);
      /* 选中车微微靠近镜头并抬高，形成层次 */
      previews[i].position.y += ((on ? 0.06 : -0.02) - previews[i].position.y) * Math.min(1, dt * 8);
      previews[i].position.z += ((on ? 0.22 : -0.14) - previews[i].position.z) * Math.min(1, dt * 8);
      previews[i].rotation.y = -0.55 + Math.sin(now * 0.00045 + i) * 0.14;
      var sh = previews[i].userData.shadow;
      if (sh) {
        sh.scale.setScalar(0.9 + s * 0.12);
        sh.material.opacity = on ? 1 : 0.78;
      }
    }
    renderer.render(scene, camera);
  }

  function updateTimer() {
    if (!timerBar || !timerNum) return;
    if (limit <= 0) return;               /* 单机不限时：计时条保持隐藏 */
    var k = Math.max(0, remain / limit);
    timerBar.style.transform = 'scaleX(' + k.toFixed(3) + ')';
    var txt = String(Math.ceil(remain));
    if (timerNum.textContent !== txt) timerNum.textContent = txt;
  }

  function fillStats() {
    var tunes = CR.Car && CR.Car.TUNES ? CR.Car.TUNES : [];
    for (var c = 0; c < 2; c++) {
      var t = tunes[c];
      if (!t) continue;
      for (var i = 0; i < STATS.length; i++) {
        var row = statRows[c * STATS.length + i];
        if (!row) continue;
        var v = STATS[i].pick(t);
        var pct = Math.max(0.04, Math.min(1, v / STATS[i].max));
        if (row.bar) row.bar.style.width = (pct * 100).toFixed(1) + '%';
        if (row.val) row.val.textContent = STATS[i].fmt(t);
      }
    }
  }

  function paintSelection() {
    for (var i = 0; i < cards.length; i++) {
      var on = i === selected;
      if (cards[i]) cards[i].className = 'cs-card' + (on ? ' selected' : '');
    }
    if (confirmBtn) confirmBtn.textContent = '确认选择 · ' + (CR.Car && CR.Car.TUNES[selected] ? CR.Car.TUNES[selected].name : '');
  }

  function confirm() {
    if (!openFlag) return;
    openFlag = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (root) root.style.display = 'none';
    var fn = onConfirm; onConfirm = null;
    /* 联机模式不能在这里先切本地车：服务端可能在比赛中拒绝换车，
       一旦被拒就会出现「本地开着 MP4/4、服务端和其他人都以为是原厂车」。
       交给 netui 的回调先确认状态、发完消息再由服务端 room 校准。 */
    var isNet = root && root.getAttribute('data-mode') === 'net';
    if (!isNet && CR.Garage && CR.Garage.setActive) CR.Garage.setActive(selected);
    if (fn) fn(selected);
  }

  S.create = function () {
    root = q('car-select');
    if (!root) return S;
    canvas = q('cs-canvas');
    timerBar = q('cs-timer-bar');
    timerNum = q('cs-timer-num');
    confirmBtn = q('cs-confirm');
    timerWrap = document.querySelector('#car-select .cs-timer');
    tipEl = document.querySelector('#car-select .cs-tip');

    var statHosts = [q('cs-stats-0'), q('cs-stats-1')];
    statRows = [];
    for (var c = 0; c < 2; c++) {
      var host = statHosts[c];
      if (!host) continue;
      for (var i = 0; i < STATS.length; i++) {
        var line = document.createElement('div');
        line.className = 'cs-stat';
        var name = document.createElement('span'); name.className = 'cs-stat-k'; name.textContent = STATS[i].key;
        var track = document.createElement('i'); track.className = 'cs-stat-t';
        var bar = document.createElement('b'); bar.className = 'cs-stat-b'; track.appendChild(bar);
        var val = document.createElement('span'); val.className = 'cs-stat-v';
        line.appendChild(name); line.appendChild(track); line.appendChild(val);
        host.appendChild(line);
        statRows.push({ bar: bar, val: val });
      }
    }

    cards = [q('cs-card-0'), q('cs-card-1')];
    for (var k = 0; k < cards.length; k++) {
      (function (idx) {
        if (!cards[idx]) return;
        cards[idx].addEventListener('click', function () { selected = idx; paintSelection(); });
      })(k);
    }
    if (confirmBtn) confirmBtn.addEventListener('click', confirm);

    fillStats();
    S.ready = true;
    return S;
  };

  /* mode 只用于回调方识别，界面本身一致；默认第二辆车 */
  S.open = function (mode, done) {
    if (!S.ready) S.create();
    if (!root) { if (done) done(1); return S; }
    selected = 1;
    limit = (mode === 'solo') ? 0 : LIMIT;
    remain = limit;
    last = 0;
    onConfirm = done || null;
    openFlag = true;
    /* 注意：CSS 里 #car-select 是 display:none，这里必须显式写成 block；
       写成 '' 只是清掉内联样式，计算值仍然是 none（曾因此整块界面看不见）。 */
    root.style.display = 'block';
    root.setAttribute('data-mode', mode || 'solo');
    fillStats();
    paintSelection();
    if (timerWrap) timerWrap.style.display = limit > 0 ? '' : 'none';
    var subEl = document.querySelector('#car-select .cs-sub');
    if (subEl) {
      subEl.textContent = limit > 0
        ? '已进入房间 · 倒计时结束自动确认当前选择'
        : '单机模式 · 选好车辆后点击确认';
    }
    if (tipEl) {
      tipEl.textContent = limit > 0
        ? '全员选完后自动开始 · 5 秒倒计时'
        : '单机模式 · 选好车辆后点击「确认选择」开始';
    }
    updateTimer();
    buildPreview();
    resize();
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(render);
    return S;
  };

  S.close = function () {
    openFlag = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (root) root.style.display = 'none';
    onConfirm = null;
    return S;
  };
  S.diag = function () {
    return { ready: !!S.ready, open: openFlag, selected: selected, remain: +remain.toFixed(2),
      limit: limit, preview: !!renderer };
  };
})();
