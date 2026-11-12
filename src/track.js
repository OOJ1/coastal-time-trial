/* =========================================================================
 * track.js — 闭合环道：18 控制点 / 等弧长重采样 / 空间哈希最近点查询
 * 行进方向：北(发车直道,向西) → 西(内陆缓坡) → 南(海湾S弯,向东迎落日)
 *          → 东(沿海直冲) → 回北，逆时针。lat>0 = 行驶方向左侧(环内)。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var T = CR.Track = {};

  T.CELL = 40;
  /* 规格常量：顶层 CR.ROAD_HALF 供其它模块直接引用，
     T.* 系列供赛道自身与 P12 物理约束使用 */
  CR.ROAD_HALF = T.ROAD_HALF = CR.CFG.ROAD_HALF;
  CR.outerLimit = T.outerLimit = CR.CFG.outerLimit;
  CR.innerRailLimit = T.innerRailLimit = CR.CFG.innerRailLimit;
  CR.innerSoftLimit = T.innerSoftLimit = CR.CFG.innerSoftLimit;
  var tmpNear = {};

  /* 18 个控制点 (x,z)：北直道西行 → 西侧下行 → 南侧 S 弯 → 东侧北上 */
  var CTRL = [
    [120, -175], [60, -178], [0, -180], [-60, -180], [-120, -176],
    [-178, -150], [-205, -80], [-210, 0], [-200, 80],
    [-165, 140], [-105, 170], [-40, 155], [20, 178],
    [85, 172], [150, 150], [205, 70], [210, -40], [180, -140]
  ];

  /* 控制点暴露出来：改这里就能改赛道形状，下游模块只读 T.*，
     不需要跟着改代码（round-trip 由 T.build() 重算全部派生量）。 */
  T.CTRL = CTRL;

  /* 基础高程：东/南贴海约 4.6m，西侧内陆爬升到约 16m */
  CR.baseElev = function (x, z) {
    var w = CR.ss(-180, 120, -x);
    var south = CR.ss(-100, 180, z);
    var north = CR.ss(120, -180, z);
    var n = CR.fbm(x * 0.004, z * 0.004, 4, CR.SALT.track);
    return 4.6 + 11.5 * w * south + 3.0 * north * (1 - 0.5 * w) + (n - 0.5) * 1.8;
  };
  CR.SEA = 1.6;

  function key(ix, iz) { return ix * 4096 + iz; }

  T.build = function () {
    var ctrl = CTRL.map(function (p) {
      return new THREE.Vector3(p[0], CR.baseElev(p[0], p[1]), p[1]);
    });
    var curve = new THREE.CatmullRomCurve3(ctrl, true, 'centripetal');
    curve.arcLengthDivisions = 4000;
    var L = curve.getLength();
    var N = Math.max(64, Math.round(L / 2));
    var sp = curve.getSpacedPoints(N);            // N+1 点，末点 = 起点

    T.L = L; T.N = N; T.ds = L / N; T.curve = curve;
    ['px', 'py', 'pz', 'tx', 'tz', 'lx', 'lz', 'slope', 'kappa'].forEach(function (k) {
      T[k] = new Float32Array(N);
    });
    var i;
    for (i = 0; i < N; i++) {
      T.px[i] = sp[i].x; T.py[i] = sp[i].y; T.pz[i] = sp[i].z;
    }
    for (i = 0; i < N; i++) {
      var p = (i - 1 + N) % N, q = (i + 1) % N;
      var dx = T.px[q] - T.px[p], dz = T.pz[q] - T.pz[p];
      var len = Math.hypot(dx, dz) || 1;
      T.tx[i] = dx / len; T.tz[i] = dz / len;
      /* 左法向 = up × forward = (tz, 0, -tx) */
      T.lx[i] = T.tz[i]; T.lz[i] = -T.tx[i];
      T.slope[i] = (T.py[q] - T.py[p]) / (2 * T.ds);
    }
    /* 带符号曲率：±6 点跨度，左弯为正 */
    for (i = 0; i < N; i++) {
      var a = (i - 6 + N) % N, b = (i + 6) % N;
      var aa = Math.atan2(T.tx[a], T.tz[a]), bb = Math.atan2(T.tx[b], T.tz[b]);
      T.kappa[i] = CR.angDiff(aa, bb) / (12 * T.ds);
    }

    /* 分段索引（供护栏 / 防波堤 / 电线杆分区使用） */
    T.iStraight0 = Math.floor(N * 0.00); T.iStraight1 = Math.floor(N * 0.17);
    T.iWest0 = Math.floor(N * 0.22); T.iWest1 = Math.floor(N * 0.45);
    T.iWall0 = Math.floor(N * 0.50); T.iWall1 = Math.floor(N * 0.72);
    T.iEast0 = Math.floor(N * 0.76); T.iEast1 = Math.floor(N * 0.95);

    buildHash();
    T.ready = true;
    return T;
  };

  /* 空间哈希：段 AABB 登记到格子。两条硬性约束，都是踩过坑的：
     ① pad 必须为 0（段一定落在它自己的那一格），早先外扩一整个 CELL(40m)，
        一条 2m 的段要写进 4×4=16 格，格内段数从 ~4 膨胀到 ~27；
     ② 必须用 Map，不能用伪整数键的普通对象——key=ix*4096+iz 是 ~5×10^5 的
        大整数，V8 会退化到字典模式，单次查找实测 1.2µs（远景点逐环扩张
        441 次查找就吃掉 0.5ms）。 */
  var hash = new Map();
  function buildHash() {
    hash = new Map();
    var N = T.N;
    for (var i = 0; i < N; i++) {
      var j = (i + 1) % N;
      var x0 = Math.floor(Math.min(T.px[i], T.px[j]) / T.CELL);
      var x1 = Math.floor(Math.max(T.px[i], T.px[j]) / T.CELL);
      var z0 = Math.floor(Math.min(T.pz[i], T.pz[j]) / T.CELL);
      var z1 = Math.floor(Math.max(T.pz[i], T.pz[j]) / T.CELL);
      for (var ix = x0; ix <= x1; ix++) {
        for (var iz = z0; iz <= z1; iz++) {
          var k = key(ix, iz);
          var cell = hash.get(k);
          if (!cell) { cell = []; hash.set(k, cell); }
          cell.push(i);
        }
      }
    }
  }

  function project(i, x, z, best) {
    var j = (i + 1) % T.N;
    var dx = T.px[j] - T.px[i], dz = T.pz[j] - T.pz[i];
    var len2 = dx * dx + dz * dz || 1e-6;
    var t = CR.clamp01(((x - T.px[i]) * dx + (z - T.pz[i]) * dz) / len2);
    var cx = T.px[i] + dx * t, cz = T.pz[i] + dz * t;
    var ex = x - cx, ez = z - cz, d2 = ex * ex + ez * ez;
    if (d2 < best.d2) { best.d2 = d2; best.i = i; best.t = t; best.cx = cx; best.cz = cz; }
  }
  function blank() { return { d2: Infinity, i: 0, t: 0, cx: 0, cz: 0 }; }

  /* nearest(x,z,out) → {i,t,s,lat,d,y,tx,tz,lx,lz,slope}
     逐环扩张搜索（可证明收敛）+ 步长 6 粗扫 / ±6 细化兜底，任何坐标都有解。 */
  function fill(best, x, z, out) {
    var a = best.i, b = (a + 1) % T.N, t = best.t;
    out.i = a; out.t = t;
    out.d = Math.sqrt(best.d2);
    out.s = (a + t) * T.ds;
    out.y = CR.lerp(T.py[a], T.py[b], t);
    var tx = CR.lerp(T.tx[a], T.tx[b], t), tz = CR.lerp(T.tz[a], T.tz[b], t);
    var l = Math.hypot(tx, tz) || 1;
    out.tx = tx / l; out.tz = tz / l;
    out.lx = out.tz; out.lz = -out.tx;
    out.lat = (x - best.cx) * out.lx + (z - best.cz) * out.lz;
    out.slope = CR.lerp(T.slope[a], T.slope[b], t);
    return out;
  }

  /* nearest(x,z,out) → {i,t,s,lat,d,y,tx,tz,lx,lz,slope}
     两级查询，任意坐标都有解、且都不退化：
     ① 先查 3×3 邻格。段登记在它自己所在的格（buildHash 的 pad=0），
        所以距 p 不超过 CELL(40m) 的段一定落在这 9 格里 —— 只要 3×3 就得到
        d < CELL 的结果，它就是全局最优，可证精确（物理 / 护栏 / 贴地都走这条）。
     ② 3×3 没命中或结果 ≥ CELL：退化为步长 6 段的粗扫 + ±8 / ±2 两轮细化。
        投影次数恒定 134 次、与距离无关。早先的"逐环扩张"在 4500m 外要扫
        5 万个格子（0.6ms/顶点 × 17.6 万顶点 = 140 秒假死），不要再改回去。 */
  T.nearest = function (x, z, out) {
    out = out || {};
    var best = blank(), i, cell, ax, az;
    var ix = Math.floor(x / T.CELL), iz = Math.floor(z / T.CELL);
    for (az = -1; az <= 1; az++) {
      for (ax = -1; ax <= 1; ax++) {
        cell = hash.get(key(ix + ax, iz + az));
        if (cell) for (i = 0; i < cell.length; i++) project(cell[i], x, z, best);
      }
    }
    if (best.d2 < T.CELL * T.CELL) return fill(best, x, z, out);
    for (i = 0; i < T.N; i += 6) project(i, x, z, best);
    for (i = -8; i <= 8; i++) project(CR.wrap(best.i + i, T.N), x, z, best);
    for (i = -2; i <= 2; i++) project(CR.wrap(best.i + i, T.N), x, z, best);
    return fill(best, x, z, out);
  };

  /* 只要段索引的快捷版（栏杆立柱 / 树木避让这类） */
  T.indexNear = function (x, z) { return T.nearest(x, z, tmpNear).i; };

  /* 按弧长取点（可带横向偏移），供沿赛道摆放物件与发车线使用 */
  T.pointAt = function (s, lat, out) {
    out = out || {};
    s = CR.wrap(s, T.L);
    var f = s / T.ds, i = Math.floor(f) % T.N, j = (i + 1) % T.N, t = f - Math.floor(f);
    var lx = CR.lerp(T.lx[i], T.lx[j], t), lz = CR.lerp(T.lz[i], T.lz[j], t);
    var ln = Math.hypot(lx, lz) || 1;
    lx /= ln; lz /= ln;
    out.lx = lx; out.lz = lz;
    /* 由左法向 l=(tz,-tx) 反推切线：tx=-lz, tz=lx */
    out.tx = -lz; out.tz = lx;
    out.x = CR.lerp(T.px[i], T.px[j], t) + lx * (lat || 0);
    out.y = CR.lerp(T.py[i], T.py[j], t);
    out.z = CR.lerp(T.pz[i], T.pz[j], t) + lz * (lat || 0);
    out.s = s; out.i = i;
    out.slope = CR.lerp(T.slope[i], T.slope[j], t);
    return out;
  };

  T.headingAt = function (s) {
    var p = T.pointAt(s, 0);
    return Math.atan2(p.tx, p.tz);
  };
})();
