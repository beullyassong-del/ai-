const http = require('http');
const crypto = require('crypto');
const PORT = Number(process.env.PORT || 8080);
const TEAM_PICK_SECONDS = Math.max(1, Number(process.env.TEAM_PICK_SECONDS || 20));
const OPEN = 1;
const rooms = new Map();

// Small built-in WebSocket implementation for text frames; no npm dependencies are required.
class MiniWebSocket {
  constructor(socket) {
    this.socket = socket; this.readyState = OPEN; this.listeners = new Map(); this.buffer = Buffer.alloc(0); this.closedEmitted = false;
    socket.on('data', chunk => this._data(chunk));
    socket.on('close', () => this._finishClose());
    socket.on('end', () => this._finishClose());
    socket.on('error', err => this._emit('error', err));
  }
  on(event, fn) { if (!this.listeners.has(event)) this.listeners.set(event, []); this.listeners.get(event).push(fn); return this; }
  _emit(event, value) { for (const fn of this.listeners.get(event) || []) { try { fn(value); } catch (e) { console.error(e); } } }
  _finishClose() { if (this.closedEmitted) return; this.closedEmitted = true; this.readyState = 3; this._emit('close'); }
  _frame(payload, opcode = 1) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
    let head;
    if (body.length < 126) { head = Buffer.from([0x80 | opcode, body.length]); }
    else if (body.length <= 65535) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(body.length, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(body.length), 2); }
    return Buffer.concat([head, body]);
  }
  send(payload) { if (this.readyState === OPEN && !this.socket.destroyed) this.socket.write(this._frame(payload, 1)); }
  close() { if (this.readyState !== OPEN) return; try { this.socket.end(this._frame(Buffer.alloc(0), 8)); } catch (_) {} this._finishClose(); }
  _data(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0], b1 = this.buffer[1], opcode = b0 & 0x0f, masked = !!(b1 & 0x80);
      let len = b1 & 0x7f, offset = 2;
      if (len === 126) { if (this.buffer.length < 4) return; len = this.buffer.readUInt16BE(2); offset = 4; }
      else if (len === 127) { if (this.buffer.length < 10) return; const longLen = this.buffer.readBigUInt64BE(2); if (longLen > 2_000_000n) { this.close(); return; } len = Number(longLen); offset = 10; }
      if (masked) offset += 4;
      if (len > 2_000_000) { this.close(); return; }
      if (this.buffer.length < offset + len) return;
      let payload = Buffer.from(this.buffer.subarray(offset, offset + len));
      if (masked) { const m = this.buffer.subarray(offset - 4, offset); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i % 4]; }
      this.buffer = this.buffer.subarray(offset + len);
      if (opcode === 8) { this.close(); return; }
      if (opcode === 9) { if (this.readyState === OPEN) this.socket.write(this._frame(payload, 10)); continue; }
      if (opcode === 1) this._emit('message', payload);
      // Client messages from this game are short, complete UTF-8 text frames.
    }
  }
}
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('VANGUARD multiplayer server is running. Open the HTML game to create or join a room.\n');
});
httpServer.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const ws = new MiniWebSocket(socket);
  handleConnection(ws);
});
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function send(ws, data) {
  if (ws && ws.readyState === OPEN) ws.send(JSON.stringify(data));
}
function broadcast(room, data, exceptId = null) {
  for (const p of room.players.values()) if (p.id !== exceptId) send(p.ws, data);
}
function roomCode() {
  let code;
  do { code = Array.from({ length: 5 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
function cleanName(name) {
  return String(name || '플레이어').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16) || '플레이어';
}
function publicPlayer(p) {
  return { id: p.id, name: p.name, team: p.team, host: p.id === p.room.hostId, hp: p.hp, armor: p.armor,
    kills: p.kills, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, weapon: p.weapon, dead: p.dead };
}
function roster(room) { return [...room.players.values()].map(publicPlayer); }
function broadcastRoom(room) {
  const remaining = room.phase === 'teamPick' ? room.remaining : undefined;
  broadcast(room, { type: 'roomUpdate', code: room.code, mode: room.mode, phase: room.phase,
    hostId: room.hostId, players: roster(room), remaining });
}
function randomSpawn() {
  return { x: Math.random() * 36 - 18, z: Math.random() * 36 - 18, yaw: Math.random() * Math.PI * 2 };
}
function spawnForTeam(team) {
  const x = team === 'red' ? -22 : 22;
  return { x, z: Math.random() * 38 - 19, yaw: team === 'red' ? -Math.PI / 2 : Math.PI / 2 };
}
function startMatch(room) {
  if (!room || !rooms.has(room.code) || room.phase === 'playing') return;
  if (room.timer) { clearInterval(room.timer); room.timer = null; }
  if (!room.players.size) { rooms.delete(room.code); return; }
  if (room.mode === 'team') {
    let red = [...room.players.values()].filter(p => p.team === 'red').length;
    let blue = [...room.players.values()].filter(p => p.team === 'blue').length;
    for (const p of room.players.values()) {
      if (!p.team) {
        p.team = red <= blue ? (red++, 'red') : (blue++, 'blue');
      }
    }
  } else {
    for (const p of room.players.values()) p.team = null;
  }
  room.phase = 'playing';
  const spawns = {};
  for (const p of room.players.values()) {
    const sp = room.mode === 'team' ? spawnForTeam(p.team) : randomSpawn();
    Object.assign(p, sp, { hp: 100, armor: 50, kills: 0, dead: false, weapon: 'ak' });
    spawns[p.id] = { x: p.x, y: 0, z: p.z, yaw: p.yaw };
  }
  broadcast(room, { type: 'matchStart', mode: room.mode, code: room.code, players: roster(room), spawns });
  broadcastRoom(room);
}
function leaveRoom(p) {
  const room = p && p.room;
  if (!room || !room.players.has(p.id)) return;
  room.players.delete(p.id);
  p.room = null;
  if (!room.players.size) {
    if (room.timer) clearInterval(room.timer);
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === p.id) room.hostId = room.players.keys().next().value;
  broadcast(room, { type: 'playerLeft', id: p.id, players: roster(room) });
  broadcastRoom(room);
}
function addPlayer(ws, name) {
  const p = { id: crypto.randomUUID(), name: cleanName(name), ws, room: null, team: null, hp: 100, armor: 50,
    kills: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, weapon: 'ak', dead: false };
  ws.player = p;
  return p;
}
function handle(ws, msg) {
  const p = ws.player;
  if (msg.type === 'create') {
    if (p && p.room) leaveRoom(p);
    const owner = p || addPlayer(ws, msg.name);
    owner.name = cleanName(msg.name); owner.team = null;
    const code = roomCode();
    const room = { code, hostId: owner.id, players: new Map(), mode: 'ffa', phase: 'lobby', timer: null, remaining: 20 };
    rooms.set(code, room); owner.room = room; room.players.set(owner.id, owner);
    send(ws, { type: 'created', id: owner.id, code, host: true, mode: room.mode });
    broadcastRoom(room);
    return;
  }
  if (msg.type === 'join') {
    if (p && p.room) leaveRoom(p);
    const code = String(msg.code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return send(ws, { type: 'error', message: '해당 코드의 방을 찾을 수 없습니다.' });
    if (room.phase !== 'lobby') return send(ws, { type: 'error', message: '이미 게임이 시작된 방에는 들어갈 수 없습니다.' });
    if (room.players.size >= 12) return send(ws, { type: 'error', message: '방 인원이 가득 찼습니다. (최대 12명)' });
    const player = p || addPlayer(ws, msg.name);
    player.name = cleanName(msg.name); player.room = room; player.team = null;
    room.players.set(player.id, player);
    send(ws, { type: 'joined', id: player.id, code, host: player.id === room.hostId, mode: room.mode });
    broadcast(room, { type: 'playerJoined', player: publicPlayer(player) }, player.id);
    broadcastRoom(room);
    return;
  }
  if (!p || !p.room) return send(ws, { type: 'error', message: '먼저 방을 만들거나 참가하세요.' });
  const room = p.room;

  if (msg.type === 'leave') { leaveRoom(p); return; }
  if (msg.type === 'mode') {
    if (p.id !== room.hostId) return send(ws, { type: 'error', message: '방장만 모드를 바꿀 수 있습니다.' });
    if (room.phase !== 'lobby') return;
    if (!['ffa', 'team'].includes(msg.mode)) return;
    room.mode = msg.mode; broadcastRoom(room); return;
  }
  if (msg.type === 'start') {
    if (p.id !== room.hostId) return send(ws, { type: 'error', message: '방장만 게임을 시작할 수 있습니다.' });
    if (room.phase !== 'lobby') return;
    if (room.mode === 'ffa') { startMatch(room); return; }
    room.phase = 'teamPick'; room.remaining = TEAM_PICK_SECONDS;
    broadcast(room, { type: 'teamPick', remaining: room.remaining }); broadcastRoom(room);
    room.timer = setInterval(() => {
      if (!rooms.has(room.code) || room.phase !== 'teamPick') { clearInterval(room.timer); room.timer = null; return; }
      room.remaining -= 1;
      broadcast(room, { type: 'teamCountdown', remaining: room.remaining });
      if (room.remaining <= 0) startMatch(room);
    }, 1000);
    return;
  }
  if (msg.type === 'team') {
    if (room.phase !== 'teamPick' || room.mode !== 'team' || !['red', 'blue'].includes(msg.team)) return;
    p.team = msg.team; broadcastRoom(room); return;
  }
  if (msg.type === 'state') {
    if (room.phase !== 'playing' || p.dead) return;
    const clamp = (v, lo, hi, fallback = 0) => Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : fallback;
    p.x = clamp(msg.x, -29, 29); p.y = clamp(msg.y, 0, 10); p.z = clamp(msg.z, -29, 29);
    p.yaw = clamp(msg.yaw, -1000, 1000); p.pitch = clamp(msg.pitch, -1.6, 1.6); p.weapon = String(msg.weapon || p.weapon).slice(0, 16);
    broadcast(room, { type: 'playerState', player: publicPlayer(p) }, p.id); return;
  }
  if (msg.type === 'blind') {
    if (room.phase !== 'playing' || p.dead) return;
    const target = room.players.get(String(msg.target || ''));
    if (!target || target.id === p.id || target.dead) return;
    if (room.mode === 'team' && p.team && p.team === target.team) return;
    send(target.ws, { type: 'blinded', duration: Math.max(0.15, Math.min(1.1, Number(msg.duration) || 0.35)) });
    return;
  }
  if (msg.type === 'hit') {
    if (room.phase !== 'playing' || p.dead) return;
    const target = room.players.get(String(msg.target || ''));
    if (!target || target.id === p.id || target.dead) return;
    if (room.mode === 'team' && p.team && p.team === target.team) return;
    const damage = Math.max(1, Math.min(160, Number(msg.damage) || 1));
    const armorTake = target.armor > 0 ? Math.min(target.armor, damage * 0.66) : 0;
    target.armor -= armorTake;
    target.hp -= damage - armorTake;
    let killed = false;
    if (target.hp <= 0) {
      target.hp = 0; target.dead = true; killed = true; p.kills += 1;
    }
    broadcast(room, { type: 'healthUpdate', target: target.id, targetName: target.name, hp: target.hp,
      armor: target.armor, killer: p.id, killerName: p.name, killed, head: !!msg.head });
    if (killed) {
      setTimeout(() => {
        if (!rooms.has(room.code) || !room.players.has(target.id) || !target.dead) return;
        target.dead = false; target.hp = 100; target.armor = 50;
        const sp = room.mode === 'team' ? spawnForTeam(target.team) : randomSpawn();
        Object.assign(target, sp, { y: 0 });
        send(target.ws, { type: 'respawn', id: target.id, spawn: { x: target.x, y: 0, z: target.z, yaw: target.yaw } });
        broadcast(room, { type: 'playerState', player: publicPlayer(target) }, target.id);
        broadcastRoom(room);
      }, 3000);
    }
    return;
  }
}

function handleConnection(ws) {
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'error', message: '잘못된 메시지 형식입니다.' }); }
    try { handle(ws, msg); } catch (err) { console.error(err); send(ws, { type: 'error', message: '서버 처리 중 오류가 발생했습니다.' }); }
  });
  ws.on('close', () => { if (ws.player) leaveRoom(ws.player); });
  ws.on('error', err => console.error('WebSocket client error:', err.message));
}

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`VANGUARD multiplayer server listening on ws://0.0.0.0:${PORT}`);
  console.log('For players on another PC, set the game HTML server address to this machine’s reachable IP/domain.');
});
