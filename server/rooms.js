/* =========================================================================
 * server/rooms.js — 房间状态机 + 30Hz 权威 tick + 反作弊 + 结算
 * ========================================================================= */
'use strict';
const crypto = require('crypto');
const { createCarSim } = require('./physics');

const PHASE = { LOBBY: 'lobby', COUNTDOWN: 'countdown', RACING: 'racing', RESULT: 'result' };
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const SAFE = {
  throttle: v => Math.max(0, Math.min(1, Number(v) || 0)),
  brake: v => Math.max(0, Math.min(1, Number(v) || 0)),
  steer: v => Math.max(-1, Math.min(1, Number(v) || 0)),
  handbrake: v => (Number(v) || 0) > 0.5 ? 1 : 0,
  nitro: v => (Number(v) || 0) > 0.5 ? 1 : 0,
  shiftUp: v => !!v,
  shiftDown: v => !!v
};
function clampInput(raw) {
  const r = raw || {};
  /* 必须给全字段默认值：car.js 的 car step 里 Math.sign(undefined) 会产生 NaN */
  const out = {};
  for (const k of Object.keys(SAFE)) out[k] = SAFE[k](r[k]);
  return out;
}
function makeCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return s;
}
function makeToken() { return crypto.randomBytes(24).toString('hex'); }
function now() { return Date.now(); }

