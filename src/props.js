/* =========================================================================
 * props.js — 全部程序化：松树/杂草/礁石/电线杆/平房/码头灯塔/拱门旗帜/
 * 远岛/渔船/浮标/海鸥 + addSway 风摆注入 + 逐帧动态
 * 同类资产一律 InstancedMesh，draw call 不随物件数线性增长。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var Props = CR.Props = {};
  var dyn = {};
  var nrOut = {}, hOut = {};

  /* 位置扰动用「连续」值噪声而不是量化整数 hash：
     non-indexed 几何里同一空间点会被复制成多个顶点（圆锥 θ=0/2π 接缝等），
     它们的浮点坐标差 ~1e-16。量化 hash 一旦跨过取整边界就会给出完全不同的
     值 → 网格裂开；value noise 在格子边界连续，写回 Float32Array 后这些副本
     会被舍入成位级完全相同的坐标，网格自然焊死。 */
  function posNoise(x, y, z, seed) {
    return CR.noise2(x * 4.3 + z * 1.7, y * 4.3 + x * 1.3, seed) * 0.65
         + CR.noise2(x * 13.1 - z * 5.2, z * 13.1 + y * 3.7, seed + 17) * 0.35;
  }

  /* ---- addSway：onBeforeCompile 注入随风摆动，实例相位由 instanceMatrix[3].xz 错开 ---- */
  Props.addSway = function (mat, amp) {
    mat.onBeforeCompile = function (shader) {
      shader.uniforms.uTime = CR.time;
      shader.uniforms.uSwayAmp = { value: amp };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uSwayAmp;')
        .replace('#include <begin_vertex>', [
          '#include <begin_vertex>',
          '#ifdef USE_INSTANCING',
          '  vec2 swayPh = vec2(instanceMatrix[3].x, instanceMatrix[3].z) * 0.13;',
          '#else',
          '  vec2 swayPh = vec2(0.0);',
          '#endif',
          '  float swh = clamp(transformed.y / 6.0, 0.0, 1.0);',
          '  float sway = sin(uTime * 1.6 + swayPh.x + swayPh.y) * 0.6',
          '            + sin(uTime * 2.7 + swayPh.x * 1.7) * 0.4;',
          '  transformed.x += sway * swh * swh * uSwayAmp;',
          '  transformed.z += sway * 0.55 * swh * swh * uSwayAmp;'
        ].join('\n'));
    };
    mat.customProgramCacheKey = function () { return 'sway' + amp; };
    return mat;
  };

  function nearPad(x, z) {
    var pads = CR.Terrain.pads;
    for (var i = 0; i < pads.length; i++) {
      if (Math.hypot(x - pads[i].x, z - pads[i].z) < pads[i].r + 4) return true;
    }
    return false;
  }
  function safeSpot(r, minD, maxDist) {
    for (var k = 0; k < 50; k++) {
      var x = r.range(-(maxDist || 900), maxDist || 900);
      var z = r.range(-(maxDist || 900), maxDist || 900);
      var nr = CR.Track.nearest(x, z, nrOut);
      if (nr.d < minD || nearPad(x, z)) continue;
      /* 雪山范围（118m）内不种树：否则树会从雪坡里长出来 */
      if (CR.Snow && CR.Snow.blocked(x, z)) continue;
      var y = CR.Terrain.heightAt(x, z, hOut);
      if (y < CR.SEA + 0.6) continue;
      return { x: x, y: y, z: z, nr: nr };
    }
    return null;
  }
  function instanced(scene, geo, mat, list, shadow) {
    if (!list.length) return null;
    var im = new THREE.InstancedMesh(geo, mat, list.length);
    var m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    var col = new THREE.Color();
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      q.setFromEuler(new THREE.Euler(0, it.ry || 0, 0));
      s.set(it.sx || 1, it.sy || 1, it.sz || 1);
      p.set(it.x, it.y, it.z);
      im.setMatrixAt(i, m.compose(p, q, s));
      col.setRGB(it.c ? it.c[0] : 1, it.c ? it.c[1] : 1, it.c ? it.c[2] : 1);
      im.setColorAt(i, col);
    }
    im.instanceMatrix.needsUpdate = true;
    im.instanceColor.needsUpdate = true;
    im.castShadow = shadow !== false; im.receiveShadow = shadow !== false;
    im.frustumCulled = false;
    scene.add(im);
    return im;
  }

  /* ---------------- 几何 ---------------- */
  function pineGeo() {
    var parts = [], k, i;
    var trunk = new THREE.CylinderGeometry(0.14, 0.25, 2.3, 7);
    trunk.translate(0, 1.15, 0); parts.push(trunk);
    for (k = 0; k < 7; k++) {
      var c = new THREE.ConeGeometry(2.05 - k * 0.23, 1.75, 8);
      c.translate(0, 1.75 + k * 0.92, 0);
      var pos = c.getAttribute('position');
      for (i = 0; i < pos.count; i++) {
        var px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
        var d = (posNoise(px, py, pz, 71 + k) - 0.5) * 0.30;
        pos.setXYZ(i, px * (1 + d), py, pz * (1 + d));
      }
      pos.needsUpdate = true; parts.push(c);
    }
    var g = CR.Geo.merge(parts);
    parts.forEach(function (p) { p.dispose(); });
    CR.Geo.tint(g, function (idx, p) {
      var y = p.getY(idx);
      return [0.12 + y * 0.010, 0.30 + y * 0.014, 0.14 + y * 0.007];
    }, 0, 0, 0.20);
    return g;
  }
  function weedGeo() {
    var parts = [];
    for (var k = 0; k < 8; k++) {
      var g = new THREE.PlaneGeometry(0.24, 0.9);
      g.translate(0, 0.45, 0);
      CR.Geo.place(g, 0, 0, 0, 0, k / 8 * Math.PI, 0.30, 1, 1, 1);
      parts.push(g);
    }
    var out = CR.Geo.merge(parts);
    parts.forEach(function (p) { p.dispose(); });
    CR.Geo.tint(out, [0.34, 0.46, 0.20], 0, 0, 0.32);
    return out;
  }
  function rockGeo(seed) {
    var g = new THREE.IcosahedronGeometry(1, 1), p = g.getAttribute('position');
    for (var i = 0; i < p.count; i++) {
      var px = p.getX(i), py = p.getY(i), pz = p.getZ(i);
      var f = 0.65 + posNoise(px, py, pz, seed) * 0.8;
      p.setXYZ(i, px * f, py * f * 0.65, pz * f);
    }
    p.needsUpdate = true; g.computeVertexNormals();
    CR.Geo.tint(g, [0.55, 0.53, 0.50], 0, 0, 0.25);
    return g;
  }
  function houseGeo(r) {
    var w = 6 + r.range(0, 1.6), d = 5.4 + r.range(0, 1.4), h = 3.2;
    var slope = 0.52, half = w * 0.62;
    /* 墙(灰泥) 与 人字瓦顶(瓦片贴图 + 独立 bump) 必须是两份网格、两种材质 */
    var wallParts = [
      CR.Geo.place(CR.Geo.box(w, h, d, 0.4), 0, h / 2, 0),
      CR.Geo.place(CR.Geo.box(1.0, 1.9, 0.10, 1), 0, 0.95, d / 2 + 0.06),           // 门
      CR.Geo.place(CR.Geo.box(0.6, 1.5, 0.6, 1), w * 0.28, h + 1.3, -d * 0.2)       // 烟囱
    ];
    var roofParts = [
      CR.Geo.place(CR.Geo.box(half, 0.18, d + 0.8, 0.35), -w * 0.27, h + 0.72, 0, 0, 0, slope),
      CR.Geo.place(CR.Geo.box(half, 0.18, d + 0.8, 0.35), w * 0.27, h + 0.72, 0, 0, 0, -slope)
    ];
    var wg = CR.Geo.merge(wallParts), rg = CR.Geo.merge(roofParts);
    wallParts.forEach(function (p) { p.dispose(); });
    roofParts.forEach(function (p) { p.dispose(); });
    CR.Geo.tint(wg, [0.92, 0.88, 0.80], 0, 0, 0.08);
    return { walls: wg, roof: rg, w: w, d: d, h: h };
  }

  /* ================= 灯塔：细致结构（全部程序化、零外部素材） =================
     局部原点 = 塔基（与栈道末端同高）。塔身保留 lighthouse 红白横带贴图，
     其余构件分两组：painted 用顶点色、metal 用统一金属材质，各 1 个 draw call。 */
  function lighthouseGeo(doorYaw) {
    var painted = [], metal = [];
    var STONE = [0.62, 0.58, 0.52], DARK = [0.085, 0.095, 0.11], RED = [0.60, 0.21, 0.16];
    function addP(g, c, x, y, z, rx, ry, rz) {
      CR.Geo.tint(g, c, 0, 0, 0);
      painted.push(CR.Geo.place(g, x, y, z, rx, ry, rz));
    }
    function addM(g, x, y, z, rx, ry, rz) {
      metal.push(CR.Geo.place(g, x, y, z, rx, ry, rz));
    }
    function ring(r, tube) {
      var t = new THREE.TorusGeometry(r, tube, 6, 24);
      t.rotateX(Math.PI / 2);
      return t;
    }
    /* 基座 + 压顶 */
    addP(new THREE.CylinderGeometry(3.55, 3.85, 1.05, 24), STONE, 0, 0.53, 0);
    addP(new THREE.CylinderGeometry(3.85, 3.85, 0.18, 24), STONE, 0, 1.14, 0);
    /* 塔身半径：底 3.0 → 顶 2.0（y 1.23..17.53） */
    function shaftR(y) { return 3.0 - CR.clamp01((y - 1.23) / 16.3); }
    [5.1, 9.4, 13.7].forEach(function (y) {
      addM(ring(shaftR(y) + 0.03, 0.075), 0, y, 0);
    });
    /* 2 层 × 4 方位的窗：金属框 + 深色玻璃；门朝栈道来向 */
    for (var lv = 0; lv < 2; lv++) {
      var wy = 7.2 + lv * 4.4, wr = shaftR(wy) + 0.02;
      for (var a = 0; a < 4; a++) {
        var ang = a * Math.PI / 2 + 0.35;
        addM(CR.Geo.box(0.66, 1.00, 0.05, 1),
             Math.sin(ang) * wr, wy, Math.cos(ang) * wr, 0, ang, 0);
        addP(CR.Geo.box(0.50, 0.84, 0.05, 1), DARK,
             Math.sin(ang) * (wr + 0.045), wy, Math.cos(ang) * (wr + 0.045), 0, ang, 0);
      }
    }
    var dy = 2.15, dr = shaftR(dy) + 0.02;
    addM(CR.Geo.box(1.28, 2.08, 0.05, 1),
         Math.sin(doorYaw) * dr, dy, Math.cos(doorYaw) * dr, 0, doorYaw, 0);
    addP(CR.Geo.box(1.05, 1.86, 0.05, 1), DARK,
         Math.sin(doorYaw) * (dr + 0.045), dy, Math.cos(doorYaw) * (dr + 0.045), 0, doorYaw, 0);
    /* 檐口 + 外廊平台 */
    addP(new THREE.CylinderGeometry(2.80, 2.10, 0.55, 24), STONE, 0, 17.75, 0);
    addP(new THREE.CylinderGeometry(2.80, 2.80, 0.16, 24), STONE, 0, 18.10, 0);
    /* 外廊栏杆：两圈横杆 + 12 根立柱 */
    [18.95, 18.55].forEach(function (y) { addM(ring(2.62, 0.045), 0, y, 0); });
    for (var p = 0; p < 12; p++) {
      var pa = p / 12 * Math.PI * 2;
      addM(new THREE.CylinderGeometry(0.042, 0.042, 0.92, 6),
           Math.sin(pa) * 2.62, 18.66, Math.cos(pa) * 2.62);
    }
    /* 灯室框架：上下圈 + 8 根竖框 */
    [18.30, 20.20].forEach(function (y) { addM(ring(1.62, 0.055), 0, y, 0); });
    for (var q = 0; q < 8; q++) {
      var qa = q / 8 * Math.PI * 2;
      addM(new THREE.CylinderGeometry(0.055, 0.055, 1.90, 6),
           Math.sin(qa) * 1.62, 19.25, Math.cos(qa) * 1.62);
    }
    /* 屋顶、顶球、避雷针与风向标 */
    addP(new THREE.ConeGeometry(1.95, 1.45, 20), RED, 0, 20.92, 0);
    addP(new THREE.SphereGeometry(0.20, 10, 8), RED, 0, 21.72, 0);
    addM(new THREE.CylinderGeometry(0.022, 0.030, 0.85, 6), 0, 22.14, 0);
    addM(CR.Geo.box(0.46, 0.05, 0.05, 1), 0.12, 22.02, 0);

    var out = {
      shaft: new THREE.CylinderGeometry(2.0, 3.0, 16.3, 24),
      painted: CR.Geo.merge(painted),
      metal: CR.Geo.merge(metal),
      glass: new THREE.CylinderGeometry(1.62, 1.62, 1.90, 16, 1, true),
      lamp: new THREE.CylinderGeometry(0.62, 0.62, 1.15, 12)
    };
    painted.forEach(function (g) { g.dispose(); });
    metal.forEach(function (g) { g.dispose(); });
    return out;
  }

  /* ================= 渔船：V 形放样船体，原点 = 水线 =================
     船底在水线以下、干舷在水线以上，Ocean.heightAt 的 b.y 不变量保持不变。
     hull / deck / detail / lights / ropes 共 5 个 draw call。 */
  function boatGeo() {
    var ST = [
      [-3.20, 1.02, 0.60, -0.34], [-2.60, 1.22, 0.64, -0.46],
      [-1.80, 1.32, 0.68, -0.54], [-0.80, 1.34, 0.70, -0.58],
      [ 0.20, 1.30, 0.72, -0.56], [ 1.20, 1.16, 0.78, -0.50],
      [ 2.00, 0.94, 0.88, -0.40], [ 2.70, 0.58, 1.04, -0.26],
      [ 3.20, 0.05, 1.26, -0.14]
    ];
    var M = 8, P = [], U = [], I = [], DP = [], DU = [], DI = [], i, j;
    for (i = 0; i < ST.length; i++) {
      var s = ST[i], v = i / (ST.length - 1);
      for (j = 0; j <= M; j++) {
        var u = j / M;
        P.push(-s[1] * Math.cos(Math.PI * u),
               s[3] + (s[2] - s[3]) * Math.pow(Math.abs(2 * u - 1), 1.55), s[0]);
        U.push(u, v * 2.4);
      }
      DP.push(-s[1], s[2] - 0.10, s[0], s[1], s[2] - 0.10, s[0]);
      DU.push(0, v * 3, 1, v * 3);
    }
    var row = M + 1;
    for (i = 0; i < ST.length - 1; i++) {
      for (j = 0; j < M; j++) {
        var a = i * row + j, b = a + row;
        I.push(a, b, a + 1, a + 1, b, b + 1);
      }
      var d = i * 2; DI.push(d, d + 2, d + 1, d + 1, d + 2, d + 3);
    }
    /* 船尾封板：第一站截面做三角扇 */
    var cidx = P.length / 3;
    P.push(0, 0.12, ST[0][0]); U.push(0.5, 0);
    for (j = 0; j < M; j++) I.push(cidx, j + 1, j);

    var hull = new THREE.BufferGeometry();
    hull.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    hull.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    hull.setIndex(I);
    hull.computeVertexNormals();
    CR.Geo.tint(hull, function (idx, p) {
      var y = p.getY(idx);
      if (y < -0.05) return [0.10, 0.12, 0.15];     // 水线下防污漆
      if (y < 0.18) return [0.42, 0.14, 0.10];      // 红色水线带
      return [0.17, 0.19, 0.22];                     // 干舷深灰
    }, 0, 0, 0);

    var deck = new THREE.BufferGeometry();
    deck.setAttribute('position', new THREE.Float32BufferAttribute(DP, 3));
    deck.setAttribute('uv', new THREE.Float32BufferAttribute(DU, 2));
    deck.setIndex(DI);
    deck.computeVertexNormals();

    var detail = [], lights = [], ropePts = [];
    function addD(g, c, x, y, z, rx, ry, rz) {
      CR.Geo.tint(g, c, 0, 0, 0);
      detail.push(CR.Geo.place(g, x, y, z, rx, ry, rz));
    }
    function addL(g, c, x, y, z) {
      CR.Geo.tint(g, c, 0, 0, 0);
      lights.push(CR.Geo.place(g, x, y, z));
    }
    /* 舷缘护条：逐段贴着船型走 */
    for (i = 0; i < ST.length - 1; i++) {
      var s0 = ST[i], s1 = ST[i + 1];
      for (var sg = -1; sg <= 1; sg += 2) {
        var x0 = sg * s0[1], z0 = s0[0], x1 = sg * s1[1], z1 = s1[0];
        var y0 = s0[2] - 0.02, y1 = s1[2] - 0.02;
        var len = Math.hypot(x1 - x0, z1 - z0);
        addD(CR.Geo.box(0.09, 0.12, len + 0.03, 1), [0.30, 0.31, 0.32],
             (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2,
             0, Math.atan2(x1 - x0, z1 - z0), 0);
      }
    }
    /* 驾驶舱 + 顶 + 暖色舷窗 */
    addD(CR.Geo.box(1.55, 0.95, 1.70, 1), [0.20, 0.23, 0.26], 0, 1.14, -0.95);
    addD(CR.Geo.box(1.72, 0.09, 1.86, 1), [0.28, 0.30, 0.33], 0, 1.66, -0.95);
    [-0.48, 0, 0.48].forEach(function (px) {
      addL(CR.Geo.box(0.30, 0.26, 0.04, 1), [1.0, 0.78, 0.45], px, 1.27, -0.06);
    });
    /* 桅杆 + 横桁 */
    addD(new THREE.CylinderGeometry(0.055, 0.075, 4.60, 8), [0.19, 0.21, 0.24], 0, 2.92, 0.15);
    var yard = new THREE.CylinderGeometry(0.032, 0.032, 2.30, 6);
    yard.rotateZ(Math.PI / 2);
    addD(yard, [0.19, 0.21, 0.24], 0, 4.05, 0.15);
    /* 护舷轮胎 + 红绿舷灯（与浮标配色呼应） */
    [-1, 1].forEach(function (sd) {
      [-1.7, 0.5].forEach(function (zz) {
        var t = new THREE.TorusGeometry(0.24, 0.075, 6, 10);
        t.rotateY(Math.PI / 2);
        addD(t, [0.10, 0.10, 0.11], sd * 1.30, 0.42, zz);
      });
      addL(new THREE.SphereGeometry(0.13, 8, 6),
           sd < 0 ? [0.90, 0.16, 0.10] : [0.16, 0.85, 0.35], sd * 1.24, 0.80, 0.70);
    });
    /* 缆绳：桅顶到船首/尾/两舷 + 横桁斜拉 */
    [[0, 5.20, 0.15, 0, 1.28, 3.10], [0, 5.20, 0.15, 0, 0.68, -3.05],
     [0, 5.20, 0.15, -1.22, 0.70, -1.20], [0, 5.20, 0.15, 1.22, 0.70, -1.20],
     [-1.15, 4.05, 0.15, 0, 5.20, 0.15], [1.15, 4.05, 0.15, 0, 5.20, 0.15]
    ].forEach(function (r) { ropePts.push(r[0], r[1], r[2], r[3], r[4], r[5]); });
    var ropes = new THREE.BufferGeometry();
    ropes.setAttribute('position', new THREE.Float32BufferAttribute(ropePts, 3));

    var out = {
      hull: hull, deck: deck,
      detail: CR.Geo.merge(detail), lights: CR.Geo.merge(lights), ropes: ropes
    };
    detail.forEach(function (g) { g.dispose(); });
    lights.forEach(function (g) { g.dispose(); });
    return out;
  }

  /* ---------------- create ---------------- */
  Props.create = function (scene) {
    var r = CR.rng(CR.SALT.tree0), T = CR.Track, i, k;

    /* 松树：850 棵 InstancedMesh，区域/高度/海陆/fbm 密度筛选，避开路面与房基 */
    var treeMat = Props.addSway(new THREE.MeshStandardMaterial({
      map: CR.Tex.get('foliage'), vertexColors: true, roughness: 0.95, side: THREE.DoubleSide
    }), 0.34);
    var trees = [], tries = 0;
    while (trees.length < CR.quality.trees && tries++ < CR.quality.trees * 8) {
      var sp = safeSpot(r, 11, 1400);
      if (!sp) continue;
      var sea = CR.ss(-110, 10, (sp.x + sp.z) * 0.7071);
      var dens = CR.fbm(sp.x * 0.0016, sp.z * 0.0016, 4, 113);
      if (r() > dens * 1.35) continue;
      if (sea > 0.75 && r() > 0.22) continue;
      var sc = r.range(0.75, 1.75), tint = r.range(0.78, 1.22);
      trees.push({ x: sp.x, y: sp.y - 0.1, z: sp.z, ry: r.range(0, 6.28),
                   sx: sc, sy: sc * r.range(0.9, 1.25), sz: sc,
                   c: [tint, tint * r.range(0.92, 1.06), tint * 0.92] });
    }
    dyn.treeMesh = instanced(scene, pineGeo(), treeMat, trees);

    /* 路边杂草丛：8 叶片合并 + InstancedMesh */
    var weedMat = Props.addSway(new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1, side: THREE.DoubleSide
    }), 0.20);
    var weeds = [], wc = Math.floor(T.L / 4.5);
    for (k = 0; k < wc; k++) {
      var s = k * 4.5 + r.range(-1, 1), lat = (r.sign()) * (T.ROAD_HALF + 3.2 + r.range(0, 7));
      var p = T.pointAt(s, lat);
      var y = CR.Terrain.heightAt(p.x, p.z);
      if (y < CR.SEA + 0.3) continue;
      var ws = r.range(0.6, 1.5), g2 = r.range(0.8, 1.15);
      weeds.push({ x: p.x, y: y, z: p.z, ry: r.range(0, 6.28), sx: ws, sy: ws, sz: ws, c: [g2, g2, g2 * 0.9] });
    }
    instanced(scene, weedGeo(), weedMat, weeds, false);

    /* 礁石：Icosahedron 噪声变形 + 平滑法线 */
    var rocks = [];
    for (k = 0; k < 180; k++) {
      var s2 = r.range(0, T.L), lat2 = r.sign() * r.range(12, 95);
      var p2 = T.pointAt(s2, lat2), y2 = CR.Terrain.heightAt(p2.x, p2.z, hOut);
      /* 只沿水线摆：岸上太高不放；海床很深时把礁石提到水线附近半潜，
         否则按旧条件 [SEA-4, SEA+1.6] 在「陆地 4.6m / 海床 -8m」的地形上
         几乎一个都命中不了（实测只剩 1 块石头）。 */
      if (y2 > CR.SEA + 2.2) continue;
      var ry = Math.max(y2, CR.SEA - 0.9);
      var rs = r.range(0.6, 3.2), g3 = r.range(0.7, 1.15);
      rocks.push({ x: p2.x, y: ry, z: p2.z, ry: r.range(0, 6.28),
                   sx: rs, sy: rs * r.range(0.5, 0.9), sz: rs, c: [g3, g3, g3] });
    }
    instanced(scene, rockGeo(7), new THREE.MeshStandardMaterial({ vertexColors: true, map: CR.Tex.get('rock'), roughness: 1 }), rocks, false);

    /* 电线杆 + 抛物线下垂电线（14 段 LineSegments） */
    var poleGeo = CR.Geo.merge([
      new THREE.CylinderGeometry(0.11, 0.16, 7.4, 6).translate(0, 3.7, 0),
      CR.Geo.place(CR.Geo.box(3.0, 0.16, 0.16, 1), 0, 6.9, 0)
    ]);
    var poleMat = new THREE.MeshStandardMaterial({ map: CR.Tex.get('wood'), roughness: 0.95 });
    var poleList = [], wirePts = [], poles = [];
    for (k = T.iWest0; k < T.iWest1; k += Math.round(60 / T.ds)) {
      var pk = T.pointAt(k * T.ds, -(T.outerLimit + 6));
      var py = CR.Terrain.heightAt(pk.x, pk.z);
      poleList.push({ x: pk.x, y: py, z: pk.z, ry: 0, sx: 1, sy: 1, sz: 1, c: [1, 1, 1] });
      poles.push(new THREE.Vector3(pk.x, py + 6.9, pk.z));
    }
    instanced(scene, poleGeo, poleMat, poleList);
    var sag = 1.6;
    for (k = 0; k < poles.length - 1; k++) {
      var A = poles[k], B = poles[k + 1];
      for (var q = 0; q < 14; q++) {
        var t0 = q / 14, t1 = (q + 1) / 14;
        var a = A.clone().lerp(B, t0); a.y -= sag * 4 * t0 * (1 - t0);
        var b = A.clone().lerp(B, t1); b.y -= sag * 4 * t1 * (1 - t1);
        wirePts.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
    var wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(wirePts, 3));
    scene.add(new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x2b2b30 })));

    /* 3 栋小平房：灰泥墙 + 人字瓦顶 + 部分亮灯窗 + 烟囱 */
    var wallMat = new THREE.MeshStandardMaterial({ map: CR.Tex.get('plaster'), vertexColors: true, roughness: 0.9 });
    var roofMat = new THREE.MeshStandardMaterial({ map: CR.Tex.get('roof'), bumpMap: CR.Tex.get('roofBump'), bumpScale: 0.3, roughness: 0.85, side: THREE.DoubleSide });
    var litMat = new THREE.MeshBasicMaterial({ color: 0xffd28a });
    CR.Terrain.pads.forEach(function (pad, idx) {
      var hr = CR.rng(CR.SALT.house + idx), hg = houseGeo(hr);
      var hm = new THREE.Mesh(hg.walls, wallMat);
      hm.position.set(pad.x, pad.h, pad.z); hm.rotation.y = hr.range(0, 6.28);
      hm.castShadow = true; hm.receiveShadow = true; scene.add(hm);
      /* 屋顶 / 窗户都作为房子的子对象，用局部坐标 —— 房子旋转时不会再飘到墙外 */
      var rm = new THREE.Mesh(hg.roof, roofMat);
      rm.castShadow = true; rm.receiveShadow = true; hm.add(rm);
      for (var w2 = 0; w2 < 3; w2++) {
        if (hr() > 0.55) {
          var win = new THREE.Mesh(CR.Geo.box(0.95, 1.0, 0.06, 1), litMat);
          win.position.set(-hg.w * 0.28 + w2 * hg.w * 0.28, 1.65, hg.d / 2 + 0.1);
          hm.add(win);
        }
      }
    });

    /* 木栈道 + 灯塔：从岸上一路铺到灯塔脚下。
       早先只是一块 46m 的孤立木板浮在海上，跟岸完全不相连。
       现在沿岸→海分 16 段，逐段降到海平面高度（每级 0.25m < 板厚 0.34m，
       段间重叠 0.45m，所以看起来是一条连续的缓坡栈道）。 */
    var lp = T.pointAt(T.L * 0.80, -70, {});
    var lx = lp.x, lz = lp.z, ly = Math.max(CR.Terrain.heightAt(lx, lz), CR.SEA + 0.4);
    var land = T.pointAt(T.L * 0.80, -7.5, {});
    var yLand = Math.max(CR.Terrain.heightAt(land.x, land.z), CR.SEA + 0.45);
    var ySea = CR.SEA + 0.35;
    var dxP = lx - land.x, dzP = lz - land.z;
    var yawP = Math.atan2(dxP, dzP), spanP = Math.hypot(dxP, dzP);
    var SEGS = 16, boards = [], segLen = spanP / SEGS;
    for (var pi = 0; pi < SEGS; pi++) {
      var pt = (pi + 0.5) / SEGS;
      var bx = land.x + dxP * pt, bz = land.z + dzP * pt;
      var by = CR.lerp(yLand, ySea, pt);
      var bd = CR.Geo.box(4.2, 0.34, segLen + 0.45, 0.25);
      CR.Geo.place(bd, bx, by, bz, 0, yawP, 0);
      boards.push(bd);
      if (pi % 3 === 1) {
        [-1, 1].forEach(function (sgp) {
          var pile = new THREE.CylinderGeometry(0.14, 0.18, 3.4, 6);
          pile.translate(sgp * 1.7, -1.7, 0);
          CR.Geo.place(pile, bx, by, bz, 0, yawP, 0);
          boards.push(pile);
        });
      }
    }
    var pierMat = new THREE.MeshStandardMaterial({ map: CR.Tex.get('wood'), roughness: 0.95, side: THREE.DoubleSide });
    var pier = new THREE.Mesh(CR.Geo.merge(boards), pierMat);
    boards.forEach(function (g) { g.dispose(); });
    pier.castShadow = true; pier.receiveShadow = true; scene.add(pier);

    /* 灯塔：基座 / 分节 / 窗门 / 外廊栏杆 / 灯室框架 / 屋顶 + 脉冲光晕。
       门朝栈道来向（yawP + π），塔基与栈道末端同高。 */
    var LH = lighthouseGeo(yawP + Math.PI);
    var tower = new THREE.Group(); tower.position.set(lx, ly, lz);
    var towerBody = new THREE.Mesh(LH.shaft,
      new THREE.MeshStandardMaterial({ map: CR.Tex.get('lighthouse'), roughness: 0.88 }));
    towerBody.position.y = 9.38; towerBody.castShadow = true; tower.add(towerBody);
    var towerPaint = new THREE.Mesh(LH.painted,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.06, side: THREE.DoubleSide }));
    towerPaint.castShadow = true; tower.add(towerPaint);
    var towerMetal = new THREE.Mesh(LH.metal,
      new THREE.MeshStandardMaterial({ color: 0x4a4e54, metalness: 0.72, roughness: 0.46 }));
    towerMetal.castShadow = true; tower.add(towerMetal);
    var lantern = new THREE.Mesh(LH.glass, new THREE.MeshStandardMaterial({
      color: 0x9fb4c0, metalness: 0.1, roughness: 0.16,
      transparent: true, opacity: 0.30, side: THREE.DoubleSide, depthWrite: false
    }));
    lantern.position.y = 19.25; tower.add(lantern);
    dyn.lampMat = new THREE.MeshStandardMaterial({
      color: 0xfff0c0, emissive: 0xffd070, emissiveIntensity: 1.6, transparent: true, opacity: 0.94
    });
    var lamp = new THREE.Mesh(LH.lamp, dyn.lampMat);
    lamp.position.y = 19.25; tower.add(lamp);
    /* 光晕复用现成的径向 dust 贴图，与同一条脉冲曲线呼吸，不新增贴图 */
    dyn.lampGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: CR.Tex.get('dust'), color: 0xffd28a, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.12
    }));
    dyn.lampGlow.position.set(0, 19.25, 0);
    dyn.lampGlow.scale.set(4.6, 4.6, 1);
    tower.add(dyn.lampGlow);
    scene.add(tower);

    /* 发车拱门 + 顶点着色器布料波动旗帜 */
    var sp0 = T.pointAt(0, 0);
    var arch = new THREE.Group(); arch.position.set(sp0.x, sp0.y, sp0.z);
    arch.rotation.y = Math.atan2(sp0.tx, sp0.tz);
    var archMat = new THREE.MeshStandardMaterial({ color: 0x4a4e56, roughness: 0.6, metalness: 0.5 });
    [-1, 1].forEach(function (sg) {
      var leg = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 6.4, 8), archMat);
      leg.position.set(sg * (T.ROAD_HALF + 1.4), 3.2, 0); arch.add(leg);
    });
    var beam = new THREE.Mesh(CR.Geo.box(T.ROAD_HALF * 2 + 3.4, 0.4, 0.4, 1), archMat);
    beam.position.y = 6.3; arch.add(beam);
    scene.add(arch);

    /* 发车旗帜：横幅直接挂在拱门横梁下，顶点着色器做布料波动。
       e = uv.x 递增 → 靠旗杆一端(uv.x=0)几乎不动，自由端摆幅最大。 */
    var flagMat = new THREE.ShaderMaterial({
      uniforms: { uTime: CR.time, tBanner: { value: CR.Tex.get('banner') } },
      vertexShader: [
        'uniform float uTime; varying vec2 vUv;',
        'void main(){ vUv = uv; vec3 p = position;',
        '  float e = uv.x * 0.85 + 0.15;',
        '  p.z += sin(uv.x * 6.0 + uTime * 3.1) * 0.30 * e + sin(uv.x * 13.0 - uTime * 4.2) * 0.09 * e;',
        '  p.y += sin(uv.x * 7.0 + uTime * 2.2) * 0.07 * e;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }'
      ].join('\n'),
      fragmentShader: 'uniform sampler2D tBanner; varying vec2 vUv; void main(){ gl_FragColor = texture2D(tBanner, vUv); }',
      side: THREE.DoubleSide
    });
    var flag = new THREE.Mesh(new THREE.PlaneGeometry(T.ROAD_HALF * 2 + 2.6, 1.25, 24, 4), flagMat);
    flag.position.set(0, 5.5, 0.25); arch.add(flag);
    dyn.flag = flag;

    /* 远处小岛：Plane 顶点按 fbm 抬高 */
    var islandGeo = new THREE.PlaneGeometry(900, 420, 48, 24);
    islandGeo.rotateX(-Math.PI / 2);
    var ip = islandGeo.getAttribute('position');
    for (i = 0; i < ip.count; i++) {
      var ix = ip.getX(i), iz = ip.getZ(i);
      ip.setY(i, CR.fbm(ix * 0.004, iz * 0.004, 4, 311) * 34 - 8);
    }
    ip.needsUpdate = true; islandGeo.computeVertexNormals();
    var island = new THREE.Mesh(islandGeo, new THREE.MeshStandardMaterial({ color: 0x5f6b52, roughness: 1 }));
    island.position.set(900, -4, 900); scene.add(island);

    /* 渔船：V 形放样船体 + 木甲板 + 舱室/桅杆/横桁/缆绳/护舷/舷灯。
       group 原点仍是水线，Props.update 里 b.y = Ocean.heightAt(...) 原样保留。 */
    var BG = boatGeo();
    var boat = new THREE.Group();
    var hull = new THREE.Mesh(BG.hull, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.86, metalness: 0.10, side: THREE.DoubleSide
    }));
    hull.castShadow = true; boat.add(hull);
    var deck = new THREE.Mesh(BG.deck, new THREE.MeshStandardMaterial({
      map: CR.Tex.get('wood'), roughness: 0.95, side: THREE.DoubleSide
    }));
    deck.castShadow = true; boat.add(deck);
    var boatDetail = new THREE.Mesh(BG.detail, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.78, metalness: 0.16, side: THREE.DoubleSide
    }));
    boatDetail.castShadow = true; boat.add(boatDetail);
    boat.add(new THREE.Mesh(BG.lights, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
    boat.add(new THREE.LineSegments(BG.ropes, new THREE.LineBasicMaterial({ color: 0x4a4540 })));
    boat.position.set(lx - 60, CR.SEA, lz + 40); scene.add(boat); dyn.boat = boat;

    /* 红绿发光浮标 */
    dyn.buoys = [];
    [0, 1, 2, 3, 4, 5].forEach(function (b) {
      var col = b % 2 ? 0x36d46a : 0xe8503c;
      var bm = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 1.5, roughness: 0.5 });
      var mesh = new THREE.Mesh(new THREE.SphereGeometry(0.55, 10, 8), bm);
      mesh.position.set(lx - 30 + b * 9, CR.SEA, lz + 18 + (b % 2) * 8);
      scene.add(mesh);
      dyn.buoys.push({ mesh: mesh, x: mesh.position.x, z: mesh.position.z, ph: b * 1.1 });
    });

    /* 11 只周期性飞过的海鸥群（扇翅 / 偶尔滑翔） */
    dyn.gulls = [];
    var gullMat = new THREE.MeshStandardMaterial({ color: 0xf2efe6, side: THREE.DoubleSide, roughness: 0.9 });
    for (k = 0; k < CR.CFG.SEAGULLS; k++) {
      var bird = new THREE.Group();
      var body = new THREE.Mesh(new THREE.ConeGeometry(0.16, 1.1, 5), gullMat);
      body.rotation.x = Math.PI / 2; bird.add(body);
      var wings = [];
      [-1, 1].forEach(function (sg) {
        var w = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 0.42), gullMat);
        w.position.set(sg * 0.58, 0, 0); bird.add(w); wings.push({ mesh: w, sg: sg });
      });
      bird.userData = { phase: k * 0.9, offset: k * 2.7, wings: wings, y: 22 + (k % 4) * 3 };
      scene.add(bird); dyn.gulls.push(bird);
    }

    Props.ready = true;
    return Props;
  };

  /* ---------------- update(dt, t, focus) ---------------- */
  Props.update = function (dt, t, focus) {
    if (!Props.ready) return;
    /* 灯塔脉冲：灯芯与光晕共用同一条曲线，与全局 CR.time 严格同步 */
    if (dyn.lampMat) {
      var pulse = Math.pow(Math.max(0, Math.sin(t * 0.9)), 24);
      dyn.lampMat.emissiveIntensity = 1.6 + 9 * pulse;
      if (dyn.lampGlow) {
        dyn.lampGlow.material.opacity = 0.10 + 0.60 * pulse;
        var gs = 4.4 + 2.0 * pulse;
        dyn.lampGlow.scale.set(gs, gs, 1);
      }
    }
    /* 旗帜波动由共享 uTime 驱动（顶点着色器），这里只加一点点整体摆向 */
    if (dyn.flag) dyn.flag.rotation.y = Math.sin(t * 0.7) * 0.18;

    /* 渔船：有限差分求浪面坡度 → pitch / roll */
    if (dyn.boat) {
      var b = dyn.boat.position, e = 1.5;
      var h0 = CR.Ocean.heightAt(b.x, b.z, t);
      var hx = CR.Ocean.heightAt(b.x + e, b.z, t) - CR.Ocean.heightAt(b.x - e, b.z, t);
      var hz = CR.Ocean.heightAt(b.x, b.z + e, t) - CR.Ocean.heightAt(b.x, b.z - e, t);
      b.y = h0;                      // group 原点 = 水线，船高严格等于波高
      dyn.boat.rotation.x = -hz / (2 * e) * 0.8;
      dyn.boat.rotation.z = hx / (2 * e) * 0.8;
      /* 原来 t*0.06 是匀速自转，渔船会在原地不停打转；改成随浪小幅往复摆头 */
      dyn.boat.rotation.y = Math.sin(t * 0.13) * 0.22;
    }
    /* 浮标随浪起伏 + 轻微摆动 */
    for (var bi = 0; bi < dyn.buoys.length; bi++) {          // 球心在水面 = 半潜漂浮
      var bo = dyn.buoys[bi];
      bo.mesh.position.y = CR.Ocean.heightAt(bo.x, bo.z, t);
      bo.mesh.rotation.z = Math.sin(t * 1.4 + bo.ph) * 0.22;
    }
    /* 海鸥：周期飞过，扇翅 / 偶尔滑翔 */
    for (var gi = 0; gi < dyn.gulls.length; gi++) {
      var bird = dyn.gulls[gi], u = bird.userData;
      var cycle = CR.wrap(t * 0.055 + u.phase * 0.03, 1);
      bird.position.set(-700 + cycle * 1400, u.y + Math.sin(t * 0.8 + u.phase) * 1.6,
                        -180 + u.offset * 12 + Math.sin(cycle * 6.28) * 60);
      bird.rotation.y = Math.PI / 2 + Math.sin(t * 0.4 + u.phase) * 0.25;
      var glide = Math.sin(t * 0.31 + u.phase) > 0.55;
      var flap = glide ? 0.06 : Math.sin(t * 8.5 + u.phase) * 0.62;
      for (var wi = 0; wi < u.wings.length; wi++) {
        var w = u.wings[wi];
        w.mesh.rotation.z = w.sg * (0.12 + flap);
      }
    }
    /* 树 / 杂草的风摆由 addSway 注入的 uTime 自动推进，无需逐实例更新 */
  };

  /* 只读诊断接口：供外部验证各动态确实在随时间变化 */
  Props.diag = function () {
    return {
      lamp: dyn.lampMat ? +dyn.lampMat.emissiveIntensity.toFixed(4) : null,
      boatX: dyn.boat ? +dyn.boat.position.x.toFixed(4) : null,
      boatZ: dyn.boat ? +dyn.boat.position.z.toFixed(4) : null,
      boatY: dyn.boat ? +dyn.boat.position.y.toFixed(4) : null,
      boatPitch: dyn.boat ? +dyn.boat.rotation.x.toFixed(4) : null,
      boatYaw: dyn.boat ? +dyn.boat.rotation.y.toFixed(4) : null,
      glow: dyn.lampGlow ? +dyn.lampGlow.material.opacity.toFixed(4) : null,
      buoyY: dyn.buoys.length ? +dyn.buoys[0].mesh.position.y.toFixed(4) : null,
      gullX: dyn.gulls.length ? +dyn.gulls[0].position.x.toFixed(3) : null,
      flagY: dyn.flag ? +dyn.flag.rotation.y.toFixed(4) : null
    };
  };
})();
