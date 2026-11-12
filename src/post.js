/* =========================================================================
 * post.js — 自研后处理链：HDR+MSAA 场景 → 半分辨率 AO → 大气雾合成
 * → 5 级 Bloom 降/升采样 → 远景 DOF + ACES + 色调 + 暗角 + 颗粒
 * uTime 直接引用 CR.time；renderer.toneMapping = NoToneMapping
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var Post = CR.Post = {};
  var R = { renderer: null, w: 1, h: 1, hw: 1, hh: 1, samples: 4,
            type: null, isGL2: false, hasDepthTex: true };
  var P = {}, passes = {}, quad = null, quadCam = null, quadScene = null;
  var tmpV2 = new THREE.Vector2();

  var VERT = [
    'varying vec2 vUv;',
    'void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }'
  ].join('\n');
  var COMMON = [
    'uniform float uTime;',
    'float crLuma(vec3 c){ return dot(c, vec3(0.2126,0.7152,0.0722)); }',
    'vec3 crAces(vec3 x){ const float a=2.51,b=0.03,c=2.43,d=0.59,e=0.14;',
    '  return clamp((x*(a*x+b))/(x*(c*x+d)+e),0.0,1.0); }'
  ].join('\n');

  /* 逐项开关（0/1）：验收时用来独立关掉 AO / Bloom / DOF，确认画面依然成立 */
  Post.flags = { ao: 1, bloom: 1, dof: 1, nitro: 1 };
  /* 每帧实际执行的后处理 pass 数（不含场景主渲染）。
     诊断口：降级/关效果后可以直接核对"省了几次全屏绘制"，不参与渲染。 */
  Post.stats = { passes: 0, ao: 0, bloom: 0 };
  /* 氮气画面强度（0..1），由 main.js 每帧用 1-exp(-dt*8) 平滑后写入 */
  Post.nitroLevel = 0;
  /* 泛光阈值：天空 HDR 亮度约 0.5–1.0，取 1.15 几乎采不到东西（实测开关无差别），
     0.82 能让落日与云缘起一层柔光，又不会把路面/海面糊成白。 */
  Post.bloomThreshold = 0.82;

  function makeRT(w, h, samples, depth, type) {
    var t = new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat, type: type || R.type || THREE.HalfFloatType,
      depthBuffer: !!depth, stencilBuffer: false, samples: samples || 0
    });
    t.texture.generateMipmaps = false;
    /* WebGL1 且缺 WEBGL_depth_texture 时只保留普通 depthBuffer，
       depthTexture 会让 framebuffer 直接 incomplete（黑屏）。 */
    if (depth && R.hasDepthTex !== false) {
      t.depthTexture = new THREE.DepthTexture(Math.max(1, w | 0), Math.max(1, h | 0));
      t.depthTexture.type = THREE.UnsignedIntType;
      t.depthTexture.minFilter = THREE.NearestFilter;
      t.depthTexture.magFilter = THREE.NearestFilter;
    }
    return t;
  }
  function Pass(frag, uniforms) {
    var m = new THREE.ShaderMaterial({
      uniforms: uniforms || {}, vertexShader: VERT, fragmentShader: frag,
      depthTest: false, depthWrite: false, transparent: false, blending: THREE.NoBlending
    });
    return { mat: m, u: m.uniforms };
  }
  function run(p, target) {
    quad.material = p.mat;
    R.renderer.setRenderTarget(target || null);
    R.renderer.render(quadScene, quadCam);
    Post.stats.passes++;
  }

  /* ---------- Pass 1：半分辨率 AO ---------- */
  var F_AO = [
    'uniform sampler2D tDepth;',
    'uniform vec2 uTexel;',
    'uniform float uNear, uFar, uTanHalf, uAspect;',
    'varying vec2 vUv;',
    COMMON,
    'float lin(vec2 uv){ float d=texture2D(tDepth,uv).r; float z=d*2.0-1.0;',
    '  return (2.0*uNear*uFar)/(uFar+uNear-z*(uFar-uNear)); }',
    'vec3 vp(vec2 uv, float l){ vec2 n=uv*2.0-1.0;',
    '  return vec3(n.x*uTanHalf*uAspect, n.y*uTanHalf, -1.0)*l; }',
    'float ign(vec2 p){ return fract(52.9829189*fract(dot(p,vec2(0.06711056,0.00583715)))); }',
    'void main(){',
    '  float l0=lin(vUv);',
    '  if(l0>uFar*0.98){ gl_FragColor=vec4(1.0); return; }',
    /* 显式邻域差分取深度差较小一侧，避免 dFdx 扩展依赖与边缘伪影 */
    '  float lL=lin(vUv-vec2(uTexel.x,0.0)), lR=lin(vUv+vec2(uTexel.x,0.0));',
    '  float lD=lin(vUv-vec2(0.0,uTexel.y)), lU=lin(vUv+vec2(0.0,uTexel.y));',
    '  float lx=abs(lR-l0)<abs(lL-l0)?lR:lL, ly=abs(lU-l0)<abs(lD-l0)?lU:lD;',
    '  vec3 p0=vp(vUv,l0);',
    '  vec3 n=normalize(cross(vp(vUv+vec2(uTexel.x,0.0),lx)-p0, vp(vUv+vec2(0.0,uTexel.y),ly)-p0));',
    '  float rnd=ign(gl_FragCoord.xy)*6.2831853, occ=0.0;',
    '  float fade=1.0-smoothstep(70.0,170.0,l0);',
    '  for(int i=0;i<8;i++){',
    '    float fi=float(i), a=fi*2.39996323+rnd, rr=sqrt((fi+0.5)/8.0);',
    '    vec2 uv=clamp(vUv+vec2(cos(a),sin(a))*rr*0.85/max(l0*uTanHalf*60.0,0.001),vec2(0.001),vec2(0.999));',
    '    float sl=lin(uv); vec3 v=vp(uv,sl)-p0; float vv=dot(v,v);',
    '    occ+=max(dot(n,v)/sqrt(max(vv,1e-4))-0.06,0.0)*(1.0/(1.0+vv*0.08));',
    '  }',
    '  float ao=1.0-clamp(occ*0.30,0.0,1.0)*fade;',
    '  gl_FragColor=vec4(vec3(ao),1.0);',
    '}'
  ].join('\n');

  /* ---------- Pass 2：4-tap AO + 方向性大气雾 ---------- */
  var F_LIT = [
    'uniform sampler2D tScene, tAO, tDepth;',
    'uniform vec2 uTexel;',
    'uniform float uNear,uFar,uTanHalf,uAspect,uCamY,uAO,uFogOn;',
    'uniform mat4 uCamWorld;',
    'varying vec2 vUv;',
    COMMON, CR.GLSL_NOISE, CR.GLSL_SKY,
    'float lin(vec2 uv){ float d=texture2D(tDepth,uv).r; float z=d*2.0-1.0;',
    '  return (2.0*uNear*uFar)/(uFar+uNear-z*(uFar-uNear)); }',
    'void main(){',
    '  vec3 c=texture2D(tScene,vUv).rgb;',
    /* uAO=0 时整段跳过：省 4 次全屏采样，也不会去读"本帧没渲染"的 tAO。
       uAO=1 时公式一字未改，输出逐像素一致。 */
    '  if(uAO>0.0){',
    '    float ao=0.0;',
    '    ao+=texture2D(tAO,vUv).r;',
    '    ao+=texture2D(tAO,vUv+vec2(uTexel.x,0.0)).r;',
    '    ao+=texture2D(tAO,vUv+vec2(0.0,uTexel.y)).r;',
    '    ao+=texture2D(tAO,vUv+uTexel).r;',
    '    c*=mix(1.0,ao*0.25,0.75*uAO);',
    '  }',
    '  float dist=lin(vUv);',
    '  if(uFogOn>0.0 && dist<uFar*0.98){',
    '    vec2 n=vUv*2.0-1.0;',
    '    vec3 rd=normalize(vec3(n.x*uTanHalf*uAspect,n.y*uTanHalf,-1.0));',
    '    vec3 rdW=normalize((uCamWorld*vec4(rd,0.0)).xyz);',
    '    float fogD=1.0-exp(-dist*0.00013);',
    /* 指数高度雾解析积分：密度 a*exp(-b*y)，fac=(1-exp(-x))/x */
    '    float b=0.19;',
    '    float a=0.9+0.5*crFbm(rdW.xz*2.0+vec2(uTime*0.01,0.0));',
    '    float xx=b*rdW.y*dist;',
    '    float fac=(1.0-exp(-xx))/max(abs(xx),1e-4);',
    '    float fogH=a*dist*exp(-b*max(uCamY,0.0))*fac*0.0016;',
    '    float fog=clamp(fogD*fogH*1.6,0.0,1.0);',
    '    vec3 fc=crHorizon(rdW)*0.82+vec3(1.0,0.55,0.22)*pow(max(dot(rdW,uSun),0.0),10.0)*0.5;',
    '    c=mix(c,fc,fog);',
    '  }',
    '  gl_FragColor=vec4(c,1.0);',
    '}'
  ].join('\n');

  var F_DOWN = [
    'uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThreshold;',
    'varying vec2 vUv;', COMMON,
    'void main(){',
    '  vec3 c=texture2D(tSrc,vUv+vec2(-1.0,-1.0)*uTexel).rgb',
    '       +texture2D(tSrc,vUv+vec2( 1.0,-1.0)*uTexel).rgb',
    '       +texture2D(tSrc,vUv+vec2(-1.0, 1.0)*uTexel).rgb',
    '       +texture2D(tSrc,vUv+vec2( 1.0, 1.0)*uTexel).rgb;',
    '  c=min(c*0.25,vec3(24.0));',
    '  if(uThreshold>0.0){ float l=crLuma(c); c*=max(0.0,l-uThreshold)/max(l,1e-4); }',
    '  gl_FragColor=vec4(c,1.0);',
    '}'
  ].join('\n');

  var F_UP = [
    'uniform sampler2D tSrc, tAdd; uniform vec2 uTexel;',
    'varying vec2 vUv;',
    'void main(){',
    '  vec3 c=texture2D(tSrc,vUv+vec2(-1.0,-1.0)*uTexel).rgb',
    '       +texture2D(tSrc,vUv+vec2( 1.0,-1.0)*uTexel).rgb',
    '       +texture2D(tSrc,vUv+vec2(-1.0, 1.0)*uTexel).rgb',
    '       +texture2D(tSrc,vUv+vec2( 1.0, 1.0)*uTexel).rgb;',
    '  gl_FragColor=vec4(c*0.25*0.85+texture2D(tAdd,vUv).rgb,1.0);',
    '}'
  ].join('\n');

  var F_FINAL = [
    'uniform sampler2D tLit, tBloom, tDepth;',
    'uniform vec2 uTexel, uResolution;',
    'uniform float uNear,uFar,uBloom,uDof,uNitro;',
    'varying vec2 vUv;', COMMON, CR.GLSL_NOISE,
    'float lin(vec2 uv){ float d=texture2D(tDepth,uv).r; float z=d*2.0-1.0;',
    '  return (2.0*uNear*uFar)/(uFar+uNear-z*(uFar-uNear)); }',
    'void main(){',
    '  float d=lin(vUv);',
    '  float coc=smoothstep(110.0,800.0,d)*uDof;',
    /* 氮气色差：只作用画面边缘（smoothstep 0.15→0.7），中心的车与近处路面 offset 为 0，
       所以不会整屏模糊，只是边缘轻微桶形 + R/B 分离。强度上限 0.35。 */
    '  vec2 q=vUv-0.5;',
    '  float edge=smoothstep(0.15,0.7,length(q));',
    '  float amp=uNitro*edge*0.35;',
    '  vec2 duv=vUv+q*(amp*amp*0.055);',
    '  vec2 ca=q*(amp*0.035);',
    '  vec3 sharp;',
    /* 氮气关闭时 amp 精确为 0：duv=vUv、ca=0，三次带 clamp 的采样其实是同一个 uv。
       合成一次采样，结果逐像素一致，省 2 次全屏纹理读取。 */
    '  if(amp>0.0){',
    '    sharp.r=texture2D(tLit,clamp(duv+ca,vec2(0.001),vec2(0.999))).r;',
    '    sharp.g=texture2D(tLit,clamp(duv,vec2(0.001),vec2(0.999))).g;',
    '    sharp.b=texture2D(tLit,clamp(duv-ca,vec2(0.001),vec2(0.999))).b;',
    '  }else{',
    '    sharp=texture2D(tLit,clamp(vUv,vec2(0.001),vec2(0.999))).rgb;',
    '  }',
    '  vec3 blur=sharp;',
    '  vec2 rad=coc*vec2(7.0/uResolution.x,7.0/uResolution.y);',
    /* coc=0（DOF 关闭或画面全在近景）时，8-tap 的结果被 mix 权重 0 完全抵消，
       直接跳过；coc>0 时公式一字未改。 */
    '  if(coc>0.0){',
    '    for(int i=0;i<8;i++){ float a=float(i)*2.39996323;',
    '      vec2 o=vec2(cos(a),sin(a))*rad*sqrt((float(i)+0.5)/8.0);',
    '      blur+=texture2D(tLit,clamp(vUv+o,vec2(0.001),vec2(0.999))).rgb; }',
    '  }',
    '  vec3 col=mix(sharp,blur/9.0,coc*0.9);',
    '  if(uBloom>0.0){ col+=texture2D(tBloom,vUv).rgb*0.12*uBloom; }',
    '  col=crAces(col*1.17);',
    '  col=pow(clamp(col,0.0,1.0),vec3(1.0/2.2));',
    /* 分离色调：暗部偏冷 / 高光偏暖 */
    '  float l=crLuma(col);',
    '  col=mix(col*vec3(0.91,0.98,1.10),col*vec3(1.055,1.005,0.94),smoothstep(0.25,0.8,l));',
    '  col*=clamp(1.0-0.34*dot(q,q)*2.1,0.0,1.0);',
    /* 颗粒 12Hz 更新、幅度 0.026：每帧全屏换噪声在静止画面下会持续闪烁 */
    '  float g=crHash(vUv*uResolution+floor(uTime*12.0)*0.37)-0.5;',
    '  col+=g*0.026;',
    '  gl_FragColor=vec4(clamp(col,0.0,1.0),1.0);',
    '}'
  ].join('\n');

  Post.create = function (renderer) {
    R.renderer = renderer;
    capabilityProbe(renderer);
    var isGL2 = !!renderer.capabilities.isWebGL2;
    var maxS = isGL2 ? (renderer.capabilities.maxSamples || 4) : 0;
    R.samples = Math.max(0, Math.min(4, maxS));
    quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    quadScene = new THREE.Scene();
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    quad = new THREE.Mesh(g, null); quad.frustumCulled = false; quadScene.add(quad);

    passes.ao = Pass(F_AO, {
      tDepth: { value: null }, uTexel: { value: new THREE.Vector2() },
      uNear: { value: 1 }, uFar: { value: 14000 },
      uTanHalf: { value: 0.5 }, uAspect: { value: 1.6 }, uTime: CR.time
    });
    passes.lit = Pass(F_LIT, {
      tScene: { value: null }, tAO: { value: null }, tDepth: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uNear: { value: 1 }, uFar: { value: 14000 },
      uTanHalf: { value: 0.5 }, uAspect: { value: 1.6 }, uCamY: { value: 0 },
      uAO: { value: 1 }, uFogOn: { value: 1 },
      uCamWorld: { value: new THREE.Matrix4() },
      uTime: CR.time, uSun: { value: CR.SUN }
    });
    passes.down = Pass(F_DOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 0 }, uTime: CR.time });
    passes.up = Pass(F_UP, { tSrc: { value: null }, tAdd: { value: null }, uTexel: { value: new THREE.Vector2() } });
    passes.final = Pass(F_FINAL, {
      tLit: { value: null }, tBloom: { value: null }, tDepth: { value: null },
      uTexel: { value: new THREE.Vector2() }, uResolution: { value: new THREE.Vector2() },
      uNear: { value: 1 }, uFar: { value: 14000 }, uBloom: { value: 1 }, uDof: { value: 1 },
      uNitro: { value: 0 }, uTime: CR.time
    });
    Post.setSize(renderer.domElement.width, renderer.domElement.height);
    Post.ready = true;
    return Post;
  };

  function disposeRT(t) { if (t) t.dispose(); }

  /* 真实建一次 framebuffer 检查完整性：新尺寸的 MSAA / HalfFloat / DepthTexture
     组合在部分驱动上会 incomplete，表现就是间歇黑帧。 */
  function rtComplete(rt) {
    var gl = R.renderer.getContext();
    R.renderer.setRenderTarget(rt);
    R.renderer.clear(true, true, true);
    var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    R.renderer.setRenderTarget(null);
    return ok;
  }

  /* ---------------- 移动 GPU 能力探测 ----------------
     HalfFloat 颜色附件在部分移动 GPU / WebGL1 上不可用（典型表现是整屏黑）。
     真实建一次 framebuffer 做完整性探测；不行就整条链退到 8bit ——
     宁可 HDR 高光被裁掉，也不要黑屏。DepthTexture 同理：缺扩展时关掉
     AO / DOF / 高度雾（它们都依赖深度），而不是让 shader 去读空纹理。 */
  function capabilityProbe(renderer) {
    var gl = renderer.getContext();
    R.isGL2 = !!renderer.capabilities.isWebGL2;
    R.hasDepthTex = R.isGL2 || !!gl.getExtension('WEBGL_depth_texture');
    var rt = null, ok = false;
    try {
      rt = makeRT(4, 4, 0, false, THREE.HalfFloatType);
      renderer.setRenderTarget(rt);
      renderer.clear(true, false, false);
      ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    } catch (e) { ok = false; }
    renderer.setRenderTarget(null);
    if (rt) rt.dispose();
    R.type = ok ? THREE.HalfFloatType : THREE.UnsignedByteType;
    if (!R.hasDepthTex) { Post.flags.ao = 0; Post.flags.dof = 0; }
  }

  /* MSAA + DepthTexture 在部分驱动上会 FRAMEBUFFER_INCOMPLETE_MULTISAMPLE
     （表现为黑屏）。这里创建一次真实 framebuffer 做完整性探测，
     不可用则永久降级到 samples:0（深度纹理在非 MSAA 下稳定可用）。 */
  var msaaChecked = false;
  function msaaProbe(w, h) {
    if (msaaChecked) return;
    msaaChecked = true;
    if (R.samples <= 0) return;
    var rt = null, ok = false, gl = R.renderer.getContext();
    try {
      rt = makeRT(Math.max(2, w), Math.max(2, h), R.samples, true);
      R.renderer.setRenderTarget(rt);
      R.renderer.clear(true, true, true);
      ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    } catch (e) { ok = false; }
    R.renderer.setRenderTarget(null);
    if (rt) rt.dispose();
    if (!ok) {
      R.samples = 0;
      if (window.console) console.warn('[Post] MSAA+Depth 不可用，已降级 samples:0');
    }
  }

  Post.setSize = function (w, h) {
    if (!R.renderer) return;
    w = Math.max(2, w | 0); h = Math.max(2, h | 0);
    /* 尺寸没变就不重建：resize 事件常因地址栏收缩/旋屏重复触发 */
    if (P.scene && w === R.w && h === R.h) return;
    msaaProbe(w, h);

    var hw = Math.max(1, Math.floor(w / 2)), hh = Math.max(1, Math.floor(h / 2));
    var next = {};
    next.scene = makeRT(w, h, R.samples, true);
    /* 新尺寸的 MSAA + DepthTexture 可能在部分驱动上 incomplete（黑帧）。
       建完立刻验证；失败就永久降 samples 再建一次，绝不让残缺 RT 进入渲染。 */
    if (R.samples > 0 && !rtComplete(next.scene)) {
      next.scene.dispose();
      R.samples = 0;
      next.scene = makeRT(w, h, 0, true);
      if (window.console) console.warn('[Post] 新尺寸 MSAA 不可用，已降级 samples:0');
    }
    next.ao = makeRT(hw, hh, 0, false, THREE.UnsignedByteType);
    next.lit = makeRT(w, h, 0, false);
    next.down = []; next.up = [];
    for (var m = 0; m < 5; m++) {
      var dw = Math.max(1, Math.floor(w / Math.pow(2, m + 1)));
      var dh = Math.max(1, Math.floor(h / Math.pow(2, m + 1)));
      next.down.push(makeRT(dw, dh, 0, false));
      if (m < 4) next.up.push(makeRT(dw, dh, 0, false));
    }

    /* 原子切换：新集合全部就绪后才替换；旧集合延迟到下一轮事件循环释放，
       避免"正在渲染的纹理被 dispose"导致 1 帧黑屏/花屏。 */
    var old = P;
    P = next;
    R.w = w; R.h = h; R.hw = hw; R.hh = hh;
    passes.ao.u.uTexel.value.set(1 / w, 1 / h);
    passes.lit.u.uTexel.value.set(1 / w, 1 / h);
    passes.final.u.uTexel.value.set(1 / w, 1 / h);
    passes.final.u.uResolution.value.set(w, h);
    if (old && old.scene) {
      setTimeout(function () {
        disposeRT(old.scene); disposeRT(old.ao); disposeRT(old.lit);
        (old.down || []).forEach(disposeRT); (old.up || []).forEach(disposeRT);
      }, 0);
    }
  };

  Post.height = function () { return R.h; };
  Post.width = function () { return R.w; };
  /* 氮气画面强度写入口：调用方负责平滑（main.js 用 1-exp(-dt*8)），这里只落 uniform */
  Post.setNitro = function (v) {
    Post.nitroLevel = CR.clamp01(v || 0);
    return Post.nitroLevel;
  };
  /* 只读诊断口：调参 / 验收时确认 uniform 真的传到了 GPU，不参与渲染 */
  Post.debug = function () {
    return {
      flags: { ao: Post.flags.ao, bloom: Post.flags.bloom, dof: Post.flags.dof, nitro: Post.flags.nitro },
      threshold: Post.bloomThreshold,
      uDof: passes.final.u.uDof.value, uBloom: passes.final.u.uBloom.value,
      uNit: passes.final.u.uNitro.value, nitroLevel: Post.nitroLevel,
      uAO: passes.lit.u.uAO.value,
      near: passes.final.u.uNear.value, far: passes.final.u.uFar.value,
      res: [passes.final.u.uResolution.value.x, passes.final.u.uResolution.value.y],
      samples: R.samples, rt: [R.w, R.h],
      passes: Post.stats.passes, aoPass: Post.stats.ao, bloomChain: Post.stats.bloom,
      hdr: R.type === THREE.HalfFloatType, isGL2: R.isGL2, hasDepthTex: R.hasDepthTex
    };
  };

  Post.render = function (scene, camera) {
    if (!Post.ready) return;
    Post.stats.passes = 0; Post.stats.ao = 0; Post.stats.bloom = 0;
    var renderer = R.renderer;
    camera.updateMatrixWorld();
    var tanHalf = Math.tan(camera.fov * Math.PI / 360);
    var aspect = camera.aspect;
    passes.ao.u.uNear.value = camera.near; passes.ao.u.uFar.value = camera.far;
    passes.ao.u.uTanHalf.value = tanHalf; passes.ao.u.uAspect.value = aspect;
    passes.lit.u.uNear.value = camera.near; passes.lit.u.uFar.value = camera.far;
    passes.lit.u.uTanHalf.value = tanHalf; passes.lit.u.uAspect.value = aspect;
    passes.lit.u.uCamY.value = camera.position.y;
    passes.lit.u.uCamWorld.value.copy(camera.matrixWorld);
    passes.final.u.uNear.value = camera.near; passes.final.u.uFar.value = camera.far;
    passes.lit.u.uAO.value = Post.flags.ao;
    passes.lit.u.uFogOn.value = R.hasDepthTex ? 1 : 0;
    passes.final.u.uBloom.value = Post.flags.bloom;
    passes.final.u.uDof.value = Post.flags.dof;
    passes.final.u.uNitro.value = Post.flags.nitro ? Post.nitroLevel : 0;

    /* Pass 0：原始 HDR 场景（MSAA + DepthTexture） */
    renderer.setRenderTarget(P.scene);
    renderer.render(scene, camera);

    /* Pass 1：半分辨率 AO。关闭时整段跳过 —— F_LIT 的 uAO=0 已不再采样 tAO，
       所以 P.ao 本帧没渲染也完全安全（旧实现无论开关都白跑 8 次深度采样）。 */
    if (Post.flags.ao) {
      passes.ao.u.tDepth.value = P.scene.depthTexture;
      run(passes.ao, P.ao);
      Post.stats.ao = 1;
    }

    /* Pass 2：AO + 大气雾合成 */
    passes.lit.u.tScene.value = P.scene.texture;
    passes.lit.u.tAO.value = P.ao.texture;
    passes.lit.u.tDepth.value = P.scene.depthTexture;
    run(passes.lit, P.lit);

    /* Pass 3/4：5 级 Bloom 降采样 + 4 级上采样。
       关闭时整段跳过（旧实现这 9 个全屏 pass 照跑，只是最终被乘了 0）；
       tBloom 指回已渲染好的 P.lit，保证纹理内容有限、uBloom=0 时加法恒为 0。 */
    var src = P.lit.texture;
    if (Post.flags.bloom) {
      passes.down.u.tSrc.value = P.lit.texture;
      passes.down.u.uTexel.value.set(1 / R.w, 1 / R.h);
      passes.down.u.uThreshold.value = Post.bloomThreshold;
      run(passes.down, P.down[0]);
      passes.down.u.uThreshold.value = 0;
      for (var m = 1; m < 5; m++) {
        var pw = Math.max(1, Math.floor(R.w / Math.pow(2, m)));
        var ph = Math.max(1, Math.floor(R.h / Math.pow(2, m)));
        passes.down.u.tSrc.value = P.down[m - 1].texture;
        passes.down.u.uTexel.value.set(1 / pw, 1 / ph);
        run(passes.down, P.down[m]);
      }
      /* 4 级 4-tap 上采样逐级叠加 *0.85（不读写同一张 RT） */
      src = P.down[4].texture;
      for (m = 3; m >= 0; m--) {
        var sw = Math.max(1, Math.floor(R.w / Math.pow(2, m + 2)));
        var sh = Math.max(1, Math.floor(R.h / Math.pow(2, m + 2)));
        passes.up.u.tSrc.value = src;
        passes.up.u.tAdd.value = P.down[m].texture;
        passes.up.u.uTexel.value.set(1 / sw, 1 / sh);
        run(passes.up, P.up[m]);
        src = P.up[m].texture;
      }
      Post.stats.bloom = 1;
    }

    /* Pass 5：终合成 */
    passes.final.u.tLit.value = P.lit.texture;
    passes.final.u.tBloom.value = src;
    passes.final.u.tDepth.value = P.scene.depthTexture;
    run(passes.final, null);
    renderer.setRenderTarget(null);
  };
})();
