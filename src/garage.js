/* =========================================================================
 * garage.js — 双车车库：两辆车的独立槽位 + 切换驾驶权
 *
 * 设计要点（P0-1 + P0-2 方案 B）：
 *   · 两辆车各有自己的 state / root / parts / 圈速计时 / 调校 / 排行榜。
 *   · 每辆车有两个位置：
 *       HOME[i]  发车原点（赛道上）—— 只有「当前正在驾驶」的车在这里；
 *       PARK[i]  展示位（终点线附近的**左侧 / 环内草地侧护栏之外**）——
 *                没在开的那辆停这里；明确不放在右侧海侧。
 *     终点前这段是北直道，内侧硬限制 innerRailLimit=5.8m（护栏在 6.7m），
 *     PARK 取 +(innerRailLimit+3.7)=+9.5m：玩家被护栏/空气墙挡在 5.8m 内，
 *     （+7.8m 会被终点门左柱挡住，实测 +9.5m 展示车完整可见）；
 *     物理上够不到展示车，因此不需要车车碰撞；
 *     摆位用 Terrain.heightAt 贴真实地形，不沉海、不进雪山。
 *   · **换车 = 被切走的车移到 PARK、被切到的车回自己的 HOME 并新开一局**：
 *     速度/氮气归零、圈速计时从 0 重来、榜单切到该车并清掉「最近一圈」高亮。
 *   · 切换只换引用；camera / hud / effects / audio 每帧重读 CR.Car.state。
 *   · 非当前车不跑物理、不参与冲线判断。
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var G = CR.Garage = {};
  G.ready = false;
  G.active = 0;

  /* 发车原点：车0 发车线，车1 后退 30m 且偏左 2.2m（lat>0 为左侧/环内） */
  var GAP_S = 30, GAP_LAT = 2.2;
  /* 展示位：终点线后 8m / 11m，左侧（环内）护栏/空气墙外 3.7m */
  var PARK_S = 8, PARK_GAP = 3, PARK_MARGIN = 3.7, PARK_LIFT = 0.06;
  var homes = null, parks = null;        /* [{s, lat}, {s, lat}]，setup 时确定 */

  /* 摆车。onGround=true 时按真实地形高度落地（展示位在路肩，不是路面） */
  function put(st, pos, onGround) {
    var p = CR.Track.pointAt(pos.s, pos.lat, {});
    st.x = p.x; st.z = p.z; st.y = p.y;
    st.psi = Math.atan2(p.tx, p.tz);
    st.s = p.s; st.lat = pos.lat;
    st.slope = p.slope;
    if (onGround && CR.Terrain && CR.Terrain.heightAt) {
      st.y = CR.Terrain.heightAt(p.x, p.z, {}) + PARK_LIFT;
      st.slope = 0;
    }
    st.vx = st.vz = st.vf = st.vl = st.speed = 0;
    st.yawRate = 0; st.steer = 0; st.delta = 0;
    st.acc = 0; st.latAcc = 0;
    st.drifting = false; st.slip = 0;
    st.offroad = false; st.braking = false;
    st.nitro = 1; st.nitroActive = false; st.nitroArmed = true;
    st.engineBrake = 0;
    st.hitAcc = 0;
  }

  /* 在 Car.create + Car2.attach 之后调用（此时 Terrain.create 已完成） */
  G.setup = function (scene) {
    var Car = CR.Car, T = CR.Track;
    if (!Car || !Car.states || !Car.roots[1]) return G;

    var s0 = T.L - 14;
    var parkLat = (CR.innerRailLimit || CR.CFG.innerRailLimit) + PARK_MARGIN;
    homes = [{ s: s0, lat: 0 }, { s: s0 - GAP_S, lat: GAP_LAT }];
    parks = [{ s: PARK_S, lat: parkLat }, { s: PARK_S + PARK_GAP, lat: parkLat }];

    put(Car.states[0], homes[0]);               /* 开局驾驶车0 */
    put(Car.states[1], parks[1], true);         /* 车1 停在终点左侧护栏外的展示位 */
    Car.states[0].grip = Car.TUNES[0].gripNormal;
    Car.states[1].grip = Car.TUNES[1].gripNormal;

    /* 两辆车都常驻场景（一辆在赛道、一辆在场外），切换只换驾驶权 */
    Car.roots[0].visible = true;
    Car.roots[1].visible = true;

    if (CR.Hud && CR.Hud.resetSessions) CR.Hud.resetSessions();
    Car.setActive(0);
    if (CR.Record && CR.Record.setActive) CR.Record.setActive(0);
    G.ready = true;
    return G;
  };

  /* 只读：发车原点 / 展示位（供复位与验收使用） */
  G.home = function (i) {
    if (!homes) return null;
    var k = ((Number(i) || 0) % 2 + 2) % 2;
    return { s: homes[k].s, lat: homes[k].lat };
  };
  G.park = function (i) {
    if (!parks) return null;
    var k = ((Number(i) || 0) % 2 + 2) % 2;
    return { s: parks[k].s, lat: parks[k].lat };
  };

  /* 切换驾驶权（V / 手柄 L3 / 触屏「换车」都走这里）：
     ① 被切走的车移到自己的 PARK（终点左侧护栏外，赛道上再也碰不到）
     ② 目标车强制回自己的 HOME、清速度/氮气/撞击累积
     ③ 目标车圈速计时槽清零（新一局）
     ④ 换 state / root / parts 引用（内部还会切 Hud 槽与相机 snap）
     ⑤ 排行榜切到该车，并清掉「最近一圈」高亮（记录不再受锁限制） */
  G.setActive = function (i) {
    i = ((i % 2) + 2) % 2;
    var Car = CR.Car, prev = G.active;

    if (prev !== i && parks && Car.states[prev]) put(Car.states[prev], parks[prev], true);
    if (homes && Car.states[i]) {
      put(Car.states[i], homes[i]);
      Car.states[i].grip = Car.TUNES[i].gripNormal;
    }
    if (CR.Hud && CR.Hud.resetCar) CR.Hud.resetCar(i);

    G.active = i;
    Car.setActive(i);
    /* 换车时软件侧的「按住」状态必须清掉，否则新车会继承旧车的油门/转向 */
    if (CR.Touch && CR.Touch.releaseAll) CR.Touch.releaseAll();
    if (CR.Input && CR.Input.clearTouch) CR.Input.clearTouch();
    if (CR.Input && CR.Input.clearPad) CR.Input.clearPad();
    if (CR.Record) {
      if (CR.Record.setActive) CR.Record.setActive(i);
      if (CR.Record.newSession) CR.Record.newSession(i);
    }
    if (CR.Car2 && CR.Car2.showName) CR.Car2.showName(i === 1);
    if (CR.Gear && CR.Gear.sync) CR.Gear.sync();
    return i;
  };
  G.toggle = function () { return G.setActive(G.active ? 0 : 1); };
  G.name = function (i) { return CR.Car.TUNES[i === undefined ? G.active : i].name; };
})();