class Room {
  constructor(host, opts) {
    this.code = makeCode();
    this.hostId = host.id;
    this.laps = [1, 3, 5].includes(opts.laps) ? opts.laps : 3;
    this.public = !!opts.public;
    this.phase = PHASE.LOBBY;
    this.created = now();
    this.players = [];
    this.countdown = 0;
    this.raceTime = 0;
    this.tick = 0;
    this.results = null;
    this.resultAt = 0;
    this.roomDirty = false;   /* 阶段变化需要补发一次 roomInfo（tick 里统一广播） */
    this.add(host);
  }
  get racing() { return this.phase === PHASE.RACING; }
  get full() { return this.players.length >= 8; }
  add(p) {
    if (this.players.indexOf(p) >= 0) return p;
    p.room = this;
    p.lap = 0;
    p.cp = 0;
    p.lapStart = 0;
    p.best = Infinity;
    p.finished = false;
    p.finishTime = 0;
    p.rank = 0;
    p.ready = false;
    p.car = p.car === 0 ? 0 : 1;   /* 默认 MP4/4，进房后由选车界面决定 */
    p.gearManual = !!p.gearManual;
    p.sim = createCarSim(p.car);
    p.sim.setManual(p.gearManual);
    this.players.push(p);
    this.resetPlayer(p);
    /* 倒计时中有人进来：回到大厅重新等所有人选车 */
    if (this.phase === PHASE.COUNTDOWN) { this.phase = PHASE.LOBBY; this.countdown = 0; this.roomDirty = true; }
    return p;
  }
  resetPlayer(p) {
    /* 发车格：两列（±2m）+ 多排（每排后 6m），避免所有人叠在同一个点 */
    const idx = Math.max(0, this.players.indexOf(p));
    const col = idx % 2, row = Math.floor(idx / 2);
    const lat = col === 0 ? 2.0 : -2.0;
    const s = p.sim.CR.Track.L - 14 - row * 6;
    p.grid = { s: s, lat: lat };
    p.sim.reset({ s: s, lat: lat });
    p.lap = 0; p.cp = 0; p.lapStart = 0; p.finished = false;
    p.finishTime = 0; p.rank = 0; p.cheat = '';
    p.lastS = p.sim.state.s;
    p.prevS = p.sim.state.s;
    p.input = { throttle: 0, brake: 0, steer: 0, handbrake: 0, nitro: 0, shiftUp: false, shiftDown: false };
  }
  /* 选车：只在未开赛时生效，重建对应车型的权威物理沙箱 */
  setCar(p, car) {
    if (this.racing) return false;
    const id = car === 0 ? 0 : 1;
    if (p.car === id) return true;
    p.car = id;
    p.sim = createCarSim(id);
    p.sim.setManual(!!p.gearManual);   /* 重建沙箱后把变速箱模式接回去 */
    this.resetPlayer(p);
    return true;
  }
  /* 自动 / 手动变速箱：未开赛或比赛中都允许（与客户端 G 键一致） */
  setGearMode(p, manual) {
    p.gearManual = !!manual;
    if (p.sim && p.sim.setManual) p.sim.setManual(p.gearManual);
    return true;
  }
  remove(p) {
    const i = this.players.indexOf(p);
    if (i >= 0) this.players.splice(i, 1);
    if (this.hostId === p.id && this.players.length) this.hostId = this.players[0].id;
    p.room = null;
    /* 倒计时中有人走：人数/准备状态都变了，退回大厅 */
    if (this.phase === PHASE.COUNTDOWN) { this.phase = PHASE.LOBBY; this.countdown = 0; this.roomDirty = true; }
    /* 人数变了就刷新房间信息（房主「开始比赛」按钮的可用状态跟着变）；
       不再自动开赛 —— 开赛只能由房主点按钮触发。 */
    this.roomDirty = true;
  }
  /* 是否可以开赛：≥2 人、且每个人都选好车。房主按钮的可用状态与服务端校验共用。 */
  canStart() {
    if (this.phase !== PHASE.LOBBY && this.phase !== PHASE.RESULT) return false;
    const active = this.players.filter(p => p.connected);
    if (active.length < 2) return false;
    return active.every(p => p.ready);
  }
  /* 开始：只有房主能触发，且全员已选车 → 进入 5 秒倒计时 */
  start(byId) {
    if (byId != null && byId !== this.hostId) return false;
    if (!this.canStart()) return false;
    this.players.forEach(p => this.resetPlayer(p));
    this.phase = PHASE.COUNTDOWN;
    this.countdown = 5;
    this.raceTime = 0;
    this.results = null;
    this.roomDirty = true;
    return true;
  }
  /* ---- 检查点：沿用客户端 checkpoint.js 的 8 门规则 ---- */
  checkpoint(p) {
    const CR = p.sim.CR, st = p.sim.state, L = CR.Track.L;
    const C = CR.CFG, N = C.CHECK_COUNT, HALF = C.CHECK_GATE_HALF;
    const target = (p.cp + 0.5) * L / N;
    const latOK = st.lat >= C.CHECK_LAT_MIN && st.lat <= C.CHECK_LAT_MAX;
    const ring = (a, b) => { const d = Math.abs(a - b); return Math.min(d, L - d); };
    let ds = st.s - p.lastS;
    if (ds < -L * 0.5) ds += L;
    const forward = ds >= 0 && ds <= HALF * 4;
    if (latOK && forward && (ring(st.s, target) <= HALF ||
        (p.lastS <= target + HALF && st.s >= target - HALF))) p.cp++;
    p.lastS = st.s;
  }
  /* ---- 冲线 + 反作弊：检查点必须全过、圈速不得低于物理极限 ---- */
  crossLine(p) {
    if (p.finished || p.cp < p.sim.CR.CFG.CHECK_COUNT) return;
    const ms = Math.round((this.raceTime - p.lapStart) * 1000);
    const limit = p.sim.CR.CFG.LAP_LIMIT_MS[p.car] || p.sim.CR.CFG.LAP_LIMIT_MS[1];
    if (ms < limit || ms <= 0) { p.cheat = '圈速异常'; return; }
    if (p.best > ms) p.best = ms;
    p.lap++;
    p.lapStart = this.raceTime;
    p.cp = 0;
    p.lastLap = ms;
    if (p.lap >= this.laps) {
      p.finished = true;
      p.finishTime = this.raceTime;
      p.rank = this.players.filter(q => q.finished && q.finishTime < p.finishTime).length + 1;
    }
  }
  /* ---- 30Hz tick ---- */
  step(dt, broadcastEvent) {
    this.tick++;
    if (this.phase === PHASE.COUNTDOWN) {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.phase = PHASE.RACING;
        this.countdown = 0;
        this.raceTime = 0;
        this.players.forEach(p => { p.lapStart = 0; p.prevS = p.sim.state.s; p.lastS = p.sim.state.s; });
        broadcastEvent(this, { kind: 'start' });
      }
      return;
    }
    if (this.phase === PHASE.RESULT) {
      if (now() - this.resultAt > 12000) {
        this.phase = PHASE.LOBBY;
        this.results = null;
        /* 回到大厅：所有人重新选车（客户端据此重新弹选车界面） */
        this.players.forEach(p => { p.ready = false; });
        this.roomDirty = true;
      }
      return;
    }
    if (!this.racing) return;
    this.raceTime += dt;

