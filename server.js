'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('./database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { WebSocketServer } = require('ws');

const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 16 || SECRET === 'change-me-to-a-long-random-string') {
  console.error('Set JWT_SECRET to a unique random secret in .env (at least 16 characters). See README.md.');
  process.exit(1);
}
const dataDir = path.resolve(process.env.BISCORD_DATA_DIR || __dirname);
const uploadDir = path.join(dataDir, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const db = new Database(path.join(dataDir, 'biscord.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
 CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,username TEXT UNIQUE,display TEXT,pass TEXT,bio TEXT DEFAULT '');
 CREATE TABLE IF NOT EXISTS servers(id INTEGER PRIMARY KEY,name TEXT,owner INTEGER);
 CREATE TABLE IF NOT EXISTS members(server_id INTEGER,user_id INTEGER,role TEXT DEFAULT 'member',PRIMARY KEY(server_id,user_id));
 CREATE TABLE IF NOT EXISTS channels(id INTEGER PRIMARY KEY,server_id INTEGER,name TEXT);
 CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY,channel_id INTEGER,user_id INTEGER,content TEXT,file TEXT,created INTEGER,edited INTEGER DEFAULT 0);
 CREATE TABLE IF NOT EXISTS reactions(message_id INTEGER,user_id INTEGER,emoji TEXT,PRIMARY KEY(message_id,user_id,emoji));
 CREATE TABLE IF NOT EXISTS invites(code TEXT PRIMARY KEY,server_id INTEGER,expires INTEGER,max INTEGER,uses INTEGER DEFAULT 0);
 CREATE TABLE IF NOT EXISTS friends(a INTEGER,b INTEGER,state TEXT,PRIMARY KEY(a,b));
 CREATE TABLE IF NOT EXISTS bans(server_id INTEGER,user_id INTEGER,PRIMARY KEY(server_id,user_id));
 CREATE TABLE IF NOT EXISTS modlog(id INTEGER PRIMARY KEY,server_id INTEGER,actor INTEGER,action TEXT,target INTEGER,note TEXT,created INTEGER);
 CREATE TABLE IF NOT EXISTS reads(user_id INTEGER,channel_id INTEGER,last_id INTEGER,PRIMARY KEY(user_id,channel_id));
 CREATE TABLE IF NOT EXISTS uploads(file TEXT PRIMARY KEY,user_id INTEGER,name TEXT,size INTEGER,created INTEGER);
 CREATE TABLE IF NOT EXISTS bookmarks(user_id INTEGER,message_id INTEGER,created INTEGER,PRIMARY KEY(user_id,message_id));
 CREATE TABLE IF NOT EXISTS polls(message_id INTEGER PRIMARY KEY,question TEXT,options TEXT,closed INTEGER DEFAULT 0);
 CREATE TABLE IF NOT EXISTS poll_votes(message_id INTEGER,user_id INTEGER,choice INTEGER,PRIMARY KEY(message_id,user_id));
 CREATE INDEX IF NOT EXISTS messages_channel_id ON messages(channel_id,id);
 CREATE INDEX IF NOT EXISTS members_user ON members(user_id);
`);
// Additive migrations preserve the original database, including accounts and chats.
for (const [table, columns] of Object.entries({
  users: { status: "TEXT DEFAULT 'online'", custom: "TEXT DEFAULT ''", color: "TEXT DEFAULT '#8b5cf6'", avatar: "TEXT DEFAULT ''", banner: "TEXT DEFAULT ''", pronouns: "TEXT DEFAULT ''", created: 'INTEGER DEFAULT 0' },
  servers: { type: "TEXT DEFAULT 'server'" },
  channels: { type: "TEXT DEFAULT 'text'", slow: 'INTEGER DEFAULT 0', topic: "TEXT DEFAULT ''" },
  members: { timeout_until: 'INTEGER DEFAULT 0' },
  messages: { reply_to: 'INTEGER', pinned: 'INTEGER DEFAULT 0' }
})) {
  const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(x => x.name));
  for (const [name, definition] of Object.entries(columns)) if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}
const app = express();
const srv = http.createServer(app);
const clients = new Map();
const rooms = new Map();
const hits = new Map();
const typingHits = new Map();
app.use(helmet({ contentSecurityPolicy: {
  directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'blob:'], mediaSrc: ["'self'", 'blob:'], connectSrc: ["'self'"], upgradeInsecureRequests: null }
} }));
app.use(express.json({ limit: '100kb' }));
app.use('/api', rateLimit({ windowMs: 60000, max: 300, standardHeaders: true, legacyHeaders: false }));
const strict = rateLimit({ windowMs: 900000, max: 20 });
const asyncRoute = f => (q, s, n) => Promise.resolve(f(q, s, n)).catch(n);
const error = (s, status, text) => s.status(status).json({ error: text });
const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const user = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);
const role = (sid, uid) => db.prepare('SELECT role FROM members WHERE server_id=? AND user_id=?').get(sid, uid)?.role;
const chan = id => db.prepare('SELECT * FROM channels WHERE id=?').get(id);
const isAdmin = r => r === 'owner' || r === 'admin';
const isDm = sid => db.prepare('SELECT type FROM servers WHERE id=?').get(sid)?.type === 'dm';
const relations = (a, b) => db.prepare('SELECT * FROM friends WHERE (a=? AND b=?) OR (a=? AND b=?)').all(a, b, b, a);
const blocked = (a, b) => relations(a, b).some(x => x.state === 'blocked');
function publicUser(u, own = false) {
  if (!u) return null;
  const online = clients.has(u.id) && u.status !== 'invisible';
  return { id: u.id, username: u.username, display: u.display, bio: u.bio, status: own ? u.status : online ? u.status : 'offline', custom: u.custom, color: u.color, avatar: u.avatar, banner: u.banner, pronouns: u.pronouns, created: u.created, online };
}
const U = id => publicUser(user(id));
const mutualServers = (a, b) => db.prepare("SELECT v.id,v.name FROM servers v JOIN members a ON a.server_id=v.id JOIN members b ON b.server_id=v.id WHERE a.user_id=? AND b.user_id=? AND v.type='server'").all(a, b);
function dmBlocked(sid) {
  if (!isDm(sid)) return false;
  const ids = db.prepare('SELECT user_id FROM members WHERE server_id=?').all(sid).map(x => x.user_id);
  return ids.length !== 2 || blocked(ids[0], ids[1]);
}
function send(uid, payload) {
  const data = JSON.stringify(payload);
  clients.get(uid)?.forEach(w => { if (w.readyState === 1) w.send(data); });
}
function bc(sid, payload, skip) {
  for (const { user_id } of db.prepare('SELECT user_id FROM members WHERE server_id=?').all(sid)) if (user_id !== skip) send(user_id, payload);
}
function profileEvent(uid) {
  const ids = new Set([uid]);
  for (const r of db.prepare('SELECT b.user_id FROM members a JOIN members b ON a.server_id=b.server_id WHERE a.user_id=?').all(uid)) ids.add(r.user_id);
  for (const r of db.prepare("SELECT a,b FROM friends WHERE (a=? OR b=?) AND state!='blocked'").all(uid, uid)) { ids.add(r.a); ids.add(r.b); }
  const u = U(uid);
  for (const id of ids) send(id, { t: 'profile', user: id === uid ? publicUser(user(uid), true) : u });
}
const friendsEvent = (a, b) => { send(a, { t: 'friends' }); send(b, { t: 'friends' }); };
const log = (sid, actor, action, target = 0, note = '') => db.prepare('INSERT INTO modlog(server_id,actor,action,target,note,created) VALUES(?,?,?,?,?,?)').run(sid, actor, action, target, clean(note, 300), Date.now());
const sign = id => jwt.sign({ id }, SECRET, { expiresIn: '30d' });
function auth(q, s, n) {
  try {
    if (!q.headers.authorization?.startsWith('Bearer ')) throw Error();
    q.uid = jwt.verify(q.headers.authorization.slice(7), SECRET).id;
    if (!Number.isSafeInteger(q.uid) || !user(q.uid)) throw Error();
    n();
  } catch { error(s, 401, 'Please log in again.'); }
}
app.post('/api/register', strict, asyncRoute(async (q, s) => {
  const username = clean(q.body.username, 100).toLowerCase();
  const password = q.body.password;
  if (!/^[a-z0-9_.]{3,32}$/.test(username)) return error(s, 400, 'Username: 3–32 letters, numbers, underscores or dots.');
  if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password) > 72) return error(s, 400, 'Password must be at least 8 characters and at most 72 bytes.');
  const hash = await bcrypt.hash(password, 11);
  try {
    const r = db.prepare('INSERT INTO users(username,display,pass,created) VALUES(?,?,?,?)').run(username, clean(q.body.display, 32) || username, hash, Date.now());
    s.json({ token: sign(r.lastInsertRowid) });
  } catch (e) { if (e.code?.startsWith('SQLITE_CONSTRAINT')) return error(s, 409, 'Username already taken.'); throw e; }
}));
app.post('/api/login', strict, asyncRoute(async (q, s) => {
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(clean(q.body.username, 100).toLowerCase());
  const password = typeof q.body.password === 'string' ? q.body.password : '';
  if (!u || Buffer.byteLength(password) > 72 || !await bcrypt.compare(password, u.pass)) return error(s, 401, 'Incorrect username or password.');
  s.json({ token: sign(u.id) });
}));
app.use('/api', auth);
app.get('/api/me', (q, s) => s.json(publicUser(user(q.uid), true)));

const fileName = /^[a-f0-9]{24}\.[a-z0-9]+$/;
const imageName = /^[a-f0-9]{24}\.(png|jpe?g|gif|webp)$/;
function imageBytes(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(12);
  try { fs.readSync(fd, b, 0, 12, 0); } finally { fs.closeSync(fd); }
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'jpg';
  if (['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString())) return 'gif';
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}
function mediaAllowed(value, uid, current) {
  if (value === '') return true;
  if (typeof value !== 'string' || !imageName.test(value)) return false;
  if (value === current) return true;
  const f = db.prepare('SELECT * FROM uploads WHERE file=? AND user_id=?').get(value, uid);
  return !!f && f.size <= 8 * 1024 ** 2 && fs.existsSync(path.join(uploadDir, value)) && !!imageBytes(path.join(uploadDir, value));
}
app.patch('/api/me', (q, s) => {
  const u = user(q.uid), b = q.body;
  const display = b.display === undefined ? u.display : clean(b.display, 32);
  if (!display) return error(s, 400, 'Display name cannot be empty.');
  if (b.status !== undefined && !['online', 'idle', 'dnd', 'invisible'].includes(b.status)) return error(s, 400, 'Invalid status.');
  if (b.color !== undefined && !/^#[0-9a-f]{6}$/i.test(b.color)) return error(s, 400, 'Choose a valid profile colour.');
  for (const key of ['avatar', 'banner']) if (b[key] !== undefined && !mediaAllowed(b[key], q.uid, u[key])) return error(s, 400, 'Upload a valid image (up to 8 MB) from your own account first.');
  db.prepare('UPDATE users SET display=?,bio=?,status=?,custom=?,color=?,avatar=?,banner=?,pronouns=? WHERE id=?').run(display, clean(b.bio ?? u.bio, 500), b.status ?? u.status, clean(b.custom ?? u.custom, 80), b.color ?? u.color, b.avatar ?? u.avatar, b.banner ?? u.banner, clean(b.pronouns ?? u.pronouns, 40), q.uid);
  profileEvent(q.uid);
  s.json(publicUser(user(q.uid), true));
});
app.get('/api/users/:id', (q, s) => {
  const id = Number(q.params.id), u = user(id);
  if (!u) return error(s, 404, 'User not found.');
  const rel = relations(q.uid, id), mutual = mutualServers(q.uid, id);
  if (id !== q.uid && !rel.length && !mutual.length) return error(s, 404, 'User not found.');
  const relationship = id === q.uid ? 'self' : rel.some(x => x.state === 'blocked' && x.a === q.uid) ? 'blocked' : rel.some(x => x.state === 'blocked') ? 'unavailable' : rel.some(x => x.state === 'friends') ? 'friends' : rel.some(x => x.state === 'pending' && x.a === q.uid) ? 'outgoing' : rel.some(x => x.state === 'pending') ? 'incoming' : 'none';
  s.json({ ...publicUser(u, id === q.uid), relationship, mutual_servers: mutual });
});
app.get('/api/friends', (q, s) => {
  const rows = db.prepare('SELECT * FROM friends WHERE a=? OR b=?').all(q.uid, q.uid);
  s.json({ friends: rows.filter(x => x.state === 'friends').map(x => U(x.a === q.uid ? x.b : x.a)).filter(Boolean), incoming: rows.filter(x => x.state === 'pending' && x.b === q.uid).map(x => U(x.a)).filter(Boolean), outgoing: rows.filter(x => x.state === 'pending' && x.a === q.uid).map(x => U(x.b)).filter(Boolean), blocked: rows.filter(x => x.state === 'blocked' && x.a === q.uid).map(x => U(x.b)).filter(Boolean) });
});
app.post('/api/friends', (q, s) => {
  const t = db.prepare('SELECT id FROM users WHERE username=?').get(clean(q.body.username, 32).toLowerCase());
  if (!t || t.id === q.uid || blocked(q.uid, t.id)) return error(s, 404, 'User not found. Check the exact username.');
  const rel = relations(q.uid, t.id);
  if (rel.some(x => x.state === 'pending' && x.a === t.id)) db.prepare("UPDATE friends SET state='friends' WHERE a=? AND b=?").run(t.id, q.uid);
  else if (rel.length) return error(s, 409, 'Already friends or a request is pending.');
  else db.prepare("INSERT INTO friends VALUES(?,?,'pending')").run(q.uid, t.id);
  friendsEvent(q.uid, t.id); s.json({});
});
app.post('/api/friends/:id/accept', (q, s) => {
  const id = Number(q.params.id);
  const changed = db.prepare("UPDATE friends SET state='friends' WHERE a=? AND b=? AND state='pending'").run(id, q.uid).changes;
  if (!changed) return error(s, 404, 'Request not found.');
  friendsEvent(q.uid, id); s.json({});
});
app.delete('/api/friends/:id', (q, s) => {
  const id = Number(q.params.id);
  db.prepare("DELETE FROM friends WHERE state!='blocked' AND ((a=? AND b=?) OR (a=? AND b=?))").run(q.uid, id, id, q.uid);
  friendsEvent(q.uid, id); s.json({});
});
app.post('/api/blocks/:id', (q, s) => {
  const id = Number(q.params.id);
  if (id === q.uid || !user(id)) return error(s, 400, 'Invalid user.');
  db.transaction(() => {
    db.prepare("DELETE FROM friends WHERE state!='blocked' AND ((a=? AND b=?) OR (a=? AND b=?))").run(q.uid, id, id, q.uid);
    db.prepare("INSERT OR REPLACE INTO friends VALUES(?,?,'blocked')").run(q.uid, id);
  })();
  for (const who of [q.uid, id]) for (const ws of clients.get(who) || []) if (ws.room) { const sid = chan(ws.room)?.server_id; if (sid && isDm(sid) && role(sid, q.uid) && role(sid, id)) leaveRoom(ws); }
  friendsEvent(q.uid, id); s.json({});
});
app.delete('/api/blocks/:id', (q, s) => { const id = Number(q.params.id); db.prepare("DELETE FROM friends WHERE a=? AND b=? AND state='blocked'").run(q.uid, id); friendsEvent(q.uid, id); s.json({}); });

function unread(cid, uid) {
  const r = db.prepare('SELECT last_id FROM reads WHERE user_id=? AND channel_id=?').get(uid, cid);
  if (!r) { db.prepare('INSERT INTO reads VALUES(?,?,(SELECT COALESCE(MAX(id),0) FROM messages WHERE channel_id=?))').run(uid, cid, cid); return { unread: 0, mentions: 0 }; }
  const messages = db.prepare('SELECT content FROM messages WHERE channel_id=? AND id>? AND user_id!=?').all(cid, r.last_id, uid);
  const un = user(uid).username.toLowerCase();
  const mention = new RegExp('(^|[^a-z0-9_.])@' + un.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9_.])', 'i');
  return { unread: messages.length, mentions: messages.filter(m => mention.test(m.content)).length };
}
function roomUsers(cid) { return [...(rooms.get(cid)?.keys() || [])]; }
app.get('/api/servers', (q, s) => {
  const list = db.prepare('SELECT v.*,m.role FROM servers v JOIN members m ON m.server_id=v.id WHERE m.user_id=? ORDER BY v.id').all(q.uid);
  s.json(list.map(v => {
    const other = v.type === 'dm' ? db.prepare('SELECT u.* FROM members m JOIN users u ON u.id=m.user_id WHERE m.server_id=? AND m.user_id!=?').get(v.id, q.uid) : null;
    return { ...v, name: other?.display || v.name, peer: publicUser(other), blocked: v.type === 'dm' && dmBlocked(v.id), channels: db.prepare('SELECT * FROM channels WHERE server_id=? ORDER BY id').all(v.id).map(c => ({ ...c, users: roomUsers(c.id), ...unread(c.id, q.uid) })) };
  }));
});
app.post('/api/servers', (q, s) => {
  const name = clean(q.body.name, 50);
  if (!name) return error(s, 400, 'Server name is required.');
  const id = db.transaction(() => {
    const id = db.prepare('INSERT INTO servers(name,owner) VALUES(?,?)').run(name, q.uid).lastInsertRowid;
    db.prepare("INSERT INTO members(server_id,user_id,role) VALUES(?,?,'owner')").run(id, q.uid);
    db.prepare("INSERT INTO channels(server_id,name) VALUES(?,'general')").run(id);
    return id;
  })();
  send(q.uid, { t: 'servers' }); s.json({ id });
});
app.patch('/api/servers/:id', (q, s) => {
  const sid = Number(q.params.id), name = clean(q.body.name, 50);
  if (role(sid, q.uid) !== 'owner' || isDm(sid)) return error(s, 403, 'Only the server owner can rename it.');
  if (!name) return error(s, 400, 'Name is required.');
  db.prepare('UPDATE servers SET name=? WHERE id=?').run(name, sid); bc(sid, { t: 'servers' }); s.json({});
});
app.get('/api/servers/:id/members', (q, s) => {
  if (!role(q.params.id, q.uid)) return error(s, 403, 'Join this server first.');
  s.json(db.prepare('SELECT u.*,m.role,m.timeout_until FROM members m JOIN users u ON u.id=m.user_id WHERE m.server_id=? ORDER BY u.display COLLATE NOCASE').all(q.params.id).map(u => ({ ...publicUser(u), role: u.role, timeout_until: u.timeout_until })));
});
app.post('/api/servers/:id/channels', (q, s) => {
  const sid = Number(q.params.id);
  if (!isAdmin(role(sid, q.uid)) || isDm(sid)) return error(s, 403, 'An administrator role is required.');
  const name = clean(q.body.name, 40).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!name) return error(s, 400, 'Channel name is required.');
  const type = q.body.type === 'voice' ? 'voice' : 'text';
  const id = db.prepare('INSERT INTO channels(server_id,name,type,topic) VALUES(?,?,?,?)').run(sid, name, type, clean(q.body.topic, 200)).lastInsertRowid;
  bc(sid, { t: 'channel', channel: { ...chan(id), users: [] } }); s.json({ id });
});
app.post('/api/servers/:id/invites', (q, s) => {
  const sid = Number(q.params.id);
  if (!role(sid, q.uid) || isDm(sid)) return error(s, 403, 'Server membership required.');
  const hours = Math.min(8760, Math.max(0, Number(q.body.hours) || 0)), max = Math.floor(Math.min(100000, Math.max(0, Number(q.body.max) || 0)));
  const code = crypto.randomBytes(8).toString('hex');
  db.prepare('INSERT INTO invites(code,server_id,expires,max) VALUES(?,?,?,?)').run(code, sid, hours ? Date.now() + hours * 36e5 : 0, max);
  s.json({ code });
});
app.post('/api/join/:code', (q, s) => {
  const inv = db.prepare('SELECT * FROM invites WHERE code=?').get(q.params.code);
  if (!inv || inv.expires && inv.expires < Date.now() || inv.max && inv.uses >= inv.max) return error(s, 404, 'Invalid, expired or fully used invite.');
  if (db.prepare('SELECT 1 FROM bans WHERE server_id=? AND user_id=?').get(inv.server_id, q.uid)) return error(s, 403, 'You are banned from this server.');
  if (!role(inv.server_id, q.uid)) db.transaction(() => {
    db.prepare("INSERT INTO members(server_id,user_id,role) VALUES(?,?,'member')").run(inv.server_id, q.uid);
    db.prepare('UPDATE invites SET uses=uses+1 WHERE code=?').run(inv.code);
  })();
  bc(inv.server_id, { t: 'members' }); send(q.uid, { t: 'servers' }); s.json({ id: inv.server_id });
});
function removeMember(sid, uid) {
  db.prepare('DELETE FROM members WHERE server_id=? AND user_id=?').run(sid, uid);
  for (const ws of clients.get(uid) || []) if (ws.room && chan(ws.room)?.server_id === sid) leaveRoom(ws);
  send(uid, { t: 'servers' }); bc(sid, { t: 'members' });
}
app.post('/api/servers/:id/leave', (q, s) => {
  const sid = Number(q.params.id);
  if (!role(sid, q.uid)) return error(s, 403, 'Not a member.');
  if (role(sid, q.uid) === 'owner') return error(s, 400, 'The owner cannot leave their server.');
  if (isDm(sid)) return error(s, 400, 'Use blocking to stop direct messages.');
  removeMember(sid, q.uid); s.json({});
});
app.post('/api/servers/:id/members/:uid/role', (q, s) => {
  const sid = Number(q.params.id), uid = Number(q.params.uid);
  if (role(sid, q.uid) !== 'owner' || uid === q.uid || !role(sid, uid) || !['admin', 'member'].includes(q.body.role)) return error(s, 403, 'Only the owner can change other members’ roles.');
  db.prepare('UPDATE members SET role=? WHERE server_id=? AND user_id=?').run(q.body.role, sid, uid);
  log(sid, q.uid, 'changed role for', uid, q.body.role); bc(sid, { t: 'members' }); send(uid, { t: 'servers' }); s.json({});
});
function hierarchy(q, s) {
  const sid = Number(q.params.id), uid = Number(q.params.uid), me = role(sid, q.uid), target = role(sid, uid);
  if (!isAdmin(me) || !target || target === 'owner' || uid === q.uid || target === 'admin' && me !== 'owner' || isDm(sid)) { error(s, 403, 'You cannot moderate this member.'); return null; }
  return { sid, uid };
}
for (const action of ['kick', 'ban', 'timeout']) app.post(`/api/servers/:id/members/:uid/${action}`, (q, s) => {
  const target = hierarchy(q, s); if (!target) return;
  const { sid, uid } = target;
  if (action === 'timeout') {
    const minutes = Math.min(40320, Math.max(0, Number(q.body.minutes) || 0));
    db.prepare('UPDATE members SET timeout_until=? WHERE server_id=? AND user_id=?').run(minutes ? Date.now() + minutes * 60000 : 0, sid, uid);
    if (minutes) for (const ws of clients.get(uid) || []) if (chan(ws.room || 0)?.server_id === sid) leaveRoom(ws);
    log(sid, q.uid, minutes ? 'timed out' : 'removed timeout for', uid, `${minutes} minutes`); bc(sid, { t: 'members' });
  } else {
    if (action === 'ban') db.prepare('INSERT OR REPLACE INTO bans VALUES(?,?)').run(sid, uid);
    removeMember(sid, uid); log(sid, q.uid, action === 'ban' ? 'banned' : 'kicked', uid);
  }
  s.json({});
});
app.get('/api/servers/:id/modlog', (q, s) => {
  if (!isAdmin(role(q.params.id, q.uid))) return error(s, 403, 'Administrator role required.');
  const name = id => user(id)?.display || 'Deleted user';
  s.json({ log: db.prepare('SELECT * FROM modlog WHERE server_id=? ORDER BY id DESC LIMIT 50').all(q.params.id).map(l => ({ when: l.created, text: `${name(l.actor)} ${l.action}${l.target ? ' ' + name(l.target) : ''}${l.note ? ' — ' + l.note : ''}` })), bans: db.prepare('SELECT user_id id FROM bans WHERE server_id=?').all(q.params.id).map(b => ({ id: b.id, name: name(b.id) })) });
});
app.delete('/api/servers/:id/bans/:uid', (q, s) => {
  if (!isAdmin(role(q.params.id, q.uid))) return error(s, 403, 'Administrator role required.');
  db.prepare('DELETE FROM bans WHERE server_id=? AND user_id=?').run(q.params.id, q.params.uid);
  log(Number(q.params.id), q.uid, 'unbanned', Number(q.params.uid)); s.json({});
});
app.post('/api/dm/:id', (q, s) => {
  const id = Number(q.params.id);
  if (id === q.uid || !user(id)) return error(s, 404, 'User not found.');
  if (blocked(q.uid, id)) return error(s, 403, 'Direct messaging is unavailable for this user.');
  if (!relations(q.uid, id).some(x => x.state === 'friends') && !mutualServers(q.uid, id).length) return error(s, 403, 'Be friends or share a server to start a conversation.');
  let dm = db.prepare("SELECT v.id FROM servers v JOIN members a ON a.server_id=v.id JOIN members b ON b.server_id=v.id WHERE v.type='dm' AND a.user_id=? AND b.user_id=?").get(q.uid, id);
  if (!dm) dm = { id: db.transaction(() => {
    const sid = db.prepare("INSERT INTO servers(name,owner,type) VALUES('dm',0,'dm')").run().lastInsertRowid;
    for (const uid of [q.uid, id]) db.prepare("INSERT INTO members(server_id,user_id,role) VALUES(?,?,'member')").run(sid, uid);
    db.prepare("INSERT INTO channels(server_id,name) VALUES(?,'dm')").run(sid); return sid;
  })() };
  bc(dm.id, { t: 'dm' }); s.json({ id: dm.id });
});
function access(q, s, write = false, cid = q.params.id) {
  const c = chan(cid), mem = c && db.prepare('SELECT * FROM members WHERE server_id=? AND user_id=?').get(c.server_id, q.uid);
  if (!mem) { error(s, 403, 'You do not have access to this channel.'); return null; }
  if (write && (dmBlocked(c.server_id) || mem.timeout_until > Date.now())) { error(s, 403, dmBlocked(c.server_id) ? 'Direct messaging is blocked.' : 'You are currently timed out.'); return null; }
  return { c, r: mem.role, mem };
}
function mine(q, s, write = false) {
  const m = db.prepare('SELECT * FROM messages WHERE id=?').get(q.params.id);
  if (!m) { error(s, 404, 'Message not found.'); return null; }
  const a = access(q, s, write, m.channel_id); return a && { ...a, m };
}
function messageOut(m) {
  const reply = m.reply_to && db.prepare('SELECT x.id,x.content,u.display FROM messages x JOIN users u ON u.id=x.user_id WHERE x.id=? AND x.channel_id=?').get(m.reply_to, m.channel_id);
  const poll = db.prepare('SELECT * FROM polls WHERE message_id=?').get(m.id);
  let pollOut = null;
  if (poll) {
    const votes = db.prepare('SELECT user_id,choice FROM poll_votes WHERE message_id=?').all(m.id);
    pollOut = { question: poll.question, closed: !!poll.closed, total: votes.length, options: JSON.parse(poll.options).map((text, i) => ({ text, voters: votes.filter(v => v.choice === i).map(v => v.user_id) })) };
  }
  return { ...m, author: U(m.user_id), reply: reply || null, reactions: db.prepare('SELECT emoji,COUNT(*) n,GROUP_CONCAT(user_id) users FROM reactions WHERE message_id=? GROUP BY emoji').all(m.id), poll: pollOut, attachment: m.file ? db.prepare('SELECT name,size FROM uploads WHERE file=?').get(m.file) || { name: m.file } : null };
}
function changed(m) { const c = chan(m.channel_id); if (c) bc(c.server_id, { t: 'edit', m: messageOut(m) }); }
app.get('/api/channels/:id/messages', (q, s) => {
  const a = access(q, s); if (!a) return;
  const before = Number(q.query.before) || Number.MAX_SAFE_INTEGER;
  const query = clean(q.query.q, 200).replace(/[%_\\]/g, '\\$&');
  s.json(db.prepare("SELECT * FROM messages WHERE channel_id=? AND id<? AND content LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 50").all(a.c.id, before, `%${query}%`).reverse().map(messageOut));
});
app.post('/api/channels/:id/messages', (q, s) => {
  const a = access(q, s, true); if (!a) return;
  if (a.c.slow && !isAdmin(a.r)) {
    const latest = db.prepare('SELECT MAX(created) t FROM messages WHERE channel_id=? AND user_id=?').get(a.c.id, q.uid).t || 0;
    const wait = latest + a.c.slow * 1000 - Date.now();
    if (wait > 0) return error(s, 429, `Slow mode: wait ${Math.ceil(wait / 1000)} seconds.`);
  }
  const recent = (hits.get(q.uid) || []).filter(t => Date.now() - t < 10000);
  if (recent.length >= 8) return error(s, 429, 'You are sending messages too quickly. Wait a few seconds.');
  const content = clean(q.body.content, 4000), file = q.body.file || null, poll = q.body.poll;
  if (file && (typeof file !== 'string' || !fileName.test(file) || !db.prepare('SELECT 1 FROM uploads WHERE file=? AND user_id=?').get(file, q.uid))) return error(s, 400, 'Upload the attachment from your account first.');
  if (poll && (!clean(poll.question, 200) || !Array.isArray(poll.options) || poll.options.length < 2 || poll.options.length > 8 || poll.options.some(x => typeof x !== 'string' || !x.trim() || x.trim().length > 100) || new Set(poll.options.map(x => x.trim().toLowerCase())).size !== poll.options.length)) return error(s, 400, 'A poll needs a question and 2–8 distinct options (100 characters each).');
  if (!content && !file && !poll) return error(s, 400, 'Write a message or add an attachment.');
  const reply = db.prepare('SELECT id FROM messages WHERE id=? AND channel_id=?').get(Number(q.body.reply_to) || 0, a.c.id)?.id || null;
  const id = db.transaction(() => {
    const id = db.prepare('INSERT INTO messages(channel_id,user_id,content,file,created,reply_to) VALUES(?,?,?,?,?,?)').run(a.c.id, q.uid, content || (poll ? clean(poll.question, 200) : ''), file, Date.now(), reply).lastInsertRowid;
    if (poll) db.prepare('INSERT INTO polls(message_id,question,options) VALUES(?,?,?)').run(id, clean(poll.question, 200), JSON.stringify(poll.options.map(x => x.trim())));
    return id;
  })();
  recent.push(Date.now()); hits.set(q.uid, recent);
  const m = messageOut(db.prepare('SELECT * FROM messages WHERE id=?').get(id));
  bc(a.c.server_id, { t: 'msg', m }); s.json(m);
});
app.patch('/api/messages/:id', (q, s) => {
  const a = mine(q, s, true); if (!a) return;
  if (a.m.user_id !== q.uid) return error(s, 403, 'Only the author can edit a message.');
  if (db.prepare('SELECT 1 FROM polls WHERE message_id=?').get(a.m.id)) return error(s, 400, 'Polls cannot be edited after posting.');
  const content = clean(q.body.content, 4000);
  if (!content && !a.m.file) return error(s, 400, 'Message cannot be empty.');
  db.prepare('UPDATE messages SET content=?,edited=1 WHERE id=?').run(content, a.m.id);
  changed(db.prepare('SELECT * FROM messages WHERE id=?').get(a.m.id)); s.json({});
});
app.delete('/api/messages/:id', (q, s) => {
  const a = mine(q, s); if (!a) return;
  if (a.m.user_id !== q.uid && !isAdmin(a.r)) return error(s, 403, 'Only the author or an administrator can delete this message.');
  db.transaction(() => {
    for (const table of ['reactions', 'bookmarks', 'poll_votes', 'polls']) db.prepare(`DELETE FROM ${table} WHERE message_id=?`).run(a.m.id);
    db.prepare('UPDATE messages SET reply_to=NULL WHERE reply_to=?').run(a.m.id);
    db.prepare('DELETE FROM messages WHERE id=?').run(a.m.id);
  })();
  bc(a.c.server_id, { t: 'del', id: a.m.id, channel_id: a.c.id }); s.json({});
});
const emojiList = ['👍', '❤️', '😂', '🎉', '🔥', '👀', '✅', '🚀', '💜', '😮', '😢', '👎'];
app.post('/api/messages/:id/react', (q, s) => {
  const a = mine(q, s, true); if (!a) return;
  const emoji = q.body.emoji;
  if (!emojiList.includes(emoji)) return error(s, 400, 'Choose an emoji from the reaction picker.');
  if (!db.prepare('DELETE FROM reactions WHERE message_id=? AND user_id=? AND emoji=?').run(a.m.id, q.uid, emoji).changes) db.prepare('INSERT INTO reactions VALUES(?,?,?)').run(a.m.id, q.uid, emoji);
  changed(a.m); s.json({});
});
app.post('/api/messages/:id/pin', (q, s) => {
  const a = mine(q, s, true); if (!a) return;
  if (!isAdmin(a.r) && !isDm(a.c.server_id)) return error(s, 403, 'Administrator role required to pin messages.');
  db.prepare('UPDATE messages SET pinned=1-pinned WHERE id=?').run(a.m.id);
  changed(db.prepare('SELECT * FROM messages WHERE id=?').get(a.m.id)); s.json({});
});
app.get('/api/channels/:id/pins', (q, s) => { const a = access(q, s); if (a) s.json(db.prepare('SELECT * FROM messages WHERE channel_id=? AND pinned=1 ORDER BY id DESC').all(a.c.id).map(messageOut)); });
app.post('/api/messages/:id/vote', (q, s) => {
  const a = mine(q, s, true); if (!a) return;
  const poll = db.prepare('SELECT * FROM polls WHERE message_id=?').get(a.m.id), choice = q.body.choice;
  if (!poll || poll.closed) return error(s, 400, 'This poll is unavailable or closed.');
  if (!Number.isInteger(choice) || choice < 0 || choice >= JSON.parse(poll.options).length) return error(s, 400, 'Invalid poll choice.');
  db.prepare('INSERT OR REPLACE INTO poll_votes VALUES(?,?,?)').run(a.m.id, q.uid, choice);
  changed(a.m); s.json({});
});
app.post('/api/messages/:id/poll/close', (q, s) => {
  const a = mine(q, s, true); if (!a) return;
  if (a.m.user_id !== q.uid && !isAdmin(a.r)) return error(s, 403, 'Only the author or an administrator can close this poll.');
  db.prepare('UPDATE polls SET closed=1 WHERE message_id=?').run(a.m.id); changed(a.m); s.json({});
});
app.get('/api/bookmarks', (q, s) => s.json(db.prepare('SELECT x.*,v.id server_id,v.name server_name,c.name channel_name FROM bookmarks b JOIN messages x ON x.id=b.message_id JOIN channels c ON c.id=x.channel_id JOIN servers v ON v.id=c.server_id JOIN members m ON m.server_id=v.id AND m.user_id=b.user_id WHERE b.user_id=? ORDER BY b.created DESC LIMIT 100').all(q.uid).map(messageOut)));
app.post('/api/messages/:id/bookmark', (q, s) => {
  const a = mine(q, s); if (!a) return;
  const removed = db.prepare('DELETE FROM bookmarks WHERE user_id=? AND message_id=?').run(q.uid, a.m.id).changes;
  if (!removed) db.prepare('INSERT INTO bookmarks VALUES(?,?,?)').run(q.uid, a.m.id, Date.now());
  send(q.uid, { t: 'bookmarks' }); s.json({ saved: !removed });
});
app.post('/api/channels/:id/read', (q, s) => {
  const a = access(q, s); if (!a) return;
  const max = db.prepare('SELECT COALESCE(MAX(id),0) id FROM messages WHERE channel_id=?').get(a.c.id).id;
  const last = Number.isSafeInteger(q.body.last_id) ? Math.min(max, Math.max(0, q.body.last_id)) : max;
  db.prepare('INSERT INTO reads VALUES(?,?,?) ON CONFLICT(user_id,channel_id) DO UPDATE SET last_id=MAX(last_id,excluded.last_id)').run(q.uid, a.c.id, last);
  send(q.uid, { t: 'read', channel: a.c.id }); s.json({});
});
app.patch('/api/channels/:id', (q, s) => {
  const a = access(q, s); if (!a) return;
  if (!isAdmin(a.r) || isDm(a.c.server_id)) return error(s, 403, 'Administrator role required.');
  const slow = q.body.slow === undefined ? a.c.slow : Math.floor(Math.min(21600, Math.max(0, Number(q.body.slow) || 0)));
  const topic = clean(q.body.topic ?? a.c.topic, 200);
  const name = clean(q.body.name ?? a.c.name, 40).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!name) return error(s, 400, 'Channel name required.');
  db.prepare('UPDATE channels SET slow=?,topic=?,name=? WHERE id=?').run(slow, topic, name, a.c.id);
  log(a.c.server_id, q.uid, 'updated channel', 0, name); bc(a.c.server_id, { t: 'chupd', channel: a.c.id, slow, topic, name }); s.json({});
});
app.delete('/api/channels/:id', (q, s) => {
  const a = access(q, s); if (!a) return;
  if (!isAdmin(a.r) || isDm(a.c.server_id)) return error(s, 403, 'Administrator role required.');
  if (db.prepare('SELECT COUNT(*) n FROM channels WHERE server_id=?').get(a.c.server_id).n < 2) return error(s, 400, 'Keep at least one channel.');
  for (const ws of rooms.get(a.c.id)?.values() || []) leaveRoom(ws);
  db.transaction(() => {
    for (const table of ['reactions', 'bookmarks', 'poll_votes', 'polls']) db.prepare(`DELETE FROM ${table} WHERE message_id IN (SELECT id FROM messages WHERE channel_id=?)`).run(a.c.id);
    db.prepare('DELETE FROM messages WHERE channel_id=?').run(a.c.id);
    db.prepare('DELETE FROM reads WHERE channel_id=?').run(a.c.id);
    db.prepare('DELETE FROM channels WHERE id=?').run(a.c.id);
  })();
  bc(a.c.server_id, { t: 'chdel', channel: a.c.id, server_id: a.c.server_id }); s.json({});
});
app.post('/api/messages/:id/report', (q, s) => {
  const a = mine(q, s); if (!a) return;
  if (isDm(a.c.server_id)) return error(s, 400, 'For DMs, use Block user. Server reports go to server moderators.');
  log(a.c.server_id, q.uid, 'reported a message by', a.m.user_id, `${clean(q.body.reason, 150)} | ${a.m.content.slice(0, 80)}`); s.json({});
});
const storage = multer.diskStorage({ destination: uploadDir, filename: (q, f, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(f.originalname).toLowerCase()) });
function uploadMiddleware(profile) {
  return multer({ storage, limits: { fileSize: profile ? 8 * 1024 ** 2 : Math.min(1024, Math.max(1, Number(process.env.MAX_UPLOAD_MB) || 1024)) * 1024 ** 2 }, fileFilter: (q, f, cb) => {
    const allowed = profile ? /\.(png|jpe?g|gif|webp)$/i : /\.(png|jpe?g|gif|webp|mp3|ogg|wav|mp4|webm|pdf|txt|zip)$/i;
    cb(allowed.test(f.originalname) ? null : Error('This file type is not supported.'), allowed.test(f.originalname));
  } }).single('file');
}
for (const [route, profile] of [['/api/upload', false], ['/api/profile-media', true]]) app.post(route, uploadMiddleware(profile), (q, s) => {
  if (!q.file) return error(s, 400, 'Choose a file first.');
  if (profile && !imageBytes(q.file.path)) { fs.unlinkSync(q.file.path); return error(s, 400, 'The file is not a valid PNG, JPEG, GIF or WebP image.'); }
  db.prepare('INSERT INTO uploads VALUES(?,?,?,?,?)').run(q.file.filename, q.uid, path.basename(q.file.originalname).slice(0, 200), q.file.size, Date.now());
  s.json({ file: q.file.filename, name: q.file.originalname, size: q.file.size });
});
app.get('/api/ice', (q, s) => {
  let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
  try { if (process.env.ICE_SERVERS) iceServers = JSON.parse(process.env.ICE_SERVERS); } catch { return error(s, 500, 'ICE_SERVERS contains invalid JSON.'); }
  s.json({ iceServers });
});
app.use('/api', (q, s) => error(s, 404, 'API endpoint not found.'));
app.use('/files', express.static(uploadDir, { index: false, dotfiles: 'deny', setHeaders: (res, file) => {
  res.setHeader('Content-Disposition', /\.(png|jpe?g|gif|webp|mp3|ogg|wav|mp4|webm)$/i.test(file) ? 'inline' : 'attachment');
  res.setHeader('X-Content-Type-Options', 'nosniff');
} }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((e, q, s, n) => {
  if (s.headersSent) return n(e);
  if (e instanceof multer.MulterError) return error(s, 400, e.code === 'LIMIT_FILE_SIZE' ? 'File is too large for this upload.' : 'Upload failed.');
  if (e.type === 'entity.parse.failed') return error(s, 400, 'Invalid JSON.');
  if (e.code?.startsWith('SQLITE') || e instanceof TypeError) { console.error(e); return error(s, 500, 'Something went wrong. Try again.'); }
  error(s, 400, e.message || 'Invalid request.');
});
const wss = new WebSocketServer({ server: srv, path: '/ws', maxPayload: 65536 });
function leaveRoom(ws) {
  const cid = ws.room; if (!cid) return;
  ws.room = null;
  const room = rooms.get(cid); if (!room || room.get(ws.uid) !== ws) return;
  room.delete(ws.uid); if (!room.size) rooms.delete(cid);
  if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'voice-left', channel: cid }));
  for (const peer of room.values()) if (peer.readyState === 1) peer.send(JSON.stringify({ t: 'peer-left', channel: cid, user: ws.uid }));
  const c = chan(cid); if (c) bc(c.server_id, { t: 'voice', channel: cid, users: roomUsers(cid) });
}
wss.on('connection', (ws, request) => {
  try {
    const origin = request.headers.origin;
    if (origin && new URL(origin).host !== request.headers.host) throw Error();
    ws.uid = jwt.verify(new URL(request.url, 'http://local').searchParams.get('token'), SECRET).id;
    if (!Number.isSafeInteger(ws.uid) || !user(ws.uid)) throw Error();
  } catch { return ws.close(1008, 'Unauthorized'); }
  const uid = ws.uid;
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  if (!clients.has(uid)) clients.set(uid, new Set());
  clients.get(uid).add(ws); profileEvent(uid);
  ws.on('message', raw => {
    try {
      const j = JSON.parse(raw), c = chan(Number(j.channel) || 0);
      const mem = c && db.prepare('SELECT * FROM members WHERE server_id=? AND user_id=?').get(c.server_id, uid);
      const maySpeak = mem && mem.timeout_until <= Date.now() && !dmBlocked(c.server_id);
      if (j.t === 'typing' && maySpeak && Date.now() - (typingHits.get(uid) || 0) > 1500) { typingHits.set(uid, Date.now()); bc(c.server_id, { t: 'typing', channel: c.id, user: uid }, uid); }
      else if (j.t === 'join') {
        if (!maySpeak || (c.type !== 'voice' && !isDm(c.server_id))) return ws.send(JSON.stringify({ t: 'error', msg: 'You cannot join this voice channel.' }));
        if (rooms.get(c.id)?.size >= 8 && !rooms.get(c.id).has(uid)) return ws.send(JSON.stringify({ t: 'error', msg: 'This call is full (8 people maximum).' }));
        leaveRoom(ws);
        const previous = rooms.get(c.id)?.get(uid); if (previous) leaveRoom(previous);
        let room = rooms.get(c.id); if (!room) rooms.set(c.id, room = new Map());
        const peers = [...room.keys()]; room.set(uid, ws); ws.room = c.id;
        ws.send(JSON.stringify({ t: 'peers', channel: c.id, peers })); bc(c.server_id, { t: 'voice', channel: c.id, users: roomUsers(c.id) });
      } else if (j.t === 'leave') leaveRoom(ws);
      else if (j.t === 'sig' && maySpeak && ws.room === c.id) {
        const peer = rooms.get(c.id)?.get(Number(j.to));
        if (peer?.readyState === 1 && JSON.stringify(j.data).length < 30000) peer.send(JSON.stringify({ t: 'sig', channel: c.id, from: uid, data: j.data }));
      }
    } catch { /* Invalid socket frames are ignored. */ }
  });
  ws.on('close', () => {
    leaveRoom(ws); clients.get(uid)?.delete(ws);
    if (!clients.get(uid)?.size) { clients.delete(uid); hits.delete(uid); typingHits.delete(uid); }
    profileEvent(uid);
  });
});
const heartbeat = setInterval(() => { for (const ws of wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } } }, 30000);
heartbeat.unref();
srv.listen(Number(process.env.PORT) || 3000, '0.0.0.0', () => console.log(`Biscord running at http://localhost:${process.env.PORT || 3000}`));
function shutdown() { clearInterval(heartbeat); for (const ws of wss.clients) ws.terminate(); srv.close(() => { db.close(); process.exit(0); }); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
