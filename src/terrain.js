/* =========================================================================
 * terrain.js — 非均匀网格地形 / 路廊贴合 / splat 三图混合 / shoreTex
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var Terrain = CR.Terrain = {};
  var nrTmp = {}, usePads = false;

  /* 3 处小房子的平整地基；Props 会复用同一份坐标 */
  /* 三处房基必须都在陆地上：第三处原来 (240,-205) 的 x+z≈35，
     按 sea=ss(-110,10,(x+z)*0.7071+噪声) 已落在海边甚至水下，
     于是房子变成海中央一块方形孤岛。挪到西北内陆 (x+z=-470)。 */
  Terrain.pads = [
    { x: -255, z: -120, r: 16 },
    { x: -268, z: 95, r: 15 },
    { x: -235, z: -235, r: 14 }
  ];
  /* 房基高度必须等 Track.build() 之后、用完整的 heightAt 求一次。
     早先在这里写死 baseElev+0.2，漏掉了 fbm 丘陵(+0~15m)：
     · 陆地上 → 房基被强行压到周围地面以下，房子坐在一个圆形凹坑里；
     · 海边上 → 房基反而凸出海面，变成一块方形孤岛。 */
  var padsInit = false;
  function initPads() {
    if (padsInit) return;
    padsInit = true;                       // 先置位，避免 heightAt 递归回来
    var saved = usePads; usePads = false;
    for (var i = 0; i < Terrain.pads.length; i++) {
      var p = Terrain.pads[i];
      p.h = Terrain.heightAt(p.x, p.z, {}) + 0.08;
    }
    usePads = saved;
  }
  Terrain.initPads = initPads;

  Terrain.heightAt = function (x, z, out) {
    if (usePads && !padsInit) initPads();
    var nr = CR.Track.nearest(x, z, out || nrTmp);
    /* 规格：sea = ss(-110, 10, (x+z)*0.7071 + 噪声)。环内永远是缓坡（内侧），
       只有环外侧才可能落进"东/南入海滩涂"。
       噪声幅度 150m，否则海岸线是一条笔直的斜线（一眼假）。
       注意 seabed 必须真的沉到海平面 1.6m 以下 —— 早先只减 3m，地形整片仍在
       水上，海被完全埋住，整张图看起来是一片绿色平原，"海岸"根本不成立。 */
    var seaN = (CR.fbm(x * 0.0021, z * 0.0021, 4, 71) - 0.5) * 150;
    var coast = CR.ss(-110, 10, (x + z) * 0.7071 + seaN);
    var sea = coast * (nr.lat < 0 ? 1 : 0);
    var hill = CR.fbm(x * 0.0016, z * 0.0016, 4, 29) * 22;
    /* 滩涂一侧不许起丘陵：路边 40m 处鼓一个 13m 的小山，海就在山后面看不见了 */
    var land = CR.baseElev(x, z) + hill * (nr.lat > 0 ? 0.35 : 0.7 * (1 - coast * 0.95));
    var seabed = -8.0 - CR.fbm(x * 0.004, z * 0.004, 3, 41) * 6.0;
    var h = CR.lerp(land, seabed, sea);
    /* 路廊贴合：陆地过渡 44m，海边收窄到 12.5m，保证路面与地形无接缝 */
    var blendEnd = 44 - sea * 31.5;
    h = CR.lerp(nr.y - 0.3, h, CR.ss(9, blendEnd, nr.d));
    /* 远处 3500–4300m 沉到 -25m 消除断面 */
    var rr = Math.hypot(x, z);
    h = CR.lerp(h, -25, CR.ss(3500, 4300, rr));
    if (usePads) {
      for (var i = 0; i < Terrain.pads.length; i++) {
        var p = Terrain.pads[i], d = Math.hypot(x - p.x, z - p.z);
        h = CR.lerp(p.h, h, CR.ss(p.r * 0.35, p.r * 1.7, d));
      }
    }
    if (out) out.h = h;
    return h;
  };

  /* 256² DataTexture 烘焙地形高度，供海面 shader 判断浅水与浪花 */
  function bakeShore() {
    var S = 256, data = new Uint8Array(S * S * 4), i, j;
    for (j = 0; j < S; j++) {
      for (i = 0; i < S; i++) {
        var x = (i / (S - 1) - 0.5) * 1000, z = (j / (S - 1) - 0.5) * 1000;
        var h = Terrain.heightAt(x, z);
        var v = Math.round(CR.clamp01((h - CR.SEA + 6) / 20) * 255);
        var o = (j * S + i) * 4;
        data[o] = data[o + 1] = data[o + 2] = v; data[o + 3] = 255;
      }
    }
    var t = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = t.magFilter = THREE.LinearFilter;
    t.needsUpdate = true;
    return t;
  }

  Terrain.create = function (scene) {
    usePads = true;
    initPads();          // 显式求房基高度，下游 Props 直接读 pad.h
    var n = CR.quality.terr;
    var geo = CR.Geo.warpGrid(n, 420, CR.CFG.TERR_EXT, function (x, z) { return Terrain.heightAt(x, z); });

    /* 每顶点算 P18 宏观色：干黄草 0.52/0.45/0.23 ↔ 青绿 0.27/0.33/0.14，
       fbm 斑驳 + 湿沙压暗 + 陡坡转岩。贴图只负责高频细节（见 onBeforeCompile）。 */
    var p = geo.getAttribute('position'), nv = geo.getAttribute('normal');
    var col = new Float32Array(p.count * 3);
    for (var i = 0; i < p.count; i++) {
      var x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      var wet = CR.ss(3.6, 1.0, y);                       // 近水更湿、更暗
      var n2 = CR.fbm(x * 0.0022, z * 0.0022, 4, 61);
      var dry = CR.clamp01(0.28 + n2 * 0.92 - wet * 0.3);
      var r = CR.lerp(0.225, 0.415, dry), g = CR.lerp(0.255, 0.375, dry), b = CR.lerp(0.155, 0.215, dry);
      var slope = 1 - CR.clamp01(nv.getY(i));
      var rocky = CR.ss(0.25, 0.62, slope) * 0.55;
      /* 沙滩只在紧邻水线的一条窄带上，否则整片滩涂会被刷成白色 */
      var sandy = CR.ss(2.2, 0.3, y) * 0.62;
      r = CR.lerp(r, 0.50, sandy); g = CR.lerp(g, 0.45, sandy); b = CR.lerp(b, 0.35, sandy);
      col[i * 3] = CR.lerp(r, 0.31, rocky);
      col[i * 3 + 1] = CR.lerp(g, 0.30, rocky);
      col[i * 3 + 2] = CR.lerp(b, 0.27, rocky);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

    var mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0.0 });
    /* onBeforeCompile 注入三张贴图混合；旋转矩阵打散第二层重复感 */
    mat.onBeforeCompile = function (shader) {
      shader.uniforms.tGrass = { value: CR.Tex.get('grass') };
      shader.uniforms.tSand = { value: CR.Tex.get('sand') };
      shader.uniforms.tRock = { value: CR.Tex.get('rock') };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWX;\nvarying vec3 vWN;')
        .replace('#include <worldpos_vertex>',
          '#include <worldpos_vertex>\n  vWX = (modelMatrix * vec4(transformed, 1.0)).xyz;\n  vWN = normalize(mat3(modelMatrix) * objectNormal);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>',
          '#include <common>\nvarying vec3 vWX;\nvarying vec3 vWN;\nuniform sampler2D tGrass;\nuniform sampler2D tSand;\nuniform sampler2D tRock;')
        .replace('#include <map_fragment>', [
          '  vec2 uv1 = vWX.xz * 0.055;',
          '  vec2 uv2 = mat2(0.80, -0.60, 0.60, 0.80) * vWX.xz * 0.071;',
          '  float slope = 1.0 - clamp(vWN.y, 0.0, 1.0);',
          '  float seaW = smoothstep(3.0, 0.0, vWX.y);',
          '  float rockW = smoothstep(0.22, 0.55, slope) + smoothstep(16.0, 34.0, vWX.y) * 0.4;',
          '  vec3 g = texture2D(tGrass, uv1).rgb * 0.6 + texture2D(tGrass, uv2).rgb * 0.4;',
          '  vec3 s = texture2D(tSand, uv1).rgb;',
          '  vec3 r = texture2D(tRock, uv1).rgb;',
          '  vec3 tex = mix(mix(g, s, seaW * 0.7), r, clamp(rockW, 0.0, 1.0));',
          /* 贴图只提供高频细节：剥掉自身亮度，只留 42% 色偏，宏观色由 vColor 决定。
             vColor 由 #include <color_fragment> 在其后相乘，这里不能再乘一次，
             否则宏观色被平方（早先就踩到，草地整体偏暗偏绿）。 */
          '  float lum = dot(tex, vec3(0.299, 0.587, 0.114));',
          '  vec3 detail = mix(vec3(1.0), tex / max(lum, 0.06), 0.22);',
          '  diffuseColor.rgb *= detail * (0.74 + 0.52 * lum);'
        ].join('\n'));
    };
    mat.customProgramCacheKey = function () { return 'terrain-splat-v1'; };

    var mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    scene.add(mesh);
    Terrain.mesh = mesh;
    Terrain.shoreTex = bakeShore();
    Terrain.ready = true;
    return Terrain;
  };
})();
