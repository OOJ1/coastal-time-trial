/* =========================================================================
 * confetti.js — 冲线彩条：终点线两侧同时向外飞散
 *
 * 触发权完全交给 hud.js 的「正向跨线」事件；本模块只负责播放与冷却，
 * 不写回任何圈速状态、不修改 Car / Hud 的计时逻辑。
 *   · 每次跨线最多触发一次（单帧边沿 + 0.05s 去重窗）
 *   · 内置 CR.CFG.confettiCD = 20s 冷却，冷却期重复冲线不重播
 *   · 冷却结束后自动恢复可触发状态（lastFire 不被冷却期的跨线刷新）
 *   · 默认只在「完成一圈」时放；CR.CFG.confettiEveryCross=true 可改成
 *     任意正向跨线都放（起跑那次也会放）
 * 粒子用 InstancedMesh，一次 draw call；生命/旋转全部乘 dt，帧率无关。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var Conf = CR.Confetti = {};

  var N = 0, mesh = null, parts = [], rnd = null, dummy = null, tmpColor = null;
  var lastFire = -Infinity, lastCross = -Infinity, fired = 0;
  var originL = null, originR = null, alive = 0;

  var PALETTE = [
    [1.00, 0.26, 0.20], [1.00, 0.72, 0.18], [0.22, 0.86, 0.86],
    [1.00, 0.96, 0.86], [0.96, 0.31, 0.76], [0.46, 0.94, 0.36]
  ];

  function spawn(p, side) {
    var o = side > 0 ? originL : originR;
    p.x = o.x + (rnd() - 0.5) * 0.5;
    p.y = o.y + 0.35 + rnd() * 0.7;
    p.z = o.z + (rnd() - 0.5) * 0.5;

    /* 主速度沿「赛道左法向 × side」向外，再叠向上、沿赛道前后和一点切向抖动 */
    var out = 4.2 + rnd() * 5.2;
    var along = (rnd() - 0.5) * 6.0;
    p.vx = o.lx * side * out + o.tx * along + (rnd() - 0.5) * 1.6;
    p.vz = o.lz * side * out + o.tz * along + (rnd() - 0.5) * 1.6;
    p.vy = 6.2 + rnd() * 6.0;

    p.rx = rnd() * 6.283; p.ry = rnd() * 6.283; p.rz = rnd() * 6.283;
    p.sx = (rnd() - 0.5) * 13; p.sy = (rnd() - 0.5) * 13; p.sz = (rnd() - 0.5) * 13;
    p.side = side;
    p.sc = 0.72 + rnd() * 0.46;          /* 尺寸只在此处抽一次，update 不再推进随机流 */
    var c = PALETTE[rnd.int(PALETTE.length)];
    p.cr = c[0]; p.cg = c[1]; p.cb = c[2];
    p.life = 3.0 + rnd() * 2.0;
    p.max = p.life;
    p.grounded = false;
    /* 出生点的地面高度只算一次，作为"是否可能落地"的粗判基准 */
    p.ground = CR.Terrain.heightAt(p.x, p.z);
  }

  function hide(p) {
    dummy.position.set(p.x, p.y, p.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.setScalar(0.0001);
    dummy.updateMatrix();
  }

  Conf.create = function (scene) {
    N = CR.CFG.confettiCount;
    rnd = CR.rng(CR.SALT.confetti);
    dummy = new THREE.Object3D();
    tmpColor = new THREE.Color();

    var T = CR.Track;
    /* 终点线在 s=0；两侧取稍宽于路面，避免彩条从沥青里冒出来 */
    var off = CR.ROAD_HALF + 0.35;
    originL = T.pointAt(0, off, {});
    originR = T.pointAt(0, -off, {});

    var geo = new THREE.PlaneGeometry(0.16, 0.44);
    var mat = new THREE.MeshBasicMaterial({
      side: THREE.DoubleSide, transparent: false, depthWrite: true, fog: false
    });
    mesh = new THREE.InstancedMesh(geo, mat, N);
    mesh.frustumCulled = false;
    mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.renderOrder = 5;
    for (var i = 0; i < N; i++) {
      var p = { x: 0, y: 0, z: 0, life: 0, max: 1, cr: 1, cg: 1, cb: 1 };
      parts.push(p);
      hide(p);
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, tmpColor.setRGB(1, 1, 1));
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    scene.add(mesh);
    Conf.mesh = mesh;
    Conf.ready = true;
    return Conf;
  };

  /* 由 hud.js 在正向跨那一帧调用；completed = 是否真的完成了一圈 */
  Conf.trigger = function (completed) {
    if (!Conf.ready) return false;
    if (!completed && !CR.CFG.confettiEveryCross) return false;
    var t = CR.time.value;
    if (t - lastCross < 0.05) return false;       /* 同一次冲线最多一次 */
    lastCross = t;
    if (t - lastFire < CR.CFG.confettiCD) return false;  /* 20s CD */
    lastFire = t;
    /* 每次都用同一颗种子重播：全局 SEED 相同则每次冲线的彩条图案逐字节可复现，
       也便于验证不同帧率下粒子积分一致。想每圈换花样可改成 +fired。 */
    rnd = CR.rng(CR.SALT.confetti);
    for (var i = 0; i < N; i++) spawn(parts[i], (i % 2) ? 1 : -1);
    alive = N;
    fired++;
    return true;
  };

  Conf.readyToFire = function () {
    return CR.time.value - lastFire >= CR.CFG.confettiCD;
  };

  Conf.update = function (dt) {
    if (!Conf.ready || alive <= 0) return;
    var g = 9.8 * 0.45, drag = Math.exp(-dt * 0.62), live = 0;
    for (var i = 0; i < N; i++) {
      var p = parts[i];
      if (p.life <= 0) { hide(p); mesh.setMatrixAt(i, dummy.matrix); continue; }
      p.life -= dt;
      if (p.life <= 0) { hide(p); mesh.setMatrixAt(i, dummy.matrix); continue; }
      live++;

      if (!p.grounded) {
        p.vy -= g * dt;
        p.vx *= drag; p.vz *= drag; p.vy *= drag;
        p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
        /* 落地后贴着地面慢慢停住，而不是穿进地形 */
        /* 只有"正在下落且接近已知地面"时才做精确 heightAt。
           上升段与高空段绝无可能落地，旧实现每帧对 180 片彩条各算一次
           nearest+fbm（冲线后 3~5s 是低端设备最明显的掉帧源）。
           p.ground 每次精确计算后更新，临界区内仍逐帧精确，
           落地时刻与贴地位置不变。 */
        if (p.vy < 0 && p.y < p.ground + 4.0) {
          var ground = CR.Terrain.heightAt(p.x, p.z);
          p.ground = ground;
          if (p.y < ground + 0.03) {
            p.y = ground + 0.03;
            p.vx *= 0.55; p.vz *= 0.55; p.vy = 0;
            p.grounded = true;
          }
        }
        p.rx += p.sx * dt; p.ry += p.sy * dt; p.rz += p.sz * dt;
        p.sx *= drag; p.sy *= drag; p.sz *= drag;
      } else {
        p.x += p.vx * dt; p.z += p.vz * dt;
        p.vx *= Math.exp(-dt * 3.2); p.vz *= Math.exp(-dt * 3.2);
        p.rz += p.sz * dt * 0.15;
      }

      /* 出生放大、末尾收缩 + 变暗，代替逐实例 alpha */
      var age = p.max - p.life;
      var fade = Math.min(1, age / 0.16) * Math.min(1, p.life / 0.7);
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(p.rx, p.ry, p.rz);
      dummy.scale.setScalar(Math.max(0.0001, p.sc * fade));
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, tmpColor.setRGB(p.cr * fade, p.cg * fade, p.cb * fade));
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    alive = live;
  };

  /* 只读诊断，供验收脚本核对 CD / 两侧分布 / 飞散方向 */
  Conf.diag = function () {
    var l = 0, r = 0, outDot = 0, cnt = 0;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (p.life <= 0) continue;
      if (p.side > 0) l++; else r++;
      var o = p.side > 0 ? originL : originR;
      var dot = p.vx * o.lx * p.side + p.vz * o.lz * p.side;
      if (!p.grounded) { outDot += dot; cnt++; }
    }
    return {
      fired: fired, cd: CR.CFG.confettiCD, ready: Conf.readyToFire(),
      alive: alive, left: l, right: r, outwardSpeed: cnt ? +(outDot / cnt).toFixed(3) : 0,
      originL: [+originL.x.toFixed(2), +originL.z.toFixed(2)],
      originR: [+originR.x.toFixed(2), +originR.z.toFixed(2)],
      count: N
    };
  };
})();
