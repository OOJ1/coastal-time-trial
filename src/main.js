/* =========================================================================
 * main.js — 分阶段启动（加载动画） / 主循环 / resize / 画质自适应
 *
 * 物理：n = ceil(dt/STEP)，把本帧 dt 均分成 n 个不超过 1/120s 的子步，
 * 状态总是刚好推进到当前渲染时刻（不做累加器插值，避免追车镜头抖动）。
 *
 * 加载：boot() 只建 renderer / scene / camera，之后把场景创建拆成 11 个阶段
 * 交给 CR.Loader 按帧推进；每阶段渲染一帧当前场景，遮罩随进度变薄，
 * 于是「地形 → 雪山/海 → 公路 → 植被 → 车辆 → 后处理」在动画期间逐层长出来。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var last = 0, started = false, nitroFx = 0;
  var qualityHold = -1e9, autoNitroOff = false;
  /* fps 统计用真实时间窗，不累加被 clamp 的 dt */
  var fpsStart = 0, fpsFrames = 0, startAt = 0;
  var resizePending = false;
  var lastShadow = -1e9;
  var wasNetRace = false;
  var TIER_MAX = 5;
  var countdownAt = 0;      /* 进入倒计时锁输入的起始时刻（兜底解锁用） */
  var renderer = null, scene = null, camera = null;

  /* ---------- 开场镜头：加载完成后从高空俯瞰平滑过渡到追车相机 ----------
     用真实时间推进（不是 clamp 后的 dt），低帧率下时长也准确；
     easeInOutCubic 让首尾速度为 0，位置 / 朝向 / FOV 同时插值，无跳变。
     过渡期间锁定输入；结束时相机正好落在 Cam.update 的目标上。 */
  var INTRO_DUR = 3.4;
  var INTRO_INPUT = { throttle: 0, brake: 0, steer: 0, handbrake: 0, nitro: 0 };
  var intro = {
    active: false, done: false, t: 0, dur: INTRO_DUR, frames: 0, start: 0,
    from: new THREE.Vector3(), to: new THREE.Vector3(),
    fromQ: new THREE.Quaternion(), toQ: new THREE.Quaternion(),
    fromFov: 55, toFov: 55
  };
  CR.Intro = intro;
  var _introPos = new THREE.Vector3(), _introQuat = new THREE.Quaternion();

  function easeInOut(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
  function startIntro() {
    if (!camera || !CR.Car || !CR.Car.ready) return;
    var st = CR.Car.state;
    CR.Cam.snap();
    CR.Cam.update(camera, 1 / 60);            /* 先算出正常追车相机作为终点 */
    intro.to.copy(camera.position);
    intro.toQ.copy(camera.quaternion);
    intro.toFov = camera.fov;
    /* 起点：车后 70m、高 110m，看向车前方 60m —— 高空俯瞰海岸与赛道 */
    intro.from.set(st.x - Math.sin(st.psi) * 70, st.y + 110, st.z - Math.cos(st.psi) * 70);
    camera.position.copy(intro.from);
    camera.lookAt(st.x + Math.sin(st.psi) * 60, st.y + 2, st.z + Math.cos(st.psi) * 60);
    intro.fromQ.copy(camera.quaternion);
    intro.fromFov = 60;
    camera.fov = 60; camera.updateProjectionMatrix();
    intro.active = true; intro.done = false;
    intro.t = 0; intro.frames = 0; intro.start = performance.now();
  }
  function updateIntro(now) {
    var k = (now - intro.start) / (intro.dur * 1000);
    if (k > 1) k = 1;
    intro.t = k; intro.frames++;
    var e = easeInOut(k);
    /* Cam.update 刚把相机写到追车目标：先缓存，再从起点插值过去 */
    _introPos.copy(camera.position);
    _introQuat.copy(camera.quaternion);
    camera.position.lerpVectors(intro.from, _introPos, e);
    camera.quaternion.slerpQuaternions(intro.fromQ, _introQuat, e);
    var f = intro.fromFov + (intro.toFov - intro.fromFov) * e;
    if (Math.abs(camera.fov - f) > 1e-3) { camera.fov = f; camera.updateProjectionMatrix(); }
    if (k >= 1) { intro.active = false; intro.done = true; }
  }
  intro.diag = function () {
    return {
      active: intro.active, done: intro.done, t: +intro.t.toFixed(3),
      dur: intro.dur, frames: intro.frames,
      from: [+intro.from.x.toFixed(2), +intro.from.y.toFixed(2), +intro.from.z.toFixed(2)],
      to: [+intro.to.x.toFixed(2), +intro.to.y.toFixed(2), +intro.to.z.toFixed(2)]
    };
  };


  function fail(e) {
    if (CR.Loader && CR.Loader.fail) return CR.Loader.fail(e);
    var b = document.getElementById('hud-boot');
    if (b) {
      b.className = 'error';
      b.innerHTML = '<strong>启动失败</strong><pre></pre>';
      b.querySelector('pre').textContent = String((e && e.stack) || e);
    }
    if (window.console) console.error('[Coastal]', e);
  }

  function qualityCheck(gl) {
    if (!CR.CFG.autoQuality) return;
    var ctx = gl.getContext(), dbg = ctx.getExtension('WEBGL_debug_renderer_info');
    var name = dbg ? String(ctx.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    var coarse = false;
    try {
      coarse = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
               (navigator.maxTouchPoints > 0 && window.innerWidth < 1100);
    } catch (e) { coarse = ('ontouchstart' in window); }
    if (/SwiftShader|llvmpipe|Software/i.test(name) || coarse) {
      CR.quality.shadow = 1024;
      CR.quality.terr = 280;
      CR.quality.ocean = 90;
      CR.quality.trees = 260;
      CR.quality.snow = 108;
      /* 软件渲染 / 触屏：MSAA 4→2，直接省掉一半场景 RT 的填充率 */
      CR.quality.msaa = 2;
      /* 低性能档把阴影重绘压回 30Hz：这些设备本身帧率就 20~30fps，
         30Hz 已接近每帧更新，不会引入可见步进，但能省下 1024² 的重复清屏。 */
      CR.CFG.shadowHz = 30;
    }
    /* 高 DPI 屏（笔记本 2x / 手机 3x）是隐形杀手：1.5 意味着 2.25 倍像素。
       1.25 掉到 1.56 倍，观感几乎无差，填充率省 30%。 */
    CR.quality.dprCap = coarse ? 1.0 : 1.25;

    /* 手动画质：?q=low（集显 / 老笔记本）或 ?q=high（强制满配录屏）。
       低档把渲染分辨率压到 70%、阴影 1024、像素比 1.0、树木减半，通常能翻倍帧率。 */
    var qp = /[?&]q=(low|high)\b/.exec(location.search);
    if (qp) {
      CR.CFG.autoTier = false;
      if (qp[1] === 'low') {
        CR.quality.scale = 0.7;
        CR.quality.dprCap = 1.0;
        CR.quality.shadow = 1024;
        CR.quality.trees = 260;
        CR.quality.ocean = 90;
        CR.CFG.shadowSoft = false;
      } else {
        CR.quality.scale = 1;
        CR.quality.dprCap = 1.5;
        CR.quality.shadow = CR.CFG.SHADOW;
        CR.CFG.shadowSoft = true;
      }
      requestResize();
    }
  }

  function requestResize() { resizePending = true; }

  function applyResize() {
    var w = window.innerWidth, h = window.innerHeight;
    var scale = Math.min(window.devicePixelRatio || 1, CR.quality.dprCap || 1.5) * CR.quality.scale;
    var cw = Math.floor(w * scale), ch = Math.floor(h * scale);
    var c = CR.renderer.domElement;
    var aspectChanged = Math.abs(CR.camera.aspect - w / h) > 1e-4;
    if (!aspectChanged && cw === c.width && ch === c.height) return;
    CR.renderer.setSize(cw, ch, false);
    c.style.width = w + 'px'; c.style.height = h + 'px';
    CR.camera.aspect = w / h;
    CR.camera.updateProjectionMatrix();
    CR.Post.setSize(cw, ch);
  }

  /* 画质档 0..5：只动纯视觉，物理 / HUD / 输入完全不受影响。
     降级顺序：氮气色差 → 远景 DOF → Bloom 5 级降 3 级 → AO → 分辨率 0.7。
     恢复时逆序；每级之间沿用 6s 冷却与滞回，避免反复抖动。 */
  function applyTier(tier) {
    tier = Math.max(0, Math.min(TIER_MAX, tier | 0));
    if (CR.quality.tier === tier) return;
    CR.quality.tier = tier;
    var P = CR.Post.flags;
    if (tier >= 1) {
      if (P.nitro) { P.nitro = 0; autoNitroOff = true; }
    } else if (autoNitroOff && !P.nitro) {
      P.nitro = 1; autoNitroOff = false;
    }
    P.dof = tier < 2 ? 1 : 0;
    if (CR.Post.setBloomLevels) CR.Post.setBloomLevels(tier < 3 ? 5 : 3);
    P.ao = tier < 4 ? 1 : 0;
    /* 分辨率阶梯：实测 70% 分辨率能到 +188% 帧率，是单项收益最大的一项。
       以前只在第 5 档一次性砍到 0.7，前面几档全在砍后期、效果有限；
       现在每档都让一点，降一两档就能回到 60fps，视觉上也比「突然变糊」平滑。 */
    var SC = [1, 0.92, 0.86, 0.80, 0.75, 0.70];
    var sc = SC[Math.min(tier, SC.length - 1)];
    if (CR.quality.scale !== sc) { CR.quality.scale = sc; requestResize(); }
    /* 阴影再降一档：2048 → 1024（第 4 档起），省 4 倍阴影填充率 */
    if (CR.Sky && CR.Sky.setShadowSize) CR.Sky.setShadowSize(tier >= 4 ? 1024 : CR.CFG.SHADOW);
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (resizePending) { resizePending = false; applyResize(); }
    var dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (!(dt > 0)) dt = 1 / 60;
    CR.time.value += dt;

    /* 整帧统一统计 draw call：autoReset=false 后由这里重置一次，
       否则每个后处理 pass 都会把 info 清零，诊断只能看到最后一次 1 个 call。 */
    if (renderer.info && renderer.info.reset) renderer.info.reset();
    /* 阴影更新裁决：同一个 shadowDue 同时控制「光源移动」与「贴图重绘」。
       旧实现每帧都移动太阳、却按 30Hz 才重绘阴影贴图，两者错拍时
       light.position 与 shadow.matrix 会差 0.2~0.6m，7° 夕阳在地面放大约
       8 倍 → 车影来回抽动。现在光源只在贴图重绘的那一帧移动。
       60Hz 上限：≤60fps 时每帧都更新（车影完全跟手），高刷屏才隔帧。
       外部（首帧 / finish）置过 needsUpdate 时也并入本次裁决。 */
    /* shadowHz = 0 表示不节流（每帧重绘，车影完全跟手，代价约 20% 帧率） */
    var hz = CR.CFG.shadowHz;
    var shadowDue = renderer.shadowMap.needsUpdate ||
                    (hz <= 0 ? true : (now - lastShadow >= 1000 / (hz || 60)));
    if (shadowDue) {
      renderer.shadowMap.needsUpdate = true;
      lastShadow = now;
    }

    /* 开场镜头期间锁定按键与驾驶输入，结束后再交还控制 */
    var netRace = !!(CR.Net && CR.Net.online && CR.Net.state === 'racing');
    /* 联机刚开赛：服务端已把档位重置到 1，客户端跟上（避免高速档起步拖慢） */
    if (netRace && !wasNetRace && CR.Gear && CR.Gear.reset) CR.Gear.reset();
    wasNetRace = netRace;
    if (!intro.active) {
      if (CR.Input.consume('KeyC')) CR.Cam.toggle();
      if (CR.Input.consume('KeyM') && CR.Audio) CR.Audio.toggle();
      if (CR.Input.consume('KeyF') && CR.FPView && CR.FPView.ready) CR.FPView.toggle();
      /* G / 手柄 L3：自动 ⇄ 手动（切换回调里会同步给服务端） */
      if (CR.Input.consume('KeyG') && CR.Gear && CR.Gear.toggle) CR.Gear.toggle();
      if (!netRace) {
        /* 换车（V / 触屏「换车」）：单机专属。联机时车辆由服务端发车格决定，
           本地换车会被 forceSync 立刻拽回去，还会打乱名次和计时，所以直接挡掉。 */
        if (CR.Input.consume('KeyV')) {
          var netOn = !!(CR.Net && CR.Net.online);
          if (!netOn && CR.Garage && CR.Garage.toggle) CR.Garage.toggle();
        }
        if (CR.Input.consume('KeyR')) {
          CR.Car.reset(true);
          if (CR.Gear && CR.Gear.reset) CR.Gear.reset();
        }
        if (CR.Input.consume('Enter') || CR.Input.consume('NumpadEnter')) {
          CR.Car.reset(false);
          if (CR.Gear && CR.Gear.reset) CR.Gear.reset();
          if (CR.Hud.restart) CR.Hud.restart();
          CR.Cam.snap();
          if (CR.Audio) CR.Audio.startEngine();
        }
      }
    }
    /* 联机 5 秒倒计时期间锁住驾驶输入：车停在发车格，别提前跑出去。
       兜底：最多锁 8 秒。服务端万一卡在 countdown（或 start 包丢了），
       玩家会「完全开不动车、也没有任何提示」，那种情况宁可提前放行。 */
    var netCountdown = !!(CR.Net && CR.Net.online && CR.Net.snapshot &&
                          CR.Net.snapshot.phase === 'countdown');
    if (netCountdown) {
      if (!countdownAt) countdownAt = now;
      else if (now - countdownAt > 8000) netCountdown = false;
    } else countdownAt = 0;
    var input;
    if (intro.active || netCountdown) input = INTRO_INPUT;
    else { input = CR.autoInput; if (!input) input = CR.Input.read(); }

    /* 换档：键盘 E 升 / Q 降（自动挡下核心会直接忽略）。
       手动换档必须发生在物理推进之前，0.12s 断油才会从本帧开始算。 */
    var gUp = 0, gDn = 0;
    if (!intro.active) {
      gUp = CR.Input.consume('KeyE') ? 1 : 0;
      gDn = CR.Input.consume('KeyQ') ? 1 : 0;
      if (CR.Gear && CR.Gear.ready && CR.Gear.manual) {
        if (gUp) CR.Gear.up();
        if (gDn) CR.Gear.down();
      }
    }

    /* 联机：输入上行 → 本地预测照常跑 → 服务端快照校正 */
    var corrected = false;
    if (CR.Net && netRace && !intro.active) {
      CR.Net.feedInput(dt, input, gUp, gDn);
    }

    var n = Math.max(1, Math.ceil(dt / CR.CFG.STEP - 1e-6)), h = dt / n;
    for (var i = 0; i < n; i++) CR.Car.step(h, input);
    if (CR.Net && netRace) corrected = CR.Net.correct(CR.Car.state, dt);

    var t = CR.time.value, st = CR.Car.state;
    if (CR.Rivals) CR.Rivals.update(dt);
    nitroFx += ((st.nitroActive ? 1 : 0) - nitroFx) * (1 - Math.exp(-dt * 8));
    CR.Post.setNitro(nitroFx);
    CR.Car.sync(t, dt);
    /* 联机（含 5 秒倒计时）一律用服务端快照刷 HUD，避免本地圈速/检查点抢跑 */
    if (!netRace && !netCountdown) CR.Hud.update(dt);
    else if (CR.Net && CR.Net.snapshot) CR.Hud.updateNet(CR.Net.snapshot);
    if (CR.Gear && CR.Gear.ready) CR.Gear.step(dt, input);
    CR.Cam.update(CR.camera, dt);
    if (intro.active) updateIntro(now);
    CR.Sky.update(CR.camera, st, shadowDue);
    CR.Ocean.update(CR.camera);
    CR.Props.update(dt, t, st);
    CR.Effects.update(dt, CR.Post.height() * 0.5 * CR.camera.projectionMatrix.elements[5]);
    CR.Confetti.update(dt);
    /* 撞击音效：Car.step 每帧把「本帧最强法向撞速」取最大值写进 hitAcc，
       这里读完必须清零 —— 否则撞一次护栏后 hitAcc 永远 > 0，A.hit 的 0.05s
       节流会让撞击声以 20Hz 无限重放，听起来就是「响个不停、不会消失」。 */
    if (st.hitAcc > 0) {
      if (!netRace && CR.Audio) CR.Audio.hit(st.hitAcc);
      st.hitAcc = 0;
    }
    if (CR.Audio) {
      if (CR.Audio.setEngineBrake) CR.Audio.setEngineBrake(st.engineBrake || 0);
      CR.Audio.update(dt, st, input);
    }
    CR.Post.render(CR.scene, CR.camera);

    fpsFrames++;
    var nowS = now / 1000;
    if (!fpsStart) fpsStart = nowS;
    if (nowS - fpsStart >= 2) {
      var fps = fpsFrames / (nowS - fpsStart);
      var cd = nowS - qualityHold;
      /* CR.CFG.autoTier=false 可锁定满配（验收 / 录屏用） */
      if (CR.CFG.autoTier && nowS - startAt > 4) {
        if (fps < 52 && cd > 6) { applyTier(CR.quality.tier + 1); qualityHold = nowS; }
        else if (fps > 58 && cd > 6) { applyTier(CR.quality.tier - 1); qualityHold = nowS; }
      }
      fpsFrames = 0; fpsStart = nowS;
    }
  }

  /* 加载阶段：顺序即依赖顺序；加载期间纯黑，不渲染预览 */
  function makeStages() {
    return [
      { label: '生成赛道与黄昏天空', run: function () {
        CR.Track.build(); CR.Sky.create(scene, renderer);
      } },
      { label: '铺设海岸地形', run: function () {
        CR.Terrain.create(scene);
      } },
      { label: '堆叠雪山与动态海面', run: function () {
        if (CR.Snow) CR.Snow.create(scene);
        CR.Ocean.create(scene);
      } },
      { label: '铺设公路 · 护栏 · 终点门', run: function () {
        CR.Road.create(scene);
      } },
      { label: '放置灯塔 · 植被 · 渔船', run: function () {
        CR.Props.create(scene);
      } },
      { label: '装配两辆赛车与车库', run: function () {
        CR.Car.create(scene);
        if (CR.Car2 && CR.Car2.attach) CR.Car2.attach(scene);
        if (CR.Garage && CR.Garage.setup) CR.Garage.setup(scene);
        if (CR.Rivals && CR.Rivals.create) CR.Rivals.create(scene);
      } },
      { label: '生成胎痕 · 尾焰 · 彩条', run: function () {
        CR.Effects.create(scene); CR.Confetti.create(scene);
      } },
      { label: '搭建 HDR 后处理链', run: function () {
        if (scene.environment) CR.Sky.applyEnvIntensity(scene, 1.35);
        CR.Post.create(renderer);
        applyResize();                       /* 建好 RT，之后的预览才能走完整色调链 */
      } },
      { label: '接入仪表 · 输入 · 音效', run: function () {
        CR.Record.create(); CR.Hud.create(); CR.Input.init();
        if (CR.FPView && CR.FPView.init) CR.FPView.init();
        if (CR.Gear && CR.Gear.init) {
          CR.Gear.init();
          /* 切换自动/手动后立刻告诉服务端（单机时 syncGear 是空操作） */
          CR.Gear.onToggle = function () {
            if (CR.Net && CR.Net.syncGear) CR.Net.syncGear();
          };
        }
        CR.Cam.snap();
        if (CR.Audio && CR.Audio.warmup) CR.Audio.warmup();
        if (CR.Net && CR.Net.init) CR.Net.init();
        if (CR.NetUI && CR.NetUI.create) CR.NetUI.create();
        if (CR.CarSelect && CR.CarSelect.create) CR.CarSelect.create();
      } },
      { label: '编译全部着色器', run: function () {
        if (renderer.compile) renderer.compile(scene, camera);
      } },
      { label: '预热首帧画面', run: function () {
        if (CR.Post.ready) { CR.Post.render(scene, camera); CR.Post.render(scene, camera); }
      } }
    ];
  }

  function finish() {
    applyResize();
    renderer.shadowMap.needsUpdate = true;
    window.addEventListener('resize', requestResize);
    window.addEventListener('orientationchange', function () {
      setTimeout(requestResize, 260);
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        last = performance.now();
        fpsStart = 0; fpsFrames = 0;
      }
    });
    last = performance.now();
    startAt = last / 1000;
    lastShadow = -1e9;
    /* 单机：先选车（10s，默认 MP4/4），确认后再进入开场镜头 */
    if (CR.CarSelect && CR.CarSelect.open) {
      CR.CarSelect.open('solo', function () { startIntro(); });
    } else {
      if (CR.Garage && CR.Garage.setActive) CR.Garage.setActive(1);
      startIntro();
    }
    requestAnimationFrame(frame);
  }

  function boot() {
    if (started) return;
    started = true;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: false, powerPreference: 'high-performance', stencil: false
      });
      renderer.setPixelRatio(1);
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.outputEncoding = THREE.LinearEncoding;
      renderer.shadowMap.enabled = true;
      renderer.setSize(window.innerWidth, window.innerHeight);
      document.getElementById('app').appendChild(renderer.domElement);
      CR.renderer = renderer;
      CR.maxAniso = renderer.capabilities.getMaxAnisotropy();
      qualityCheck(renderer);
      /* PCF（4 次采样）而不是 PCFSoft（9 次）：实测关掉阴影整体能到 +57fps，
         其中绝大部分花在**主渲染的阴影采样**上，而不是阴影贴图重绘。
         夕阳场景本身就有强烈的方向性，硬一点的阴影边反而更贴光。 */
      renderer.shadowMap.type = CR.CFG.shadowSoft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
      /* 阴影改为按需更新（frame 里按 30Hz 置 needsUpdate），避免静止光源每帧重绘全场景 */
      renderer.shadowMap.autoUpdate = false;
      renderer.shadowMap.needsUpdate = true;   /* 加载预览的首帧先生成一次阴影 */
      if (renderer.info) renderer.info.autoReset = false;

      scene = new THREE.Scene(); CR.scene = scene;
      camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 14000);
      CR.camera = camera;
    } catch (e) { return fail(e); }

    /* 加载期间保持纯黑：不渲染场景预览，只显示加载 UI；
       着色器编译与首帧预热仍在加载阶段完成，进游戏后不会临时卡顿。 */
    if (CR.Loader) CR.Loader.preview = null;   /* embed.html 不加载 loader.js，走下面的同步分支 */
    if (CR.Loader && CR.Loader.run) CR.Loader.run(makeStages(), finish);
    else { makeStages().forEach(function (s) { s.run(); }); finish(); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