    for (const p of this.players) {
      if (p.finished || !p.connected) continue;
      const prevS = p.sim.state.s;
      p.sim.step(dt, p.input);
      /* 位置连续性：瞬移超过物理上限（120 m/s）视为作弊 */
      const jump = Math.hypot(p.sim.state.x - (p.lastX || p.sim.state.x),
                              p.sim.state.z - (p.lastZ || p.sim.state.z));
      if (jump > 120 * dt + 2) p.cheat = '位置跳变';
      p.lastX = p.sim.state.x; p.lastZ = p.sim.state.z;

      this.checkpoint(p);
      const s = p.sim.state.s, L = p.sim.CR.Track.L;
      /* 正向冲线：上一帧在 L 尾、这一帧回到 L 头 */
      if (prevS > 0.8 * L && s < 0.2 * L) this.crossLine(p);
      p.prevS = s;
    }
    /* 全员完赛 → 结算 */
    if (this.players.length && this.players.every(p => p.finished || !p.connected)) {
      this.phase = PHASE.RESULT;
      this.resultAt = now();
      this.results = this.players.slice().sort((a, b) =>
        (a.finished ? a.finishTime : Infinity) - (b.finished ? b.finishTime : Infinity)
      ).map((p, i) => ({
        rank: i + 1, name: p.name, device: p.device,
        finished: p.finished, time: p.finished ? +p.finishTime.toFixed(3) : -1,
        best: isFinite(p.best) ? p.best : -1, lap: p.lap, cheat: p.cheat || ''
      }));
      broadcastEvent(this, { kind: 'result' });
    }
  }
  snapshot() {
    /* 实时名次：按「相对发车点的累计进度」降序。
       发车点在终点线前 14m（s≈L-14），直接比 lap*L+s 会让刚起步的车
       s 变小而排到没动的人后面，所以先换算成从发车点前进的距离。 */
    const L = this.players.length ? this.players[0].sim.CR.Track.L : 1;
    const startS = L - 14;
    const progress = q => {
      let d = q.sim.state.s - startS;
      if (d < 0) d += L;
      return q.lap * L + d;
    };
    const order = this.players.slice().sort((a, b) => {
      const pa = a.finished ? -1 : progress(a);
      const pb = b.finished ? -1 : progress(b);
      return pb - pa;
    });
    const rankOf = new Map();
    order.forEach((q, i) => rankOf.set(q, i + 1));
    return {
      t: 'snapshot',
      /* 发送时刻（服务端毫秒）。客户端用它做插值时间轴 —— 用本地接收时间的话，
         主线程卡一下会让几个快照的时间戳挤在同一刻，插值退化成一帧瞬移。 */
      st: Date.now(),
      phase: this.phase,
      countdown: +Math.max(0, this.countdown).toFixed(2),
      raceTime: +this.raceTime.toFixed(3),
      laps: this.laps,
      tick: this.tick,
      players: this.players.map(p => {
        const s = p.sim.snapshot();
        s.id = p.id;
        s.name = p.name;
        s.car = p.car;
        s.connected = p.connected;
        s.ready = p.ready;
        s.lap = p.lap;
        s.cp = p.cp;
        s.lapTime = +(this.raceTime - p.lapStart).toFixed(3);
        s.best = isFinite(p.best) ? p.best : -1;
        s.lastLap = p.lastLap || 0;
        s.finished = p.finished;
        s.rank = p.finished ? p.rank : (rankOf.get(p) || 0);
        s.cheat = p.cheat || '';
        return s;
      })
    };
  }
  roomInfo() {
    return {
      t: 'room',
      code: this.code,
      host: this.hostId,
      canStart: this.canStart(),
      phase: this.phase,
      countdown: +Math.max(0, this.countdown).toFixed(2),
      laps: this.laps,
      public: this.public,
      players: this.players.map(p => ({
        id: p.id, name: p.name, car: p.car, ready: p.ready,
        connected: p.connected, finished: p.finished, lap: p.lap
      }))
    };
  }
}

class RoomManager {
  constructor() {
    this.rooms = new Map();
    this.players = new Map();
  }
  create(host, opts) {
    const r = new Room(host, opts || {});
    this.rooms.set(r.code, r);
    return r;
  }
  join(code, p) {
    const r = this.rooms.get(String(code || '').toUpperCase());
    if (!r) return { err: '房间不存在' };
    if (r.full) return { err: '房间已满' };
    if (r.racing) return { err: '比赛已开始' };
    r.add(p);
    return { room: r };
  }
  find(p) { return p && p.room; }
  cleanup() {
    for (const [code, r] of this.rooms) {
      if (!r.players.length || (r.phase !== PHASE.RACING && now() - r.created > 30 * 60 * 1000)) {
        this.rooms.delete(code);
      }
    }
  }
}

module.exports = { RoomManager, PHASE, clampInput, makeToken };
