/* =========================================================================
 * geo.js — 几何工具库 CR.Geo
 * merge / tint / ribbon / warpGrid / box / place
 * 约定：除 place 外都返回新的 BufferGeometry（place 原地变换后返回自身）
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var G = CR.Geo = CR.geo = {};     /* CR.geo 是旧别名，保留一版兼容 */

  /* 合并多份 BufferGeometry 的 position/normal/uv/color → 输出 Uint32 索引，
     用来把几十个 Box 拼成一个 draw call。
     缺 normal 时对该份几何先 computeVertexNormals（否则合并后整块黑面），
     缺 color 时填 1（白，不改变最终颜色）。 */
  G.merge = function (list) {
    var P = [], N = [], U = [], C = [], I = [], base = 0, wantA = false, g;
    for (g = 0; g < list.length; g++) {
      var ca = list[g].getAttribute('color');
      if (ca && ca.itemSize === 4) wantA = true;   // 刹车痕 / 胎痕需要顶点 alpha
    }
    for (g = 0; g < list.length; g++) {
      var src = list[g];
      var geo = src.index ? src.toNonIndexed() : src;
      if (!geo.getAttribute('normal')) {
        if (geo === src) geo = src.clone();        // 不污染调用方的几何
        geo.computeVertexNormals();
      }
      var p = geo.getAttribute('position'), n = geo.getAttribute('normal');
      var u = geo.getAttribute('uv'), c = geo.getAttribute('color');
      for (var i = 0; i < p.count; i++) {
        P.push(p.getX(i), p.getY(i), p.getZ(i));
        N.push(n.getX(i), n.getY(i), n.getZ(i));
        U.push(u ? u.getX(i) : 0, u ? u.getY(i) : 0);
        C.push(c ? c.getX(i) : 1, c ? c.getY(i) : 1, c ? c.getZ(i) : 1);
        if (wantA) C.push(c && c.itemSize === 4 ? c.getW(i) : 1);
        I.push(base + i);
      }
      base += p.count;
      if (geo !== src) geo.dispose();
    }
    var out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    out.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    out.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
    out.setAttribute('color', new THREE.Float32BufferAttribute(C, wantA ? 4 : 3));
    out.setIndex(new THREE.BufferAttribute(new Uint32Array(I), 1));
    out.computeBoundingSphere();
    return out;
  };

  /* 写顶点色 + 随机明暗抖动。
     规格签名 tint(g, r, g, b, jitter, rng)；
     另外兼容 r 传数组 / 函数（树与房屋需要逐顶点渐变）。 */
  G.tint = function (geo, r, g, b, jitter, rnd) {
    var p = geo.getAttribute('position'), n = p.count;
    var arr = new Float32Array(n * 3);
    var rnd2 = rnd || CR.rng(CR.SALT.geo);
    var isFn = typeof r === 'function';
    var isArr = Object.prototype.toString.call(r) === '[object Array]';
    for (var i = 0; i < n; i++) {
      var c = isFn ? r(i, p) : (isArr ? r : [r, g, b]);
      var k = 1 + (rnd2() - 0.5) * (jitter || 0);
      arr[i * 3] = c[0] * k; arr[i * 3 + 1] = c[1] * k; arr[i * 3 + 2] = c[2] * k;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return geo;
  };

  /* 沿赛道拉带状网格：prof=[{lat,y,u}]，uv.v = 累计路程/tileV。
     i0 可以为负、i1 可以超过 N —— 索引取模、弧长连续，所以跨起点依然无缝。 */
  G.ribbon = function (T, i0, i1, prof, tileV) {
    T = T || CR.Track;
    var cols = prof.length, rows = i1 - i0 + 1;
    if (rows < 2) throw new Error('[Geo] ribbon 需要至少两行 (i0=' + i0 + ', i1=' + i1 + ')');
    var P = new Float32Array(rows * cols * 3);
    var U = new Float32Array(rows * cols * 2);
    var I = [], r, c;
    for (r = 0; r < rows; r++) {
      var idx = CR.wrap(i0 + r, T.N);
      var s = (i0 + r) * T.ds;
      for (c = 0; c < cols; c++) {
        var pr = prof[c], o = (r * cols + c) * 3;
        P[o] = T.px[idx] + T.lx[idx] * pr.lat;
        P[o + 1] = T.py[idx] + (pr.y || 0);
        P[o + 2] = T.pz[idx] + T.lz[idx] * pr.lat;
        U[(r * cols + c) * 2] = pr.u;
        U[(r * cols + c) * 2 + 1] = s / tileV;
      }
    }
    /* prof 的 lat 递增时 (a,b,e) 法线朝 +Y；递减时必须翻转绕序，
       否则整条路面法线朝下、被 FrontSide 剔除（表现为"公路消失"）。 */
    var latUp = prof[cols - 1].lat > prof[0].lat;
    for (r = 0; r < rows - 1; r++) {
      for (c = 0; c < cols - 1; c++) {
        var a = r * cols + c, b = a + cols, e = a + 1, d = b + 1;
        if (latUp) I.push(a, b, e, e, b, d);
        else I.push(a, e, b, e, d, b);
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
    g.setIndex(I);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  };

  /* 非均匀网格：inner 是中心线性区半宽(米)，中心 60% 顶点线性覆盖 ±inner，
     外部按三次曲线拉伸到 extent(半宽)。一张网格兼顾近景细节与远景。 */
  G.warpGrid = function (n, inner, extent, heightFn, uvFn) {
    var side = n + 1, count = side * side;
    var P = new Float32Array(count * 3), U = new Float32Array(count * 2), I = [];
    var core = Math.min(0.5, inner / extent);
    function map(t) {
      var a = Math.abs(t), sg = t < 0 ? -1 : 1;
      var q = a <= 0.6
        ? (a / 0.6) * core
        : core + (1 - core) * Math.pow((a - 0.6) / 0.4, 3);
      return sg * q * extent;
    }
    for (var j = 0; j < side; j++) {
      for (var i = 0; i < side; i++) {
        var k = j * side + i;
        var x = map(i / n * 2 - 1), z = map(j / n * 2 - 1);
        P[k * 3] = x;
        P[k * 3 + 1] = heightFn ? heightFn(x, z) : 0;
        P[k * 3 + 2] = z;
        if (uvFn) { var uv = uvFn(x, z); U[k * 2] = uv[0]; U[k * 2 + 1] = uv[1]; }
        else { U[k * 2] = i / n; U[k * 2 + 1] = j / n; }
      }
    }
    for (j = 0; j < n; j++) {
      for (i = 0; i < n; i++) {
        var a2 = j * side + i, b2 = a2 + 1, c2 = a2 + side, d2 = c2 + 1;
        I.push(a2, c2, b2, b2, c2, d2);   // 绕序保证法线朝 +Y
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
    g.setIndex(I);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  };

  /* Box 按真实米数重算 6 面 UV（scale 米 = 一张贴图），贴图不会被拉伸 */
  G.box = function (w, h, d, scale) {
    var g = new THREE.BoxGeometry(w, h, d);
    var uv = g.getAttribute('uv'), s = scale == null ? 1 : scale;
    var dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
    for (var f = 0; f < 6; f++) {
      for (var k = 0; k < 4; k++) {
        var i = f * 4 + k;
        uv.setXY(i, uv.getX(i) * dims[f][0] * s, uv.getY(i) * dims[f][1] * s);
      }
    }
    uv.needsUpdate = true;
    return g;
  };

  /* 矩阵变换后返回自身，便于 place(...) 串起来再 merge */
  G.place = function (geo, x, y, z, rx, ry, rz, sx, sy, sz) {
    var q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx || 0, ry || 0, rz || 0));
    var m = new THREE.Matrix4().compose(
      new THREE.Vector3(x || 0, y || 0, z || 0), q,
      new THREE.Vector3(sx == null ? 1 : sx, sy == null ? 1 : sy, sz == null ? 1 : sz));
    geo.applyMatrix4(m);
    return geo;
  };
})();
