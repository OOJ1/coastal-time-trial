/* =========================================================================
 * sky.js — 黄昏天空穹顶 / 共享 GLSL 大气函数 / PMREM 环境 / 光照与阴影
 * crSky / crHorizon 以 GLSL 字符串导出，被 ocean.js 与 post.js 直接拼接复用。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var Sky = CR.Sky = {};

  CR.SUN = new THREE.Vector3(CR.CFG.SUN[0], CR.CFG.SUN[1], CR.CFG.SUN[2]).normalize();

  /* 共享 GLSL：所有需要天空色的 shader 都拼接这一段，保证同一套颜色函数 */
  CR.GLSL_SKY = [
    'uniform vec3 uSun;',
    'vec3 crHorizon(vec3 d){',
    '  float k = max(dot(normalize(d), uSun), 0.0);',
    '  vec3 gold = vec3(1.70, 0.73, 0.24) * pow(k, 7.0);',
    '  vec3 rose = vec3(0.40, 0.31, 0.31);',
    '  return rose + gold;',
    '}',
    'vec3 crSky(vec3 d){',
    '  d = normalize(d);',
    '  float h = max(d.y, 0.0);',
    '  float t = exp(-h * 6.5);',
    '  vec3 col = mix(vec3(0.040, 0.090, 0.255), crHorizon(d), t);',
    '  float sd = max(dot(d, uSun), 0.0);',
    '  col += vec3(1.0, 0.62, 0.30) * pow(sd, 9.0) * 0.6;',
    '  col += vec3(1.0, 0.86, 0.62) * pow(sd, 80.0) * 1.45;',
    '  return col;',
    '}'
  ].join('\n');

  /* 噪声函数单独导出：post.js 也会用到 crFbm / crHash，
     与颜色函数分开可避免 shader 里出现同名函数重复定义。 */
  CR.GLSL_NOISE = [
    'float crHash(vec2 p){',
    '  vec3 p3 = fract(vec3(p.xyx) * 0.1031);',
    '  p3 += dot(p3, p3.yzx + 33.33);',
    '  return fract((p3.x + p3.y) * p3.z);',
    '}',
    'float crNoise(vec2 p){',
    '  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);',
    '  float a=crHash(i), b=crHash(i+vec2(1,0)), c=crHash(i+vec2(0,1)), d=crHash(i+vec2(1,1));',
    '  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);',
    '}',
    'float crFbm(vec2 p){ float s=0.0,a=0.5; for(int i=0;i<4;i++){ s+=a*crNoise(p); p*=2.03; a*=0.5; } return s; }'
  ].join('\n');

  var VERT = [
    'varying vec3 vDir;',
    'void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'
  ].join('\n');

  var FRAG = [
    'uniform float uTime;',
    'uniform float uDisk;',
    'varying vec3 vDir;',
    CR.GLSL_NOISE,
    CR.GLSL_SKY,
    'void main(){',
    '  vec3 d = normalize(vDir);',
    '  vec3 col = crSky(d);',
    /* 高空卷云：d.xz/(d.y+0.14) 投影 + 4 阶 fbm */
    '  vec2 cp = d.xz / (max(d.y, 0.0) + 0.14) * 0.09;',
    '  float n = crFbm(cp * 1.7 + vec2(uTime * 0.0035, 0.0));',
    '  n += 0.28 * crFbm(cp * 3.7 - vec2(uTime * 0.006, 0.0));',
    '  float band = smoothstep(0.56, 0.84, n) * smoothstep(0.01, 0.12, d.y) * (1.0 - smoothstep(0.42, 0.9, d.y));',
    '  float sd = max(dot(d, uSun), 0.0);',
    '  vec3 cloud = mix(vec3(0.30, 0.25, 0.32), vec3(1.35, 0.74, 0.34), pow(sd, 3.0));',
    '  col = mix(col, cloud, band * 0.5);',
    /* 太阳圆盘：PMREM 生成时用 uDisk=0 去掉，避免反射里出现噪点 */
    '  col += vec3(1.0, 0.92, 0.74) * smoothstep(0.99986, 0.99996, sd) * 34.0 * uDisk;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'
  ].join('\n');

  function makeMaterial(disk) {
    return new THREE.ShaderMaterial({
      uniforms: { uTime: CR.time, uSun: { value: CR.SUN }, uDisk: { value: disk } },
      vertexShader: VERT, fragmentShader: FRAG,
      side: THREE.BackSide, depthTest: false, depthWrite: false,
      transparent: false, blending: THREE.NoBlending
    });
  }

  var dome = null, sun = null, hemi = null, up = new THREE.Vector3(0, 1, 0);
  var rightAxis = new THREE.Vector3(), upAxis = new THREE.Vector3();
  /* 阴影纹素对齐每帧复用：旧实现每帧 new + 4 次 clone，共 5 个短命 Vector3，
     在低端设备上会周期性触发 GC 微卡顿（相机/阴影本来就是惯性链路的一部分）。 */
  var _p = new THREE.Vector3(), _aligned = new THREE.Vector3(), _tmp = new THREE.Vector3();

  Sky.create = function (scene, renderer) {
    dome = new THREE.Mesh(new THREE.SphereGeometry(5000, 48, 24), makeMaterial(1));
    dome.frustumCulled = false;
    dome.renderOrder = -100;
    scene.add(dome);
    Sky.dome = dome;

    /* PMREM：用同一片天空（uDisk=0）离屏生成环境贴图 */
    try {
      var envScene = new THREE.Scene();
      var envDome = new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), makeMaterial(0));
      envScene.add(envDome);
      var pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      var envRT = pmrem.fromScene(envScene, 0, 0.1, 1000);
      scene.environment = envRT.texture;
      /* r149 的 WebGLRenderer 不读 scene.environmentIntensity（r155 才有），
         这里两处都写：新版本直接生效，老版本由各材质的 envMapIntensity 系数补。 */
      scene.environmentIntensity = 1.35;
      Sky.envRT = envRT;
      envDome.geometry.dispose(); envDome.material.dispose();
      pmrem.dispose();
    } catch (e) {
      if (window.console) console.warn('[Sky] PMREM unavailable:', e);
    }

    /* 光照 */
    sun = new THREE.DirectionalLight(new THREE.Color(1.0, 0.57, 0.27), 5.1);
    sun.castShadow = true;
    var s = CR.quality.shadow;
    sun.shadow.mapSize.set(s, s);
    var cam = sun.shadow.camera;
    cam.left = -75; cam.right = 75; cam.top = 75; cam.bottom = -75;
    cam.near = 1; cam.far = 400; cam.updateProjectionMatrix();
    /* 夕阳仰角只有约 7°，bias 太小会在地形 / 护栏上产生自遮挡条纹，
       相机移动时表现为成片闪烁。这两个值是早期记录里验证过的。 */
    sun.shadow.bias = -0.0016;
    sun.shadow.normalBias = 0.10;
    sun.shadow.radius = 2.5;
    scene.add(sun); scene.add(sun.target);
    Sky.sun = sun;

    hemi = new THREE.HemisphereLight(0x687dad, 0x584333, 0.78);
    scene.add(hemi);

    rightAxis.crossVectors(CR.SUN, up).normalize();
    upAxis.crossVectors(rightAxis, CR.SUN).normalize();
    Sky.ready = true;
    return Sky;
  };

  /* r149 没有全局 environmentIntensity，这里给出等价实现：
     把所有 PBR 材质的 envMapIntensity 统一乘一次 k（同一个材质只乘一次）。
     main.js 在所有模块建完之后调用一次。 */
  Sky.applyEnvIntensity = function (scene, k) {
    var seen = [];
    scene.traverse(function (o) {
      var mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      for (var i = 0; i < mats.length; i++) {
        var m = mats[i];
        if (!m || m.__envScaled || m.envMapIntensity === undefined) continue;
        m.__envScaled = true;
        /* envMapIntensity 不等于默认值 1，说明这个材质是按规格显式设过
           （车漆 1.25 / 玻璃 1.4 / 镀铬 1.2 / 路面 0.35 / 护栏 0.9），
           全局 1.35 只作用于未指定的材质，不去覆盖它们。 */
        if (m.envMapIntensity !== 1) continue;
        m.envMapIntensity *= k;
        m.needsUpdate = false;
      }
    });
  };

  /* 阴影纹素对齐：把光源 target 沿 right / up 两轴四舍五入到纹素网格，
     避免相机移动时阴影闪烁 */
  Sky.update = function (camera, focus) {
    if (!dome) return;
    dome.position.copy(camera.position);
    if (!sun || !focus) return;
    var texel = 150 / CR.quality.shadow;
    _p.set(focus.x, focus.y || 0, focus.z);
    var rs = Math.round(_p.dot(rightAxis) / texel) * texel;
    var us = Math.round(_p.dot(upAxis) / texel) * texel;
    var fs = _p.dot(CR.SUN);
    _aligned.copy(rightAxis).multiplyScalar(rs)
      .add(_tmp.copy(upAxis).multiplyScalar(us))
      .add(_tmp.copy(CR.SUN).multiplyScalar(fs));
    sun.target.position.copy(_aligned);
    sun.position.copy(_aligned).add(_tmp.copy(CR.SUN).multiplyScalar(140));
    sun.target.updateMatrixWorld();
  };
})();
