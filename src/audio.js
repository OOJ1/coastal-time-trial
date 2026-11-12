/* =========================================================================
 * audio.js — 程序化音效系统（纯 WebAudio，零外部素材）
 *   引擎（启动 / 怠速 / 随转速变调）· 油门进气 · 刹车摩擦+啸叫 · 漂移胎噪
 *   · 撞墙（噪声 + 低频闷响）· 氮气推进 · 待机熄火
 * 全部声音由 Car.state / input 派生，物理不依赖本模块。
 *
 * 状态机（与画面无关，只影响声音）：
 *   running --(静止且无操作满 3s)--> 播一次熄火音 --> off
 *   off ----(任何驾驶操作)--------> 播一次启动音 --> 0.42s 后引擎声淡入 -> running
 * 所有一次性音效都有锁，状态切换只播一次。
 *
 * 默认静音：不建 AudioContext，避免自动播放策略拦截并刷控制台告警。
 * 开关：CR.Audio.toggle() / setEnabled(bool)，键盘 M
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var A = CR.Audio = {};

  A.enabled = false;          /* 默认静音 */
  A.available = true;
  A.ready = false;

  var ctx = null, master = null, comp = null, noiseBuf = null, analyser = null;
  var specBuf = null, timeBuf = null;

  /* 引擎链：双锯齿失谐 + 三角谐波 + 次低音 + 机械噪声 → 低通 → engineBus */
  var engineBus = null, engineMix = null, engineLP = null;
  var eng1 = null, eng1G = null, eng1b = null, eng1bG = null;
  var eng2 = null, eng2G = null, engSub = null, engSubG = null;
  var engN = null, engBP = null, engNG = null;
  var idleLFO = null, idleDepth = null;

  /* 其他层 */
  var intake = null, intakeBP = null, intakeG = null;
  /* 氮气：一条噪声源分四路（低频风压 / 中频推力 / 高频喷气 / 极高频气嘴），
     + 一条随转速上扫的涡轮哨音，另有一次性的「起爆」瞬态（A.nitroBurst） */
  var boostSrc = null, boostLow = null, boostLowG = null;
  var boostBody = null, boostBodyG = null;
  var boostAir = null, boostAirG = null;
  var boostSpray = null, boostSprayG = null;
  var boostWhistle = null, boostWhistleG = null;
  var boostLFO = null, boostLFOg = null;
  var boostLvl = null;         /* 总包络：一个 gain 统一控制起/停的斜坡 */
  var boostPrev = 0;           /* 上一帧是否在推进：用来检测起爆沿 */
  var nitroBursts = 0;

  /* 刹车：低频摩擦 + 高频啸叫（窄带 + 慢颤音） */
  var brakeFric = null, brakeFricLP = null, brakeFricG = null;
  var brakeSq = null, brakeSqBP = null, brakeSqAM = null, brakeSqG = null, brakeLFO = null;

  /* 漂移：低频摩擦 + 中频胎噪主体 + 深漂点缀的高频 */
  var driftLow = null, driftLowLP = null, driftLowG = null;
  var driftMid = null, driftMidBP = null, driftMidG = null;
  var driftHi = null, driftHiBP = null, driftHiAM = null, driftHiG = null, driftLFO = null;

  var engineRunning = false, engineAt = 0, idleTimer = 0;
  var IDLE_OFF = 3.0;         /* 静止无操作满 3 秒熄火 */
  var lastCrank = -1, lastHit = -1, hitCount = 0;
  var crankCount = 0, shutCount = 0;   /* 只用于自检：确认状态切换只播一次 */
  var lvl = { engine: 0, throttle: 0, boost: 0, brake: 0, drift: 0 };
  var ar = null;              /* 一次性音效用的随机流（运行期噪声不需要可复现） */
  /* 可选的真实素材槽：默认全空 = 纯合成，不产生任何网络请求。
     需要替换时调用 A.useSamples({hit:'audio/hit.ogg', nitro:'audio/nitro.ogg'})。 */
  var samples = { hit: null, nitro: null };

  function ran() { return ar ? ar() : 0.5; }
  function gain(v) { var g = ctx.createGain(); g.gain.value = v; return g; }
  function filt(type, f, q) { var b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; return b; }
  function loopNoise() {
    var s = ctx.createBufferSource();
    s.buffer = noiseBuf; s.loop = true; s.start(0);
    return s;
  }
  function osc(type, f) {
    var o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.start(0);
    return o;
  }

  /* 懒建：只有用户真的打开音效时才 new AudioContext */
  A.init = function () {
    if (A.ready) return A;
    var AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
    if (!AC) { A.available = false; return A; }
    try {
      ar = CR.rng(CR.SALT.fx + 23);
      ctx = new AC();

      /* 噪声源：2s 白噪声，所有噪声层共用一份 buffer */
      var sr = ctx.sampleRate, len = Math.max(1, Math.floor(sr * 2));
      noiseBuf = ctx.createBuffer(1, len, sr);
      var d = noiseBuf.getChannelData(0), r = CR.rng(CR.SALT.fx + 11);
      for (var i = 0; i < len; i++) d[i] = r() * 2 - 1;

      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18; comp.knee.value = 16; comp.ratio.value = 5;
      comp.attack.value = 0.005; comp.release.value = 0.24;
      /* 分析节点常驻：只在 A.spectrum() 被调用时才读数据，
         平时零开销；用于自检「碰撞是不是宽频 + 有金属峰」这类听不出来的问题。 */
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0;   /* 只给自检用，不做平滑 */
      master = gain(0);
      master.connect(comp); comp.connect(analyser); analyser.connect(ctx.destination);

      /* ---- 引擎：失谐双锯齿给厚度，三角波补谐波，正弦补低频，噪声补机械感 ----
         全部先过低通（cutoff 随转速 520~2000Hz），把锯齿的高次谐波削掉，
         这样既有转速感又不刺耳；怠速抖动由 6.4Hz 微幅调频提供。 */
      engineBus = gain(0);
      engineBus.connect(master);
      engineMix = gain(1);
      engineLP = filt('lowpass', 900, 0.7);
      engineMix.connect(engineLP); engineLP.connect(engineBus);

      eng1 = osc('sawtooth', 62); eng1G = gain(0.12);
      eng1b = osc('sawtooth', 62); eng1bG = gain(0.09);
      eng1b.detune.value = 9;
      eng1.connect(eng1G); eng1G.connect(engineMix);
      eng1b.connect(eng1bG); eng1bG.connect(engineMix);

      eng2 = osc('triangle', 124); eng2G = gain(0.06);
      eng2.connect(eng2G); eng2G.connect(engineMix);

      engSub = osc('sine', 31); engSubG = gain(0.09);
      engSub.connect(engSubG); engSubG.connect(engineMix);

      engN = loopNoise(); engBP = filt('bandpass', 210, 0.8); engNG = gain(0.05);
      engN.connect(engBP); engBP.connect(engNG); engNG.connect(engineMix);

      idleLFO = osc('sine', 6.4); idleDepth = gain(0);
      idleLFO.connect(idleDepth);
      idleDepth.connect(eng1.frequency);
      idleDepth.connect(eng1b.frequency);

      /* ---- 油门：进气噪声 ---- */
      intake = loopNoise(); intakeBP = filt('bandpass', 860, 0.8); intakeG = gain(0);
      intake.connect(intakeBP); intakeBP.connect(intakeG); intakeG.connect(master);

      /* ---- 氮气推进：一条噪声源分四路，模拟真实 N2O 喷流的频谱分层 ----
         真实氮气最响的其实不是"嗖"，而是三样东西叠在一起：
         ① 气瓶阀门打开后喷出的宽频白噪（几十 ms 的起爆，单独由 nitroBurst 播）
         ② 喷口处的持续喷流——低频是气流撞击的"轰"，中频是推力，高频是细密的"嘶"
         ③ 涡轮/机械被带起来的哨音，频率随车速上扫
         另外它会把引擎声压住，所以 update 里对 engineBus 做轻微侧链闪避。
         低频 150Hz 那一路是重点：没有它，氮气听起来像吸尘器。 */
      boostLvl = gain(0);                 /* 总包络 */
      boostLvl.connect(master);

      boostSrc = loopNoise();

      boostLow = filt('lowpass', 150, 0.9); boostLowG = gain(0.55);
      boostSrc.connect(boostLow); boostLow.connect(boostLowG); boostLowG.connect(boostLvl);

      boostBody = filt('bandpass', 620, 0.85); boostBodyG = gain(0.30);
      boostSrc.connect(boostBody); boostBody.connect(boostBodyG); boostBodyG.connect(boostLvl);

      boostAir = filt('bandpass', 1800, 0.6); boostAirG = gain(0.14);
      boostSrc.connect(boostAir); boostAir.connect(boostAirG); boostAirG.connect(boostLvl);

      boostSpray = filt('highpass', 6000, 0.7); boostSprayG = gain(0.05);
      boostSrc.connect(boostSpray); boostSpray.connect(boostSprayG); boostSprayG.connect(boostLvl);

      /* 气流脉动：喷流不是稳定的，3.4Hz 的轻微起伏让它"有生命" */
      boostLFO = osc('sine', 3.4); boostLFOg = gain(0.05);
      boostLFO.connect(boostLFOg); boostLFOg.connect(boostBodyG.gain);

      /* 涡轮哨音：三角波 + 窄带，音量很低，只在上扫时给"增压"的暗示 */
      boostWhistle = osc('triangle', 900); boostWhistleG = gain(0);
      boostWhistle.connect(boostWhistleG); boostWhistleG.connect(boostLvl);

      /* ---- 刹车：低速只有摩擦（760Hz 低通），高速才叠窄带啸叫 ----
         啸叫 Q 降到 6、中心 2k 左右，避免原来 3.2k/Q9 那种扎耳朵的尖啸。 */
      brakeFric = loopNoise(); brakeFricLP = filt('lowpass', 760, 0.7); brakeFricG = gain(0);
      brakeFric.connect(brakeFricLP); brakeFricLP.connect(brakeFricG); brakeFricG.connect(master);

      brakeSq = loopNoise(); brakeSqBP = filt('bandpass', 2000, 6);
      brakeSqAM = gain(0.7); brakeSqG = gain(0);
      brakeSq.connect(brakeSqBP); brakeSqBP.connect(brakeSqAM); brakeSqAM.connect(brakeSqG);
      brakeSqG.connect(master);
      brakeLFO = osc('sine', 7);
      var blg = gain(0.3); brakeLFO.connect(blg); blg.connect(brakeSqAM.gain);

      /* ---- 漂移：低频摩擦铺底、中频胎噪主体、深漂时高频点缀；11Hz 颤音给"沙"感 ---- */
      driftLow = loopNoise(); driftLowLP = filt('lowpass', 420, 0.9); driftLowG = gain(0);
      driftLow.connect(driftLowLP); driftLowLP.connect(driftLowG); driftLowG.connect(master);

      driftMid = loopNoise(); driftMidBP = filt('bandpass', 900, 1.25); driftMidG = gain(0);
      driftMid.connect(driftMidBP); driftMidBP.connect(driftMidG); driftMidG.connect(master);

      driftHi = loopNoise(); driftHiBP = filt('bandpass', 1500, 2.4);
      driftHiAM = gain(0.72); driftHiG = gain(0);
      driftHi.connect(driftHiBP); driftHiBP.connect(driftHiAM); driftHiAM.connect(driftHiG);
      driftHiG.connect(master);
      driftLFO = osc('sine', 12);
      var dlg = gain(0.28); driftLFO.connect(dlg); dlg.connect(driftHiAM.gain);

      A.ready = true;
    } catch (e) { A.available = false; ctx = null; }
    return A;
  };

  /* 首次用户手势里 resume（键盘 M / 点击画面都算手势） */
  function gesture() {
    if (A.enabled && A.ready && ctx.state === 'suspended' && ctx.resume) {
      var p = ctx.resume();
      if (p && p.catch) p.catch(function () {});
    }
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('keydown', gesture);
    window.addEventListener('pointerdown', gesture);
  }

  A.setEnabled = function (on) {
    on = !!on;
    if (on) {
      if (!A.ready) A.init();
      if (!A.ready) { A.enabled = false; return false; }
      if (ctx.state === 'suspended' && ctx.resume) {
        var p = ctx.resume();
        if (p && p.catch) p.catch(function () {});
      }
    }
    A.enabled = on;
    if (A.ready) master.gain.setTargetAtTime(on ? 0.9 : 0, ctx.currentTime, 0.06);
    /* 关掉时清掉起爆沿：否则"静音 → 开着氮气再打开音效"会误触发一次起爆 */
    if (!on) boostPrev = 0;
    if (on && !engineRunning) A.startEngine();
    return A.enabled;
  };
  A.toggle = function () { return A.setEnabled(!A.enabled); };

  /* ---------------- 启动：起动机抖动 → 点火 → 怠速，0.42s 后接上运转音 ---------------- */
  A.startEngine = function () {
    if (!A.ready) return false;
    if (engineRunning) return false;              /* 已在运转：不重复播启动音 */
    var t0 = ctx.currentTime;
    if (t0 - lastCrank < 0.35) return false;      /* 0.35s 内不重复打火 */
    lastCrank = t0;
    engineRunning = true;
    crankCount++;
    idleTimer = 0;
    engineAt = t0 + 0.42;

    /* 起动机：带通噪声的几次抖动（每次 50~80ms），音量比原来低一点 */
    var s = loopNoise();
    var bp = filt('bandpass', 420, 1.2);
    var g = gain(0);
    s.connect(bp); bp.connect(g); g.connect(master);
    g.gain.setValueAtTime(0.0001, t0);
    [[0.02, 0.26], [0.09, 0.07], [0.15, 0.24], [0.23, 0.05],
     [0.29, 0.21], [0.37, 0.04], [0.43, 0.18], [0.52, 0.0005]].forEach(function (p) {
      g.gain.linearRampToValueAtTime(p[1], t0 + p[0]);
    });
    s.stop(t0 + 0.62);

    /* 低频扫频：30 → 54Hz，点火后转速上冲；过 300Hz 低通，闷而不糊 */
    var o = osc('sawtooth', 30), lp = filt('lowpass', 300, 0.8), og = gain(0);
    o.frequency.setValueAtTime(30, t0);
    o.frequency.linearRampToValueAtTime(54, t0 + 0.42);
    o.connect(lp); lp.connect(og); og.connect(master);
    og.gain.setValueAtTime(0.0001, t0);
    og.gain.linearRampToValueAtTime(0.13, t0 + 0.18);
    og.gain.linearRampToValueAtTime(0.0005, t0 + 0.52);
    o.stop(t0 + 0.58);

    /* 点火瞬态：一小段高通噪声，给"着车"一个清晰的起点 */
    var k = ctx.createBufferSource();
    k.buffer = noiseBuf;
    var hp = filt('highpass', 1100, 0.7), kg = gain(0);
    k.connect(hp); hp.connect(kg); kg.connect(master);
    kg.gain.setValueAtTime(0.0001, t0 + 0.16);
    kg.gain.exponentialRampToValueAtTime(0.05, t0 + 0.19);
    kg.gain.exponentialRampToValueAtTime(0.0004, t0 + 0.34);
    k.start(t0 + 0.16); k.stop(t0 + 0.4);
    return true;
  };
  A.engineRunning = function () { return engineRunning; };

  /* ---------------- 熄火：低频下滑 + 泄气，约 0.55s ---------------- */
  A.shutdown = function () {
    if (!A.ready || !engineRunning) return false;
    engineRunning = false;
    shutCount++;
    engineAt = 0;
    idleTimer = 0;
    lastCrank = -1;           /* 熄火后允许立即重启，不再受打火去重窗口影响 */
    var t0 = ctx.currentTime;

    var o = osc('sawtooth', 58), lp = filt('lowpass', 320, 0.8), og = gain(0);
    o.frequency.setValueAtTime(58, t0);
    o.frequency.exponentialRampToValueAtTime(24, t0 + 0.5);
    o.connect(lp); lp.connect(og); og.connect(master);
    og.gain.setValueAtTime(0.0001, t0);
    og.gain.exponentialRampToValueAtTime(0.15, t0 + 0.02);
    og.gain.exponentialRampToValueAtTime(0.0004, t0 + 0.52);
    o.stop(t0 + 0.56);

    var s = loopNoise(), slp = filt('lowpass', 420, 0.8), sg = gain(0);
    s.connect(slp); slp.connect(sg); sg.connect(master);
    sg.gain.setValueAtTime(0.0001, t0);
    sg.gain.exponentialRampToValueAtTime(0.08, t0 + 0.03);
    sg.gain.exponentialRampToValueAtTime(0.0003, t0 + 0.3);
    s.stop(t0 + 0.34);
    return true;
  };

  /* ---------------- 加载阶段预热 ----------------
     把 AudioContext 与 2s 噪声 buffer 在开局前建好，保持静音（master gain 0），
     首次用户手势再 resume。避免局内第一次按 M 时才分配音频资源造成卡顿。 */
  A.warmup = function () {
    if (!A.ready) A.init();
    return A.ready;
  };

  /* ---------------- 氮气起爆：阀门 + 高压气体释放 ----------------
     真实 N2O 按下的一瞬间是三段：
     ① 电磁阀的「咔」（5ms 级高频瞬态）
     ② 高压气体冲出的「嘶」——宽频噪声，起手最亮，随压力平衡迅速掉下去，
        所以带通中心要从 ~3.2kHz 往下扫到 ~900Hz
     ③ 车体被推力顶一下的低频「轰」
     之后才是 update 里那四层持续喷流。这一段只播一次，由 boostOn 的上升沿触发。 */
  A.nitroBurst = function () {
    if (!A.ready || !A.enabled) return false;
    var t = ctx.currentTime;
    nitroBursts++;

    /* 有真实素材时用它做主体，持续喷流仍然走合成（素材是短促的一声，铺不满） */
    if (samples.nitro) {
      var nb = ctx.createBufferSource();
      nb.buffer = samples.nitro;
      nb.playbackRate.value = 0.96 + 0.1 * ran();
      var nbm = gain(0);
      nb.connect(nbm); nbm.connect(master);
      nbm.gain.setValueAtTime(0.0001, t);
      nbm.gain.exponentialRampToValueAtTime(0.55, t + 0.006);
      nbm.gain.exponentialRampToValueAtTime(0.0005, t + 0.7);
      nb.start(t); nb.stop(t + 0.8);
      return true;
    }

    /* ① 阀门咔哒 */
    var k = ctx.createBufferSource();
    k.buffer = noiseBuf; k.playbackRate.value = 1.4 + 0.3 * ran();
    var khp = filt('highpass', 4200, 0.7), kg = gain(0);
    k.connect(khp); khp.connect(kg); kg.connect(master);
    kg.gain.setValueAtTime(0.0001, t);
    kg.gain.exponentialRampToValueAtTime(0.09, t + 0.004);
    kg.gain.exponentialRampToValueAtTime(0.0004, t + 0.05);
    k.start(t); k.stop(t + 0.09);

    /* ② 气体释放「嘶」：中心频率下扫，前 8ms 起手，340ms 收尾 */
    var s = ctx.createBufferSource();
    s.buffer = noiseBuf; s.playbackRate.value = 0.95 + 0.2 * ran();
    var bp = filt('bandpass', 3200, 0.75), sg = gain(0);
    /* 串一级 7.5kHz 低通：高压气体确实很"嘶"，但 8kHz 以上只剩刺耳，压掉更像喷流 */
    var slp = filt('lowpass', 7500, 0.7);
    bp.frequency.setValueAtTime(3200, t);
    bp.frequency.exponentialRampToValueAtTime(900, t + 0.30);
    s.connect(bp); bp.connect(slp); slp.connect(sg); sg.connect(master);
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(0.42, t + 0.008);
    sg.gain.exponentialRampToValueAtTime(0.16, t + 0.09);
    sg.gain.exponentialRampToValueAtTime(0.0005, t + 0.34);
    s.start(t); s.stop(t + 0.4);

    /* ③ 推力顶一下 */
    var o = osc('sine', 150), og = gain(0);
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.18);
    o.connect(og); og.connect(master);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.26, t + 0.01);
    og.gain.exponentialRampToValueAtTime(0.0005, t + 0.26);
    o.stop(t + 0.3);
    return true;
  };

  /* ---------------- 撞墙：金属护栏撞击 ----------------
     五层合成。真实护栏撞击的听感 = 「叮」的金属余韵 + 「咚」的车身 + 「擦」的钣金，
     单靠一层噪声或一层正弦都不像。强度只改音量、亮度、基频与尾音长度，不改结构：
     ① 接触瞬态：噪声带通 2.4~5.6kHz，2.5ms 起手，35~105ms 衰减
     ② 金属余韵：5 个非谐波泛音（1 / 2.13 / 3.41 / 4.77 / 6.62），高次衰减更快
     ③ 车身闷响：78~118Hz 下滑到 40Hz
     ④ 钣金挤压：中低频噪声（强度够大才出现）
     ⑤ 零件颤振：80~320ms 内 2~5 个极短高频「嗒」，模拟松脱件回弹
     每次撞击的基频有 ±6% 抖动，连续蹭墙不会听起来像同一个采样在循环。 */
  A.hit = function (strength) {
    if (!A.ready || !A.enabled) return false;
    var t = ctx.currentTime;
    if (t - lastHit < 0.05) return false;
    var sIn = Math.max(0, strength || 0);
    if (sIn < 0.30) return false;
    var v = CR.clamp01((sIn - 0.45) / 16);
    if (v < 0.02) v = 0.02;
    lastHit = t; hitCount++;
    var vol = 0.18 + 0.72 * v;
    var jit = 0.94 + 0.12 * ran();          /* 每次撞击的基频抖动 */
    var i, i0;

    /* 若调用方用 A.useSamples() 塞了真实素材，就用素材当主体（合成只补低频重量） */
    if (samples.hit) {
      var sb = ctx.createBufferSource();
      sb.buffer = samples.hit;
      sb.playbackRate.value = 0.92 + 0.16 * v;
      var sbm = gain(0);
      sb.connect(sbm); sbm.connect(master);
      sbm.gain.setValueAtTime(0.0001, t);
      sbm.gain.exponentialRampToValueAtTime(vol * 0.9, t + 0.004);
      sbm.gain.exponentialRampToValueAtTime(0.0005, t + 0.9);
      sb.start(t); sb.stop(t + 1.0);
      var so = osc('sine', 76 + 36 * v), sog = gain(0);
      so.frequency.setValueAtTime(76 + 36 * v, t);
      so.frequency.exponentialRampToValueAtTime(40, t + 0.17);
      so.connect(sog); sog.connect(master);
      sog.gain.setValueAtTime(0.0001, t);
      sog.gain.exponentialRampToValueAtTime(0.30 * vol, t + 0.006);
      sog.gain.exponentialRampToValueAtTime(0.0005, t + 0.20);
      so.stop(t + 0.28);
      return true;
    }

    /* ① 接触瞬态 */
    var s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.playbackRate.value = 0.9 + 0.5 * ran();
    var bp = filt('bandpass', 2400 + 3200 * v, 1.1);
    var g = gain(0);
    s.connect(bp); bp.connect(g); g.connect(master);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol * 0.50, t + 0.0025);
    g.gain.exponentialRampToValueAtTime(0.0006, t + 0.035 + 0.07 * v);
    s.start(t); s.stop(t + 0.26);

    /* ② 金属余韵：非整数倍频 + 逐个递减的衰减，形成「金属味」 */
    var base = (380 + 380 * v) * jit;   /* 波形梁/钢管基频 380~760Hz，低强度也带金属味 */
    var RATIO = [1, 2.13, 3.41, 4.77, 6.62];
    for (i = 0; i < RATIO.length; i++) {
      var o = ctx.createOscillator();
      o.type = i === 0 ? 'triangle' : 'sine';
      o.frequency.setValueAtTime(base * RATIO[i], t);
      o.frequency.exponentialRampToValueAtTime(base * RATIO[i] * 0.982, t + 0.45);
      var og2 = gain(0);
      o.connect(og2); og2.connect(master);
      var amp = vol * (i === 0 ? 0.17 : 0.135 / (i + 0.5));
      og2.gain.setValueAtTime(0.0001, t);
      og2.gain.exponentialRampToValueAtTime(amp, t + 0.004);
      og2.gain.exponentialRampToValueAtTime(0.0004, t + 0.16 + 0.46 / (i + 1));
      o.start(t); o.stop(t + 0.75);
    }

    /* ③ 车身闷响 */
    var o2 = osc('sine', 78 + 40 * v), og3 = gain(0);
    o2.frequency.setValueAtTime(78 + 40 * v, t);
    o2.frequency.exponentialRampToValueAtTime(40, t + 0.17);
    o2.connect(og3); og3.connect(master);
    og3.gain.setValueAtTime(0.0001, t);
    og3.gain.exponentialRampToValueAtTime(0.40 * vol, t + 0.006);
    og3.gain.exponentialRampToValueAtTime(0.0005, t + 0.22);
    o2.stop(t + 0.3);

    /* ④ 钣金挤压（只在撞得够狠时出现，轻蹭不该有） */
    if (v > 0.25) {
      var c = ctx.createBufferSource();
      c.buffer = noiseBuf; c.playbackRate.value = 0.7 + 0.3 * ran();
      var clp = filt('lowpass', 900 + 500 * v, 1.3), cg = gain(0);
      c.connect(clp); clp.connect(cg); cg.connect(master);
      cg.gain.setValueAtTime(0.0001, t + 0.002);
      cg.gain.exponentialRampToValueAtTime(vol * 0.20 * (v - 0.25) / 0.75 + 0.002, t + 0.02);
      cg.gain.exponentialRampToValueAtTime(0.0004, t + 0.12 + 0.14 * v);
      c.start(t); c.stop(t + 0.34);
    }

    /* ⑤ 零件颤振：几个极短的「嗒」，越狠越多、间隔越乱 */
    var n = 2 + Math.round(3 * v);
    i0 = 0.08 + 0.04 * ran();
    for (i = 0; i < n; i++) {
      var tk = ctx.createBufferSource();
      tk.buffer = noiseBuf; tk.playbackRate.value = 1.2 + 0.8 * ran();
      var thp = filt('highpass', 3600 + 900 * ran(), 0.8), tg = gain(0);
      tk.connect(thp); thp.connect(tg); tg.connect(master);
      var tt = t + i0;
      var ta = vol * (0.075 - 0.012 * i);
      if (ta < 0.004) ta = 0.004;
      tg.gain.setValueAtTime(0.0001, tt);
      tg.gain.exponentialRampToValueAtTime(ta, tt + 0.002);
      tg.gain.exponentialRampToValueAtTime(0.0003, tt + 0.03);
      tk.start(tt); tk.stop(tt + 0.05);
      i0 += 0.055 + 0.07 * ran();
    }
    return true;
  };

  /* ---------------- 每帧参数 + 熄火/启动状态机 ---------------- */
  A.update = function (dt, st, input) {
    if (!A.ready || !A.enabled) return;
    var hidden = (typeof document !== 'undefined') && document.hidden;
    var on = !hidden;
    var t = ctx.currentTime;
    var throttle = (input && input.throttle) ? input.throttle : 0;
    var brakePedal = (input && input.brake) ? 1 : 0;
    var hand = (input && input.handbrake) ? 1 : 0;
    var nitroKey = (input && input.nitro) ? 1 : 0;
    var speed = st.speed || 0;

    /* 是否处于"有人在开"的状态：任何踏板、手刹、氮气或车还在动都算 */
    var operating = on && (throttle > 0.02 || brakePedal || hand || nitroKey ||
                           speed > 0.8 || (st.slip || 0) > 0.03);
    if (!on) {
      /* 页面不可见：不推进计时，保持当前状态 */
    } else if (operating) {
      idleTimer = 0;
      if (!engineRunning) A.startEngine();       /* 熄火状态被操作 → 启动一次 */
    } else {
      idleTimer += dt;
      if (engineRunning && idleTimer >= IDLE_OFF) A.shutdown();
    }

    var spd = CR.clamp01(speed / 62);
    var th = on ? throttle : 0;
    var boostOn = on && st.nitroActive ? 1 : 0;
    var br = (on && st.braking && speed > 4) ? CR.clamp01((speed - 4) / 26) : 0;
    var dr = on ? CR.clamp01((st.slip || 0) * 1.25) : 0;

    /* 引擎转速与音色：基频 58~238Hz，低通随转速打开，怠速抖动随车速收掉 */
    var f = 58 + 148 * spd + 30 * th;
    var lift = 1 - CR.clamp01(spd * 1.6);
    eng1.frequency.setTargetAtTime(f, t, 0.07);
    eng1b.frequency.setTargetAtTime(f * 1.004, t, 0.07);
    eng2.frequency.setTargetAtTime(f * 2.01, t, 0.07);
    engSub.frequency.setTargetAtTime(f * 0.5, t, 0.09);
    engBP.frequency.setTargetAtTime(f * 3.4, t, 0.1);
    engineLP.frequency.setTargetAtTime(520 + 1250 * spd + 320 * th, t, 0.1);
    idleDepth.gain.setTargetAtTime(on ? 0.9 * lift : 0, t, 0.15);

    eng1G.gain.setTargetAtTime(on ? 0.11 + 0.06 * th : 0, t, 0.1);
    eng1bG.gain.setTargetAtTime(on ? 0.08 + 0.05 * th : 0, t, 0.1);
    eng2G.gain.setTargetAtTime(on ? 0.05 + 0.05 * th : 0, t, 0.1);
    engSubG.gain.setTargetAtTime(on ? 0.08 + 0.06 * th : 0, t, 0.12);
    engNG.gain.setTargetAtTime(on ? 0.05 + 0.05 * th : 0, t, 0.12);

    var engOn = engineRunning && on && t >= engineAt;
    /* 氮气会把引擎声压住一点：真实 N2O 喷流是宽频强声源，听觉上会盖掉排气 */
    engineBus.gain.setTargetAtTime(engOn ? (0.40 + 0.30 * th) * (boostOn ? 0.82 : 1) : 0,
                                   t, engOn ? 0.12 : 0.16);

    intakeG.gain.setTargetAtTime(on ? 0.11 * th * (0.35 + 0.65 * spd) : 0, t, 0.07);
    intakeBP.frequency.setTargetAtTime(680 + 820 * spd, t, 0.12);

    /* 氮气：起爆沿播一次瞬态，然后四层气流按车速上扫、开阀快关阀慢 */
    if (boostOn && !boostPrev) A.nitroBurst();
    boostPrev = boostOn;
    var bTgt = boostOn ? 0.28 + 0.18 * spd : 0;
    boostLvl.gain.setTargetAtTime(bTgt, t, boostOn ? 0.045 : 0.14);
    /* 车速越高，气流越"亮"：中频与高频随速度抬起，低频反而收一点 */
    boostBody.frequency.setTargetAtTime(520 + 520 * spd, t, 0.14);
    boostAir.frequency.setTargetAtTime(1500 + 1400 * spd, t, 0.16);
    boostSpray.frequency.setTargetAtTime(5800 + 1800 * spd, t, 0.18);
    boostLowG.gain.setTargetAtTime(boostOn ? 0.60 - 0.10 * spd : 0, t, 0.12);
    boostAirG.gain.setTargetAtTime(boostOn ? 0.11 + 0.10 * spd : 0, t, 0.12);
    /* 涡轮哨音：900Hz 起，随车速上扫到约 2.4kHz */
    boostWhistle.frequency.setTargetAtTime(900 + 1500 * spd, t, 0.2);
    boostWhistleG.gain.setTargetAtTime(boostOn ? 0.006 + 0.016 * spd : 0, t, 0.2);

    /* 刹车：低速偏摩擦、高速偏啸叫，两者此消彼长，不会叠成刺耳的一片 */
    var squeal = br * CR.clamp01((speed - 12) / 22);
    brakeFricG.gain.setTargetAtTime(on ? br * 0.12 : 0, t, 0.06);
    brakeFricLP.frequency.setTargetAtTime(620 + 420 * spd, t, 0.12);
    brakeSqG.gain.setTargetAtTime(on ? squeal * 0.11 : 0, t, 0.07);
    brakeSqBP.frequency.setTargetAtTime(1900 + 500 * spd, t, 0.12);

    /* 漂移：低频铺底 + 中频主体 + 深漂高频点缀；颤音随滑移率加快 */
    var deep = CR.clamp01((dr - 0.35) / 0.65);
    driftLowG.gain.setTargetAtTime(on ? dr * 0.12 : 0, t, 0.07);
    driftMidG.gain.setTargetAtTime(on ? dr * 0.12 : 0, t, 0.07);
    driftHiG.gain.setTargetAtTime(on ? deep * 0.06 : 0, t, 0.09);
    driftMidBP.frequency.setTargetAtTime(780 + 480 * dr, t, 0.12);
    driftHiBP.frequency.setTargetAtTime(1420 + 460 * dr, t, 0.1);
    driftLFO.frequency.setTargetAtTime(9 + 6 * dr, t, 0.2);

    lvl.engine = engOn ? (0.40 + 0.30 * th) * (boostOn ? 0.82 : 1) : 0;
    lvl.throttle = on ? 0.11 * th * (0.35 + 0.65 * spd) : 0;
    lvl.boost = boostOn ? bTgt * 1.17 : 0;
    lvl.brake = (on ? br * 0.12 : 0) + (on ? squeal * 0.11 : 0);
    lvl.drift = on ? dr * 0.24 + deep * 0.06 : 0;
  };

  /* ---------------- 可选：用真实录音素材替换合成瞬态 ----------------
     本项目默认零外部素材，全部程序化合成。若你找到了满意的 CC0 / 已授权片段，
     把文件放到 game/audio/ 下再调用本接口即可，不用改任何其它代码：

       CR.Audio.useSamples({ hit: 'audio/hit.ogg', nitro: 'audio/nitro.ogg' })
         .then(function (ok) { console.log('替换成功', ok); });

     行为：
       · hit   —— 整次撞击的主体换成素材，合成只保留 ~40Hz 的低频重量；
       · nitro —— 起爆那一声换成素材，持续喷流仍然是合成（素材太短，铺不满）。
     解码失败只会让对应槽保持 null，自动回退到合成，不会静音、不会抛到主循环。 */
  A.useSamples = function (urls) {
    if (!A.ready) A.init();
    if (!A.ready || !ctx) return Promise.resolve([]);
    var keys = Object.keys(urls || {});
    return Promise.all(keys.map(function (k) {
      if (k !== 'hit' && k !== 'nitro') return null;
      return fetch(urls[k]).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      }).then(function (ab) {
        return new Promise(function (res, rej) {
          ctx.decodeAudioData(ab, res, function (e) { rej(e || new Error('decode fail')); });
        });
      }).then(function (buf) { samples[k] = buf; return k; })
        .catch(function (e) {
          if (window.console) console.warn('[Audio] sample "' + k + '" 不可用，回退合成：', e && e.message);
          return null;
        });
    })).then(function (list) {
      return list.filter(Boolean);
    });
  };

  /* ---------------- 频谱自检（验收用，运行时不调用） ----------------
     返回当前输出的 RMS、频谱重心、峰值频点与四段能量占比。
     用来确认碰撞是「宽频 + 有金属峰」而不是一团低频噪声。 */
  A.spectrum = function () {
    if (!A.ready || !analyser) return null;
    if (!specBuf || specBuf.length !== analyser.frequencyBinCount) {
      specBuf = new Float32Array(analyser.frequencyBinCount);
    }
    analyser.getFloatFrequencyData(specBuf);
    var sr = ctx.sampleRate, n = specBuf.length, df = sr / (n * 2);
    var sum = 0, wsum = 0, peak = -200, peakF = 0;
    var band = { low: 0, mid: 0, high: 0, air: 0 };
    for (var i = 1; i < n; i++) {
      var f = i * df;
      var db = specBuf[i];
      if (db < -110) continue;
      var p = Math.pow(10, db / 10);           /* 功率 */
      sum += p; wsum += p * f;
      if (db > peak) { peak = db; peakF = f; }
      if (f < 200) band.low += p;
      else if (f < 2000) band.mid += p;
      else if (f < 8000) band.high += p;
      else band.air += p;
    }
    var tot = sum || 1;
    if (!timeBuf || timeBuf.length !== analyser.fftSize) timeBuf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(timeBuf);
    var r = 0;
    for (var k = 0; k < timeBuf.length; k++) r += timeBuf[k] * timeBuf[k];
    return {
      rms: +Math.sqrt(r / timeBuf.length).toFixed(4),
      peakDb: +peak.toFixed(1), peakHz: Math.round(peakF),
      centroidHz: Math.round(wsum / tot),
      bands: {
        low: +(band.low / tot).toFixed(3), mid: +(band.mid / tot).toFixed(3),
        high: +(band.high / tot).toFixed(3), air: +(band.air / tot).toFixed(3)
      }
    };
  };

  A.diag = function () {
    return {
      available: A.available, ready: A.ready, enabled: A.enabled,
      state: (A.ready && ctx) ? ctx.state : 'none',
      engine: engineRunning, idle: +idleTimer.toFixed(2), hits: hitCount,
      cranks: crankCount, shuts: shutCount, bursts: nitroBursts,
      boostLayers: 4, samples: { hit: !!samples.hit, nitro: !!samples.nitro },
      levels: { engine: +lvl.engine.toFixed(3), throttle: +lvl.throttle.toFixed(3),
                boost: +lvl.boost.toFixed(3), brake: +lvl.brake.toFixed(3),
                drift: +lvl.drift.toFixed(3) }
    };
  };
})();
