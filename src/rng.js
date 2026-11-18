/* =========================================================================
 * rng.js — 全局单例 / 数学 / 确定性 PRNG / 噪声 / 集中配置
 * 经典 script，window.CR 单例，无构建、无框架。
 *
 * 规格要点：
 *   CR.SEED 为固定整数；CR.rng(salt) = SEED ^ imul(salt, 0x9E3779B1)，
 *   每个子系统用不同 salt（贴图 5~173、赛道 301/501、树木 701~780、特效 901），
 *   互不干扰且完全可复现。
 *   CR.time = { value: 0 } 是**同一个对象**，可以直接塞进 ShaderMaterial.uniforms，
 *   全引擎共享一份时间（灯塔脉冲 / 波浪 / 旗帜 / 颗粒都读它）。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR = window.CR || {};

  CR.VERSION = '2.2.14-test2';

  /* ---------------- 固定种子 ----------------
     改这个数会让整个世界（贴图 / 树木 / 房屋 / 裂缝）整体换一套，
     但同一次构建内所有随机结果逐字节可复现。 */
  CR.SEED = 20241111;

  CR.time = { value: 0 };          // 全局共享 uniform 对象（勿替换引用）
  CR.autoInput = null;             // 外部接管输入（自动驾驶 / 回放 / 录屏）
  CR.maxAniso = 1;
  CR.scene = null; CR.camera = null; CR.renderer = null;
  CR.SUN = null;                   // sky.js 设为归一化 Vector3

  /* 规格数值集中在这里。autoQuality 会在软件渲染器上自动降一档，
     真实 GPU 走满配；把 autoQuality 置 false 即严格使用规格值。 */
  CR.CFG = {
    STEP: 1 / 120,
    SUN: [0.97, 0.118, 0.20],
    ROAD_HALF: 5.0,
    outerLimit: 5.8, innerRailLimit: 5.8, innerSoftLimit: 10.5,
    /* 阴影贴图默认 2048：相机覆盖 150m → 每纹素 7.3cm，PCF 软阴影下差别很小，
       但填充率只有 4096 的 1/4 —— 实测停掉阴影重绘能涨 34%，这是最大单项开销。 */
    SHADOW: 2048, TERR_N: 420, TERR_EXT: 4500,
    OCEAN_N: 220, OCEAN_EXT: 11500,
    TREES: 850, SEAGULLS: 11,
    WHEEL_R: 0.335, WB: 2.65, AX_F: 1.35, AX_R: -1.30,
    /* 每米前进量对应的车轮弧度（视觉系数）。默认 0.72 = 原来的 0.012*60，
       物理正确值是 1/WHEEL_R ≈ 2.985，想更真实可改这个数，不影响任何帧率一致性。 */
    wheelSpin: 0.72,
    /* 冲线彩条：冷却 20s；粒子数；是否任意正向跨线都放（默认只完成一圈时放） */
    confettiCD: 20, confettiCount: 180, confettiEveryCross: false,
    /* 草地纵向阻力（旧实现硬编码 0.55，按需求降到 0.30） */
    offroadDrag: 0.30,
    /* ---- 圈速校验（防抄近道 / 防伪造）----
       赛道 L≈1333.13m，按 car.js 纵向动力学解稳态极速（最乐观：全程满氮气、
       铺装路、不减速），得物理上绝对不可能更快的一圈：
         车0 原厂跑车 70.48 m/s → 18.915 s → 18915 ms（平衡后推力/极速上调）
         车1 MP4/4    72.38 m/s → 18.418 s → 18418 ms
       比这更快 = 伪造/外挂，不计成绩；服务端用同一组数做二次拦截。 */
    LAP_LIMIT_MS: [18915, 18418],
    /* 检查点：沿弧长均分 8 个，位置 (k+0.5)/8·L，避开起终线。
       横向覆盖车辆可达的全部范围：外侧 outerLimit=5.8、内侧 innerSoftLimit=10.5，
       两侧各留 2m 余量，走草地/蹭护栏都算通过，不会漏判。 */
    CHECK_COUNT: 8,
    CHECK_GATE_HALF: 12,          // 纵向窗口 ±12m（71m/s @60fps 仅 1.2m/帧）
    CHECK_LAT_MIN: -7.8,
    CHECK_LAT_MAX: 12.5,
    autoQuality: true,
    /* 自动画质档：按真实 fps 逐级降纯视觉效果（可设 false 锁定满配用于验收） */
    autoTier: true,
    /* 阴影贴图重绘上限（Hz）。太阳跟着车做纹素对齐，光源与阴影矩阵必须
       在同一帧更新，否则车影会来回抽动（见 sky.js / main.js 注释）。
       60 表示 ≤60fps 时每帧更新；低性能设备由 main.js qualityCheck 降到 30。
       设 0 = 不节流（高刷屏上车影完全跟手，但 4096² 阴影每帧重绘约 -20% 帧率）。 */
    shadowHz: 60,
    /* 软阴影（PCFSoft = 9 次采样）。关掉用 PCF（4 次）：阴影边略硬，但省一半采样 */
    shadowSoft: false
  };
  CR.quality = {
    shadow: CR.CFG.SHADOW, terr: CR.CFG.TERR_N,
    ocean: CR.CFG.OCEAN_N, trees: CR.CFG.TREES, snow: 144, scale: 1,
    msaa: 4, tier: 0,
    /* devicePixelRatio 上限：桌面 1.25（原 1.5，高 DPI 屏上像素数差 30%），
       触屏由 main.js 收紧到 1.0 */
    dprCap: 1.25
  };

  /* ---------------- 氮气（P-N1） ----------------
     唯一状态源是 Car.state.nitro / nitroActive / nitroArmed；
     其它模块只读，不各存一份开关。所有速率都是「每秒」，乘 dt 结算，与帧率无关。 */
  CR.NITRO = {
    BURN: 0.28,          // 激活时每秒消耗
    REGEN: 0.075,        // 未激活时每秒回充
    DRIFT_GAIN: 0.14,    // 漂移时额外充能/秒（弯道漂移充能）
    MIN_START: 0.05,     // 低于此值：强制关闭 + 上锁
    REARM: 0.15,         // 回充到此值才解锁（滞回上阈值）
    THRUST: 7.5,         // 附加纵向加速度 m/s²
    VMAX: 84,            // 推力衰减参考速度 m/s（软上限，不硬夹）
    DRAG_SCALE: 0.7,     // 氮气时风阻系数缩放
    OFFROAD_SCALE: 0.5   // 氮气时越野阻力缩放
  };

  /* ---------------- 数学 ---------------- */
  CR.clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
  CR.clamp01 = function (v) { return CR.clamp(v, 0, 1); };
  CR.lerp = function (a, b, t) { return a + (b - a) * t; };
  CR.smoothstep = function (a, b, x) { var t = CR.clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  /* ss 支持 e0 > e1 的反向 smoothstep（"距离越远越弱"大量使用） */
  CR.ss = function (e0, e1, x) {
    var t = CR.clamp01((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
  };
  /* 最短角差：把 b-a 归一化到 (-π, π] */
  CR.angDiff = function (a, b) {
    var d = (b - a + Math.PI) % (Math.PI * 2);
    if (d < 0) d += Math.PI * 2;
    return d - Math.PI;
  };
  CR.damp = function (rate, dt) { return 1 - Math.exp(-dt * rate); };
  CR.wrap = function (v, m) { return ((v % m) + m) % m; };

  /* ---------------- mulberry32 种子 PRNG ----------------
     CR.rng(salt) 用固定 SEED 与盐做一次 32 位混合，得到彼此独立的随机流。
     同一个 salt 永远得到同一串数；不同 salt 之间统计上互不相关。 */
  CR.rng = function (salt) {
    var s = (CR.SEED ^ Math.imul((salt == null ? 1 : salt) | 0, 0x9E3779B1)) | 0;
    if (s === 0) s = 0x6D2B79F5;
    var f = function () {
      s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    f.range = function (a, b) { return a + (b - a) * f(); };
    f.int = function (n) { return Math.floor(f() * n); };
    f.sign = function () { return f() < 0.5 ? -1 : 1; };
    return f;
  };

  /* ---------------- 值噪声 / fbm / 可平铺版本 ---------------- */
  CR.hash2 = function (ix, iy, seed) {
    var h = Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed | 0, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  function fade(t) { return t * t * (3 - 2 * t); }

  CR.noise2 = function (x, y, seed) {
    var ix = Math.floor(x), iy = Math.floor(y);
    var fx = fade(x - ix), fy = fade(y - iy);
    var a = CR.hash2(ix, iy, seed), b = CR.hash2(ix + 1, iy, seed);
    var c = CR.hash2(ix, iy + 1, seed), d = CR.hash2(ix + 1, iy + 1, seed);
    return CR.lerp(CR.lerp(a, b, fx), CR.lerp(c, d, fx), fy);
  };
  CR.fbm = function (x, y, oct, seed) {
    oct = oct || 4;
    var sum = 0, amp = 0.5, norm = 0, f = 1;
    for (var i = 0; i < oct; i++) {
      sum += amp * CR.noise2(x * f, y * f, (seed || 0) + i * 17);
      norm += amp; amp *= 0.5; f *= 2.03;
    }
    return sum / norm;
  };

  /* 可平铺噪声：x/y 是"格坐标"（已乘过周期），pu/pv 是 x/y 两个方向的周期格数。
     格子索引对周期取模 → x 方向走满 pu 格、y 方向走满 pv 格后正好回到起点，
     所以 Canvas 贴图四边天然无缝。
     （x/y 分开给周期，是为了让横向拉伸的贴图（路肩、横幅）也能各向无缝。） */
  CR.tnoise = function (x, y, pu, pv, seed) {
    var ix = Math.floor(x), iy = Math.floor(y);
    var fx = fade(x - ix), fy = fade(y - iy);
    pu = pu || 1; pv = pv || 1;
    var x0 = CR.wrap(ix, pu), x1 = CR.wrap(ix + 1, pu);
    var y0 = CR.wrap(iy, pv), y1 = CR.wrap(iy + 1, pv);
    var a = CR.hash2(x0, y0, seed), b = CR.hash2(x1, y0, seed);
    var c = CR.hash2(x0, y1, seed), d = CR.hash2(x1, y1, seed);
    return CR.lerp(CR.lerp(a, b, fx), CR.lerp(c, d, fx), fy);
  };

  /* 可平铺 fbm：u/v 取 [0,1]，pu/pv 是基础周期格数，**每阶翻倍**。
     第 i 阶在第 i 阶自己的周期内首尾相接，因此整条 fbm 也严格无缝。 */
  CR.tfbm = function (u, v, pu, pv, oct, seed) {
    oct = oct || 4;
    pu = pu || 1; pv = pv || 1;
    var sum = 0, amp = 0.5, norm = 0, a = pu, b = pv;
    for (var i = 0; i < oct; i++) {
      sum += amp * CR.tnoise(u * a, v * b, a, b, (seed || 0) + i * 17);
      norm += amp; amp *= 0.5; a *= 2; b *= 2;
    }
    return sum / norm;
  };

  /* ---------------- r149 颜色空间适配 ----------------
   * SRGBColorSpace 常量在 r149 已存在，但 Texture.colorSpace 属性尚未成为主流；
   * 这里做双写，保证 texture.encoding 与 colorSpace whichever 生效都正确。 */
  CR.srgb = function (t) {
    if (THREE.SRGBColorSpace !== undefined) t.colorSpace = THREE.SRGBColorSpace;
    if (THREE.sRGBEncoding !== undefined) t.encoding = THREE.sRGBEncoding;
    return t;
  };

  /* ---------------- 盐表（唯一真源，避免两个子系统撞流） ---------------- */
  CR.SALT = {
    texRoad: 5, texShoulder: 11, texGrass: 17, texSand: 23, texRock: 29,
    texConcrete: 37, texRust: 43, texRoof: 47, texPlaster: 59, texWood: 61,
    texFoliage: 67, texLight: 71, texWater: 79, texRim: 83, texDust: 89,
    texBanner: 97, texCrack: 101, geo: 131,
    track: 301, road: 501,
    tree0: 701, tree1: 702, tree2: 703, rock: 711, pole: 721,
    house: 731, gull: 741, buoy: 751, weed: 761, island: 771,
    boat: 775, arch: 780,
    fx: 901, confetti: 903, snow: 907
  };
})();
