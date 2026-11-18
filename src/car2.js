/* =========================================================================
 * car2.js — 第二辆车（用户 Blender 模型 mp44.blend 导出）
 *
 * 双车版：第二辆车有**自己的 root / parts / state 槽**，与车0 分开摆在同一条赛道上。
 *   · 切驾驶权由 garage.js 负责，切换后 Car.state / Car.parts 指向本车；
 *     本车的 root.position/rotation.y 由 Car.sync 按自己的 state 更新。
 *   · 车身挂在自己的 body 组下 → 坡度俯仰 / 侧倾照常生效；
 *   · 轮子按模型真实轮心拆成 4 个独立轮组（前轮可转向、后轮手刹停转）。
 *   · 尾焰 / 胎痕 / 尾尘的车身局部锚点由 Car.ANCHORS[1] 提供（见 car.js）。
 *   · 数据来自 car2data.js（三角面 soup + 材质颜色，×1000 整数存储）。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var D = CR.Car2Data;
  var Car2 = CR.Car2 = {};
  Car2.ready = false;
  Car2.active = false;
  Car2.name = D ? D.name : '';
  if (!D) return;

  var badge = null, badgeT = 0;

  function meshFrom(groups, parent) {
    groups.forEach(function (g) {
      var pos = new Float32Array(g.p.length);
      for (var i = 0; i < g.p.length; i++) pos[i] = g.p[i] / 1000;
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      var lum = (g.c[0] + g.c[1] + g.c[2]) / 3;
      var dark = lum < 0.08;
      /* 深色（轮胎/底盘）：压低环境反射、拉满粗糙度，避免被黄昏暖光染成棕褐 */
      var mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(g.c[0], g.c[1], g.c[2]),
        roughness: dark ? 0.95 : 0.62, metalness: 0,
        envMapIntensity: dark ? 0.18 : 0.75,
        side: THREE.DoubleSide,     /* 原模型有单面片，双面保险 */
        flatShading: true
      });
      var mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      parent.add(mesh);
    });
  }

  function badgeEl() {
    if (badge === null) badge = document.getElementById('car-badge') || false;
    return badge;
  }
  /* 切换车型时闪一下车型名（on 为当前是否驾驶第二辆车） */
  Car2.showName = function (on) {
    Car2.active = !!on;
    var el = badgeEl();
    if (!el) return;
    el.textContent = '当前车辆  ' + (on ? D.name : CR.Car.TUNES[0].name);
    el.classList.add('on');
    clearTimeout(badgeT);
    badgeT = setTimeout(function () { el.classList.remove('on'); }, 2200);
  };

  /* 把「整根横轴」的三角面 soup 按三角形重心 x 拆成左右两个独立轮子。
     实测（模型包围盒）：前轮左右各 1532 个三角形、无跨中心三角形；后轮同理。
     拆完把顶点 x 平移到各自轮心，pivot 再放到该轮心 —— 世界位置与拆分前逐点一致，
     但前轮现在能各自绕 Y 转向，手刹也只锁后轮，不再把前轴一起锁死。 */
  var WHEEL_CX = { front: 0.846, rear: 0.846 };   /* 实测左右轮 bbox 中点 */
  function splitGroups(groups, side, cx) {
    var out = [], shift = side * cx * 1000;
    groups.forEach(function (g) {
      var p = [];
      for (var i = 0; i < g.p.length; i += 9) {
        var gx = (g.p[i] + g.p[i + 3] + g.p[i + 6]) / 3;   /* 三角形重心 x（毫米） */
        if (side > 0 ? gx <= 120 : gx >= -120) continue;    /* ±0.12m 内为跨中心，实测为 0 */
        for (var k = 0; k < 9; k += 3) {
          p.push(g.p[i + k] - shift, g.p[i + k + 1], g.p[i + k + 2]);
        }
      }
      if (p.length) out.push({ c: g.c, p: p });
    });
    return out;
  }

  /* 在 CR.Car.create(scene) 之后调用 */
  Car2.attach = function (scene) {
    var Car = CR.Car;
    if (!Car || !Car.parts || !Car.root) return Car2;

    /* 独立的 root 与 body 组：不再挂到车0 的 body 下 */
    var root2 = new THREE.Group();
    root2.name = 'MP44_Root';
    var body2 = new THREE.Group();
    body2.name = 'carBody';                /* rivals.js 克隆后按名字复位姿态 */
    root2.add(body2);
    meshFrom(D.body, body2);

    /* 尾灯：放在车尾段（模型实测 z∈[-2.229,-1.904]、宽 ±0.529）之内。
       旧版 (0.62,0.66,-1.55) 比车尾还宽、z 也不在车尾段，实际看不见；
       现在位于尾翼下方两侧，刹车时 Car.sync 把 emissiveIntensity 0.9→6。 */
    var tailMat = new THREE.MeshStandardMaterial({
      color: 0x8e1008, emissive: 0xff2410, emissiveIntensity: 0.9, roughness: 0.5
    });
    [-1, 1].forEach(function (sg) {
      var m = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.09, 0.06), tailMat);
      m.position.set(0.38 * sg, 0.58, -2.08);
      body2.add(m);
    });

    /* 四个独立轮子：前轮 front=true 跟 st.delta 转向，后轮 front=false 手刹时停转。
       滚动轴仍是局部 X，与 Car.sync 的 spin.rotation.x 完全一致。 */
    var wheels = [];
    ['front', 'rear'].forEach(function (key) {
      var w = D.wheels[key];
      if (!w) return;
      [-1, 1].forEach(function (sg) {
        var groups = splitGroups(w.groups, sg, WHEEL_CX[key]);
        var pivot = new THREE.Group();
        pivot.name = 'wheelPivot';
        pivot.position.set(sg * WHEEL_CX[key], w.center[1], w.center[2]);
        var spin = new THREE.Group(); spin.name = 'wheelSpin';
        pivot.add(spin);
        meshFrom(groups, spin);
        root2.add(pivot);
        wheels.push({ pivot: pivot, spin: spin, front: key === 'front', side: sg });
      });
    });

    scene.add(root2);
    Car.roots[1] = root2;
    Car.partsList[1] = {
      wheels: wheels, body: body2, tail: tailMat,
      paint: null, glass: null
    };

    Car2.ready = true;
    return Car2;
  };
})();
