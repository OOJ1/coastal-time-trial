/* =========================================================================
 * textures.js — 零外部图片：Canvas 2D 逐像素 / 笔触生成 15 类贴图，懒加载缓存
 * tex(c,srgb,rx,ry) → CanvasTexture + RepeatWrapping + sRGB + maxAniso
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var T = CR.Tex = {};
  var cache = {}, roadPair = null;

  function pix(w, h, fn) {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    var x = c.getContext('2d'), img = x.createImageData(w, h), d = img.data;
    for (var j = 0; j < h; j++) {
      for (var i = 0; i < w; i++) {
        var o = (j * w + i) * 4, col = fn(i, j, i / w, j / h);
        d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2];
        d[o + 3] = col[3] == null ? 255 : col[3];
      }
    }
    x.putImageData(img, 0, 0);
    return c;
  }
  function tex(c, srgb, rx, ry) {
    var t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (rx || ry) t.repeat.set(rx || 1, ry || 1);
    t.anisotropy = CR.maxAniso;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    if (srgb) CR.srgb(t);
    t.needsUpdate = true;
    return t;
  }
  function stroke(canvas, fn) { fn(canvas.getContext('2d')); return canvas; }

  /* --- road：颜色图 + R=凹凸 / G=粗糙度 的 surface 图 --- */
  function makeRoad() {
    var S = 512, r = CR.rng(CR.SALT.texCrack);
    var color = pix(S, S, function (i, j, u, v) {
      var n = CR.tfbm(u, v, 8, 8, 4, 771);
      var g = 34 + n * 30;
      /* 4 条高斯胎迹磨损带 */
      var bands = [0.18, 0.34, 0.66, 0.82], k;
      for (k = 0; k < 4; k++) { var d = (u - bands[k]) / 0.055; g += Math.exp(-d * d) * 7; }
      g += (CR.hash2(i, j, 31) - 0.5) * 14;
      var base = [g, g * 1.01, g * 1.05];
      var wn = CR.tfbm(u * 3, v * 3, 24, 24, 3, 313);
      if (Math.abs(u - 0.055) < 0.012 || Math.abs(u - 0.945) < 0.012) {
        base = [196 * (0.72 + wn * 0.34), 194 * (0.72 + wn * 0.34), 182 * (0.72 + wn * 0.34)];
      }
      if (Math.abs(u - 0.5) < 0.012 && (v * 4 % 1) < 0.55) {
        base = [218 * (0.68 + wn * 0.42), 164 * (0.68 + wn * 0.42), 54 * (0.68 + wn * 0.42)];
      }
      return base;
    });
    /* 7 条随机裂纹 */
    stroke(color, function (x) {
      for (var k = 0; k < 7; k++) {
        var px = r() * S, py = r() * S, a = r() * 6.28;
        x.strokeStyle = 'rgba(10,11,13,' + (0.2 + r() * 0.25).toFixed(2) + ')';
        x.lineWidth = 0.6 + r();
        x.beginPath(); x.moveTo(px, py);
        for (var q = 0; q < 6; q++) {
          a += (r() - 0.5) * 1.2;
          px += Math.cos(a) * (12 + r() * 26); py += Math.sin(a) * (12 + r() * 26);
          x.lineTo(px, py);
        }
        x.stroke();
      }
    });
    var surface = pix(S, S, function (i, j, u, v) {
      var n = CR.tfbm(u, v, 8, 8, 4, 991);
      return [128 + (n - 0.5) * 90 + (CR.hash2(i, j, 17) - 0.5) * 44,
              186 + (n - 0.5) * 54, 0, 255];
    });
    return { map: tex(color, true), rb: tex(surface, false) };
  }

  var makers = {
    /* 碎石→杂草渐变，外缘 alpha 渐隐融入地形 */
    shoulder: function () {
      var c = pix(256, 512, function (i, j, u, v) {
        var n = CR.tfbm(u, v, 8, 8, 4, 557);
        var weed = CR.ss(0.35, 1.0, u);
        var g = 92 + n * 62, b = 68 + n * 40;
        return [CR.lerp(g, 68, weed), CR.lerp(b, 92, weed), CR.lerp(52, 42, weed),
                Math.round(255 * (1 - CR.ss(0.72, 1.0, u)))];
      });
      return tex(c, true);
    },
    grass: function () {
      var c = pix(256, 256, function (i, j, u, v) {
        var n = CR.tfbm(u, v, 8, 8, 4, 313), p = CR.hash2(i, j, 5);
        return [46 + n * 58 + p * 22, 66 + n * 74 + p * 18, 32 + n * 34, 255];
      });
      return tex(c, true);
    },
    sand: function () {
      var c = pix(256, 256, function (i, j, u, v) {
        var n = CR.tfbm(u, v, 8, 8, 4, 811);
        var ripple = Math.sin(v * Math.PI * 2 * 10 + CR.tfbm(u, v, 8, 8, 2, 91) * 12) * 8;
        return [178 + n * 50 + ripple, 156 + n * 44 + ripple, 118 + n * 34, 255];
      });
      return tex(c, true);
    },
    rock: function () {
      var c = pix(256, 256, function (i, j, u, v) {
        var n = CR.tfbm(u, v, 8, 8, 4, 1201);
        var layer = Math.sin(v * Math.PI * 2 * 5 + n * 8) * 12;
        return [88 + n * 76 + layer, 88 + n * 72 + layer, 86 + n * 70 + layer, 255];
      });
      return tex(c, true);
    },
    /* 雪面：极低对比的近白噪 + 顺风向拉长的风蚀条纹。
       只用来给山体提供高频细节（材质里按 lum 剥掉自身亮度），
       所以真正决定颜色的是 snowmountain.js 的顶点色，不会因为贴图偏蓝而发青。 */
    snow: function () {
      var c = pix(256, 256, function (i, j, u, v) {
        var n = CR.tfbm(u, v, 8, 8, 4, 4409);
        var drift = Math.sin(v * Math.PI * 2 * 5 + CR.tfbm(u, v, 8, 8, 2, 17) * 9) * 7;
        var g = CR.hash2(i, j, 77);
        var base = 196 + n * 34 + drift + g * 8;
        return [base - 4, base, base + 5, 255];
      });
      return tex(c, true);
    },
    concrete: function () {
      var c = pix(256, 256, function (i, j, u, v) {
        var n = CR.tfbm(u, v, 8, 8, 4, 2027);
        var seam = ((v * 4 + 0.5) % 1 < 0.02 || (u * 2 + 0.5) % 1 < 0.015) ? -38 : 0;
        return [142 + n * 44 + seam, 140 + n * 42 + seam, 132 + n * 40 + seam, 255];
      });
      return tex(c, true);
    },
    rust: function () {
      var c = pix(256, 256, function (i, j, u, v) {
        var n = CR.tfbm(u, v, 8, 8, 4, 616);
        var rust = CR.ss(0.55, 0.78, n) * 150;
        return [128 + n * 50 + rust, 132 + n * 44 + rust * 0.45, 138 + n * 40, 255];
      });
      return tex(c, true);
    },
    roof: function () {
      var c = pix(256, 256, function (i, j, u, v) {
        var row = Math.floor(v * 12), shift = (row % 2) * 0.5;
        var cu = (u * 9 + shift + 0.5) % 1, cv = (v * 12 + 0.5) % 1;
        var tile = (cu < 0.06 || cv < 0.08) ? -34 : 0;
        var n = CR.tfbm(u, v, 8, 8, 3, 4409);
        var moss = CR.ss(0.62, 0.85, n) * 40;
        return [128 + n * 48 + tile, 66 + n * 32 + tile + moss, 48 + n * 24 + tile, 255];
      });
      return tex(c, true);
    },
    roofBump: function () {
      var c = pix(256, 256, function (i, j, u, v) {
        var cv = (v * 12 + 0.5) % 1, cu = (u * 9 + (Math.floor(v * 12) % 2) * 0.5 + 0.5) % 1;
        var h = (cu < 0.06 || cv < 0.08) ? 60 : 190;
        return [h, h, h, 255];
      });
      return tex(c, false);
    },
    plaster: function () {
      var c = pix(256, 256, function (i, j, u, v) {
        var n = CR.tfbm(u, v, 8, 8, 4, 3301);
        var streak = Math.pow(CR.tfbm(u, v, 128, 2, 2, 77), 4) * 26;
        return [206 + n * 38 - streak, 198 + n * 36 - streak, 182 + n * 32 - streak, 255];
      });
      return tex(c, true);
    },
    wood: function () {
      var c = pix(128, 128, function (i, j, u, v) {
        var n = Math.sin(u * Math.PI * 2 * 9 + CR.tfbm(u, v, 8, 8, 2, 6607) * 8) * 0.5 + 0.5;
        return [92 + n * 46, 66 + n * 34, 42 + n * 22, 255];
      });
      return tex(c, true);
    },
    foliage: function () {
      var c = pix(128, 128, function (i, j, u, v) {
        var n = CR.tfbm(u, v, 8, 8, 3, 818), needle = Math.sin(u * Math.PI * 2 * 14) * 10;
        return [30 + n * 46 + needle, 58 + n * 72 + needle, 30 + n * 34, 255];
      });
      return tex(c, true);
    },
    lighthouse: function () {
      var c = pix(128, 256, function (i, j, u, v) {
        var band = (v > 0.22 && v < 0.36) || (v > 0.62 && v < 0.76);
        var n = CR.tfbm(u, v, 8, 8, 3, 5519), weather = CR.ss(0.55, 0.85, n) * 40;
        return band ? [176 - weather, 56 - weather * 0.5, 44 - weather * 0.4, 255]
                    : [224 - weather, 218 - weather, 202 - weather, 255];
      });
      return tex(c, true);
    },
    /* 可平铺 fbm 高度场 → 中心差分求梯度 → 切线空间法线，B 通道存高度 */
    waterNormal: function () {
      var S = 256, h = new Float32Array(S * S);
      for (var j = 0; j < S; j++) for (var i = 0; i < S; i++) h[j * S + i] = CR.tfbm(i / S, j / S, 8, 8, 4, 991);
      var c = pix(S, S, function (i, j) {
        var l = h[j * S + ((i - 1 + S) % S)], r = h[j * S + ((i + 1) % S)];
        var u = h[((j - 1 + S) % S) * S + i], d = h[((j + 1) % S) * S + i];
        var nx = (l - r) * 3, ny = (u - d) * 3, nz = 1;
        var len = Math.hypot(nx, ny, nz);
        return [(nx / len * 0.5 + 0.5) * 255, (ny / len * 0.5 + 0.5) * 255,
                (h[j * S + i] * 0.5 + 0.5) * 255, 255];
      });
      return tex(c, false);
    },
    /* 纯 2D Canvas 五辐轮毂 + 金属圈 */
    rim: function () {
      var S = 256, c = document.createElement('canvas'); c.width = c.height = S;
      var x = c.getContext('2d');
      var g = x.createRadialGradient(S / 2, S / 2, 20, S / 2, S / 2, S / 2);
      g.addColorStop(0, '#3a3d42'); g.addColorStop(0.72, '#9aa0a6'); g.addColorStop(1, '#d8dce0');
      x.fillStyle = g; x.fillRect(0, 0, S, S);
      x.translate(S / 2, S / 2);
      for (var k = 0; k < 5; k++) {
        x.save(); x.rotate(k / 5 * Math.PI * 2);
        x.fillStyle = '#41454b';
        x.beginPath(); x.moveTo(-14, -22); x.lineTo(14, -22); x.lineTo(9, -104); x.lineTo(-9, -104); x.closePath(); x.fill();
        x.strokeStyle = 'rgba(230,235,240,0.55)'; x.lineWidth = 2; x.stroke();
        x.restore();
      }
      x.fillStyle = '#22252a'; x.beginPath(); x.arc(0, 0, 27, 0, 6.2832); x.fill();
      x.strokeStyle = '#cfd4d8'; x.lineWidth = 7; x.beginPath(); x.arc(0, 0, 118, 0, 6.2832); x.stroke();
      return tex(c, true);
    },
    dust: function () {
      var S = 64, c = pix(S, S, function (i, j) {
        var d = Math.hypot(i - S / 2, j - S / 2) / (S / 2);
        var a = Math.max(0, 1 - d * d);
        return [226, 208, 176, Math.round(a * a * 255)];
      });
      return tex(c, true);
    },
    banner: function () {
      var W = 512, H = 64, c = pix(W, H, function (i, j, u, v) {
        var chk = ((Math.floor(u * 24) + Math.floor(v * 3)) % 2) ? 1 : 0;
        var stripe = (v > 0.30 && v < 0.52) ? 1 : 0;
        if (stripe) return [232, 108, 38, 255];
        return chk ? [238, 234, 222, 255] : [42, 46, 54, 255];
      });
      return tex(c, true);
    }
  };

  /* 懒加载 + 缓存。'road' 这一张特殊：它其实是 {map, rb} 两张
     （rb 的 R 存凹凸、G 存粗糙度），用 roadMap / roadRB 可取单张。 */
  T.get = function (name) {
    if (!roadPair) roadPair = makeRoad();
    if (name === 'road') return roadPair;
    if (name === 'roadMap') return roadPair.map;
    if (name === 'roadRB' || name === 'roadSurface') return roadPair.rb;
    if (!cache[name]) {
      if (!makers[name]) throw new Error('[Tex] unknown texture: ' + name);
      cache[name] = makers[name]();
    }
    return cache[name];
  };
})();
