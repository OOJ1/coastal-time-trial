/* =========================================================================
 * net.js — 联机客户端（经典 script，原生 WebSocket）
 *   · 大厅/房间/准备/开始/结算的消息协议
 *   · 30Hz 输入上行（带序号）+ 15Hz 快照下行 + 100ms 插值缓冲
 *   · 本地玩家用服务端快照校正；对手车只按快照插值，不跑物理
 *   · 断线自动重连（保留座位与进度），失败 3 次退回单机
 * ========================================================================= */
(function () {
  'use strict';
  var CR = window.CR;
  var N = CR.Net = {};

  N.enabled = false;
  N.initialized = false;
  N.online = false;
  N.state = 'offline';          /* offline / connecting / lobby / room / racing / result */
  N.id = 0;
  N.code = '';
  N.players = [];
  N.snapshot = null;
  N.result = null;
  N.rank = 0;
  N.gap = 0;
  N.lastError = '';

  var ws = null, token = '', device = '', nickname = '';
  var seq = 0, inputTimer = 0, retry = 0, reconnectTimer = null;
  /* 开赛 / 重连后的第一次快照：把本地车硬对齐到服务端发车状态。
     不做这一步的话，本地车还停在单机出生点，与服务端发车格横向差 2m，
     correct() 只能一点点拽，起步就会「车头掰不动」。 */
  var forceSync = false;
  var snapshots = [], SNAP_DELAY = 0.1;
  /* 插值时间轴用「服务端时间」，不是本地接收时间：
     · srvOff = performance.now() - Date.now()，取历史最小值（最快到达的那条最接近真实钟差），
       之后缓慢跟随以抵抗时钟漂移；
     · jitterMs 是到达间隔相对 15Hz 的平均偏差，缓冲按抖动自动放大，避免断流后一帧跳过去。 */
  var SNAP_GAP = 1000 / 15;
  var srvOff = null, jitterMs = 0, lastArriveMs = 0;
  /* 插值时间轴限速：主线程卡一下（GC / 重绘）后 performance.now 会跳 100ms+，
     target 一步跳过去 = 对手车瞬移。这里让它每帧最多比真实时间快 35% 地追赶。 */
  var lastTarget = null, lastSampMs = 0, sampDt = 0.016;
  var serverUrl = '';
  var handlers = {};
  /* 大厅按钮在握手完成前就可能点击：先排队，welcome 后再发。
     旧实现固定等 200ms，真实浏览器握手稍慢就静默丢消息，表现为「按钮没反应」。 */
  var pendingActions = [];
  var connectTimer = null;

  /* 从地址推导服务端：
     · 生产（https 或 80/443 端口）：同源 wss://域名<页面目录>ws，
       支持部署在子路径（如 https://www.ooj1.cn/race/ → wss://www.ooj1.cn/race/ws）；
     · 本地开发（静态服务在 8000 等端口）：仍连当前主机的 8787；
     · file:// 直开：连 127.0.0.1:8787；
     · 也可用 ?net=ws://host:port 显式指定。 */
  function pickUrlFor(loc) {
    var proto = loc.protocol || 'http:';
    if (proto === 'file:') return 'ws://127.0.0.1:8787';
    var host = loc.host || loc.hostname || '127.0.0.1';
    var secure = proto === 'https:' || loc.port === '443';
    if (secure || !loc.port || loc.port === '80') {
      var dir = (loc.pathname || '/').replace(/[^/]*$/, '');
      return (secure ? 'wss://' : 'ws://') + host + dir + 'ws';
    }
    return 'ws://' + (loc.hostname || '127.0.0.1') + ':8787';
  }
  function pickUrl() {
    var m = /[?&]net=([^&]+)/.exec(window.location.search || '');
    if (m) return decodeURIComponent(m[1]);
    return pickUrlFor(window.location);
  }
  N._pickUrlFor = pickUrlFor;   /* 调试/单测用 */
  function storage(k, v) {
    try {
      if (v === undefined) return window.localStorage.getItem(k);
      window.localStorage.setItem(k, v);
    } catch (e) {}
    return null;
  }
  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }
  function emit(kind, data) {
    var list = handlers[kind] || [];
    for (var i = 0; i < list.length; i++) list[i](data);
  }
  N.on = function (kind, fn) {
    (handlers[kind] || (handlers[kind] = [])).push(fn);
    return N;
  };

  function connect() {
    /* 已在线或正在连接：直接复用，避免新建 socket 让旧 onclose 误触发离房 */
    if (N.online || (ws && ws.readyState === WebSocket.CONNECTING)) return;
    N.state = 'connecting';
    N.lastError = '';
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    emit('state', N.state);
    try { ws = new WebSocket(serverUrl); }
    catch (e) { fail('无法创建连接'); return; }
    /* 8 秒还没握手成功就明确报错，不再让用户对着没反应的按钮干等 */
    connectTimer = setTimeout(function () {
      connectTimer = null;
      if (!N.online) fail('连接超时：请确认服务端已启动（node server/server.js）');
    }, 8000);
    ws.onopen = function () {
      retry = 0;
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      send({ t: 'hello', protocol: 1, version: CR.VERSION, device: device, nickname: nickname });
    };
    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      switch (m.t) {
        case 'welcome':
          N.id = m.id; token = m.token;
          lastTarget = null; lastSampMs = 0; srvOff = null; jitterMs = 0; lastArriveMs = 0;
          N.online = true; N.enabled = true;
          if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
          emit('welcome', m);
          /* 握手完成后执行大厅里排队的创建/加入 */
          var acts = pendingActions; pendingActions = [];
          for (var ai = 0; ai < acts.length; ai++) {
            try { acts[ai](); } catch (e) { if (window.console) console.warn('[Net] 排队操作失败', e); }
          }
          break;
        case 'reject': fail(m.reason || '服务端拒绝'); break;
        case 'error': N.lastError = m.reason || ''; emit('error', m.reason); break;
        case 'room':
          N.code = m.code; N.players = m.players;
          /* 服务端权威：换车被拒/补发时，把本地记录的车型拉回来 */
          for (var ri = 0; ri < m.players.length; ri++) {
            if (m.players[ri].id === N.id) { N.car = m.players[ri].car; break; }
          }
          N.state = 'room';
          emit('room', m);
          break;
        case 'snapshot':
          N.snapshot = m;
          var arrived = performance.now();
          var srvMs = Number(m.st) || 0;
          if (srvMs > 0) {
            var off = arrived - srvMs;
            if (srvOff === null) { srvOff = off; snapshots.length = 0; }
            else {
              /* 钟差只允许「限速跟随」：直接把 srvOff 赋成更小的 off，等于把时间轴
                 往前猛拽一下，对手车就会瞬移一大段。单次最多修 15ms，
                 变快方向再保守一些（0.08 vs 0.02），让它慢慢收敛。 */
              var dOff = off - srvOff;
              var step = Math.max(-15, Math.min(15, dOff * (dOff > 0 ? 0.02 : 0.08)));
              srvOff += step;
            }
            if (lastArriveMs) {
              var dev = Math.abs((arrived - lastArriveMs) - SNAP_GAP);
              jitterMs += (dev - jitterMs) * 0.15;
            }
            lastArriveMs = arrived;
          }
          snapshots.push({ t: srvMs > 0 ? srvMs : arrived, data: m });
          if (snapshots.length > 20) snapshots.shift();
          N.players = m.players;
          /* 开赛或中途重连：以服务端 phase 为准切状态 */
          if (m.phase === 'racing' && N.state !== 'racing') {
            N.state = 'racing'; forceSync = true; emit('state', N.state);
          }
          var me = m.players.find(function (p) { return p.id === N.id; });
          if (me) { N.rank = me.rank || 0; N.gap = me.gap || 0; }
          emit('snapshot', m);
          break;
        case 'event':
          if (m.kind === 'start' && N.state !== 'racing') {
            N.state = 'racing'; forceSync = true; emit('state', N.state);
          }
          emit('event', m); break;
        case 'result': N.result = m; N.state = 'result'; emit('result', m); break;
        case 'pong': break;
      }
    };
    ws.onclose = function () {
      N.online = false;
      emit('disconnect');
      if (N.state === 'room' || N.state === 'racing' || N.state === 'result') {
        scheduleReconnect();
      } else {
        N.state = 'offline'; emit('state', N.state);
      }
    };
    ws.onerror = function () { /* onclose 会处理，这里不重复弹错 */ };
  }
  function scheduleReconnect() {
    if (reconnectTimer) return;
    var delay = Math.min(1000 * (retry + 1), 5000);
    retry++;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      if (retry > 3) { fail('重连失败，已退回单机'); return; }
      N.state = 'connecting'; emit('state', N.state);
      connect();
      setTimeout(function () {
        if (N.online && N.code) send({ t: 'reconnect', code: N.code, token: token, device: device });
      }, 250);
    }, delay);
  }
  function fail(reason) {
    N.lastError = reason || '';
    N.online = false; N.enabled = false; N.state = 'offline';
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    pendingActions = [];
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    emit('error', reason); emit('state', N.state);
  }

  /* 连接就绪后执行；已在线则立即执行 */
  N.whenReady = function (fn) {
    if (typeof fn !== 'function') return N;
    if (N.online) fn();
    else { pendingActions.push(fn); N.connect(); }
    return N;
  };

  N.init = function () {
    serverUrl = pickUrl();
    device = storage('ooji-device-id') || '';
    if (!device) {
      device = (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
        : 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2);
      storage('ooji-device-id', device);
    }
    nickname = storage('ooji-game-nickname') || '';
    N.initialized = true;
    return N;
  };

  N.connect = function () { if (!N.initialized) N.init(); connect(); return N; };
  N.disconnect = function () {
    if (ws) { try { ws.send(JSON.stringify({ t: 'leave' })); } catch (e) {} }
    fail('');
    return N;
  };
  N.setName = function (name) {
    nickname = String(name || '').slice(0, 12);
    storage('ooji-game-nickname', nickname);
    return nickname;
  };
  N.name = function () { return nickname; };
  N.device = function () { return device; };

  N.create = function (opts) { send(Object.assign({ t: 'create' }, opts || {})); return N; };
  N.join = function (code) { send({ t: 'join', code: code }); return N; };
  /* 选车结果：本地已切好模型，这里把车型 + 变速箱模式同步给服务端 */
  N.selectCar = function (car) {
    /* 比赛中换车会被服务端拒绝（setCar 里 if (racing) return false），
       这里提前挡住，别让 N.car 和本地模型先跑偏 */
    if (N.state === 'racing') { emit('error', '比赛进行中不能换车'); return N; }
    N.car = car === 0 ? 0 : 1;
    send({ t: 'car', car: N.car, manual: !!(CR.Gear && CR.Gear.manual) });
    return N;
  };
  /* 自动 / 手动切换：服务端按同一份换挡核心推进，模式必须一致 */
  N.syncGear = function () {
    send({ t: 'gear', manual: !!(CR.Gear && CR.Gear.manual) });
    return N;
  };
  N.ready = function (on) { send({ t: 'ready', ready: !!on }); return N; };
  N.start = function () { send({ t: 'start' }); return N; };
  N.leave = function () { send({ t: 'leave' }); N.state = 'lobby'; return N; };

  /* 主循环每帧调用：按 30Hz 上行输入；附带手动换档沿 */
  N.feedInput = function (dt, input, gearUp, gearDown) {
    if (!N.online || N.state !== 'racing') return;
    inputTimer += dt;
    if (inputTimer < 1 / 30) return;
    inputTimer -= 1 / 30;
    seq++;
    send({
      t: 'input', seq: seq,
      throttle: input.throttle, brake: input.brake, steer: input.steer,
      handbrake: input.handbrake, nitro: input.nitro,
      shiftUp: !!gearUp, shiftDown: !!gearDown
    });
  };

  /* 本地玩家：用最新权威快照校正位置；偏差小则平滑跟上，大则直接吸附 */
  N.correct = function (st, dt) {
    if (!N.online || !N.snapshot || N.state !== 'racing') return false;
    var me = null;
    for (var i = 0; i < N.snapshot.players.length; i++) {
      if (N.snapshot.players[i].id === N.id) { me = N.snapshot.players[i]; break; }
    }
    if (!me || me.finished) return false;
    /* 开赛/重连第一帧：无条件对齐（含朝向与速度），之后才走平滑校正 */
    if (forceSync) {
      forceSync = false;
      st.x = me.x; st.y = me.y; st.z = me.z;
      st.psi = me.psi; st.yawRate = 0;
      st.vf = me.vf; st.vl = me.vl; st.nitro = me.nitro;
      st.s = me.s; st.lat = me.lat; st.speed = me.speed;
      st.delta = 0; st.steer = 0;
      st.vx = Math.sin(st.psi) * st.vf; st.vz = Math.cos(st.psi) * st.vf;
      return true;
    }
    var dx = me.x - st.x, dz = me.z - st.z;
    var d = Math.hypot(dx, dz);
    /* 吸附阈值随速度放大：4m 固定阈值在高速下会每帧把车拽回服务端，
       表现为「方向盘被锁住」。8m + 0.35×速度 ≈ 高速允许 0.35s 的偏差。 */
    var snapAt = 8 + Math.abs(st.vf) * 0.35;
    if (d > snapAt) {
      st.x = me.x; st.y = me.y; st.z = me.z;
      st.vf = me.vf; st.vl = me.vl; st.nitro = me.nitro;
      st.s = me.s; st.lat = me.lat; st.speed = me.speed;
      /* 朝向：只有差得离谱（跑飞 / 传送 / 调头）才硬切，正常驾驶保留本地转向手感 */
      var ae = CR.angDiff(st.psi, me.psi);
      if (Math.abs(ae) > 2.0) { st.psi = me.psi; st.yawRate = 0; }
      st.vx = Math.sin(st.psi) * st.vf; st.vz = Math.cos(st.psi) * st.vf;
      return true;
    }
    var k = 1 - Math.exp(-dt * 8);
    st.x += dx * k; st.y += (me.y - st.y) * k; st.z += dz * k;
    var ds = me.s - st.s, L = CR.Track.L;
    if (ds > L * 0.5) ds -= L; else if (ds < -L * 0.5) ds += L;
    st.s = (st.s + ds * k + L) % L;
    st.lat += (me.lat - st.lat) * k;
    st.nitro += (me.nitro - st.nitro) * k;
    /* 朝向只做很轻的慢修正：不再跟玩家抢方向盘 */
    var ae2 = CR.angDiff(st.psi, me.psi);
    if (Math.abs(ae2) < 2.0) st.psi += ae2 * Math.min(1, dt * 1.2);
    return false;
  };

  /* 对手车：100ms 前的快照 → 当前时刻插值 */
  N.sample = function (id, out) {
    if (!snapshots.length) return null;
    var nowMs = performance.now();
    /* 缓冲 = 基础 100ms + 抖动补偿（最多再 +90ms）：抖动大时多留一帧，
       宁可多 100ms 延迟也不要「停顿→跳」。 */
    var delayMs = (SNAP_DELAY + Math.min(0.09, jitterMs * 1.2 / 1000)) * 1000;
    var target = (srvOff !== null ? nowMs - srvOff : nowMs) - delayMs;
    /* 逐帧推进限速（同一帧多次调用只算一次 dt） */
    var gap = nowMs - lastSampMs;
    if (gap > 0.5) {
      var g = gap / 1000;
      /* 只让「正常帧」参与帧时长估计：卡顿那一帧的 120ms 不能算进来，
         否则限速步长跟着变大，限速等于没限。 */
      if (g < 0.08) sampDt += (g - sampDt) * 0.15;
      lastSampMs = nowMs;
    }
    if (lastTarget !== null) {
      var maxAdv = sampDt * 1.35 * 1000;
      if (target > lastTarget + maxAdv) target = lastTarget + maxAdv;
      if (target < lastTarget) target = lastTarget;      /* 时间轴不倒退 */
      /* 落后太多（断流很久）就别慢慢追了，直接重新缓冲到最新 */
      var newest = snapshots[snapshots.length - 1].t;
      if (target < newest - 1000) target = newest - delayMs;
    }
    lastTarget = target;
    var a = snapshots[0], b = snapshots[snapshots.length - 1];
    for (var i = 1; i < snapshots.length; i++) {
      if (snapshots[i].t >= target) { a = snapshots[i - 1]; b = snapshots[i]; break; }
      a = snapshots[i];
    }
    function find(snap) {
      for (var j = 0; j < snap.data.players.length; j++) {
        if (snap.data.players[j].id === id) return snap.data.players[j];
      }
      return null;
    }
    var pa = find(a), pb = find(b);
    if (!pa && !pb) return null;
    if (!pa) pa = pb; if (!pb) pb = pa;
    var span = b.t - a.t, u = span > 0 ? Math.max(0, Math.min(1, (target - a.t) / span)) : 1;
    out.x = pa.x + (pb.x - pa.x) * u;
    out.y = pa.y + (pb.y - pa.y) * u;
    out.z = pa.z + (pb.z - pa.z) * u;
    out.psi = pa.psi + CR.angDiff(pa.psi, pb.psi) * u;
    out.vf = pa.vf + (pb.vf - pa.vf) * u;
    out.speed = pa.speed + (pb.speed - pa.speed) * u;
    out.nitroActive = pb.nitroActive;
    out.slip = pa.slip + (pb.slip - pa.slip) * u;
    out.lap = pb.lap; out.name = pb.name; out.finished = pb.finished;
    return out;
  };

  /* 同步质量诊断：缓冲时长 / 抖动 / 钟差，用于验收「卡顿瞬移」 */
  N.netDiag = function () {
    return {
      snaps: snapshots.length,
      bufferMs: Math.round((SNAP_DELAY + Math.min(0.09, jitterMs * 1.2 / 1000)) * 1000),
      jitterMs: Math.round(jitterMs),
      srvOffsetMs: srvOff === null ? null : Math.round(srvOff)
    };
  };

  N.opponents = function () {
    var list = [];
    if (!N.snapshot) return list;
    for (var i = 0; i < N.snapshot.players.length; i++) {
      var p = N.snapshot.players[i];
      if (p.id !== N.id) list.push(p);
    }
    return list;
  };
  N.me = function () {
    if (!N.snapshot) return null;
    for (var i = 0; i < N.snapshot.players.length; i++) {
      if (N.snapshot.players[i].id === N.id) return N.snapshot.players[i];
    }
    return null;
  };
  N.diag = function () {
    return {
      initialized: N.initialized, online: N.online, state: N.state,
      pending: pendingActions.length,
      id: N.id, code: N.code, players: N.players.length,
      rank: N.rank, error: N.lastError, server: serverUrl,
      buffered: snapshots.length
    };
  };
})();
