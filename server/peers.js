// Wisp-to-Wisp: your Wisp can talk with friends' Wisps (on their own machines) to coordinate plans,
// under sharing rules you set for each friend. Friends reach a separate port that serves only
// /peer/*, never the Wisps app or its API. Pairing is an invite code you send them yourself.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { state, save, id, now, getWisp, DATA_DIR } from './store.js';
import { secrets, setSecret } from './connectors/index.js';
import * as engine from './engine.js';

export const PEER_PORT = Number(process.env.PEER_PORT || 4778);
const MAX_TEXT = 4000;
const PER_HOUR = 40; // messages a friend's Wisp may send yours per hour
export const DEFAULT_SHARE = "Whether I'm free or busy at a given time (not what I'm doing or where).";

export const contacts = () => (state.contacts ||= []);
export const getContact = (cid) => contacts().find((c) => c.id === cid);
export const findContact = (q) => { const s = String(q || '').trim().toLowerCase(); return contacts().find((c) => c.id === q || c.name.toLowerCase() === s) || contacts().find((c) => c.name.toLowerCase().startsWith(s) && s); };
export const settings = () => (state.settings.peer ||= { publicUrl: '', name: '' });
export const publicUrl = () => settings().publicUrl || process.env.PEER_PUBLIC_URL || '';
export const ownerName = () => settings().name || state.settings.telegram.people.find((p) => p.canApprove)?.name || 'my owner';

const hash = (t) => crypto.createHash('sha256').update(String(t)).digest();
const newToken = () => crypto.randomBytes(24).toString('base64url');
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const validUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href.replace(/\/+$/, '') : null; } catch { return null; } };

// ---- conversation log (so you can always see what was said for you) ---------------
const logFile = (cid) => path.join(DATA_DIR, 'peers', `${cid}.jsonl`);
export function log(cid, entry) {
  fs.mkdirSync(path.dirname(logFile(cid)), { recursive: true });
  fs.appendFileSync(logFile(cid), JSON.stringify({ at: now(), ...entry }) + '\n');
  const c = getContact(cid);
  if (c) { c.lastAt = now(); save(); }
}
export function readLog(cid, limit = 200) {
  try { return fs.readFileSync(logFile(cid), 'utf8').split('\n').filter(Boolean).slice(-limit).map((l) => JSON.parse(l)); } catch { return []; }
}

