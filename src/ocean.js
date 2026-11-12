/* =========================================================================
 * ocean.js — 3 组方向波：同一份 WAVES 参数同时生成 JS heightAt 与 GLSL crWave，
 * 因此渔船 / 浮标是真正随浪起伏而不是视觉近似。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var Ocean = CR.Ocean = {};

  Ocean.WAVES = [
    { dx: 1.0, dz: 0.30, k: 0.021, w: 0.62, a: 0.62 },
    { dx: -0.35, dz: 1.0, k: 0.037, w: 0.88, a: 0.34 },
    { dx: 0.80, dz: -0.60, k: 0.075, w: 1.35, a: 0.16 }
  ];
  Ocean.WAVES.forEach(function (w) {
    var l = Math.hypot(w.dx, w.dz); w.dx /= l; w.dz /= l;
  });
  function f(x) { return Number(x).toFixed(6); }

  /* 同一份参数拼出 GLSL，保证 JS 与 GPU 的浪完全一致 */
  function waveGLSL() {
    var a = ['float crWave(vec2 p, float t, out vec2 grad){', '  float h = 0.0; grad = vec2(0.0);'];
    Ocean.WAVES.forEach(function (w) {
      a.push('  { float ph = dot(p, vec2(' + f(w.dx) + ',' + f(w.dz) + ')) * ' + f(w.k) + ' + t * ' + f(w.w) + ';');
      a.push('    h += sin(ph) * ' + f(w.a) + ';');
      a.push('    grad += vec2(' + f(w.dx) + ',' + f(w.dz) + ') * ' + f(w.k) + ' * cos(ph) * ' + f(w.a) + '; }');
    });
    a.push('  return h;', '}');
    return a.join('\n');
  }
  Ocean.crWave = waveGLSL();

  /* JS 版：渔船 / 浮标 / 泡沫判定都用它 */
  Ocean.heightAt = function (x, z, t) {
    var h = 0;
    for (var i = 0; i < Ocean.WAVES.length; i++) {
      var w = Ocean.WAVES[i];
      h += Math.sin((x * w.dx + z * w.dz) * w.k + t * w.w) * w.a;
    }
    return CR.SEA + h;
  };

  var VERT = [
    'uniform float uTime;',
    'uniform float uSea;',
    'varying vec3 vWorld;',
    'varying vec3 vN;',
    'varying vec2 vUv;',
    'varying float vFade;',
    Ocean.crWave,
    'void main(){',
    '  vec4 wp = modelMatrix * vec4(position, 1.0);',
    '  float dist = length(wp.xz - cameraPosition.xz);',
    '  float fade = 1.0 - smoothstep(1500.0, 4500.0, dist);',
    '  vec2 grad;',
    '  float h = crWave(wp.xz, uTime, grad) * fade;',
    '  wp.y = uSea + h;',
    '  vN = normalize(vec3(-grad.x * fade, 1.0, -grad.y * fade));',
    '  vWorld = wp.xyz; vUv = uv; vFade = fade;',
    '  gl_Position = projectionMatrix * viewMatrix * wp;',
    '}'
  ].join('\n');

  var FRAG = [
    'uniform float uTime;',
    'uniform float uSea;',
    'uniform vec3 uCamPos;',
    'uniform sampler2D tNormal;',
    'uniform sampler2D tShore;',
    'varying vec3 vWorld;',
    'varying vec3 vN;',
    'varying vec2 vUv;',
    'varying float vFade;',
    CR.GLSL_SKY,
    'void main(){',
    '  vec3 V = normalize(uCamPos - vWorld);',
    '  float dist = length(vWorld.xz - uCamPos.xz);',
    /* 三层反向滚动的切线空间细波纹，强度随距离 0.34 → 0.11 */
    '  float amp = mix(0.34, 0.11, smoothstep(40.0, 900.0, dist));',
    '  vec2 base = vWorld.xz * 0.055;',
    '  vec3 n1 = texture2D(tNormal, base + vec2(uTime * 0.011, uTime * 0.006)).rgb * 2.0 - 1.0;',
    '  vec3 n2 = texture2D(tNormal, base * 1.9 - vec2(uTime * 0.009, uTime * 0.013)).rgb * 2.0 - 1.0;',
    '  vec3 n3 = texture2D(tNormal, base * 3.3 + vec2(uTime * 0.017, -uTime * 0.008)).rgb * 2.0 - 1.0;',
    '  vec3 N = normalize(vN + (n1 + n2 + n3) * amp * 0.33);',
    '  float fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 5.0);',
    '  vec3 R = reflect(-V, N); R.y = abs(R.y) * 0.7 + 0.02;',
    '  vec3 sky = crSky(R);',
    '  sky = sky / (1.0 + sky * 0.22);',
    /* 浅水青绿：shoreTex 烘焙的地形高度决定水深 */
    '  float bed = texture2D(tShore, vWorld.xz / 1000.0 + 0.5).r * 20.0 - 6.0 + uSea;',
    '  float depth = clamp(uSea - bed, 0.0, 8.0);',
    '  float shallow = 1.0 - smoothstep(0.2, 4.5, depth);',
    '  vec3 water = mix(vec3(0.012, 0.050, 0.085), vec3(0.035, 0.125, 0.135), shallow);',
    '  vec3 col = mix(water, sky, clamp(fres * 1.35, 0.0, 1.0));',
    /* 落日碎金 */
    '  float sd = max(dot(normalize(R), uSun), 0.0);',
    '  col += vec3(1.0, 0.72, 0.34) * (pow(sd, 700.0) * 55.0 + pow(sd, 90.0) * 2.2 + pow(sd, 14.0) * 0.16);',
    /* 岸边泡沫 */
    '  float foam = smoothstep(0.25, 0.0, depth) * (0.4 + 0.6 * n1.b);',
    '  col += vec3(0.52, 0.58, 0.56) * foam * 0.35;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  Ocean.create = function (scene) {
    var n = CR.quality.ocean;
    var geo = CR.Geo.warpGrid(n, 620, CR.CFG.OCEAN_EXT, null);
    var mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: CR.time, uSun: { value: CR.SUN },
        uSea: { value: CR.SEA },
        uCamPos: { value: new THREE.Vector3() },
        tNormal: { value: CR.Tex.get('waterNormal') },
        tShore: { value: CR.Terrain.shoreTex }
      },
      vertexShader: VERT, fragmentShader: FRAG,
      side: THREE.DoubleSide, transparent: false
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = -1;
    scene.add(mesh);
    Ocean.mesh = mesh;
    Ocean.mat = mat;
    Ocean.ready = true;
    return Ocean;
  };

  Ocean.update = function (camera) {
    if (Ocean.mat) Ocean.mat.uniforms.uCamPos.value.copy(camera.position);
  };
})();
