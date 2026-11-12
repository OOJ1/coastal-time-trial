/* =========================================================================
 * car.js — P11 程序化低趴双门跑车 + P12 驾驶物理
 * 车头朝局部 +z；航向 psi 增大 = 左转；前向 f=(sinψ,cosψ)，左向 l=(cosψ,-sinψ)
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var Car = CR.Car = {};
  var C = CR.CFG;

  Car.WHEEL_R = C.WHEEL_R; Car.WB = C.WB; Car.AX_F = C.AX_F; Car.AX_R = C.AX_R;

  Car.state = {
    x: 0, y: 0, z: 0, psi: 0,
    vx: 0, vz: 0, vf: 0, vl: 0, speed: 0,
    yawRate: 0, steer: 0, delta: 0,
    grip: 9.5, drifting: false, slip: 0,
    lat: 0, s: 0, acc: 0, latAcc: 0, slope: 0,
    offroad: false, braking: false,
    nitro: 1, nitroActive: false, nitroArmed: true,
    hitAcc: 0              /* 撞击强度累加器：Car.step 写、main.js 消费清零（音效用） */
  };

  /* ---------------- loft：沿车长放样超椭圆截面 ---------------- */
  function sp(c, e) { return (c < 0 ? -1 : 1) * Math.pow(Math.abs(c), e); }
  function cr4(a, b, c, d, t) {
    return 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t
                  + (-a + 3 * b - 3 * c + d) * t * t * t);
  }
  /* st 站点表 [{z,w,h,y}]，Catmull-Rom 插值；th0..th1 为截面角范围 */
  Car.loft = function (st, u0, u1, nz, th0, th1, nt, e, grow, caps) {
    var P = [], U = [], I = [], k, j;
    for (k = 0; k <= nz; k++) {
      var u = u0 + (u1 - u0) * k / nz;
      var fi = u * (st.length - 1), i = Math.min(st.length - 2, Math.max(0, Math.floor(fi))), t = fi - i;
      var a = st[Math.max(0, i - 1)], b = st[i], c = st[i + 1], d = st[Math.min(st.length - 1, i + 2)];
      var z = cr4(a.z, b.z, c.z, d.z, t);
      var w = Math.max(0.01, cr4(a.w, b.w, c.w, d.w, t));
      var h = Math.max(0.01, cr4(a.h, b.h, c.h, d.h, t));
      var y = cr4(a.y, b.y, c.y, d.y, t);
      var g = 1 + (grow || 0) * (u - 0.5);
      for (j = 0; j <= nt; j++) {
        var th = th0 + (th1 - th0) * j / nt;
        P.push(sp(Math.cos(th), e) * w * g, y + sp(Math.sin(th), e) * h * g, z);
        U.push(j / nt, u);
      }
    }
    var row = nt + 1;
    for (k = 0; k < nz; k++) {
      for (j = 0; j < nt; j++) {
        var p0 = k * row + j, p1 = p0 + row, p2 = p0 + 1, p3 = p1 + 1;
        I.push(p0, p1, p2, p2, p1, p3);
      }
    }
    if (caps) {
      [0, nz].forEach(function (kk) {
        var base = kk * row, cen = P.length / 3;
        var cx = 0, cy = 0, cz = 0, m;
        for (m = 0; m <= nt; m++) { cx += P[(base + m) * 3]; cy += P[(base + m) * 3 + 1]; cz += P[(base + m) * 3 + 2]; }
        cx /= (nt + 1); cy /= (nt + 1); cz /= (nt + 1);
        P.push(cx, cy, cz); U.push(0.5, kk ? 1 : 0);
        for (m = 0; m < nt; m++) {
          if (kk === 0) I.push(cen, base + m + 1, base + m);
          else I.push(cen, base + m, base + m + 1);
        }
      });
    }
    var g2 = new THREE.BufferGeometry();
    g2.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g2.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    g2.setIndex(I);
    g2.computeVertexNormals();
    return g2;
  };

  /* BODY 11 站 / CABIN 7 站 */
  var BODY = [
    { z: -2.25, w: 0.72, h: 0.20, y: 0.52 }, { z: -2.05, w: 0.90, h: 0.28, y: 0.53 },
    { z: -1.65, w: 0.94, h: 0.32, y: 0.54 }, { z: -1.10, w: 0.95, h: 0.33, y: 0.54 },
    { z: -0.50, w: 0.96, h: 0.34, y: 0.55 }, { z: 0.00, w: 0.96, h: 0.34, y: 0.55 },
    { z: 0.55, w: 0.95, h: 0.33, y: 0.55 }, { z: 1.10, w: 0.93, h: 0.31, y: 0.54 },
    { z: 1.65, w: 0.88, h: 0.28, y: 0.53 }, { z: 2.05, w: 0.78, h: 0.23, y: 0.51 },
    { z: 2.25, w: 0.62, h: 0.18, y: 0.50 }
  ];
  var CABIN = [
    { z: -1.35, w: 0.02, h: 0.02, y: 0.86 }, { z: -1.10, w: 0.62, h: 0.20, y: 0.92 },
    { z: -0.60, w: 0.76, h: 0.30, y: 1.02 }, { z: 0.00, w: 0.78, h: 0.31, y: 1.04 },
    { z: 0.55, w: 0.72, h: 0.27, y: 1.00 }, { z: 0.95, w: 0.56, h: 0.18, y: 0.92 },
    { z: 1.15, w: 0.02, h: 0.02, y: 0.86 }
  ];

  function materialSet() {
    return {
      paint: new THREE.MeshPhysicalMaterial({
        color: 0x6e1216, metalness: 0.62, roughness: 0.34,
        clearcoat: 1.0, clearcoatRoughness: 0.07, envMapIntensity: 1.25
      }),
      glass: new THREE.MeshPhysicalMaterial({
        color: 0x141c26, metalness: 0.1, roughness: 0.12, transparent: true,
        opacity: 0.72, envMapIntensity: 1.4
      }),
      chrome: new THREE.MeshStandardMaterial({ color: 0xc8ccd2, metalness: 0.95, roughness: 0.18, envMapIntensity: 1.2 }),
      dark: new THREE.MeshStandardMaterial({ color: 0x141518, metalness: 0.25, roughness: 0.85 }),
      drl: new THREE.MeshStandardMaterial({ color: 0xfff2d0, emissive: 0xffd9a0, emissiveIntensity: 2.6 }),
      head: new THREE.MeshStandardMaterial({ color: 0xfff6e0, emissive: 0xffedc0, emissiveIntensity: 3.2 }),
      tail: new THREE.MeshStandardMaterial({ color: 0x8e1008, emissive: 0xff2410, emissiveIntensity: 0.9 })
    };
  }

  /* ---------------- 轮组细节 ----------------
     5 根立体轮辐 + 中心盖 + 5 颗螺栓 + 2 道胎面环，顶点色合并成 1 份几何，
     挂在 spin 下随车轮一起滚动。每个轮子只多 1 个 draw call。 */
  function wheelDetailGeo(side) {
    var parts = [], i, a, R = C.WHEEL_R;
    function add(g, c, x, y, z, rx) {
      CR.Geo.tint(g, c, 0, 0, 0);
      parts.push(CR.Geo.place(g, x, y, z, rx || 0, 0, 0));
    }
    /* 轮辐：长边沿 y，绕 x 轴转进 yz 平面 */
    for (i = 0; i < 5; i++) {
      a = i / 5 * Math.PI * 2;
      add(CR.Geo.box(0.035, R * 1.36, 0.075, 1), [0.70, 0.73, 0.77], side * 0.145, 0, 0, a);
    }
    var cap = new THREE.CylinderGeometry(0.075, 0.075, 0.045, 12);
    cap.rotateZ(Math.PI / 2);
    add(cap, [0.22, 0.24, 0.27], side * 0.165, 0, 0);
    for (i = 0; i < 5; i++) {
      a = i / 5 * Math.PI * 2 + 0.3;
      add(new THREE.SphereGeometry(0.022, 6, 4), [0.90, 0.91, 0.93],
          side * 0.172, Math.cos(a) * 0.105, Math.sin(a) * 0.105);
    }
    /* 胎面环：法线沿 x，落在轮胎宽度内 */
    [-0.085, 0.085].forEach(function (xx) {
      var t = new THREE.TorusGeometry(R * 0.985, 0.020, 6, 18);
      t.rotateY(Math.PI / 2);
      add(t, [0.075, 0.078, 0.085], xx, 0, 0);
    });
    var g = CR.Geo.merge(parts);
    parts.forEach(function (p) { p.dispose(); });
    return g;
  }

  Car.create = function (scene) {
    var M = materialSet(), root = new THREE.Group();
    root.rotation.order = 'YXZ';
    var body = new THREE.Group();
    root.add(body);

    var shell = new THREE.Mesh(Car.loft(BODY, 0, 1, 40, 0, Math.PI * 2, 16, 0.72, 0.04, true), M.paint);
    shell.castShadow = true; shell.receiveShadow = true; body.add(shell);
    var cabin = new THREE.Mesh(Car.loft(CABIN, 0, 1, 24, 0, Math.PI * 2, 12, 0.68, 0, true), M.glass);
    cabin.castShadow = true; body.add(cabin);

    /* 细节件：全部 Box / Cylinder / Torus 拼装，最后仍只合并成 dark + chrome 两个 Mesh */
    var darkParts = [], chromeParts = [];
    function addDark(g, x, y, z, rx, ry, rz) { darkParts.push(CR.Geo.place(g, x, y, z, rx, ry, rz)); }
    function addChr(g, x, y, z, rx, ry, rz) { chromeParts.push(CR.Geo.place(g, x, y, z, rx, ry, rz)); }
    addDark(CR.Geo.box(1.3, 0.24, 1.7, 1), 0, 0.86, -0.25);                    // 内饰暗块
    addDark(CR.Geo.box(1.5, 0.07, 1.5, 1), 0, 1.30, -0.10);                    // 车顶漆面底
    /* 尾翼抬高到 1.16，支柱同步加长到刚好托住翼面（原来差 4cm、像悬空） */
    addDark(CR.Geo.box(1.70, 0.07, 0.36, 1), 0, 1.16, -2.05);
    addDark(CR.Geo.box(0.06, 0.36, 0.30, 1), -0.58, 0.98, -2.02);
    addDark(CR.Geo.box(0.06, 0.36, 0.30, 1), 0.58, 0.98, -2.02);
    addDark(CR.Geo.box(1.25, 0.20, 0.10, 1), 0, 0.50, 2.22);                    // 格栅
    addDark(CR.Geo.box(1.35, 0.16, 0.26, 1), 0, 0.36, -2.18);                   // 扩散器
    /* 后视镜外移到 ±1.06 并补支架（原来贴在车壳里，看不出是镜子） */
    addDark(CR.Geo.box(0.28, 0.12, 0.16, 1), -1.06, 0.92, 0.55);
    addDark(CR.Geo.box(0.28, 0.12, 0.16, 1), 1.06, 0.92, 0.55);
    addDark(CR.Geo.box(1.70, 0.10, 0.22, 1), 0, 0.36, 2.15);                    // 前唇
    /* 鲨鱼鳍移到车顶暗块上方，露出 3cm（原来埋在车顶下面） */
    addDark(CR.Geo.box(0.28, 0.09, 0.20, 1), 0, 1.37, -0.72);
    /* 车门分缝 / 侧窗 A/B 柱 / 前杠进气口 / 扩散器鳍片 */
    [-1, 1].forEach(function (sg2) {
      addDark(CR.Geo.box(0.012, 0.32, 0.02, 1), sg2 * 0.968, 0.66, -0.35);
      addDark(CR.Geo.box(0.012, 0.32, 0.02, 1), sg2 * 0.968, 0.66, -1.55);
      addDark(CR.Geo.box(0.045, 0.26, 0.05, 1), sg2 * 0.79, 1.10, -0.05);
      addDark(CR.Geo.box(0.05, 0.30, 0.05, 1), sg2 * 0.62, 1.12, 0.85, -0.45, 0, 0);
      addDark(CR.Geo.box(0.42, 0.13, 0.05, 1), sg2 * 0.55, 0.43, 2.24);
    });
    [-0.42, 0, 0.42].forEach(function (fx) {
      addDark(CR.Geo.box(0.04, 0.14, 0.22, 1), fx, 0.34, -2.24);
    });
    [-1, 1].forEach(function (sg) {
      addDark(CR.Geo.box(0.10, 0.12, 2.4, 1), sg * 0.94, 0.36, 0);             // 侧裙
      addDark(CR.Geo.box(0.06, 0.22, 0.55, 1), sg * 0.95, 0.60, -0.75);        // 侧进气口
      addDark(CR.Geo.box(0.06, 0.18, 0.40, 1), sg * 0.95, 0.62, 1.35);         // 散热口
      addDark(CR.Geo.box(0.16, 0.05, 0.30, 1), sg * 0.72, 0.34, 1.95);         // 导流片
      /* 排气管位置必须保持 ±0.55 / 0.34 / -2.28 —— Car.exhaust 与它对齐 */
      addChr(new THREE.CylinderGeometry(0.09, 0.09, 0.22, 10), sg * 0.55, 0.34, -2.28, Math.PI / 2, 0, 0);
      addChr(new THREE.TorusGeometry(0.105, 0.02, 6, 12), sg * 0.55, 0.34, -2.30, 0, Math.PI, 0); // 排气口外圈
      addChr(new THREE.TorusGeometry(0.055, 0.012, 6, 10), sg * 0.72, 0.48, 2.24);               // 前雾灯圈
      addChr(CR.Geo.box(0.16, 0.035, 0.05, 1), sg * 0.99, 0.89, 0.55);                          // 后视镜支架
      addChr(CR.Geo.box(0.015, 0.035, 0.16, 1), sg * 0.972, 0.78, -0.55);                       // 门把手
    });
    var fuelCap = new THREE.CylinderGeometry(0.09, 0.09, 0.012, 12);
    fuelCap.rotateZ(Math.PI / 2);
    addChr(fuelCap, 0.972, 0.72, -1.25);                                          // 油箱盖
    addChr(CR.Geo.box(0.12, 0.05, 0.02, 1), 0, 0.66, 2.27);                       // 车标
    addChr(CR.Geo.box(0.44, 0.16, 0.06, 1), 0, 0.72, -2.27);                      // 车牌框
    var dm = new THREE.Mesh(CR.Geo.merge(darkParts), M.dark); dm.castShadow = true; body.add(dm);
    var cm = new THREE.Mesh(CR.Geo.merge(chromeParts), M.chrome); body.add(cm);
    darkParts.forEach(function (g) { g.dispose(); });
    chromeParts.forEach(function (g) { g.dispose(); });

    /* 灯光：贯穿尾条 + 左右主尾灯；日行灯 / 大灯各自左右合并。
       材质与 emissive 强度都不变（sync 仍改 M.tail），只是少 2 个 draw call。 */
    var tailParts = [
      CR.Geo.place(CR.Geo.box(1.62, 0.10, 0.07, 1), 0, 0.74, -2.27),
      CR.Geo.place(CR.Geo.box(0.36, 0.16, 0.07, 1), -0.66, 0.74, -2.28),
      CR.Geo.place(CR.Geo.box(0.36, 0.16, 0.07, 1), 0.66, 0.74, -2.28)
    ];
    body.add(new THREE.Mesh(CR.Geo.merge(tailParts), M.tail));
    tailParts.forEach(function (g) { g.dispose(); });
    var drlParts = [], headParts = [];
    [-1, 1].forEach(function (sg) {
      drlParts.push(CR.Geo.place(CR.Geo.box(0.30, 0.07, 0.06, 1), sg * 0.63, 0.70, 2.24));
      headParts.push(CR.Geo.place(CR.Geo.box(0.34, 0.14, 0.07, 1), sg * 0.55, 0.62, 2.25));
    });
    body.add(new THREE.Mesh(CR.Geo.merge(drlParts), M.drl));
    body.add(new THREE.Mesh(CR.Geo.merge(headParts), M.head));
    drlParts.forEach(function (g) { g.dispose(); });
    headParts.forEach(function (g) { g.dispose(); });

    /* 车轮：轮拱暗槽 + 轮胎 + rim 贴图 + 镀铬轮辋；pivot(转向) / spin(滚动) */
    var tyreGeo = new THREE.CylinderGeometry(C.WHEEL_R, C.WHEEL_R, 0.26, 18);
    tyreGeo.rotateZ(Math.PI / 2);
    var rimGeo = new THREE.CylinderGeometry(C.WHEEL_R * 0.72, C.WHEEL_R * 0.72, 0.272, 18);
    rimGeo.rotateZ(Math.PI / 2);
    var tyreMat = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.94 });
    var rimMat = new THREE.MeshStandardMaterial({ map: CR.Tex.get('rim'), metalness: 0.8, roughness: 0.3 });
    var rimEdgeMat = M.chrome;
    var wheelDetailMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.62 });
    var wheels = [];
    [[-1, C.AX_F, true], [1, C.AX_F, true], [-1, C.AX_R, false], [1, C.AX_R, false]].forEach(function (w) {
      var pivot = new THREE.Group();
      pivot.position.set(w[0] * 0.86, C.WHEEL_R, w[1]);
      var spin = new THREE.Group(); pivot.add(spin);
      var arch = new THREE.Mesh(new THREE.TorusGeometry(C.WHEEL_R + 0.07, 0.055, 6, 16, Math.PI), M.dark);
      arch.rotation.y = Math.PI / 2; pivot.add(arch);
      var tyre = new THREE.Mesh(tyreGeo, tyreMat); tyre.castShadow = true; spin.add(tyre);
      var rim = new THREE.Mesh(rimGeo, rimMat); spin.add(rim);
      var edge = new THREE.Mesh(new THREE.TorusGeometry(C.WHEEL_R * 0.74, 0.028, 6, 18), rimEdgeMat);
      edge.rotation.y = Math.PI / 2; edge.position.x = w[0] * 0.14; spin.add(edge);
      var wd = new THREE.Mesh(wheelDetailGeo(w[0]), wheelDetailMat);
      wd.castShadow = true; spin.add(wd);
      root.add(pivot);
      wheels.push({ pivot: pivot, spin: spin, front: w[2], side: w[0] });
    });

    scene.add(root);
    Car.root = root;
    Car.parts = { wheels: wheels, body: body, tail: M.tail, paint: M.paint, glass: M.glass };
    Car.reset(false);
    Car.ready = true;
    return Car;
  };

  /* 后轮世界位置（供 effects 胎痕） */
  Car.rearWheel = function (side, out) {
    out = out || {};
    var st = Car.state, f0 = Math.sin(st.psi), f1 = Math.cos(st.psi);
    var l0 = Math.cos(st.psi), l1 = -Math.sin(st.psi);
    var z = C.AX_R, x = side * 0.86;
    out.x = st.x + f0 * z + l0 * x;
    out.y = st.y + 0.04;
    out.z = st.z + f1 * z + l1 * x;
    return out;
  };

  /* 两个排气口世界坐标（供 effects 尾焰）：与车身几何里的排气管对齐——
     几何在 z=-2.28 / y=0.34 / x=±0.55，这里取车尾外 0.02、略高于管口中心，
     根部不再埋进车壳，也不会被路面吃掉。 */
  Car.exhaust = function (side, out) {
    out = out || {};
    var st = Car.state, f0 = Math.sin(st.psi), f1 = Math.cos(st.psi);
    var l0 = Math.cos(st.psi), l1 = -Math.sin(st.psi);
    var z = -2.30, x = side * 0.55;
    out.x = st.x + f0 * z + l0 * x;
    out.y = st.y + 0.36;
    out.z = st.z + f1 * z + l1 * x;
    return out;
  };

  /* ---------------- P12 驾驶物理 ---------------- */
  var nrOut = {};        /* 复用同一个 out 对象，避免每子步分配（120Hz 下每秒 120 次） */
  /* 蹭墙锁：撞墙后 0.3s 内不允许点火（0.3s = 36 个 120Hz 子步）。
     模块内私有计时，不进 Car.state —— 对外仍只有 nitro / nitroActive / nitroArmed。 */
  var WALL_LOCK = 0.3, wallLock = 0;
  var EMPTY_INPUT = {};      /* sync 的兜底空输入，避免每帧新建对象 */

  Car.step = function (dt, input) {
    input = input || { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    var st = Car.state, T = CR.Track;
    var f0 = Math.sin(st.psi), f1 = Math.cos(st.psi);
    var l0 = Math.cos(st.psi), l1 = -Math.sin(st.psi);

    /* 局部坐标分解 */
    st.vf = st.vx * f0 + st.vz * f1;
    st.vl = st.vx * l0 + st.vz * l1;

    /* 转向平滑：回中 6/s、打方向 4/s */
    var rate = Math.abs(input.steer) < 0.01 ? 6 : 4;
    st.steer += (input.steer - st.steer) * Math.min(1, dt * rate);
    var maxSteer = 0.52 / (1 + Math.pow(Math.abs(st.vf) / 21, 1.35));
    st.delta = st.steer * maxSteer;

    /* ---------------- 氮气（P-N1 状态 / P-N3 动力学）：只改纵向 ----------------
       不碰横摆模型、侧向抓地公式与赛道约束。
       滞回：低于 MIN_START 强制关闭并上锁；回充到 REARM 才解锁。
       手刹期间关闭（禁用推力），但漂移回充（DRIFT_GAIN）仍然保留。 */
    var N = CR.NITRO;
    if (wallLock > 0) wallLock = Math.max(0, wallLock - dt);
    if (st.nitro < N.MIN_START) st.nitroArmed = false;
    else if (!st.nitroArmed && st.nitro >= N.REARM) st.nitroArmed = true;
    st.nitroActive = input.nitro > 0 && st.nitroArmed && st.nitro >= N.MIN_START &&
                     !input.handbrake && wallLock <= 0;

    /* 纵向：氮气必须同时抬 vmax、降风阻、加推力，三者缺一都无效。
       68 只是推力归零阈值，实际稳态约 51 m/s(=184 km/h) 由 0.0021*vf*|vf| 决定；
       氮气把阈值抬到 84、阻力乘 0.7、推力 +7.5，稳态约 68 m/s(=245 km/h)。 */
    var boosting = st.nitroActive;
    var vmax = boosting ? N.VMAX : 68;
    var thrust = 13.5 + (boosting ? N.THRUST : 0);
    if (st.offroad) thrust *= N.OFFROAD_SCALE;                    // 越野推力减半
    thrust *= Math.max(0, 1 - Math.pow(Math.max(st.vf, 0) / vmax, 2));
    /* 氮气独立于油门：松油门按住氮气也能推 */
    var drive = input.throttle ? input.throttle : (boosting ? 1 : 0);
    var acc = thrust * drive;
    if (input.brake) {
      if (st.vf > 0.8) acc -= 25 * input.brake;
      else if (st.vf > -13) acc -= 7 * input.brake;
    }
    if (input.throttle === 0 && input.brake && st.vf <= 0.8) acc -= 20 * input.brake; // 倒车推力
    var dragK = 0.0021 * (boosting ? N.DRAG_SCALE : 1);
    acc -= dragK * st.vf * Math.abs(st.vf);
    acc -= 0.35 * Math.sign(st.vf) * Math.min(1, Math.abs(st.vf));
    /* 草地阻力：0.55 → CR.CFG.offroadDrag(0.30)，草地上不再明显掉速 */
    if (st.offroad) acc -= st.vf * C.offroadDrag;
    if (input.handbrake) acc -= Math.sign(st.vf) * Math.min(7, Math.abs(st.vf) / dt);
    st.acc = acc;
    st.vf += acc * dt;
    st.braking = !!input.brake;

    /* 横摆：自行车模型 yawT = vf*tan(delta)/WB*(手刹?1.45:1)，平滑 漂移5 / 正常10 */
    var yawT = st.vf * Math.tan(st.delta) / C.WB * (input.handbrake ? 1.45 : 1);
    st.yawRate += (yawT - st.yawRate) * Math.min(1, dt * (st.drifting ? 5 : 10));
    st.psi += st.yawRate * dt;

    /* 漂移状态机 */
    if (Math.abs(st.vl) > 3.6 || (input.handbrake && Math.abs(st.vf) > 9)) st.drifting = true;
    if (Math.abs(st.vl) < 1.1 && !input.handbrake) st.drifting = false;
    var gripT = input.handbrake ? 1.5 : (st.drifting ? 3.4 : 9.5);
    st.grip += (gripT - st.grip) * Math.min(1, dt * (gripT < st.grip ? 12 : 2.2));
    /* 草地阻力降低后横向抓地同步从 9 提到 11，避免草地上过度甩尾 */
    var maxLat = st.offroad ? 11 : (input.handbrake ? 10 : (st.drifting ? 14.5 : 18));
    st.latAcc = CR.clamp(-st.vl * st.grip, -maxLat, maxLat);
    st.vl += st.latAcc * dt;
    if (Math.abs(st.vl) < Math.abs(st.latAcc * dt)) st.vl = 0;   // 防抖

    /* 积分：速度用「本步开始时的」车身轴重组；psi 已在前面更新，
       下一步分解到新轴时才自然产生侧滑 vl（漂移的来源）。
       若这里改用新轴重组，侧滑会被吃掉，vl 恒为 0，手刹漂移失效。 */
    st.vx = f0 * st.vf + l0 * st.vl;
    st.vz = f1 * st.vf + l1 * st.vl;
    st.x += st.vx * dt; st.z += st.vz * dt;
    st.speed = Math.hypot(st.vx, st.vz);

    /* 赛道约束：Track.nearest 后沿法向推回、消法向速度*1.25、速度衰减 0.985、
       angDiff 把航向缓慢掰回赛道切线（只朝前时）。
       物理每帧至少跑 1 次（120Hz 子步时更多），带 hint 走 25 次投影的快速路径。 */
    var nr = T.nearest(st.x, st.z, nrOut);
    st.lat = nr.lat; st.s = nr.s; st.slope = nr.slope;
    var hasRail = nr.lat > 0 && (nr.i >= T.iStraight0 && nr.i <= T.iStraight1);
    var lim = nr.lat > 0 ? (hasRail ? T.innerRailLimit : T.innerSoftLimit) : T.outerLimit;
    if (Math.abs(nr.lat) > lim) {
      /* 撞墙这一子步强制熄灭氮气，并锁 0.3s：蹭着护栏时不会每 8ms 重新点火 */
      st.nitroActive = false;
      wallLock = WALL_LOCK;
      var sg = nr.lat > 0 ? 1 : -1;
      var push = nr.lat - sg * lim;
      st.x -= nr.lx * push; st.z -= nr.lz * push;
      /* 碰撞响应必须按子步长折算，否则帧率越高、每秒子步越多，蹭护栏时
         衰减与回弹被反复累加：实测 240fps 比 60fps 少跑 21%。
         h=STEP 时两个系数保持规格原值（1.25 / 0.985）。 */
      var rq = dt / C.STEP;
      var vn = st.vx * nr.lx + st.vz * nr.lz;
      /* 撞击强度 = 法向撞速；累加给音效（main 每帧消费一次，不会漏掉子步里的碰撞） */
      if (Math.abs(vn) > st.hitAcc) st.hitAcc = Math.abs(vn);
      st.vx -= nr.lx * vn * (1 + 0.25 * rq); st.vz -= nr.lz * vn * (1 + 0.25 * rq);
      var kf = Math.pow(0.985, rq);
      st.vx *= kf; st.vz *= kf;
      if (st.vf > 0) {
        var target = Math.atan2(nr.tx, nr.tz);
        st.psi += CR.angDiff(st.psi, target) * Math.min(1, dt * 1.6);
      }
      st.speed = Math.hypot(st.vx, st.vz);
    }

    /* 高度平滑跟随 nr.y（速率 14，越野 -0.12） */
    st.offroad = Math.abs(nr.lat) > T.ROAD_HALF;
    var targetY = nr.y + (st.offroad ? -0.12 : 0);
    st.y += (targetY - st.y) * (1 - Math.exp(-dt * 14));

    /* slip：手刹且 speed>6 时至少 0.55 */
    st.slip = CR.clamp01((Math.abs(st.vl) - 1.6) / 7);
    if (input.handbrake && st.speed > 6) st.slip = Math.max(st.slip, 0.55);

    /* 氮气资源结算：激活按 BURN 烧（越野再乘 OFFROAD_SCALE），未激活按 REGEN 回充、
       漂移再叠 DRIFT_GAIN。每子步按 dt 结算 → 帧率无关（30/60/144fps 一秒消耗相同）。
       放在漂移状态机之后，让漂移回充用本步刚更新的 st.drifting。 */
    if (st.nitroActive) {
      st.nitro -= N.BURN * (st.offroad ? N.OFFROAD_SCALE : 1) * dt;
    } else {
      st.nitro += N.REGEN * dt;
      if (st.drifting) st.nitro += N.DRIFT_GAIN * dt;
    }
    st.nitro = CR.clamp01(st.nitro);
  };

  /* ---------------- sync(t, dt) ---------------- */
  Car.sync = function (t, dtIn) {
    if (!Car.root) return;
    var st = Car.state, P = Car.parts;
    Car.root.position.set(st.x, st.y, st.z);
    Car.root.rotation.y = st.psi;
    /* 坡度俯仰 / 侧倾 latAcc*0.0042 / 点头 -acc*0.0022 / 越野 sin(t*31) 颠簸 */
    P.body.rotation.x = -Math.atan(st.slope) - st.acc * 0.0022 + (st.offroad ? Math.sin(t * 31) * 0.012 : 0);
    P.body.rotation.z = st.latAcc * 0.0042;
    /* 车轮滚动必须乘 dt：原来 `+= vf*0.012` 是每帧固定量，
       144fps 会比 60fps 快 2.4 倍。没传 dt 时从 t 的差值兜底（t 是全局累加时间）。 */
    var dt = (typeof dtIn === 'number') ? dtIn : Math.max(0, Math.min(0.05, t - (Car._syncT == null ? t : Car._syncT)));
    Car._syncT = t;
    var roll = st.vf * CR.CFG.wheelSpin * dt;
    /* 前轮转角 + 滚动；手刹时后轮停止自转 */
    var inp = CR.autoInput || (CR.Input && CR.Input.state) || EMPTY_INPUT;
    var handbrake = !!inp.handbrake;
    for (var wi = 0; wi < P.wheels.length; wi++) {
      var w = P.wheels[wi];
      if (w.front) w.pivot.rotation.y = st.delta;
      if (!(handbrake && !w.front)) w.spin.rotation.x += roll;
    }
    /* 刹车灯 emissive 0.9 → 6；氮气时再略增 0.9（用 1-exp 平滑，不突变） */
    var nk = Car._tailK || 0;
    nk += ((st.nitroActive ? 1 : 0) - nk) * (1 - Math.exp(-dt * 8));
    Car._tailK = nk;
    P.tail.emissiveIntensity = 0.9 + (st.braking ? 5.1 : 0) + nk * 0.9;
  };

  /* ---------------- reset(keepPlace) ---------------- */
  Car.reset = function (keepPlace) {
    var st = Car.state, T = CR.Track;
    var s = keepPlace ? T.nearest(st.x, st.z, nrOut).s : T.L - 14;
    var p = T.pointAt(s, 0);
    st.x = p.x; st.y = p.y; st.z = p.z;
    st.psi = Math.atan2(p.tx, p.tz);
    st.vx = st.vz = st.vf = st.vl = st.speed = 0;
    st.yawRate = 0; st.steer = 0; st.delta = 0;
    st.grip = 9.5; st.drifting = false; st.slip = 0;
    st.acc = 0; st.latAcc = 0; st.slope = 0;
    st.offroad = false; st.braking = false;
    st.nitro = 1; st.nitroActive = false; st.nitroArmed = true;
    wallLock = 0; st.hitAcc = 0;
    st.lat = 0; st.s = s;
    if (Car.root) Car.sync(CR.time.value);
  };
})();
