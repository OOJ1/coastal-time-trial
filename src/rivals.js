/* =========================================================================
 * rivals.js — 联机对手车（只渲染，不跑物理、不参与碰撞）
 *   外观复用 car2data.js 的 MP4/4 三角面；每人一个 instance，
 *   位置/朝向由 Net.sample() 的 100ms 插值快照驱动。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var R = CR.Rivals = {};
  var scene = null, pool = [], byId = new Map();
  var TINT = [0x4aa3ff, 0xff6b6b, 0x62d59a, 0xf5c542, 0xc07bff, 0x5ce1e6, 0xff9f43];
  var MAX_RIVALS = 7;                  /* 池上限，超出就抢占最老的一个 */

  /* ---- 头顶名字标签：DOM 叠层，按相机投影每帧定位 ---- */
  var tagLayer = null, tags = new Map();
  var _v = new THREE.Vector3(), _dir = new THREE.Vector3(), _fwd = new THREE.Vector3();

  function ensureLayer() {
    if (tagLayer) return;
    tagLayer = document.createElement('div');
    tagLayer.id = 'rival-tags';
    document.body.appendChild(tagLayer);
  }
  function tagFor(id, name, isSelf) {
    ensureLayer();
    var t = tags.get(id);
    if (!t) {
      t = document.createElement('div');
      t.className = 'rival-tag' + (isSelf ? ' me' : '');
      t.innerHTML = '<i></i><b></b>';
      tagLayer.appendChild(t);
      tags.set(id, t);
    }
    t.className = 'rival-tag' + (isSelf ? ' me' : '');
    var txt = name + (isSelf ? ' · 你' : '');
    var b = t.querySelector('b');
    if (b.textContent !== txt) b.textContent = txt;
    return t;
  }
  function placeTag(t, x, y, z) {
    var cam = CR.camera;
    if (!cam) { t.style.display = 'none'; return; }
    _dir.set(x - cam.position.x, y - cam.position.y, z - cam.position.z);
    var dist = _dir.length();
    if (dist > 260) { t.style.display = 'none'; return; }
    _fwd.set(0, 0, -1).applyQuaternion(cam.quaternion);
    if (_dir.dot(_fwd) <= 0) { t.style.display = 'none'; return; }
    _v.set(x, y, z).project(cam);
    if (_v.z >= 1) { t.style.display = 'none'; return; }
    var sx = (_v.x * 0.5 + 0.5) * window.innerWidth;
    var sy = (-_v.y * 0.5 + 0.5) * window.innerHeight;
    t.style.transform = 'translate(-50%,-100%) translate(' + sx.toFixed(1) + 'px,' + sy.toFixed(1) + 'px)';
    t.style.opacity = dist > 140 ? '0.35' : (dist > 70 ? '0.62' : '1');
    t.style.display = '';
  }

  function meshFrom(groups, parent, tint) {
    groups.forEach(function (g) {
      var pos = new Float32Array(g.p.length);
      for (var i = 0; i < g.p.length; i++) pos[i] = g.p[i] / 1000;
      var geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.computeVertexNormals();
      var lum = (g.c[0] + g.c[1] + g.c[2]) / 3;
      var dark = lum < 0.08;
      var col = new THREE.Color(g.c[0], g.c[1], g.c[2]);
      /* 白车身染队伍色，深色部件（轮胎/底盘）保持原样 */
      if (!dark && g.c[0] > 0.75 && g.c[1] > 0.75 && g.c[2] > 0.75) col.setHex(tint);
      var mat = new THREE.MeshStandardMaterial({
        color: col, roughness: dark ? 0.95 : 0.62, metalness: 0,
        envMapIntensity: dark ? 0.18 : 0.75,
        side: THREE.DoubleSide, flatShading: true
      });
      var mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = false;      /* 对手车不投影，避免 30Hz 阴影拖累 */
      mesh.receiveShadow = false;
      parent.add(mesh);
    });
  }

  /* 克隆体是从「本车当前帧」完整复制的：body 的坡度俯仰 / 加速点头 / 过弯侧倾、
     前轮 pivot 的方向盘角（最多 0.8rad ≈ 46°）、轮胎 spin 的滚动角，全都跟着过来。
     而 R.update 只写 position 与 rotation.y，这些值之后永不更新 —— 对手车就会
     永久歪着车身、前轮永久打死，克隆时本车若在坡上还会插进地面。
     克隆完成后统一复位，并顺手收集轮子用于滚动动画。 */
  function resetPose(root) {
    var wheels = [], body = null;
    root.traverse(function (o) {
      var n = o.name;
      if (n === 'carBody') { o.rotation.set(0, 0, 0); body = o; }
      else if (n === 'wheelPivot') o.rotation.y = 0;
      else if (n === 'wheelSpin') { o.rotation.x = 0; wheels.push(o); }
    });
    return { wheels: wheels, body: body };
  }

  /* 从场景摘掉一辆（不 dispose 几何体：clone 与本车共享 geometry，
     dispose 会把本车也一起弄坏） */
  function killOne(item) {
    if (!item) return;
    if (item.root && item.root.parent) item.root.parent.remove(item.root);
    item.busy = false; item.id = 0;
  }

  function makeOne(tint, carId) {
    var src = CR.Car && CR.Car.roots && CR.Car.roots[carId === 0 ? 0 : 1];
    var root;
    if (src) {
      root = src.clone(true);
      root.traverse(function (o) {
        if (!o.isMesh || !o.material) return;
        var mats = Array.isArray(o.material) ? o.material : [o.material];
        var out = [];
        for (var k = 0; k < mats.length; k++) {
          var m = mats[k].clone();
          if (m.color && m.color.r > 0.42 && m.color.g > 0.42 && m.color.b > 0.42) m.color.setHex(tint);
          if (m.emissive) m.emissiveIntensity = 0;
          out.push(m);
        }
        o.material = Array.isArray(o.material) ? out : out[0];
        o.castShadow = false; o.receiveShadow = false;
      });
    } else {
      root = new THREE.Group();
    }
    var pose = src ? resetPose(root) : { wheels: [], body: null };
    var tl = new THREE.MeshStandardMaterial({ color: 0x8e1008, emissive: 0xff2410, emissiveIntensity: 1.2 });
    if (src) {
      /* 克隆体自带尾灯 mesh，但材质已独立克隆；这里另加两片可控尾灯，避免改错部件 */
      [-0.38, 0.38].forEach(function (x) {
        var m = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.08, 0.05), tl);
        m.position.set(x, 0.58, -2.12);
        root.add(m);
      });
    }
    var D = CR.Car2Data;
    if (!src && D && D.body) meshFrom(D.body, root, tint);
    /* 兜底：root 不可用时给一个简化外形 */
    if (!src) {
    var wg = new THREE.CylinderGeometry(CR.CFG.WHEEL_R, CR.CFG.WHEEL_R, 0.26, 12);
    wg.rotateZ(Math.PI / 2);
    var wm = new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.95 });
    [[-0.86, 1.35], [0.86, 1.35], [-0.86, -1.30], [0.86, -1.30]].forEach(function (w) {
      var m = new THREE.Mesh(wg, wm);
      m.position.set(w[0], CR.CFG.WHEEL_R, w[1]);
      root.add(m);
    });
    /* 尾灯：让远处也能看出车头车尾 */
    [-0.38, 0.38].forEach(function (x) {
      var m = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.09, 0.06), tl);
      m.position.set(x, 0.58, -2.08);
      root.add(m);
    });
    }
    root.visible = false;
    scene.add(root);
    return { root: root, tail: tl, car: carId, wheels: pose.wheels, body: pose.body };
  }

  R.create = function (sc) {
    /* 重新初始化（重开一局 / 退房再进）时必须把上一轮的模型从场景摘掉：
       旧 root 仍 visible=true 且已不在 byId 里，会变成永远擦不掉的「幽灵车」。 */
    for (var i = 0; i < pool.length; i++) killOne(pool[i]);
    tags.forEach(function (t) { if (t.parentNode) t.parentNode.removeChild(t); });
    tags.clear();
    pool = []; byId.clear();
    scene = sc;
    ensureLayer();
    return R;
  };

  var _s = {}, _nr = {};
  R.update = function (dt) {
    if (!scene || !CR.Net || !CR.Net.online) { R.hideAll(); return; }
    var list = CR.Net.opponents();
    var seen = new Set();
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      var want = p.car === 0 ? 0 : 1;
      var item = byId.get(p.id);
      /* 同一个玩家中途换车：byId 已命中，旧逻辑只在「新建 item」时才比对车型，
         结果其他客户端会一直挂着换车前的模型。这里就地重建并替换池中的元素。 */
      if (item && item.car !== want) {
        var oldAt = pool.indexOf(item);
        killOne(item);
        var rebuilt = makeOne(TINT[(oldAt >= 0 ? oldAt : 0) % TINT.length], want);
        if (oldAt >= 0) pool[oldAt] = rebuilt; else pool.push(rebuilt);
        item = rebuilt;
        item.busy = true; item.id = p.id;
        byId.set(p.id, item);
      }
      if (!item) {
        var free = pool.find(function (o) { return !o.busy && o.car === want; });
        if (!free) free = pool.find(function (o) { return !o.busy; });
        if (!free) {
          if (pool.length < MAX_RIVALS) {
            free = makeOne(TINT[pool.length % TINT.length], want);
            pool.push(free);
          } else {
            /* 池满且全部在用：抢占最老的一辆。这里必须「替换数组元素」而不是
               push —— 旧实现 push 之后旧对象仍留在 pool 里且已被移出场景，
               下一轮 find 命中它就会拿到一个不在场景中的 root：
               结果是对手车不显示，但头顶名字标签还在（标签是独立 DOM 层）。 */
            free = pool[0];
            if (free.busy && free.id) byId.delete(free.id);
            if (window.console && console.warn) {
              console.warn('[Rivals] 池已满（' + MAX_RIVALS + '），抢占 id=' + free.id + ' 给 ' + p.id);
            }
          }
        }
        if (free.car !== want) {
          /* 车型不同就地重建，避免同一辆对手换车后还挂着旧车型 */
          var at = pool.indexOf(free);
          killOne(free);
          var made = makeOne(TINT[(at >= 0 ? at : 0) % TINT.length], want);
          if (at >= 0) pool[at] = made; else pool.push(made);
          free = made;
        }
        free.car = want;
        free.busy = true; free.id = p.id;
        item = free;
        byId.set(p.id, item);
      }
      seen.add(p.id);
      if (!CR.Net.sample(p.id, _s)) continue;
      /* 快照里偶尔会带 NaN（服务端刚重置 / 掉包）：写进矩阵会让整辆车消失或闪一帧 */
      if (!isFinite(_s.x) || !isFinite(_s.y) || !isFinite(_s.z) || !isFinite(_s.psi)) {
        item.root.visible = false;
        continue;
      }
      item.root.visible = true;
      item.root.position.set(_s.x, _s.y, _s.z);
      item.root.rotation.y = _s.psi;
      /* 贴合坡面：姿态归零后车是水平的，坡道上会一角插进地面。
         用赛道采样补一个俯仰角（只取 slope，不做侧倾，避免又变成「歪车」）。 */
      item.nrT = (item.nrT || 0) - dt;
      if (item.body && item.nrT <= 0) {
        /* 20Hz 足够：坡度变化很慢。每辆车保留自己的 hint（nearest 的快速路径
           依赖上一次的位置），否则多车共用 hint 会互相打断、退化成全量搜索。 */
        item.nrT = 0.05;
        var hnr = item.nr || (item.nr = {});
        var nr = CR.Track.nearest(_s.x, _s.z, hnr);
        if (nr && isFinite(nr.slope)) item.body.rotation.x = -Math.atan(nr.slope);
      }
      /* 轮胎滚动：纯视觉，速度取快照纵向速度，系数与本车 Car.sync 一致 */
      if (item.wheels && item.wheels.length) {
        var roll = (_s.vf || 0) * (CR.CFG.wheelSpin || 0.012) * Math.min(dt, 0.05);
        for (var wi = 0; wi < item.wheels.length; wi++) item.wheels[wi].rotation.x += roll;
      }
      /* 倒车 / 撞墙被弹回时尾灯常亮：这类「看着在反着走」的情况，朝向数据其实是对的
         （diag 里位移方向与车头方向的 dot 恒为 1），亮尾灯能让它一眼看出是在倒车，
         而不是同步出错。 */
      if (item.tail) {
        var back = (_s.vf || 0) < -1.5;
        item.tail.emissiveIntensity = back ? 5.0
          : (_s.nitroActive ? 3.2 : ((_s.speed > 20 && Math.random() < 0.1) ? 2.2 : 1.2));
      }
      var snap = CR.Net.snapshot;
      if (snap && (snap.phase === 'racing' || snap.phase === 'countdown')) {
        var tg = tagFor(p.id, p.name || ('玩家 ' + p.id), false);
        placeTag(tg, _s.x, _s.y + 2.25, _s.z);
        seen.add('tag' + p.id);
      }
    }
    /* 自己的名字标签（金色，标「你」） */
    var snap2 = CR.Net.snapshot;
    if (snap2 && (snap2.phase === 'racing' || snap2.phase === 'countdown')) {
      var meP = CR.Net.me();
      var st = CR.Car && CR.Car.state;
      if (meP && st) {
        var tg2 = tagFor(CR.Net.id, meP.name || '我', true);
        placeTag(tg2, st.x, st.y + 2.25, st.z);
        seen.add('tag' + CR.Net.id);
      }
    }
    /* 回收离场玩家 */
    byId.forEach(function (item, id) {
      if (!seen.has(id)) {
        item.busy = false; item.root.visible = false; item.id = 0;
        byId.delete(id);
      }
    });
  };
  R.hideAll = function () {
    for (var i = 0; i < pool.length; i++) { pool[i].root.visible = false; pool[i].busy = false; }
    byId.clear();
    tags.forEach(function (t) { t.style.display = 'none'; });
  };
  /* 世界空间车头向量：模型局部 +Z 为车头（见 car.js 锚点注释），
     乘上 root 的世界四元数就是它在世界里的朝向。用来客观验证「对手车反向」。 */
  var _q = new THREE.Quaternion(), _n = new THREE.Vector3();
  function noseOf(obj) {
    if (!obj) return null;
    obj.updateWorldMatrix(true, false);
    obj.getWorldQuaternion(_q);
    _n.set(0, 0, 1).applyQuaternion(_q);
    return { x: _n.x, z: _n.z };
  }
  R.diag = function () {
    var mine = noseOf(CR.Car && CR.Car.root);
    var items = [];
    byId.forEach(function (item, id) {
      var kids = [];
      item.root.children.forEach(function (c) {
        kids.push({ t: c.type, n: c.name || '', ry: +c.rotation.y.toFixed(3), rx: +c.rotation.x.toFixed(3), rz: +c.rotation.z.toFixed(3) });
      });
      var nose = noseOf(item.root);
      items.push({
        id: id,
        car: item.car,   /* 诊断：换车后各端车型是否一致 */
        kids: kids,
        rotY: +item.root.rotation.y.toFixed(3),
        x: +item.root.position.x.toFixed(2),
        z: +item.root.position.z.toFixed(2),
        nose: nose ? { x: +nose.x.toFixed(3), z: +nose.z.toFixed(3) } : null,
        dotMine: (nose && mine) ? +(nose.x * mine.x + nose.z * mine.z).toFixed(3) : null,
        visible: !!item.root.visible,
        tag: tags.has(id) ? tags.get(id).textContent : ''
      });
    });
    return {
      pool: pool.length, active: byId.size, items: items,
      mine: mine ? { x: +mine.x.toFixed(3), z: +mine.z.toFixed(3),
                     psi: +(CR.Car && CR.Car.state ? CR.Car.state.psi : 0).toFixed(3) } : null
    };
  };
})();
