/* =========================================================================
 * main.js — 启动流程 / 主循环 / resize / 自适应分辨率
 * 物理：n = ceil(dt/STEP)，把本帧 dt 均分成 n 个不超过 1/120s 的子步，
 * 状态总是刚好推进到当前渲染时刻（不做累加器插值，避免追车镜头抖动）。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var last = 0, started = false, nitroFx = 0;
  /* 画质档调整冷却（真实秒）+ "氮气色差是本引擎自己关的"标记。
     后者保证验收脚本手动 Post.flags.nitro=0 时不会被回升逻辑覆盖。 */
  var qualityHold = -1e9, autoNitroOff = false;
  /* fps 统计必须用真实时间窗：旧实现累加的是被 clamp 到 0.05 的 dt，
     低帧率下要 40 帧才凑满 2s，自适应几乎永不触发。 */
  var fpsStart = 0, fpsFrames = 0, startAt = 0;
  /* resize 只置位，在下一帧统一应用：在事件回调里直接 setSize 会与渲染错帧，
     地址栏收缩/旋屏/拖窗口这类连续事件还会反复重建 12 张 RT。 */
  var resizePending = false;

  function fail(e) {
    var b = document.getElementById('hud-boot');
    if (b) {
      b.className = 'error';
      b.innerHTML = '<strong>启动失败</strong><pre></pre>';
      b.querySelector('pre').textContent = String(e && e.stack || e);
    }
    if (window.console) console.error('[Coastal]', e);
  }

  function qualityCheck(renderer) {
    if (!CR.CFG.autoQuality) return;
    var gl = renderer.getContext(), dbg = gl.getExtension('WEBGL_debug_renderer_info');
    var name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    /* 触屏设备与软件渲染器一样默认低一档：4096² 阴影 + 420² 地形 + 850 棵树
       在移动 GPU 上会持续掉帧，而追车镜头的平滑依赖稳定的帧间隔，
       掉帧比少几棵树更伤手感。桌面 pointer:fine 的设备完全不受影响。 */
    var coarse = false;
    try {
      coarse = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ||
               (navigator.maxTouchPoints > 0 && window.innerWidth < 1100);
    } catch (e) { coarse = ('ontouchstart' in window); }
    /* 软件渲染器自动降一档；CR.CFG.autoQuality=false 可强制满配规格值 */
    if (/SwiftShader|llvmpipe|Software/i.test(name) || coarse) {
      CR.quality.shadow = 1024;
      CR.quality.terr = 280;
      CR.quality.ocean = 90;
      CR.quality.trees = 260;
      CR.quality.snow = 108;
    }
    /* 移动 GPU 的 DPR 常到 3，全分辨率渲染是最大的填充率开销。
       桌面维持 1.5（规格原值），触屏收紧到 1.0。 */
    CR.quality.dprCap = coarse ? 1.0 : 1.5;
  }

  function requestResize() { resizePending = true; }

  function applyResize() {
    var w = window.innerWidth, h = window.innerHeight;
    var scale = Math.min(window.devicePixelRatio || 1, CR.quality.dprCap || 1.5) * CR.quality.scale;
    var cw = Math.floor(w * scale), ch = Math.floor(h * scale);
    var c = CR.renderer.domElement;
    var aspectChanged = Math.abs(CR.camera.aspect - w / h) > 1e-4;
    /* 尺寸与宽高比都没变就直接返回，避免无意义地 dispose + 重建全部 RT */
    if (!aspectChanged && cw === c.width && ch === c.height) return;
    CR.renderer.setSize(cw, ch, false);
    c.style.width = w + 'px'; c.style.height = h + 'px';
    CR.camera.aspect = w / h;
    CR.camera.updateProjectionMatrix();
    CR.Post.setSize(cw, ch);
  }

  function frame(now) {
    requestAnimationFrame(frame);
    /* 尺寸变更与渲染放在同一帧：setSize 后立刻重绘，浏览器合成时不会露出空白帧 */
    if (resizePending) { resizePending = false; applyResize(); }
    var dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (!(dt > 0)) dt = 1 / 60;
    CR.time.value += dt;

    if (CR.Input.consume('KeyC')) CR.Cam.toggle();
    if (CR.Input.consume('KeyR')) CR.Car.reset(true);
    if (CR.Input.consume('KeyM') && CR.Audio) CR.Audio.toggle();
    /* 重新开始一局：回到发车线、清计时、给排行榜解锁、重新打火 */
    if (CR.Input.consume('Enter') || CR.Input.consume('NumpadEnter')) {
      CR.Car.reset(false);
      if (CR.Hud.restart) CR.Hud.restart();
      CR.Cam.snap();
      if (CR.Audio) CR.Audio.startEngine();
    }
    /* CR.autoInput 为真时完全跳过 readInput：input.nitro 由外部脚本提供 */
    var input = CR.autoInput;
    if (!input) input = CR.Input.read();

    /* 均分子步：物理状态刚好推进到当前渲染时刻 */
    var n = Math.max(1, Math.ceil(dt / CR.CFG.STEP - 1e-6)), h = dt / n;
    for (var i = 0; i < n; i++) CR.Car.step(h, input);

    var t = CR.time.value, st = CR.Car.state;
    /* 氮气画面强度：1-exp(-dt*8) 平滑（不在渲染帧里做任何氮气判定，
       判定与资源结算全部在 Car.step 的子步内完成） */
    nitroFx += ((st.nitroActive ? 1 : 0) - nitroFx) * (1 - Math.exp(-dt * 8));
    CR.Post.setNitro(nitroFx);
    CR.Car.sync(t, dt);
    CR.Hud.update(dt);
    CR.Cam.update(CR.camera, dt);
    CR.Sky.update(CR.camera, st);
    CR.Ocean.update(CR.camera);
    CR.Props.update(dt, t, st);
    CR.Effects.update(dt, CR.Post.height() * 0.5 * CR.camera.projectionMatrix.elements[5]);
    CR.Confetti.update(dt);
    /* 音效：撞墙是事件（st.hitAcc 由 Car.step 累加、这里消费清零），
       其余层（引擎/油门/刹车/漂移/氮气）每帧按状态推参数 */
    if (st.hitAcc > 0) {
      if (CR.Audio) CR.Audio.hit(st.hitAcc);
      st.hitAcc = 0;
    }
    if (CR.Audio) CR.Audio.update(dt, st, input);
    CR.Post.render(CR.scene, CR.camera);

    /* 自适应：预热 3s，每 2s 真实时间统计 fps。
       降级顺序不变：先关纯视觉的氮气边缘色差，再降分辨率（物理完全无感）。
       本轮针对"闪烁"的三处修正：
       · fps 用真实时间窗，不再累加 clamp 后的 dt（低帧率下旧实现几乎不触发）；
       · 分辨率一次降到 0.7（旧实现 1.0→0.8→0.7 会连续重建两次）；
       · 冷却与判定都用真实秒，避免游戏时间慢放导致策略不可预测。 */
    fpsFrames++;
    var nowS = now / 1000;
    if (!fpsStart) fpsStart = nowS;
    if (nowS - fpsStart >= 2) {
      var fps = fpsFrames / (nowS - fpsStart);
      var cd = nowS - qualityHold;
      if (nowS - startAt > 3) {
        if (fps < 48 && cd > 6) {
          if (CR.Post.flags.nitro) {
            CR.Post.flags.nitro = 0; autoNitroOff = true;
            qualityHold = nowS;
          } else if (CR.quality.scale > 0.7) {
            CR.quality.scale = 0.7;
            requestResize();
            qualityHold = nowS;
          }
        } else if (fps > 58 && cd > 6) {
          if (CR.quality.scale < 1) {
            CR.quality.scale = 1;
            requestResize();
            qualityHold = nowS;
          } else if (autoNitroOff && !CR.Post.flags.nitro) {
            CR.Post.flags.nitro = 1; autoNitroOff = false;
            qualityHold = nowS;
          }
        }
      }
      fpsFrames = 0; fpsStart = nowS;
    }
  }

  function start() {
    if (started) return;
    started = true;
    try {
      var renderer = new THREE.WebGLRenderer({
        antialias: false, powerPreference: 'high-performance', stencil: false
      });
      renderer.setPixelRatio(1);
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.outputEncoding = THREE.LinearEncoding;   // 最终 pass 自行 gamma
      renderer.shadowMap.enabled = true;
      /* 阴影类型在 qualityCheck 之后按设备决定（见下方 dprCap 判断） */
      renderer.setSize(window.innerWidth, window.innerHeight);
      document.getElementById('app').appendChild(renderer.domElement);
      CR.renderer = renderer;
      CR.maxAniso = renderer.capabilities.getMaxAnisotropy();
      qualityCheck(renderer);
      /* 夕阳仰角只有约 7°：桌面用 PCFSoft 让阴影边缘更柔、移动时不易闪；
         触屏/低端设备保留 PCF，省采样。 */
      renderer.shadowMap.type = (CR.quality.dprCap > 1) ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;

      var scene = new THREE.Scene(); CR.scene = scene;
      var camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 1, 14000);
      CR.camera = camera;

      CR.Track.build();
      CR.Sky.create(scene, renderer);
      CR.Terrain.create(scene);
      /* 雪山只叠加在地形之上：必须在 Terrain.create 之后、Props.create 之前，
         这样 safeSpot 的 118m 植被排除区也已就位 */
      if (CR.Snow) CR.Snow.create(scene);
      CR.Ocean.create(scene);
      CR.Road.create(scene);
      CR.Props.create(scene);
      CR.Car.create(scene);
      CR.Effects.create(scene);
      CR.Confetti.create(scene);
      /* 环境反射强度 1.35：r149 没有 scene.environmentIntensity，用材质系数等价实现 */
      if (scene.environment) CR.Sky.applyEnvIntensity(scene, 1.35);
      CR.Post.create(renderer);
      CR.Record.create();
      CR.Hud.create();
      CR.Input.init();
      CR.Cam.snap();

      applyResize();
      /* 开局前把 shader 全部编译掉：场景材质 + 5 个后处理 pass 各渲染一次。
         这样局内第一次出现彩条 / 尾焰 / 碰撞效果时不会临时编译造成卡顿。 */
      if (renderer.compile) renderer.compile(scene, camera);
      if (CR.Post.ready) CR.Post.render(scene, camera);
      /* 音频资源同样在加载阶段建好（保持静音，首次手势后 resume） */
      if (CR.Audio && CR.Audio.warmup) CR.Audio.warmup();

      window.addEventListener('resize', requestResize);
      /* iOS Safari 旋屏后 innerWidth/innerHeight 会晚一拍才更新，补一次延迟重算；
         HUD 与触屏控件的横竖屏断点也依赖这次 resize。 */
      window.addEventListener('orientationchange', function () {
        setTimeout(requestResize, 260);
      });
      /* 后台标签页回来时 rAF 的 now 会跳一大截：重置 dt 基准与 fps 窗口，
         避免第一帧被 clamp 成 50ms、以及把后台时间算进 fps。 */
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) {
          last = performance.now();
          fpsStart = 0; fpsFrames = 0;
        }
      });
      last = performance.now();
      startAt = last / 1000;
      requestAnimationFrame(frame);
    } catch (e) { fail(e); }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
