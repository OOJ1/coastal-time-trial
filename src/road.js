/* =========================================================================
 * road.js — 路面 / 路肩 / W 形波形梁护栏 / 混凝土防波堤 / 刹车痕 / 发车线
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var Road = CR.Road = {};
  var markMat = null;

  /* 胎痕 / 刹车痕 / 发车线共用：贴在路面上不 Z-fighting */
  Road.markMaterial = function () {
    if (!markMat) {
      markMat = new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
        side: THREE.DoubleSide
      });
    }
    return markMat;
  };

  /* 胎痕 / 刹车痕 / 发车线：一份共享的大 BufferGeometry，直接追加四个顶点。
     markMaterial 是 MeshBasicMaterial，根本不读法线，所以既不建中间 geometry
     也不调 computeVertexNormals —— 原来每个 quad 都白算一次。 */
  function markBuilder() {
    var P = [], C = [], I = [], n = 0;
    return {
      quad: function (p0, p1, p2, p3, rgba) {
        P.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z, p3.x, p3.y, p3.z);
        for (var i = 0; i < 4; i++) C.push(rgba[0], rgba[1], rgba[2], rgba[3]);
        I.push(n, n + 2, n + 1, n + 1, n + 2, n + 3);
        n += 4;
      },
      /* streak()：一条沿赛道的矩形痕迹，参数全部由种子随机决定 */
      streak: function (T, s0, len, lat0, half, rgba) {
        this.quad(T.pointAt(s0, lat0 - half), T.pointAt(s0, lat0 + half),
                  T.pointAt(s0 + len, lat0 - half), T.pointAt(s0 + len, lat0 + half), rgba);
      },
      finish: function (lift) {
        var g = new THREE.BufferGeometry();
        if (lift) for (var v = 1; v < P.length; v += 3) P[v] += lift;
        g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
        g.setAttribute('color', new THREE.Float32BufferAttribute(C, 4));
        g.setIndex(new THREE.BufferAttribute(new Uint32Array(I), 1));
        g.computeBoundingSphere();
        return g;
      }
    };
  }

  Road.create = function (scene) {
    var T = CR.Track, N = T.N, H = T.ROAD_HALF;
    var roadTex = CR.Tex.get('road');   // {map, rb}：rb 的 R 凹凸 / G 粗糙度
    var tile = T.L / Math.max(1, Math.round(T.L / 12));   // 整圈整数循环，闭合处无缝

    /* --- 路面：3 条剖面 --- */
    var roadMat = new THREE.MeshStandardMaterial({
      map: roadTex.map,
      roughnessMap: roadTex.rb,
      bumpMap: roadTex.rb,
      bumpScale: 0.6, roughness: 0.92, metalness: 0.0,
      envMapIntensity: 0.35
    });
    var road = new THREE.Mesh(CR.Geo.ribbon(T, 0, N, [
      { lat: H, u: 0, y: 0 }, { lat: 0, u: 0.5, y: 0.02 }, { lat: -H, u: 1, y: 0 }
    ], tile), roadMat);
    road.receiveShadow = true; road.frustumCulled = false;
    road.renderOrder = 2;
    scene.add(road);

    /* --- 路肩：带 alpha 渐隐，融入地形 --- */
    var shoulderMat = new THREE.MeshStandardMaterial({
      map: CR.Tex.get('shoulder'), transparent: true, depthWrite: false,
      roughness: 1.0, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
    });
    [-1, 1].forEach(function (sg) {
      var prof = [0, 0.5, 1].map(function (k) {
        return { lat: sg * (H + k * 3.2), u: k, y: -0.01 };
      });
      var m = new THREE.Mesh(CR.Geo.ribbon(T, 0, N, prof, tile), shoulderMat);
      m.renderOrder = 1; m.frustumCulled = false;
      scene.add(m);
    });

    /* --- W 形波形梁护栏：5 点剖面；外侧全程，内侧仅北直道 --- */
    var guardMat = new THREE.MeshStandardMaterial({
      map: CR.Tex.get('rust'), roughness: 0.62, metalness: 0.55,
      envMapIntensity: 0.9, side: THREE.DoubleSide
    });
    function rail(from, to, baseLat) {
      var prof = [
        { dx: -0.13, y: 0.34 }, { dx: -0.06, y: 0.66 }, { dx: 0, y: 0.50 },
        { dx: 0.06, y: 0.66 }, { dx: 0.13, y: 0.34 }
      ].map(function (p, k) { return { lat: baseLat + p.dx, u: k / 4, y: p.y }; });
      var m = new THREE.Mesh(CR.Geo.ribbon(T, from, to, prof, 3.2), guardMat);
      m.castShadow = true; m.frustumCulled = false; m.renderOrder = 3;
      scene.add(m);
    }
    var outer = T.outerLimit + 0.9;
    rail(0, N, -outer);                                   // 外侧全程
    rail(T.iStraight0, T.iStraight1, T.innerRailLimit + 0.9); // 内侧仅北直道

    /* --- 南侧 S 弯外缘：3 段混凝土防波堤 --- */
    var wallMat = new THREE.MeshStandardMaterial({
      map: CR.Tex.get('concrete'), roughness: 0.95, side: THREE.DoubleSide
    });
    var walls = [];
    for (var w = 0; w < 3; w++) {
      var lat = -(outer + 0.5 + w * 0.45);
      var prof = [
        { lat: lat - 0.22, u: 0, y: 0.0 },
        { lat: lat - 0.22, u: 0.4, y: 0.55 + w * 0.18 },
        { lat: lat + 0.22, u: 0.6, y: 0.55 + w * 0.18 },
        { lat: lat + 0.22, u: 1, y: 0.0 }
      ];
      walls.push(CR.Geo.ribbon(T, T.iWall0, T.iWall1, prof, 3.0));
    }
    var wall = new THREE.Mesh(CR.Geo.merge(walls), wallMat);
    wall.castShadow = true; wall.receiveShadow = true; wall.frustumCulled = false;
    scene.add(wall);
    walls.forEach(function (g) { g.dispose(); });

    /* --- 立柱：InstancedMesh，每 4.2m 一根，贴地 --- */
    var postGeo = CR.Geo.box(0.13, 1.12, 0.13, 1);
    var postMat = new THREE.MeshStandardMaterial({ color: 0x8c9096, roughness: 0.6, metalness: 0.5 });
    var count = Math.floor(T.L / 4.2), placements = [];
    for (var k = 0; k < count; k++) {
      var s = k * 4.2;
      [-1, 1].forEach(function (sg) {
        /* 内侧(sg>0)护栏只铺到北直道末端，立柱不能孤零零留在其余路段 */
        if (sg > 0 && s > T.iStraight1 * T.ds) return;
        var p = T.pointAt(s, sg * outer);
        placements.push([p.x, CR.Terrain.heightAt(p.x, p.z) + 0.56, p.z]);
      });
    }
    var posts = new THREE.InstancedMesh(postGeo, postMat, placements.length);
    var mtx = new THREE.Matrix4();
    placements.forEach(function (p, i2) { posts.setMatrixAt(i2, mtx.makeTranslation(p[0], p[1], p[2])); });
    posts.instanceMatrix.needsUpdate = true;
    posts.castShadow = true; posts.frustumCulled = false;
    scene.add(posts);

    /* --- 弯道刹车痕：扫描 kappa 局部峰值（±30 采样点内绝对值最大且 >0.0075） --- */
    var rnd = CR.rng(CR.SALT.road), marks = markBuilder();
    var isPeak = function (i) {
      if (Math.abs(T.kappa[i]) <= 0.0075) return false;
      for (var q = -30; q <= 30; q++) {
        if (q && Math.abs(T.kappa[CR.wrap(i + q, N)]) > Math.abs(T.kappa[i])) return false;
      }
      return true;
    };
    var peaks = 0, lastPeak = -1e9;
    for (var i = 0; i < N; i++) {
      if (!isPeak(i)) continue;
      /* 同一个弯只取一次：逐点扫描会在峰顶附近连续命中 */
      var gap = Math.abs(i - lastPeak);
      if (lastPeak >= 0 && Math.min(gap, N - gap) < 60) continue;
      lastPeak = i;
      peaks++;
      var groups = 10 + rnd.int(9);                    // 10–18 组
      for (var g2 = 0; g2 < groups; g2++) {
        var s0 = i * T.ds - (12 + rnd.range(0, 58)); // 弯前 12–70 m 开始
        var len = rnd.range(2.5, 9.0);
        for (var side = 0; side < 2; side++) {
          var lat0 = (side ? 1 : -1) * rnd.range(1.4, 3.4);
          var half = rnd.range(0.12, 0.28);
          var alpha = rnd.range(0.16, 0.46);
          marks.streak(T, s0, len, lat0, half, [0.055, 0.05, 0.048, alpha]);
        }
      }
    }
    /* 发车线：16×2 黑白格 */
    for (var row = 0; row < 2; row++) {
      for (var col2 = 0; col2 < 16; col2++) {
        var l0 = -H + col2 / 16 * H * 2, l1 = -H + (col2 + 1) / 16 * H * 2;
        var sa = row * 0.6, sb = (row + 1) * 0.6;
        var white = ((row + col2) % 2) === 0 ? [0.94, 0.93, 0.90, 1] : [0.08, 0.08, 0.09, 1];
        marks.quad(T.pointAt(sa, l0), T.pointAt(sa, l1), T.pointAt(sb, l0), T.pointAt(sb, l1), white);
      }
    }
    /* 统一抬高 0.055m：路面剖面中心 y=+0.02，所以这里留 0.035m 间隙，不会 Z-fighting */
    var markMesh = new THREE.Mesh(marks.finish(0.055), Road.markMaterial());
    markMesh.frustumCulled = false; markMesh.renderOrder = 4;
    scene.add(markMesh);
    Road.markCount = peaks;

    Road.mesh = road;
    Road.ready = true;
    return Road;
  };
})();
