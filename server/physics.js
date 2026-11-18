/* =========================================================================
 * server/physics.js — 在 Node 里复用客户端的 rng.js / track.js / car.js
 *
 * 关键：绝不重写物理。赛道由 track.json（客户端 Track.build() 导出的采样）喂回去，
 * 用一个最小 THREE 垫片让 T.build() 只跑「填充数组 + buildHash」这段，
 * 不碰 CatmullRomCurve3。Car.step 直接 from src/car.js。
 * ========================================================================= */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const TRACK = JSON.parse(fs.readFileSync(path.join(__dirname, 'track.json'), 'utf8'));

/* T.build() 只需要 Vector3 + CatmullRomCurve3.getLength/getSpacedPoints。
   我们把采样点直接塞回去，让 build 的产物与浏览器逐字节一致。 */
function makeThreeStub() {
  function Vector3(x, y, z) { this.x = x; this.y = y; this.z = z; }
  function CatmullRomCurve3(points) {
    this.points = points;
    this.arcLengthDivisions = 4000;
  }
  CatmullRomCurve3.prototype.getLength = function () { return TRACK.L; };
  CatmullRomCurve3.prototype.getSpacedPoints = function (n) {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const k = i % TRACK.N;
      out.push(new Vector3(TRACK.px[k], TRACK.py[k], TRACK.pz[k]));
    }
    return out;
  };
  return { Vector3, CatmullRomCurve3, SRGBColorSpace: undefined, sRGBEncoding: undefined };
}

/* 一辆车的物理沙箱。每人一份，避免 Car.state / wallLock 串车。 */
function createCarSim(carId) {
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    Math, JSON, Map, Float32Array, Uint32Array, Uint8Array, Array, Object,
    Number, String, Boolean, Date, isFinite, parseInt, parseFloat,
    performance: { now: () => Date.now() },
    setTimeout, clearTimeout
  };
  sandbox.window = sandbox;
  sandbox.THREE = makeThreeStub();
  vm.createContext(sandbox);

  for (const f of ['rng.js', 'track.js', 'car.js', 'gearbox-core.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', f), 'utf8'), sandbox,
      { filename: f });
  }
  const CR = sandbox.CR;
  CR.Track.build();

  const Car = CR.Car;
  Car.active = carId;
  Car.state = Car.states[carId];
  Car.tune = Car.TUNES[carId];

  /* 档位：与浏览器共用 src/gearbox-core.js（纯逻辑，vm 里直接可跑），
     不再手抄一份 RATIOS —— 换挡点改动只需改一处。
     氮气缩放系数与 car.js 完全一致：NITRO.VMAX / 本车 engineVmax。 */
  const gearBox = CR.GearCore.create({
    boostScale: CR.NITRO.VMAX / (Car.tune.engineVmax || 68)
  });
  CR.Gear = {
    ready: true,
    isMP44: () => carId === 1,
    spec: () => gearBox.spec(),
    up: () => gearBox.up(),
    down: (v, boost) => gearBox.down(v, boost),
    setManual: (on) => gearBox.setManual(on),
    get manual() { return gearBox.manual; },
    get gear() { return gearBox.gear; }
  };
  /* 手动换档的上报是「持续位」，服务端自己取一次边沿，避免一次按键被应用多次 */
  let lastShiftUp = false, lastShiftDown = false;

  return {
    CR, Car,
    state: Car.state,
    reset(pos) {
      const st = Car.state, T = CR.Track;
      const p = T.pointAt(pos.s, pos.lat, {});
      st.x = p.x; st.y = p.y; st.z = p.z; st.psi = Math.atan2(p.tx, p.tz);
      st.vx = st.vz = st.vf = st.vl = st.speed = 0;
      st.yawRate = st.steer = st.delta = 0;
      st.acc = st.latAcc = st.slope = 0;
      st.drifting = false;
      st.slip = 0;
      st.offroad = st.braking = false;
      st.nitro = 1; st.nitroActive = false; st.nitroArmed = true;
      st.hitAcc = 0; st.s = p.s; st.lat = pos.lat;
      st.grip = Car.TUNES[carId].gripNormal;
      gearBox.reset();
      lastShiftUp = lastShiftDown = false;
    },
    /* 自动 / 手动：由房间按玩家设置调用。切回自动时核心会清掉断油 */
    setManual(on) { return gearBox.setManual(on); },
    get manual() { return gearBox.manual; },
    step(dt, input) {
      /* 手动换档边沿：必须在物理推进前生效，断油从本 tick 开始 */
      if (gearBox.manual) {
        if (input.shiftUp && !lastShiftUp) gearBox.up();
        if (input.shiftDown && !lastShiftDown) gearBox.down(Math.abs(Car.state.vf), !!Car.state.nitroActive);
      }
      lastShiftUp = !!input.shiftUp;
      lastShiftDown = !!input.shiftDown;

      /* 与 main.js 一致：n = ceil(dt/STEP)，固定子步推进 */
      const n = Math.max(1, Math.ceil(dt / CR.CFG.STEP - 1e-6));
      const h = dt / n;
      for (let i = 0; i < n; i++) Car.step(h, input);

      /* 自动换档放在物理之后，与客户端 Gear.step 的顺序完全一致。
         手动模式核心只做断油倒计时，不会改档位。 */
      gearBox.step(dt, Car.state.vf, {
        throttle: input.throttle,
        boost: !!Car.state.nitroActive,
        handbrake: !!input.handbrake
      });
    },
    snapshot() {
      const s = Car.state;
      return {
        x: +s.x.toFixed(3), y: +s.y.toFixed(3), z: +s.z.toFixed(3),
        psi: +s.psi.toFixed(5), vf: +s.vf.toFixed(3), vl: +s.vl.toFixed(3),
        s: +s.s.toFixed(3), lat: +s.lat.toFixed(3), speed: +s.speed.toFixed(3),
        nitro: +s.nitro.toFixed(4), nitroActive: s.nitroActive ? 1 : 0,
        slip: +(s.slip || 0).toFixed(3), drifting: s.drifting ? 1 : 0,
        gear: carId === 1 ? gearBox.gear : 0
      };
    }
  };
}

module.exports = { createCarSim, TRACK };
