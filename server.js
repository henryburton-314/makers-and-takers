const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const ROUND_MS = (+process.env.ROUND_SECONDS || 180) * 1000;
const PORT = process.env.PORT || 3000;
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];
const rooms = {};

const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const uid = () => Math.random().toString(36).slice(2, 10);
// Split n players into groups of 4-6; null if impossible (e.g. 7 or <4)
const split = n => { const k = Math.ceil(n / 6), b = Math.floor(n / k); if (b < 4) return null; return Array.from({ length: k }, (_, i) => b + (i < n % k ? 1 : 0)); };

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') return res.end('ok');
  fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, d) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d); });
});
const wss = new WebSocketServer({ server });

function sendState(room) {
  const players = [...room.players.values()];
  const board = players.map(p => ({ name: p.name, score: p.score, total: p.total, rounds: p.rounds, on: !!p.ws })).sort((a, b) => b.score - a.score);
  const nm = id => room.players.get(id).name;
  for (const p of players) {
    if (!p.ws || p.ws.readyState !== 1) continue;
    const g = p.gid != null ? room.groups[p.gid] : null;
    const book = side => g ? g.orders.filter(o => o.side === side)
      .sort((a, b) => (side === 'b' ? b.price - a.price : a.price - b.price) || a.id - b.id)
      .map(o => ({ id: o.id, name: nm(o.pid), price: o.price, qty: o.qty, mine: o.pid === p.id })) : [];
    p.ws.send(JSON.stringify({
      type: 'state', code: room.code, phase: room.phase, round: room.round, endsAt: room.endsAt, now: Date.now(),
      host: room.host === p.id, me: p.name, board,
      group: g && { suit: g.suit, names: g.ids.map(nm) },
      my: g && room.phase === 'trading' ? { card: p.card, pos: p.pos, cash: p.cash } : null,
      bids: book('b'), asks: book('s'), trades: g ? g.trades.slice(-40).reverse() : [],
      results: (g && g.results) || null,
      lobby: players.map(q => ({ name: q.name, on: !!q.ws })),
    }));
  }
}

function startRound(room, p) {
  const on = [...room.players.values()].filter(q => q.ws);
  const sizes = split(on.length);
  if (!sizes) return err(p, `Need 4-6 connected players (or 8+) to start. Connected now: ${on.length}.`);
  room.round++; room.phase = 'trading'; room.groups = [];
  room.players.forEach(q => { q.gid = null; });
  const ps = shuffle(on); let i = 0;
  sizes.forEach((sz, gi) => {
    const ids = ps.slice(i, i + sz).map(q => q.id); i += sz;
    const deck = shuffle(RANKS.slice());
    ids.forEach((id, j) => Object.assign(room.players.get(id), { gid: gi, card: deck[j], pos: 0, cash: 0 }));
    room.groups.push({ suit: SUITS[gi % 4], ids, orders: [], trades: [], oid: 1, results: null });
  });
  room.endsAt = Date.now() + ROUND_MS;
  room.timer = setTimeout(() => endRound(room), ROUND_MS);
  sendState(room);
}

function endRound(room) {
  clearTimeout(room.timer); room.phase = 'results';
  for (const g of room.groups) {
    const ps = g.ids.map(id => room.players.get(id));
    // Settlement: twice the median of the number cards (2-10) dealt; 12 if there are none.
    // Twice the median = sum of the two middle cards (a single middle card counts twice).
    const others = ps.map(p => p.card).filter(c => !isNaN(c)).map(Number).sort((a, b) => a - b);
    const n = others.length;
    const settle = n === 0 ? 12 : others[Math.floor((n - 1) / 2)] + others[Math.floor(n / 2)];
    const added = false;
    g.orders = [];
    const rows = ps.map(p => {
      const sh = Math.max(-p.pos, 0), lg = Math.max(p.pos, 0);
      const bonus = { J: 2 * Math.min(sh, 4), Q: 3 * Math.min(sh, 2), K: 3 * Math.min(lg, 2), A: 2 * Math.min(lg, 4) }[p.card] || 0;
      const pnl = p.cash + p.pos * settle + bonus, capped = Math.min(pnl, 60);
      p.score += capped; p.total += pnl; p.rounds[room.round - 1] = { pnl, capped };
      return { name: p.name, card: p.card, pos: p.pos, cash: p.cash, bonus, pnl, capped };
    });
    g.results = { settle, others, added, rows };
  }
  sendState(room);
}

