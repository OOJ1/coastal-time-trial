/* =========================================================================
 * server/server.js — 联机服务入口：静态文件 + WebSocket
 * 启动：node server/server.js [port]     默认 8787
 * 环境变量：PORT / HOST（反代部署时 HOST=127.0.0.1 只监听本机）
 * 依赖：npm i ws   （唯一外部依赖，只服务端用；客户端仍是原生 WebSocket）
 * ========================================================================= */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const WebSocket = require('ws');
const { RoomManager, PHASE, clampInput, makeToken } = require('./rooms');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || process.argv[2]) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const TICK = 1000 / 30;
const PROTOCOL = 1;
const VERSION = '2.2.14-test2';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon'
};
/* 生产环境别把源码和配置当静态文件发出去 */
const DENY = ['/server', '/deploy', '/.git', '/.workbuddy'];
function denied(p) {
  if (p.includes('/.')) return true;             /* 任何点文件 / 点目录 */
  return DENY.some(d => p === d || p.startsWith(d + '/'));
}

const server = http.createServer((req, res) => {
  try {
    var p;
    try { p = decodeURIComponent((req.url || '/').split('?')[0]); }
    catch (e) { res.writeHead(400); res.end('400'); return; }     /* 畸形 %xx 不再打挂进程 */
    if (p.indexOf('\0') >= 0 || p.length > 512) { res.writeHead(400); res.end('400'); return; }

    if (p === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        ok: true, version: VERSION, uptime: Math.round(process.uptime()),
        rooms: manager.rooms.size, players: manager.players.size
      }));
      return;
    }
    if (p === '/') p = '/index.html';
    if (denied(p)) { res.writeHead(403); res.end('403'); return; }
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || !fs.statSync(f).isFile()) {
      res.writeHead(404); res.end('404'); return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(f)] || 'application/octet-stream',
      /* 入口 html 不缓存（脚本都带 ?v=），换版本后刷新即可生效 */
      'Cache-Control': path.extname(f) === '.html' ? 'no-cache' : 'public, max-age=300'
    });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    try { res.writeHead(500); res.end('500'); } catch (x) {}
    console.error('[http]', e.message);
  }
});

const wss = new WebSocket.Server({ server, maxPayload: 1024 });
const manager = new RoomManager();
let nextId = 1;
const rate = new Map();

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* 单个客户端写失败不影响房间 */ }
  }
}
function limited(key, max, windowMs) {
  const t = Date.now(), a = rate.get(key) || [];
  while (a.length && t - a[0] > windowMs) a.shift();
  if (a.length >= max) return false;
  a.push(t); rate.set(key, a);
  return true;
}
function broadcastRoom(r, obj, except) {
  for (const p of r.players) if (p.ws !== except) send(p.ws, obj);
}
function event(r, obj) {
  broadcastRoom(r, Object.assign({ t: 'event' }, obj));
}

