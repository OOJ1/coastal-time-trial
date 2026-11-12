/* =========================================================================
 * snowmountain.js — 地图中心雪山（第 21 个经典 script）
 *
 * 设计约束：
 *   · 只叠加、不改地形：顶点高度 = Terrain.heightAt(x,z) + h(x,z)。
 *     山体增量在中低频上做山形，在边缘用 smoothstep 收到 0（一阶导也为 0），
 *     再额外下沉 0.14m 让 mesh 被地形盖住 —— 天然贴合、无悬空、无 Z-fighting，
 *     也不需要修改 terrain.js。
 *   · 山脚轮廓不是正圆：半径按方位角做低频扰动（±5.5%），接缝线是自然起伏的，
 *     不会出现"圆规画的雪线"。
 *   · 三峰高斯 + ridged fbm 山脊 + 两层细节噪声；雪线按相对高度与坡度分区，
 *     陡坡露岩，山脚复用 terrain.js 的同一套草地配色公式与同一个 fbm 种子，
 *     所以接缝两侧的宏观色是连续的。
 *   · 光影与全场景统一：材质走和地形同一套三贴图 detail 注入（草地/岩石/雪），
 *     envMapIntensity 保持默认 1，由 Sky.applyEnvIntensity 统一乘 1.35；
 *     castShadow / receiveShadow 都开，山脚会被车影、护栏影压暗。
 *   · 零外部素材：贴图全是 textures.js 的程序化可平铺噪声，颜色由顶点色决定。
 *   · 固定 CR.SALT.snow，Snow.build() 可重复调用且逐字节一致（验收用）。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var Snow = CR.Snow = {};

  /* 山脚半径 149m：中心到赛道中心线实测 159.55m，
     减去 149 后山脚距中心线 10.55m → 距路缘（半宽 5m）约 5.5m，
     距内侧护栏（6.7m）3.85m，正好停在路肩外侧、护栏背后。 */
  Snow.RADIUS = 149;
  Snow.BLOCK = 157;       /* 植被排除半径：山脚 + 8m 缓冲 */
  Snow.PEAK = 70;         /* 主峰目标相对高度（米） */
  var SEED = CR.SALT.snow;

  /* 边缘轮廓扰动：输入方位角，返回半径倍率。
     因为输入是单位圆上的点，fbm 沿圆周天然连续且周期闭合，不会出现接缝。 */
  function rimScale(a) {
    var n = CR.fbm(Math.cos(a) * 1.7 + 31.4, Math.sin(a) * 1.7 - 12.7, 3, SEED + 91);
    return 1 + (n - 0.5) * 0.11;
  }

  function peak(nx, nz, px, pz, amp, rad) {
    var dx = nx - px, dz = nz - pz;
    return amp * Math.exp(-(dx * dx + dz * dz) / (rad * rad));
  }

  /* 山体增量：rr>=1 时固定 -0.14（埋进地形），rr<1 时向边缘收到 0 再下沉 */
  function heightDelta(x, z) {
    var R = Snow.RADIUS;
    var nx = x / R, nz = z / R;
    var a = Math.atan2(nz, nx);
    var rr = Math.sqrt(nx * nx + nz * nz) / rimScale(a);
    if (rr >= 1) return -0.14;

    /* 0.55 起收边：比原来的 0.60 更早，山脚因此有一段 60m 宽的缓坡，
       接缝处坡度接近 0，不会出现"一层雪直接立起来"的台阶感。 */
    var edge = 1 - CR.ss(0.55, 1.0, rr);

    var h = peak(nx, nz, -0.16, -0.10, 1.00, 0.64)
          + peak(nx, nz, 0.34, 0.28, 0.60, 0.46)
          + peak(nx, nz, 0.12, -0.44, 0.46, 0.38);
    var n1 = CR.fbm(nx * 2.1 + 3.7, nz * 2.1 - 1.9, 5, SEED);
    var ridge = Math.pow(1 - Math.abs(2 * n1 - 1), 1.7);
    var det = CR.fbm(nx * 7.5, nz * 7.5, 4, SEED + 17) - 0.5;
    var fine = CR.fbm(nx * 16.0 + 5.3, nz * 16.0 - 2.1, 3, SEED + 71) - 0.5;
    h = h * (0.56 + 0.44 * ridge) + det * 0.18 + fine * 0.045;

    /* 半径放大后，归一化噪声的物理尺度也跟着变大；补一层物理坐标的细节，
       让雪面在 2m 网格上仍有可看的纹理，而不是一块光滑的壳。 */
    var pDet = CR.fbm(x * 0.055, z * 0.055, 3, SEED + 133) - 0.5;
    h += pDet * 0.020;

    /* 0.80 是把三峰叠加后的峰值（约 87.7）归一到设计高度 70m 的系数 */
    h = Math.max(0, h) * Snow.PEAK * 0.80 * edge;
    /* 边缘下沉：只在最外 6% 半径内发生，且起点处增量已接近 0，
       切线方向收得干净，不会在草地上挖出一条沟。 */
    return h - 0.14 * CR.ss(0.94, 1.0, rr);
  }
  Snow.heightDelta = heightDelta;

  /* 与 terrain.js create() 里的宏观色公式逐项一致（同一个 fbm 种子 61），
     保证山脚那一圈的颜色和它脚下的地面完全相同，接缝只剩纹理差异。 */
  function groundColor(x, y, z, slopeY, out) {
    var wet = CR.ss(3.6, 1.0, y);
    var n2 = CR.fbm(x * 0.0022, z * 0.0022, 4, 61);
    var dry = CR.clamp01(0.28 + n2 * 0.92 - wet * 0.3);
    var r = CR.lerp(0.225, 0.415, dry), g = CR.lerp(0.255, 0.375, dry), b = CR.lerp(0.155, 0.215, dry);
    var rocky = CR.ss(0.25, 0.62, 1 - CR.clamp01(slopeY)) * 0.55;
    out[0] = CR.lerp(r, 0.31, rocky);
    out[1] = CR.lerp(g, 0.30, rocky);
    out[2] = CR.lerp(b, 0.27, rocky);
    return out;
  }

  /* 构建高度场几何 + 顶点色。可在同一进程内重复调用做确定性比对。 */
  Snow.build = function () {
    var n = CR.quality.snow || 144;
    var side = n + 1, R = Snow.RADIUS, total = side * side;
    var pos = new Float32Array(total * 3);
    var uv = new Float32Array(total * 2);
    var aSnow = new Float32Array(total);
    var aRock = new Float32Array(total);
    var baseArr = new Float32Array(total);
    var idx = [], i, j, k = 0;

    for (j = 0; j <= n; j++) {
      for (i = 0; i <= n; i++) {
        var x = (i / n * 2 - 1) * R, z = (j / n * 2 - 1) * R;
        /* heightAt 只算一次并缓存：否则顶点色阶段会再跑 2 万次 nearest+fbm */
        baseArr[k] = CR.Terrain.heightAt(x, z);
        pos[k * 3] = x;
        pos[k * 3 + 1] = baseArr[k] + heightDelta(x, z);
        pos[k * 3 + 2] = z;
        uv[k * 2] = x / 22; uv[k * 2 + 1] = z / 22;
        k++;
      }
    }
    for (j = 0; j < n; j++) {
      for (i = 0; i < n; i++) {
        var a = j * side + i, b = a + 1, c = a + side, d = c + 1;
        idx.push(a, c, b, b, c, d);      /* 与 warpGrid 同绕序：法线朝 +Y */
      }
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    var nAttr = geo.getAttribute('normal');
    var col = new Float32Array(total * 3);
    var peakH = 0, snowCount = 0, above = 0, aboveSnow = 0;
    /* 雪色压到 0.40~0.57：材质里的 detail 会把亮贴图再抬约 15%，
       黄昏直射光 5.1 + 环境光后仍会接近 1.0，起高了会整座山过曝、被 Bloom 糊亮。 */
    var rockC = [0.17, 0.165, 0.16], snowC = [0.40, 0.455, 0.585];
    var gc = [0, 0, 0];

    for (k = 0; k < total; k++) {
      var x2 = pos[k * 3], y2 = pos[k * 3 + 1], z2 = pos[k * 3 + 2];
      var hh = y2 - baseArr[k];              /* 山体增量（含边缘下沉） */
      if (hh > peakH) peakH = hh;
      var hn = CR.clamp01(Math.max(0, hh) / Snow.PEAK);
      var ny = nAttr.getY(k);
      var slope = 1 - CR.clamp01(ny);

      /* 雪：越高越多、越陡越少；再叠一层低频噪声把雪线打碎 */
      var snow = CR.ss(0.10, 0.32, hn) * (1 - 0.95 * CR.ss(0.42, 0.72, slope));
      snow *= 0.86 + 0.28 * CR.fbm(x2 * 0.06, z2 * 0.06, 3, SEED + 31);
      snow = CR.clamp01(snow);

      /* 山脚过渡带：从 0.25m 一直铺到 7m，并对高度加噪声扰动，
         雪线/林线因此是锯齿状的，不会沿等高线长出一条硬边。 */
      var wob = (CR.fbm(x2 * 0.075 + 4.1, z2 * 0.075 - 8.3, 3, SEED + 47) - 0.5) * 2.2;
      var foot = CR.ss(0.25, 7.0, Math.max(0, hh) + wob);
      /* 陡坡上把过渡带提前收掉：裸岩不需要"渐变成草" */
      foot *= 1 - 0.55 * CR.ss(0.30, 0.62, slope);

      var gW = 1 - foot;                      /* 草地权重 */
      var sW = snow * foot;                   /* 雪权重 */
      var rW = 1 - gW - sW;                   /* 岩石兜底，三者恒等于 1 */
      if (rW < 0) rW = 0;

      groundColor(x2, y2, z2, ny, gc);
      var r0 = gc[0] * gW + rockC[0] * rW + snowC[0] * sW;
      var g0 = gc[1] * gW + rockC[1] * rW + snowC[1] * sW;
      var b0 = gc[2] * gW + rockC[2] * rW + snowC[2] * sW;

      /* 两层明暗：11m 大尺度体量 + 3m 雪面风蚀斑驳（顶点密度足够采样，不产生摩尔纹） */
      var shade = 0.90 + 0.16 * CR.fbm(x2 * 0.09 + 11, z2 * 0.09 - 7, 3, SEED + 43);
      shade *= 0.95 + 0.10 * CR.fbm(x2 * 0.28, z2 * 0.28, 3, SEED + 59);
      col[k * 3] = r0 * shade; col[k * 3 + 1] = g0 * shade; col[k * 3 + 2] = b0 * shade;

      aSnow[k] = sW;
      aRock[k] = rW;

      if (snow > 0.5) snowCount++;
      if (hn > 0.60) { above++; if (snow > 0.5) aboveSnow++; }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSnow', new THREE.BufferAttribute(aSnow, 1));
    geo.setAttribute('aRock', new THREE.BufferAttribute(aRock, 1));
    geo.computeBoundingSphere();

    return {
      geo: geo, peak: peakH, n: n,
      snowRatio: snowCount / total,
      snowAbove: above ? aboveSnow / above : 0
    };
  };

  Snow.create = function (scene) {
    var built = Snow.build();

    /* 与地形同一套材质思路：顶点色给宏观色，贴图只提供高频细节。
       区别只是这里按 aSnow / aRock 三个权重混合草地、岩石、雪的贴图，
       所以山脚那一圈和它脚下的草地是同一张 grass 贴图、同一套亮度曲线。 */
    var mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.97, metalness: 0.0
    });
    mat.onBeforeCompile = function (shader) {
      shader.uniforms.tGrass = { value: CR.Tex.get('grass') };
      shader.uniforms.tRock = { value: CR.Tex.get('rock') };
      shader.uniforms.tSnow = { value: CR.Tex.get('snow') };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>',
          '#include <common>\nattribute float aSnow;\nattribute float aRock;\n' +
          'varying float vSnow;\nvarying float vRock;\nvarying vec3 vWX;\nvarying vec3 vWN;')
        .replace('#include <worldpos_vertex>',
          '#include <worldpos_vertex>\n' +
          '  vSnow = aSnow;\n  vRock = aRock;\n' +
          '  vWX = (modelMatrix * vec4(transformed, 1.0)).xyz;\n' +
          '  vWN = normalize(mat3(modelMatrix) * objectNormal);');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>',
          '#include <common>\nvarying float vSnow;\nvarying float vRock;\n' +
          'varying vec3 vWX;\nvarying vec3 vWN;\n' +
          'uniform sampler2D tGrass;\nuniform sampler2D tRock;\nuniform sampler2D tSnow;')
        .replace('#include <map_fragment>', [
          '  vec2 uv1 = vWX.xz * 0.055;',
          '  vec2 uv2 = mat2(0.80, -0.60, 0.60, 0.80) * vWX.xz * 0.071;',
          '  float sW = clamp(vSnow, 0.0, 1.0);',
          '  float rW = clamp(vRock, 0.0, 1.0);',
          '  float gW = max(0.0, 1.0 - sW - rW);',
          '  vec3 g = texture2D(tGrass, uv1).rgb * 0.6 + texture2D(tGrass, uv2).rgb * 0.4;',
          '  vec3 r = texture2D(tRock, uv1).rgb;',
          /* 雪面风蚀纹理：两层不同尺度、反向旋转，避免出现规则重复 */
          '  vec3 sn = texture2D(tSnow, uv1 * 0.62).rgb * 0.62 + texture2D(tSnow, uv2 * 1.9).rgb * 0.38;',
          '  vec3 tex = g * gW + r * rW + sn * sW;',
          /* 与地形完全一致的处理：剥掉贴图自身亮度，只留色偏与亮度调制，
             宏观色仍由 vColor（#include <color_fragment>）决定。 */
          '  float lum = dot(tex, vec3(0.299, 0.587, 0.114));',
          '  vec3 detail = mix(vec3(1.0), tex / max(lum, 0.06), 0.18);',
          '  diffuseColor.rgb *= detail * (0.76 + 0.46 * lum);'
        ].join('\n'));
    };
    mat.customProgramCacheKey = function () { return 'snow-splat-v1'; };

    var mesh = new THREE.Mesh(built.geo, mat);
    /* 阴影：跟随全场景（车影会落在山脚雪面上，雪坡也会被自己挡住的部分压暗）。
       阴影相机只覆盖车周 ±75m，所以只有山脚这一段参与投影，远处的山体不受影响。 */
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    scene.add(mesh);
    Snow.mesh = mesh;

    /* 5 块岩石露头：半埋在山体里，合并成 1 个 draw call */
    var rocks = [], R = Snow.RADIUS;
    [[-0.44, -0.26, 3.4], [0.36, 0.14, 2.6], [-0.08, 0.48, 2.2],
     [0.54, -0.18, 3.0], [-0.60, 0.26, 1.9]].forEach(function (r, ri) {
      var g = new THREE.IcosahedronGeometry(1, 1), p = g.getAttribute('position');
      for (var vi = 0; vi < p.count; vi++) {
        var px = p.getX(vi), py = p.getY(vi), pz = p.getZ(vi);
        var f = 0.62 + 0.9 * (CR.noise2(px * 3.1 + py * 1.7, pz * 3.1 - py * 1.3, SEED + 200 + ri) - 0.5);
        f = Math.max(0.45, f);
        p.setXYZ(vi, px * f, py * f, pz * f);
      }
      p.needsUpdate = true; g.computeVertexNormals();
      CR.Geo.tint(g, [0.34, 0.32, 0.29], 0, 0, 0.18);
      var wx = r[0] * R, wz = r[1] * R;
      g.scale(r[2], r[2] * 0.62, r[2]);
      CR.Geo.place(g, wx, CR.Terrain.heightAt(wx, wz) + heightDelta(wx, wz) * 0.55, wz,
                    0, ri * 1.7, 0);
      rocks.push(g);
    });
    var rockGeo = CR.Geo.merge(rocks);
    rocks.forEach(function (g) { g.dispose(); });
    var rockMesh = new THREE.Mesh(rockGeo, new THREE.MeshStandardMaterial({
      vertexColors: true, map: CR.Tex.get('rock'),
      roughness: 0.98, envMapIntensity: 0.30
    }));
    rockMesh.castShadow = true; rockMesh.receiveShadow = true;
    rockMesh.frustumCulled = false;
    scene.add(rockMesh);
    Snow.rocks = rockMesh;

    Snow.diag = function () {
      return {
        n: built.n,
        verts: built.geo.getAttribute('position').count,
        tris: built.geo.getIndex().count / 3,
        peak: +built.peak.toFixed(2),
        snowRatio: +built.snowRatio.toFixed(3),
        snowAbove: +built.snowAbove.toFixed(3),
        radius: Snow.RADIUS, block: Snow.BLOCK
      };
    };
    Snow.ready = true;
    return Snow;
  };

  /* 植被避让：props.js 的 safeSpot 直接调用 */
  Snow.blocked = function (x, z) {
    return (x * x + z * z) < Snow.BLOCK * Snow.BLOCK;
  };
})();
