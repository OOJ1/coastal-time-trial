/* =========================================================================
 * effects.js — 胎痕环形缓冲(CAP=2400) + 尾尘点精灵(DUST=260)
 * uScale 由主循环传入 Post.height()*0.5*projectionMatrix.elements[5]
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var Effects = CR.Effects = {};
  /* 纯视觉特效逐项开关（验收 M）：关掉任何一项都不影响物理与画面成立 */
  Effects.flags = { flame: 1, dust: 1, skid: 1 };
  var CAP = 2400, DUST = 260;
  /* 胎痕每帧复用同一个 out 对象：旧实现每帧造 4 个短命 {}。 */
  var _wheel = { x: 0, y: 0, z: 0 };
  /* 特效随机走独立种子流（CR.SALT.fx = 901）：连粒子抖动都可复现 */
  var fxRnd = null;

  Effects.create = function (scene) {
    fxRnd = CR.rng(CR.SALT.fx);
    /* --- 胎痕：CAP 个四边形环形缓冲，DynamicDrawUsage 局部更新 --- */
    var pos = new Float32Array(CAP * 4 * 3);
    var col = new Float32Array(CAP * 4 * 4);
    var idx = new Uint32Array(CAP * 6);
    for (var i = 0; i < CAP; i++) {
      var b = i * 4;
      idx[i * 6] = b; idx[i * 6 + 1] = b + 2; idx[i * 6 + 2] = b + 1;
      idx[i * 6 + 3] = b + 1; idx[i * 6 + 4] = b + 2; idx[i * 6 + 5] = b + 3;
    }
    var g = new THREE.BufferGeometry();
    var pa = new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage);
    var ca = new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pa); g.setAttribute('color', ca);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    var mesh = new THREE.Mesh(g, CR.Road.markMaterial());
    mesh.frustumCulled = false; mesh.renderOrder = 2;
    scene.add(mesh);
    /* last 预分配 + on 标志：旧实现每帧新建两个 {x,y,z}，现在只改字段 */
    /* dirty：本帧是否写过 quad（决定这一帧要不要上传） */
    Effects.skid = { geo: g, pa: pa, ca: ca, head: 0, count: 0,
                     dirty: false,
                     last: [{ x: 0, y: 0, z: 0, on: false }, { x: 0, y: 0, z: 0, on: false }] };

    /* --- 尾尘：点精灵 --- */
    var dp = new Float32Array(DUST * 3), ds = new Float32Array(DUST), dl = new Float32Array(DUST);
    var dg = new THREE.BufferGeometry();
    var dpa = new THREE.BufferAttribute(dp, 3).setUsage(THREE.DynamicDrawUsage);
    var dsa = new THREE.BufferAttribute(ds, 1).setUsage(THREE.DynamicDrawUsage);
    var dla = new THREE.BufferAttribute(dl, 1).setUsage(THREE.DynamicDrawUsage);
    dg.setAttribute('position', dpa); dg.setAttribute('aSize', dsa); dg.setAttribute('aLife', dla);
    dg.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    var dmat = new THREE.ShaderMaterial({
      uniforms: { tDust: { value: CR.Tex.get('dust') }, uScale: { value: 300 }, uTime: CR.time },
      vertexShader: [
        'attribute float aSize; attribute float aLife;',
        'uniform float uScale; varying float vLife;',
        'void main(){ vLife = aLife; vec4 mv = modelViewMatrix * vec4(position, 1.0);',
        '  gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.5), 1.0, 96.0);',
        '  gl_Position = projectionMatrix * mv; }'
      ].join('\n'),
      fragmentShader: [
        'uniform sampler2D tDust; varying float vLife;',
        'void main(){ vec4 t = texture2D(tDust, gl_PointCoord);',
        '  float fade = smoothstep(0.0, 0.18, vLife) * (1.0 - smoothstep(0.6, 1.0, vLife));',
        '  gl_FragColor = vec4(vec3(0.95, 0.66, 0.42), t.a * fade * 0.55);',
        '  if (gl_FragColor.a < 0.01) discard; }'
      ].join('\n'),
      transparent: true, depthWrite: false
    });
    var points = new THREE.Points(dg, dmat);
    points.frustumCulled = false; points.renderOrder = 6;
    scene.add(points);
    /* live/dirty：一个粒子都没活着、且本帧没新发射时，整段遍历与缓冲上传都跳过 */
    Effects.dust = { geo: dg, pa: dpa, sa: dsa, la: dla, mat: dmat, head: 0,
                     life: new Float32Array(DUST), vel: [], live: 0, dirty: false };
    for (i = 0; i < DUST; i++) Effects.dust.vel.push({ x: 0, y: 0, z: 0 });

    /* --- 尾焰：每个排气口两层（外焰 + 内核），共用一套 shader，靠 uCore 切配色与衰减 ---
       · 内核短而亮（白蓝 → 暖白）：点火核心，根部最实；
       · 外焰长而淡（蓝 → 橙）：光晕与拖尾，随车速拉长、随漂移变宽。
       几何原点在根部，长轴跟车尾方向并略微上扬 —— 既不会被路面切掉下半截，
       也不会埋进保险杠。复用 dust 贴图，不新增素材。 */
    var fg = new THREE.PlaneGeometry(1, 1);
    fg.translate(0, 0.5, 0);                 /* 原点在根部，向 +y 延伸 */
    var flames = [];
    for (var s = 0; s < 2; s++) {
      for (var ly = 0; ly < 2; ly++) {
        var fm = new THREE.ShaderMaterial({
          uniforms: {
            tDust: { value: CR.Tex.get('dust') },
            uK: { value: 0 },
            uPhase: { value: s * 1.73 + ly * 0.61 },
            uCore: { value: ly }
          },
          vertexShader: [
            'varying vec2 vUv;',
            'void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'
          ].join('\n'),
          fragmentShader: [
            'uniform sampler2D tDust; uniform float uK, uPhase, uCore; varying vec2 vUv;',
            'void main(){',
            '  vec4 t = texture2D(tDust, vUv);',
            /* 内核衰减更快 → 短而亮；外焰拉得长 → 有拖尾层次 */
            '  float tail = pow(clamp(1.0 - vUv.y, 0.0, 1.0), mix(1.15, 2.10, uCore));',
            /* 横向收束成锥形，避免矩形直边露馅 */
            '  float side = smoothstep(0.0, 0.18, vUv.x) * (1.0 - smoothstep(0.82, 1.0, vUv.x));',
            '  float taper = mix(1.0, 0.45, vUv.y);',
            '  vec3 cCore = mix(vec3(0.55,0.78,1.0), vec3(1.0,0.94,0.82), smoothstep(0.0, 0.60, vUv.y));',
            '  vec3 cOut  = mix(vec3(0.26,0.40,1.0), vec3(1.0,0.45,0.08), smoothstep(0.0, 0.70, vUv.y));',
            '  vec3 col = mix(cOut, cCore, uCore);',
            '  float a = t.a * tail * side * taper * uK;',
            '  if (a < 0.004) discard;',
            '  gl_FragColor = vec4(col, a);',
            '}'
          ].join('\n'),
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
        });
      var mq = new THREE.Mesh(fg, fm);
      /* 初始可见（uK=0 时片元全部 discard，画面无变化），
         这样启动时的 renderer.compile 能把尾焰 shader 也编译掉，
         避免局内第一次点火才编译造成卡顿。updateFlame 第一帧会再隐藏。 */
      mq.frustumCulled = false; mq.renderOrder = 7; mq.visible = true;
        scene.add(mq);
        flames.push({ mesh: mq, mat: fm, side: s ? 1 : -1, core: ly === 1 });
      }
    }

    /* 根部光晕：始终正对相机的一小团亮光。
       追尾视角下火焰沿视线方向、投影会被压扁，光晕保证"任何角度都看得见排气口在烧"。 */
    var glowGeo = new THREE.PlaneGeometry(1, 1);
    for (s = 0; s < 2; s++) {
      var gm = new THREE.ShaderMaterial({
        uniforms: {
          tDust: { value: CR.Tex.get('dust') },
          uK: { value: 0 },
          uPhase: { value: s * 2.1 }
        },
        vertexShader: [
          'varying vec2 vUv;',
          'void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }'
        ].join('\n'),
        fragmentShader: [
          'uniform sampler2D tDust; uniform float uK, uPhase; varying vec2 vUv;',
          'void main(){',
          '  float d = length(vUv - vec2(0.5));',
          '  float g = smoothstep(0.5, 0.04, d);',
          '  vec3 col = mix(vec3(0.36,0.56,1.0), vec3(1.0,0.86,0.58), clamp(uK, 0.0, 1.0) * 0.75);',
          '  float a = g * g * uK;',
          '  if (a < 0.004) discard;',
          '  gl_FragColor = vec4(col, a);',
          '}'
        ].join('\n'),
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide
      });
      var gq = new THREE.Mesh(glowGeo, gm);
      gq.frustumCulled = false; gq.renderOrder = 8; gq.visible = false;
      scene.add(gq);
      flames.push({ mesh: gq, mat: gm, side: s ? 1 : -1, core: false, glow: true });
    }
    Effects.flame = { list: flames, k: 0 };
    Effects.ready = true;
    return Effects;
  };

  function emit(a, b, alpha) {
    var S = Effects.skid, h = S.head, o = h * 12, c = h * 16;
    var dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
    var nx = -dz / l * 0.13, nz = dx / l * 0.13;
    var p = S.pa.array, cc = S.ca.array;
    p[o] = a.x - nx; p[o + 1] = a.y; p[o + 2] = a.z - nz;
    p[o + 3] = a.x + nx; p[o + 4] = a.y; p[o + 5] = a.z + nz;
    p[o + 6] = b.x - nx; p[o + 7] = b.y; p[o + 8] = b.z - nz;
    p[o + 9] = b.x + nx; p[o + 10] = b.y; p[o + 11] = b.z + nz;
    for (var k = 0; k < 4; k++) {
      cc[c + k * 4] = 0.05; cc[c + k * 4 + 1] = 0.048; cc[c + k * 4 + 2] = 0.045;
      cc[c + k * 4 + 3] = alpha;
    }
    /* 同一帧左右轮各写一个 quad。旧实现每次 emit 都直接改 updateRange，
       第二次会覆盖第一次的上传区间 → GPU 上只剩一条胎痕。
       现在只置 dirty，由 update 末尾统一上传。 */
    S.dirty = true;
    S.head = (h + 1) % CAP;
    S.count = Math.min(CAP, S.count + 1);
    S.geo.setDrawRange(0, S.count * 6);
  }

  /* 公开的扬尘接口：update 内部与外部脚本（回放 / 自动驾驶）都可直接调用 */
  Effects.emitDust = function (x, y, z, strength) {
    var D = Effects.dust;
    if (!D) return;
    var i = D.head, p = D.pa.array;
    if (D.life[i] <= 0) D.live++;        /* 复用死亡槽才增加活跃数；覆盖存活槽不变 */
    var f0 = Math.sin(CR.Car.state.psi), f1 = Math.cos(CR.Car.state.psi);
    p[i * 3] = x + (fxRnd() - 0.5) * 0.9;
    p[i * 3 + 1] = y;
    p[i * 3 + 2] = z + (fxRnd() - 0.5) * 0.9;
    D.sa.array[i] = 0.55 + fxRnd() * 0.75 + (strength || 0);
    D.la.array[i] = 0;
    D.life[i] = 0.9 + fxRnd() * 1.0;
    var v = D.vel[i];
    v.x = -f0 * (1.4 + fxRnd() * 1.8) + (fxRnd() - 0.5);
    v.y = 0.5 + fxRnd() * 0.9;
    v.z = -f1 * (1.4 + fxRnd() * 1.8) + (fxRnd() - 0.5);
    D.pa.needsUpdate = true; D.sa.needsUpdate = true; D.la.needsUpdate = true;
    D.head = (i + 1) % DUST;
    D.dirty = true;
  };

  /* ---------- 尾焰：柱状 billboard，长轴跟车尾方向 + 适度上扬 ---------- */
  var _fw = {}, _fp = new THREE.Vector3(), _fn = new THREE.Vector3(),
      _fu = new THREE.Vector3(), _fr = new THREE.Vector3(), _fm4 = new THREE.Matrix4();
  function updateFlame(dt, t) {
    var F = Effects.flame, cam = CR.camera;
    if (!F) return;
    var i, f;
    if (!Effects.flags.flame) {                 /* 运行时可单独关掉尾焰 */
      if (F.k !== 0 || F.list[0].mesh.visible) {
        F.k = 0;
        for (i = 0; i < F.list.length; i++) {
          F.list[i].mesh.visible = false;
          F.list[i].mat.uniforms.uK.value = 0;
        }
      }
      return;
    }
    if (!cam) return;
    var st = CR.Car.state;
    var spd = CR.clamp01((st.speed || 0) / 40);
    var dr = CR.clamp01(st.slip || 0);
    var moving = st.speed > 1.5;
    /* 目标强度：行驶时留一层微焰、漂移略强、氮气爆发；完全静止时收干净 */
    var target = (moving ? 0.10 + 0.20 * spd : 0) +
                 (st.nitroActive ? 0.78 : 0) +
                 (moving ? 0.06 * dr : 0);
    var k = F.k + (target - F.k) * (1 - Math.exp(-dt * (target > F.k ? 14 : 9)));
    F.k = k;
    var on = k >= 0.012;
    for (i = 0; i < F.list.length; i++) F.list[i].mesh.visible = on;
    if (!on) return;
    var fx = Math.sin(st.psi), fz = Math.cos(st.psi);
    var lx = Math.cos(st.psi), lz = -Math.sin(st.psi);
    _fp.copy(cam.position);
    for (i = 0; i < F.list.length; i++) {
      f = F.list[i];
      CR.Car.exhaust(f.side, _fw);
      /* 根部再向车尾外偏 0.06、抬高 0.02：与保险杠留缝，不被车壳吃掉 */
      _fw.x -= fx * 0.06; _fw.z -= fz * 0.06; _fw.y += 0.02;

      /* 根部光晕：永远正对相机，任何视角都有一团可见的排气口亮光 */
      if (f.glow) {
        var gph = f.mat.uniforms.uPhase.value;
        f.mesh.position.set(_fw.x, _fw.y, _fw.z);
        f.mesh.quaternion.copy(cam.quaternion);
        var gs = 0.40 + 0.46 * k + 0.16 * spd;
        f.mesh.scale.set(gs, gs, 1);
        f.mat.uniforms.uK.value = k * (0.62 + 0.22 * Math.sin(t * 37 + gph));
        continue;
      }

      _fn.set(_fp.x - _fw.x, _fp.y - _fw.y, _fp.z - _fw.z);
      var nl = _fn.length() || 1; _fn.multiplyScalar(1 / nl);
      /* 长轴 = 车尾方向在「垂直于视向量」平面上的投影；正对车尾看时投影退化 */
      var d = (-fx) * _fn.x + (-fz) * _fn.z;
      _fu.set(-fx - _fn.x * d, -_fn.y * d, -fz - _fn.z * d);
      var head = _fu.length();
      if (head < 1e-3) { _fu.set(0, 1, 0); head = 0; } else { _fu.multiplyScalar(1 / head); }
      _fu.y += 0.26;                             /* 上扬：拖向斜后方，离开地面 */
      /* 向外张开：追尾视角下两条火焰呈「八」字，投影不会被压成一小团 */
      _fu.x += lx * f.side * 0.20;
      _fu.z += lz * f.side * 0.20;
      _fu.normalize();
      _fr.crossVectors(_fu, _fn).normalize();
      _fm4.makeBasis(_fr, _fu, _fn);
      f.mesh.quaternion.setFromRotationMatrix(_fm4);
      var ph = f.mat.uniforms.uPhase.value;
      var fl = 0.80 + 0.20 * Math.sin(t * 51.0 + ph) + 0.10 * Math.sin(t * 23.7 + ph * 2.1);
      var sway = Math.sin(t * 33.0 + ph) * 0.045 * (0.35 + dr) * k;
      f.mesh.position.set(_fw.x + lx * sway, _fw.y, _fw.z + lz * sway);
      /* head 越小＝越正对车尾：此时补一点长度和宽度，避免缩成一个点 */
      var near = CR.clamp01((0.45 - head) / 0.45);
      var grow = (0.78 + 0.55 * spd) * (1 + 0.95 * near);
      var pulse = 0.82 + 0.55 * k;
      if (f.core) {
        f.mesh.scale.set(0.17 * (0.86 + 0.30 * fl) * (1 + 0.22 * dr) * (1 + 0.40 * near),
                         (0.26 + 0.30 * head) * grow * fl * pulse, 1);
        f.mat.uniforms.uK.value = k * (0.85 + 0.40 * fl);
      } else {
        f.mesh.scale.set(0.46 * (0.85 + 0.35 * fl) * (1 + 0.28 * dr) * (1 + 0.45 * near),
                         (0.80 + 1.45 * head) * grow * fl * pulse, 1);
        f.mat.uniforms.uK.value = k * (0.62 + 0.38 * fl);
      }
    }
  }

  Effects.update = function (dt, pixelScale) {
    if (!Effects.ready) return;
    var st = CR.Car.state, S = Effects.skid, D = Effects.dust;
    D.mat.uniforms.uScale.value = pixelScale;

    /* 胎痕：slip>0.04 && speed>3 && !offroad，相邻点 0.3–6m 接一小段 */
    if (st.slip > 0.04 && st.speed > 3 && !st.offroad) {
      for (var side = 0; side < 2; side++) {
        var p = CR.Car.rearWheel(side ? 1 : -1, _wheel);
        var last = S.last[side];
        if (last.on) {
          var d = Math.hypot(p.x - last.x, p.z - last.z);
          if (d > 0.3 && d < 6) emit(last, p, 0.42 + st.slip * 0.6);
        }
        last.x = p.x; last.y = p.y; last.z = p.z; last.on = true;
      }
    } else {
      S.last[0].on = S.last[1].on = false;
    }

    /* 本帧写过 quad 就整段上传。
       为什么不用 updateRange 的「分区间」上传：three r149 在 WebGL2 下走的是
       bufferSubData(target, dstByteOffset, srcData, srcOffset, length) 五参数重载，
       实测（SwiftShader 与真实 D3D11 均复现）该重载的写入不会在缓冲里累积——
       每帧只有最后一次写入的那两个 quad 留在 GPU 上，表现就是「车后只有一两条
       很短的胎痕」。退回 updateRange.count = -1 的三参数全量上传后正常。
       代价：仅在本帧确实画了胎痕时上传，2400 段 × (12+16) float ≈ 268KB/帧，
       不漂移时一次都不传。 */
    if (S.dirty) {
      S.dirty = false;
      S.pa.updateRange.offset = 0;
      S.ca.updateRange.offset = 0;
      S.pa.updateRange.count = -1;
      S.ca.updateRange.count = -1;
      S.pa.needsUpdate = true; S.ca.needsUpdate = true;
    }

    /* 尾尘：打滑/漂移 1 个；越野且 speed>8 时额外 3 个 */
    var rearX = st.x - Math.sin(st.psi) * 1.7, rearZ = st.z - Math.cos(st.psi) * 1.7;
    if (st.slip > 0.02 && st.speed > 3) {
      Effects.emitDust(rearX, st.y + 0.16, rearZ, 0);
    }
    if (st.offroad && st.speed > 8) {
      for (var q = 0; q < 3; q++) {
        Effects.emitDust(rearX + (fxRnd() - 0.5) * 1.2, st.y + 0.12,
                         rearZ + (fxRnd() - 0.5) * 1.2, 0.5);
      }
    }
    /* 粒子全死且本帧没有新发射时，整段跳过：不遍历 260 个槽、不上传 3 个缓冲。
       最后一个粒子死亡那一帧仍会上传一次 aLife=0，画面与旧实现完全一致。 */
    if (D.live > 0 || D.dirty) {
      var pa = D.pa.array, la = D.la.array, sa = D.sa.array, live = 0;
      for (var i = 0; i < DUST; i++) {
        if (D.life[i] <= 0) { la[i] = 0; continue; }
        D.life[i] -= dt;
        var v = D.vel[i];
        pa[i * 3] += v.x * dt; pa[i * 3 + 1] += v.y * dt; pa[i * 3 + 2] += v.z * dt;
        v.y -= dt * 0.6;
        sa[i] += dt * 0.7;
        la[i] = CR.clamp01(1 - D.life[i] / 1.9);
        if (D.life[i] <= 0) la[i] = 0;
        else live++;
      }
      D.live = live;
      D.dirty = false;
      D.pa.needsUpdate = true; D.sa.needsUpdate = true; D.la.needsUpdate = true;
    }

    updateFlame(dt, CR.time.value);
  };
})();