function place(room, p, m) {
  const g = p.gid != null && room.groups[p.gid];
  if (room.phase !== 'trading' || !g) return err(p, 'No round in progress for you.');
  const price = +m.price, qty = +m.qty, buy = m.side === 'b';
  if (!['b', 's'].includes(m.side) || !Number.isInteger(price) || !Number.isInteger(qty) || price < 0 || price > 20 || qty < 1 || qty > 20)
    return err(p, 'Price must be a whole number 0-20 and size 1-20.');
  const opp = g.orders.filter(o => o.side !== m.side && (buy ? o.price <= price : o.price >= price));
  if (opp.some(o => o.pid === p.id)) return err(p, 'That would trade with your own order. Cancel it first.');
  opp.sort((a, b) => (buy ? a.price - b.price : b.price - a.price) || a.id - b.id);
  let left = qty;
  for (const o of opp) {
    if (!left) break;
    const q = Math.min(left, o.qty), other = room.players.get(o.pid);
    const B = buy ? p : other, S = buy ? other : p;
    B.pos += q; B.cash -= q * o.price; S.pos -= q; S.cash += q * o.price;
    g.trades.push({ b: B.name, s: S.name, p: o.price, q });
    o.qty -= q; left -= q;
  }
  g.orders = g.orders.filter(o => o.qty > 0);
  if (left) g.orders.push({ id: g.oid++, pid: p.id, side: m.side, price, qty: left });
  sendState(room);
}

const err = (p, msg) => p.ws && p.ws.send(JSON.stringify({ type: 'error', msg }));

function join(room, ws, m) {
  let p = m.pid && room.players.get(m.pid);
  if (!p) {
    if (room.players.size >= 24) return ws.send(JSON.stringify({ type: 'error', msg: 'Room is full (24 players).' }));
    let name = String(m.name || 'Player').trim().slice(0, 14) || 'Player', n = name, k = 2;
    while ([...room.players.values()].some(q => q.name === n)) n = name + k++;
    p = { id: uid(), name: n, ws, score: 0, total: 0, rounds: [], gid: null };
    room.players.set(p.id, p);
  }
  p.ws = ws; ws.pid = p.id; ws.room = room;
  if (!room.host || !room.players.get(room.host).ws) room.host = p.id;
  ws.send(JSON.stringify({ type: 'joined', pid: p.id, code: room.code }));
  sendState(room);
}

wss.on('connection', ws => {
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'ping') return;
    if (m.type === 'create') {
      let code; do { code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)]).join(''); } while (rooms[code]);
      rooms[code] = { code, players: new Map(), host: null, round: 0, phase: 'lobby', groups: [], endsAt: 0, last: Date.now() };
      return join(rooms[code], ws, m);
    }
    if (m.type === 'join') {
      const room = rooms[String(m.code || '').toUpperCase().trim()];
      if (!room) return ws.send(JSON.stringify({ type: 'error', msg: 'Room not found.', gone: true }));
      return join(room, ws, m);
    }
    const room = ws.room, p = room && room.players.get(ws.pid);
    if (!p) return;
    room.last = Date.now();
    if (m.type === 'start' && room.host === p.id && room.phase !== 'trading') startRound(room, p);
    else if (m.type === 'order') place(room, p, m);
    else if (m.type === 'cancel' && room.phase === 'trading' && p.gid != null) {
      const g = room.groups[p.gid]; g.orders = g.orders.filter(o => !(o.id === m.id && o.pid === p.id)); sendState(room);
    }
  });
  ws.on('close', () => {
    const room = ws.room, p = room && room.players.get(ws.pid);
    if (!p || p.ws !== ws) return;
    p.ws = null;
    if (room.host === p.id) { const n = [...room.players.values()].find(q => q.ws); if (n) room.host = n.id; }
    sendState(room);
  });
});

setInterval(() => { for (const c in rooms) { const r = rooms[c]; if (![...r.players.values()].some(p => p.ws) && Date.now() - r.last > 3 * 3600e3) delete rooms[c]; } }, 600e3);
server.listen(PORT, () => console.log('Makers and Takers on port ' + PORT));