function onMessage(ws, p, raw) {
  if (!limited('m:' + (p ? p.id : ws._ip), 90, 1000)) return;
  let m;
  try { m = JSON.parse(raw); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;

  if (m.t === 'hello') {
    if (p) return;
    /* 只硬校验协议号：版本号每次发版都会变，硬校验会把「还开着旧标签页」的
       玩家直接挡在门外（版本不匹配，请刷新页面）。协议没变就放行，版本只记日志。 */
    if (m.protocol !== PROTOCOL) {
      send(ws, { t: 'reject', reason: '协议不匹配，请刷新页面' }); return;
    }
    if (m.version !== VERSION) {
      console.warn('[hello] 客户端 ' + m.version + ' ≠ 服务端 ' + VERSION + '（协议一致，放行）');
    }
    const pid = nextId++;
    p = {
      id: pid, ws, room: null,
      device: String(m.device || '').slice(0, 64) || 'unknown',
      /* 没填昵称也要能区分对手：用「车手 + id」兜底 */
      name: String(m.nickname || ('车手 ' + pid)).slice(0, 12) || ('车手 ' + pid),
      token: makeToken(),
      connected: true, ready: false, input: {},
      lastX: 0, lastZ: 0, lastLap: 0, cheat: '',
      joinedAt: Date.now()
    };
    ws._player = p;
    manager.players.set(p.id, p);
    send(ws, { t: 'welcome', id: p.id, token: p.token, protocol: PROTOCOL, version: VERSION });
    return;
  }

  if (!p) { send(ws, { t: 'reject', reason: '请先握手' }); return; }

  switch (m.t) {
    case 'create': {
      if (p.room) leave(p);
      if (!limited('create:' + p.device, 5, 60000)) return;
      const r = manager.create(p, m);
      send(ws, r.roomInfo());
      break;
    }
    case 'join': {
      if (p.room) leave(p);
      if (!limited('join:' + p.device, 10, 60000)) return;
      const res = manager.join(String(m.code || ''), p);
      if (res.err) { send(ws, { t: 'error', reason: res.err }); return; }
      send(ws, res.room.roomInfo());
      broadcastRoom(res.room, res.room.roomInfo());
      broadcastRoom(res.room, { t: 'event', kind: 'join', name: p.name });
      break;
    }
    case 'reconnect': {
      const r = manager.rooms.get(String(m.code || '').toUpperCase());
      const target = r && r.players.find(q => q.token === m.token && q.device === p.device);
      if (!target) { send(ws, { t: 'error', reason: '重连凭证无效' }); return; }
      /* 把连接从旧 ws 迁到新 ws，保留座位与进度 */
      const old = target.ws;
      target.ws = ws; target.connected = true;
      ws._player = target;
      manager.players.delete(p.id);
      p = target;
      if (old && old !== ws) { try { old.close(); } catch (e) {} }
      send(ws, { t: 'welcome', id: p.id, token: p.token, protocol: PROTOCOL, version: VERSION });
      send(ws, r.roomInfo());
      send(ws, r.snapshot());
      broadcastRoom(r, r.roomInfo());
      event(r, { kind: 'reconnect', name: p.name });
      break;
    }
    case 'car': {
      const r = p.room;
      if (!r) return;
      if (!r.setCar(p, m.car)) {
        send(ws, { t: 'error', reason: '比赛进行中不能换车' });
        break;
      }
      /* 选车消息里附带变速箱模式，省一次往返（车型没变也要生效） */
      if (m.manual != null) r.setGearMode(p, m.manual);
      /* 选好车 = 准备完毕；开赛由房主点「开始比赛」触发，不再自动倒计时 */
      if (!r.racing && r.phase !== PHASE.RESULT) p.ready = true;
      broadcastRoom(r, r.roomInfo());
      break;
    }
    case 'gear': {
      const r = p.room;
      if (!r) return;
      r.setGearMode(p, m.manual);
      break;
    }
    case 'ready': {
      const r = p.room; if (!r || r.racing) return;
      p.ready = !!m.ready;
      broadcastRoom(r, r.roomInfo());
      break;
    }
    case 'start': {
      const r = p.room;
      if (!r) return;
      if (r.hostId !== p.id) { send(ws, { t: 'error', reason: '只有房主能开始' }); return; }
      if (!r.canStart()) {
        const active = r.players.filter(x => x.connected);
        const ready = active.filter(x => x.ready).length;
        send(ws, { t: 'error', reason: active.length < 2 ? '至少需要 2 人才能开始' : ('还有 ' + (active.length - ready) + ' 人没选好车') });
        return;
      }
      if (!r.start(p.id)) { send(ws, { t: 'error', reason: '现在不能开始' }); return; }
      broadcastRoom(r, r.roomInfo());
      break;
    }
    case 'leave': leave(p); break;
    case 'input': {
      const r = p.room;
      if (!r || !r.racing || p.finished) return;
      p.input = clampInput(m);
      break;
    }
    case 'ping': send(ws, { t: 'pong', v: m.v }); break;
  }
}

function leave(p) {
  const r = p.room; if (!r) return;
  p.room = null; p.connected = false;
  r.remove(p);
  broadcastRoom(r, r.roomInfo());
  event(r, { kind: 'leave', name: p.name });
  if (!r.players.length) manager.rooms.delete(r.code);
}

wss.on('connection', (ws, req) => {
  ws._ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').slice(0, 64);
  ws._player = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  let p = null;
  ws.on('message', raw => {
    try { onMessage(ws, p, raw); } catch (e) { console.error('[net]', e.message); }
    p = ws._player;
  });
  ws.on('close', () => {
    p = ws._player;
    if (!p) return;
    p.connected = false;
    p.ws = null;
    /* 立刻广播一次房间信息：否则其他人一直看到「全员已就位」，
       而服务端的 canStart() 已经把掉线的人过滤掉了 —— 房主会对着一个
       点不动的「开始比赛」发呆，完全没有线索。 */
    if (p.room) { try { broadcastRoom(p.room, p.roomInfo()); } catch (e) {} }
    /* 不立刻移除座位：15 秒宽限期，期间 AI 不接管（无碰撞模式下静止即可） */
    setTimeout(() => {
      if (!p.connected && p.room) leave(p);
      manager.players.delete(p.id);
    }, 15000);
  });
});

/* 30Hz 权威 tick */
let last = Date.now();
setInterval(() => {
  const t = Date.now();
  const dt = Math.min((t - last) / 1000, 0.05);
  last = t;
  for (const r of manager.rooms.values()) {
    try {
      r.step(dt, event);
      /* 阶段变化（倒计时开始 / 回到大厅）补发一次房间信息 */
      if (r.roomDirty) { r.roomDirty = false; broadcastRoom(r, r.roomInfo()); }
      if (r.tick % 2 === 0) broadcastRoom(r, r.snapshot());   /* 15Hz 快照 */
      if (r.results && r.tick % 10 === 0) broadcastRoom(r, { t: 'result', rows: r.results });
    } catch (e) {
      console.error('[tick] room ' + r.code + ':', e.message);
    }
  }
  manager.cleanup();
}, TICK);

/* 心跳：反向代理/云负载均衡通常会掐掉长时间没有数据的空闲连接（大厅挂机最常见）。
   25s 一次 ping，两个周期没回应就断开，让客户端走重连逻辑。 */
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  }
}, 25000);
heartbeat.unref();
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, HOST, () => {
  console.log('[coastal] server listening on http://' + HOST + ':' + PORT);
  console.log('[coastal] protocol v' + PROTOCOL + ' / game v' + VERSION + ' / tick 30Hz');
});

/* systemd / pm2 停止时先断开所有连接，避免半关状态卡住端口 */
function shutdown(sig) {
  console.log('[coastal] ' + sig + ' received, closing…');
  clearInterval(heartbeat);
  for (const ws of wss.clients) { try { ws.close(1001, 'server shutdown'); } catch (e) {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