// ---- pairing -----------------------------------------------------------------------
const encode = (o) => `wisp1.${Buffer.from(JSON.stringify(o)).toString('base64url')}`;
function decode(code) {
  const m = /^wisp1\.([\w-]+)$/.exec(String(code || '').trim());
  if (!m) throw fail("That doesn't look like a Wisps invite code (it starts with wisp1.).");
  try { return JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch { throw fail('That invite code is damaged. Ask for a new one.'); }
}
const newContact = (o) => ({ id: id('k'), name: 'Friend', url: null, wispId: state.settings.telegram.defaultWispId || state.wisps[0]?.id || null, share: DEFAULT_SHARE, sendApproval: 'ask', availability: true, status: 'invited', createdAt: now(), ...o });

// You invite a friend: they paste this code into their Wisps.
export function createInvite({ name, wispId }) {
  if (!publicUrl()) throw fail('First set the address where friends can reach your Wisps (see "Your peer address").');
  const token = newToken();
  const c = newContact({ name: String(name || '').trim().slice(0, 60) || 'Friend', ...(getWisp(wispId) ? { wispId } : {}) });
  contacts().push(c);
  setSecret(`peer:in:${c.id}`, hash(token).toString('hex'));
  save();
  return { contact: c, code: encode({ v: 1, url: publicUrl(), token, name: ownerName() }) };
}

// A friend invited you: pair with their Wisps and hand them a way to reach yours.
export async function acceptInvite(code, { wispId } = {}) {
  const inv = decode(code);
  const url = validUrl(inv.url);
  if (!url || !inv.token) throw fail('That invite code is missing its address. Ask for a new one.');
  if (!publicUrl()) throw fail('First set the address where friends can reach your Wisps, so their Wisp can reply.');
  const token = newToken();
  const c = newContact({ name: String(inv.name || 'Friend').slice(0, 60), url, status: 'linked', ...(getWisp(wispId) ? { wispId } : {}) });
  const r = await call(url, '/peer/pair', inv.token, { url: publicUrl(), token, name: ownerName() }, 20000)
    .catch((e) => { throw fail(e.remote ? e.message : `Couldn't reach their Wisps at ${url}: ${e.message}`); });
  if (!r.ok) throw fail(r.error || 'Their Wisps refused the invite. It may have been used already.');
  contacts().push(c);
  setSecret(`peer:out:${c.id}`, inv.token);
  setSecret(`peer:in:${c.id}`, hash(token).toString('hex'));
  save();
  return c;
}

export function removeContact(cid) {
  state.contacts = contacts().filter((c) => c.id !== cid);
  setSecret(`peer:in:${cid}`, null); setSecret(`peer:out:${cid}`, null);
  save();
}

// ---- talking to a friend's Wisp ---------------------------------------------------------
async function call(base, p, token, body, timeoutMs = 240000) {
  const r = await fetch(`${base}${p}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `HTTP ${r.status}`), { remote: true });
  return j;
}

export async function send(contact, { conversation, text, fromWisp }) {
  const token = secrets()[`peer:out:${contact.id}`];
  if (contact.status !== 'linked' || !token || !contact.url) throw new Error(`${contact.name} hasn't accepted the invite yet.`);
  log(contact.id, { dir: 'out', conversation, wisp: fromWisp.name, text });
  const r = await call(contact.url, '/peer/message', token, { conversation, text: String(text).slice(0, MAX_TEXT), from: { name: ownerName(), wisp: fromWisp.name } });
  const reply = String(r.reply || '').slice(0, MAX_TEXT);
  log(contact.id, { dir: 'in', conversation, wisp: r.wisp || '', text: reply });
  return reply;
}

// ---- the peer port -------------------------------------------------------------------------
function authContact(req) {
  const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const h = hash(m[1]);
  return contacts().find((c) => {
    const s = secrets()[`peer:in:${c.id}`];
    return s && s.length === 64 && crypto.timingSafeEqual(Buffer.from(s, 'hex'), h);
  }) || null;
}

const recent = new Map(); // contactId -> timestamps
function limited(cid) {
  const t = (recent.get(cid) || []).filter((x) => Date.now() - x < 3600e3);
  t.push(Date.now()); recent.set(cid, t);
  return t.length > PER_HOUR;
}

const plain = (v, n) => String(v || '').replace(/[^\p{L}\p{N} .'-]/gu, '').slice(0, n); // names from the other side go into prompts
const queues = new Map(); // contactId -> Promise chain, one message at a time per friend
async function onMessage(c, b) {
  const text = String(b.text || '').trim().slice(0, MAX_TEXT);
  if (!text) throw fail('Empty message.');
  const conversation = String(b.conversation || 'default').replace(/[^\w-]/g, '').slice(0, 40) || 'default';
  const prev = queues.get(c.id) || Promise.resolve();
  const p = prev.catch(() => {}).then(() => engine.peerTurn(c, { conversation, text, from: { name: plain(b.from?.name || c.name, 60), wisp: plain(b.from?.wisp, 40) } }));
  queues.set(c.id, p);
  return p;
}

const readBody = (req) => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', (d) => { s += d; if (s.length > 20000) { reject(fail('Too large', 413)); req.destroy(); } });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(fail('Bad JSON')); } });
});

export function startPeerServer() {
  const srv = http.createServer(async (req, res) => {
    const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const p = new URL(req.url, 'http://x').pathname;
    if (req.method !== 'POST' || !['/peer/pair', '/peer/message'].includes(p)) return reply(404, { error: 'Not found' });
    try {
      const b = await readBody(req);
      const c = authContact(req);
      if (!c) return reply(401, { error: 'Unknown Wisp. Ask its owner for a new invite.' });
      if (p === '/peer/pair') {
        if (c.status !== 'invited') return reply(409, { ok: false, error: 'This invite was already used. Ask for a new one.' });
        const url = validUrl(b.url);
        if (!url || !b.token) return reply(400, { ok: false, error: 'Missing address.' });
        Object.assign(c, { url, status: 'linked', theirName: String(b.name || '').slice(0, 60) });
        setSecret(`peer:out:${c.id}`, String(b.token));
        save();
        return reply(200, { ok: true, name: ownerName() });
      }
      if (c.status !== 'linked') return reply(409, { error: 'Not paired yet.' });
      if (limited(c.id)) return reply(429, { error: 'Too many messages. Try again later.' });
      const r = await onMessage(c, b);
      return reply(200, r);
    } catch (e) {
      if (!e.status) console.error('[peers]', e);
      return reply(e.status || 500, { error: e.status ? e.message : 'Something went wrong on this Wisp.' });
    }
  });
  srv.on('error', (e) => console.error(`[peers] couldn't open the peer port ${PEER_PORT}: ${e.message}`));
  srv.listen(PEER_PORT, process.env.HOST || '127.0.0.1', () => console.log(`Friends' Wisps can reach this one on port ${PEER_PORT} (only /peer/*)`));
  return srv;
}

// Public view for the UI (contacts hold no secrets; tokens live in secrets.json)
export function publicView() {
  return { contacts: contacts(), peer: { ...settings(), publicUrl: publicUrl(), ownerName: ownerName(), port: PEER_PORT } };
}
