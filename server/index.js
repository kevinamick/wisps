// Wisps: local always-on agents powered by your Claude Code subscription.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  state, save, flush, bus, id, now, getWisp, getTask, snapshot, ensureWispDirs, computerDir,
  readChat, readActivity, readMemory, writeMemory, DATA_DIR,
} from './store.js';
import * as engine from './engine.js';
import { startScheduler } from './scheduler.js';
import * as telegram from './telegram.js';
import * as connectors from './connectors/index.js';
import * as google from './connectors/google.js';
import * as play from './connectors/play.js';
import * as amazon from './connectors/amazon.js';
import * as signin from './browser-session.js';

const PORT = Number(process.env.PORT || 4777);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const NM = path.join(ROOT, 'node_modules');

const VENDOR = {
  'preact.js': 'preact/dist/preact.module.js',
  'hooks.js': 'preact/hooks/dist/hooks.module.js',
  'htm.js': 'htm/dist/htm.module.js',
  'marked.js': 'marked/lib/marked.esm.js',
  'purify.js': 'dompurify/dist/purify.es.mjs',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

// ---- helpers ---------------------------------------------------------------
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 2e6) reject(new Error('too large')); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
});
const fullSnapshot = () => ({ ...snapshot(), live: engine.live, telegram: telegram.tg, connectors: connectors.publicList(), amazonWatches: state.amazonWatches || [], googleClient: !!connectors.secrets()['google:clientId'], dataDir: DATA_DIR });

// Local-only app that can run commands: refuse other hosts (DNS rebinding) and cross-site writes.
// Extra host names Wisps may be reached by, e.g. its Tailscale name (ALLOWED_HOSTS=wisps-vm.tailnet.ts.net).
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', ...String(process.env.ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean)]);
function trusted(req) {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!ALLOWED_HOSTS.has(host) && HOST === '127.0.0.1') return false;
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return false;
  }
  return true;
}

const clamp = (s, n) => String(s ?? '').slice(0, n);
const MODELS = new Set(['opus', 'sonnet', 'haiku']);
const MODES = new Set(['ask', 'balanced', 'autonomous']);

function applyWispFields(wisp, b) {
  if (b.name !== undefined) wisp.name = clamp(b.name, 40).trim() || wisp.name;
  if (b.role !== undefined) wisp.role = clamp(b.role, 200);
  if (b.persona !== undefined) wisp.persona = clamp(b.persona, 4000);
  if (b.goals !== undefined) wisp.goals = clamp(b.goals, 4000);
  if (b.model !== undefined && MODELS.has(b.model)) wisp.model = b.model;
  if (b.autonomy !== undefined && MODES.has(b.autonomy)) wisp.autonomy = b.autonomy;
  if (b.avatar !== undefined) wisp.avatar = { hue: Number(b.avatar.hue) || 0, hue2: Number(b.avatar.hue2) || 0, face: clamp(b.avatar.face, 20) || 'wisps', glow: !!b.avatar.glow };
  if (Array.isArray(b.rules)) wisp.rules = b.rules.filter((r) => r?.pattern && ['allow', 'ask', 'deny'].includes(r.behavior)).map((r) => ({ pattern: clamp(r.pattern, 300), behavior: r.behavior }));
  if (Array.isArray(b.grants)) wisp.grants = b.grants.map((g) => clamp(g, 500).trim()).filter(Boolean).map((g) => g.replace(/^~/, os.homedir()));
  if (b.heartbeat !== undefined) wisp.heartbeat = { ...wisp.heartbeat, enabled: !!b.heartbeat.enabled, everyMin: Math.max(15, Number(b.heartbeat.everyMin) || 120) };
  if (b.paused !== undefined) wisp.paused = !!b.paused;
  if (b.connectors && typeof b.connectors === 'object') wisp.connectors = Object.fromEntries(Object.entries(b.connectors).filter(([k]) => connectors.get(k)).map(([k, v]) => [k, !!v]));
}

function listFiles(wispId, rel = '') {
  const base = computerDir(wispId);
  const target = path.resolve(base, rel);
  if (!target.startsWith(base)) throw new Error('outside computer');
  const st = fs.statSync(target);
  if (st.isDirectory()) {
    const entries = fs.readdirSync(target, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => { const s = fs.statSync(path.join(target, e.name)); return { name: e.name, dir: e.isDirectory(), size: s.size, mtime: s.mtime }; })
      .sort((a, b) => (b.dir - a.dir) || (new Date(b.mtime) - new Date(a.mtime)));
    return { type: 'dir', path: path.relative(base, target), entries };
  }
  const buf = fs.readFileSync(target);
  const binary = buf.subarray(0, 8000).includes(0);
  return { type: 'file', path: path.relative(base, target), size: st.size, binary, content: binary ? null : buf.toString('utf8').slice(0, 400_000) };
}

// ---- routes ----------------------------------------------------------------
const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

route('GET', '/api/state', () => fullSnapshot());

route('POST', '/api/wisps', (b) => {
  const wisp = {
    id: id('wisp'), name: 'New Wisp', role: '', persona: '', goals: '', model: 'sonnet', autonomy: 'balanced',
    avatar: { hue: Math.floor(Math.random() * 360), hue2: Math.floor(Math.random() * 360), face: 'wisps', glow: true },
    rules: [], grants: [], heartbeat: { enabled: true, everyMin: 120 }, paused: false, chatSessionId: null, createdAt: now(),
  };
  applyWispFields(wisp, b);
  state.wisps.push(wisp);
  ensureWispDirs(wisp.id);
  if (!state.settings.telegram.defaultWispId) state.settings.telegram.defaultWispId = wisp.id;
  save();
  return wisp;
});
route('PATCH', '/api/wisps/:wispId', (b, { wispId }) => { const d = getWisp(wispId); if (!d) throw404(); applyWispFields(d, b); save(); engine.pump(); return d; });
route('DELETE', '/api/wisps/:wispId', (b, { wispId }) => {
  engine.stopWisp(wispId);
  state.wisps = state.wisps.filter((d) => d.id !== wispId);
  state.schedules = state.schedules.filter((s) => s.wispId !== wispId);
  state.tasks.forEach((t) => { if (t.wispId === wispId && ['queued', 'proposed'].includes(t.status)) t.status = 'cancelled'; });
  save();
  return { ok: true, note: `Files kept at ${path.join(DATA_DIR, 'wisps', wispId)}` };
});
route('POST', '/api/wisps/:wispId/stop', (b, { wispId }) => { engine.stopWisp(wispId); return { ok: true }; });
route('POST', '/api/wisps/:wispId/checkin', (b, { wispId }) => { engine.checkin(wispId); return { ok: true }; });

route('GET', '/api/wisps/:wispId/chat', (b, { wispId }) => readChat(wispId, 400));
route('POST', '/api/wisps/:wispId/chat', (b, { wispId }) => {
  const text = clamp(b.text, 20000).trim();
  if (!text) return { ok: false };
  engine.chat(wispId, text, { source: b.source === 'voice' ? 'voice' : 'web' });
  return { ok: true };
});
route('POST', '/api/wisps/:wispId/chat/reset', (b, { wispId }) => { engine.resetChat(wispId); return { ok: true }; });

route('GET', '/api/wisps/:wispId/memory', (b, { wispId }) => ({ text: readMemory(wispId) }));
route('PUT', '/api/wisps/:wispId/memory', (b, { wispId }) => { writeMemory(wispId, clamp(b.text, 50000)); return { ok: true }; });
route('POST', '/api/wisps/:wispId/memory/tidy', async (b, { wispId }) => { await engine.consolidate(wispId); return { text: readMemory(wispId) }; });

route('GET', '/api/wisps/:wispId/files', (b, { wispId }, url) => listFiles(wispId, url.searchParams.get('path') || ''));

route('POST', '/api/wisps/:wispId/tasks', (b, { wispId }) => {
  if (!getWisp(wispId)) throw404();
  return engine.createTask(wispId, { title: clamp(b.title, 200).trim() || 'Untitled task', detail: clamp(b.detail, 20000), source: 'you' });
});
route('GET', '/api/tasks/:taskId/activity', (b, { taskId }) => { const t = getTask(taskId); if (!t) throw404(); return readActivity(t.wispId, taskId); });
route('POST', '/api/tasks/:taskId/cancel', (b, { taskId }) => ({ ok: engine.cancelTask(taskId) }));
route('POST', '/api/tasks/:taskId/retry', (b, { taskId }) => engine.retryTask(taskId));
route('POST', '/api/tasks/:taskId/decide', (b, { taskId }) => ({ ok: engine.approveProposal(taskId, !!b.approve) }));
route('POST', '/api/tasks/:taskId/feedback', (b, { taskId }) => { engine.feedback(taskId, { rating: b.rating === 'down' ? 'down' : 'up', note: clamp(b.note, 2000) }); return { ok: true }; });

route('POST', '/api/inbox/:itemId/resolve', (b, { itemId }) => {
  const item = state.inbox.find((i) => i.id === itemId);
  if (!item) throw404();
  if (item.kind === 'approval') return { ok: engine.resolveApproval(itemId, ['allow', 'always', 'deny'].includes(b.decision) ? b.decision : 'deny', clamp(b.message, 1000)) };
  if (item.kind === 'proposal') return { ok: engine.approveProposal(item.taskId, b.decision === 'allow') };
  item.resolved = true; item.resolution = 'read'; save();
  return { ok: true };
});
route('POST', '/api/inbox/clear', () => { state.inbox.forEach((i) => { if (!['approval', 'proposal'].includes(i.kind)) i.resolved = true; }); save(); return { ok: true }; });

route('POST', '/api/schedules', (b) => {
  if (!getWisp(b.wispId)) throw404();
  const every = b.every?.kind === 'once' && !Number.isNaN(new Date(b.every.at).getTime()) ? { kind: 'once', at: b.every.at } : b.every?.kind === 'daily' ? { kind: 'daily', time: /^\d{1,2}:\d{2}$/.test(b.every.time) ? b.every.time : '08:00' } : { kind: 'interval', minutes: Math.max(15, Number(b.every?.minutes) || 60) };
  return engine.createSchedule(b.wispId, { title: clamp(b.title, 200) || 'Recurring task', detail: clamp(b.detail, 20000), every });
});
route('PATCH', '/api/schedules/:sid', (b, { sid }) => { const s = state.schedules.find((x) => x.id === sid); if (!s) throw404(); if (b.enabled !== undefined) s.enabled = !!b.enabled; save(); return s; });
route('DELETE', '/api/schedules/:sid', (b, { sid }) => { state.schedules = state.schedules.filter((x) => x.id !== sid); save(); return { ok: true }; });
route('POST', '/api/schedules/:sid/run', (b, { sid }) => { const s = state.schedules.find((x) => x.id === sid); if (!s) throw404(); return engine.createTask(s.wispId, { title: s.title, detail: s.detail, source: 'schedule', scheduleId: s.id }); });

route('PUT', '/api/telegram/token', async (b) => { await telegram.configure(clamp(b.token, 200)); return { ok: true }; });
route('POST', '/api/telegram/recheck', async () => { await telegram.recheck(); return { ok: true }; });
route('POST', '/api/telegram/people', (b) => {
  const t = state.settings.telegram;
  const u = b.userId && telegram.tg.unknown.find((x) => x.userId === b.userId);
  const p = telegram.newPerson({ name: clamp(b.name, 60).trim() || u?.name || 'Guest', canApprove: !!b.canApprove, userId: u ? u.userId : null, username: u?.username || '' });
  t.people.push(p);
  if (u) telegram.tg.unknown = telegram.tg.unknown.filter((x) => x.userId !== u.userId);
  save();
  return p;
});
route('PUT', '/api/telegram/config', (b) => {
  const t = state.settings.telegram;
  if (Array.isArray(b.people)) {
    // only name / approver / preferred Wisp are editable; identity comes from Telegram
    t.people = b.people.map((x) => { const p = t.people.find((y) => y.id === x.id); return p && { ...p, name: clamp(x.name, 60).trim() || p.name, canApprove: !!x.canApprove, wispId: getWisp(x.wispId) ? x.wispId : p.wispId }; }).filter(Boolean);
  }
  if (Array.isArray(b.groups)) t.groups = b.groups.map((x) => { const g = t.groups.find((y) => y.chatId === x.chatId); return g && { ...g, wispId: getWisp(x.wispId) ? x.wispId : g.wispId, replyToAll: !!x.replyToAll }; }).filter(Boolean);
  if (b.defaultWispId !== undefined && getWisp(b.defaultWispId)) t.defaultWispId = b.defaultWispId;
  if (b.updates !== undefined) t.updates = !!b.updates;
  save();
  return { ok: true };
});
route('POST', '/api/telegram/groups/connect', (b) => { const g = telegram.tg.pendingGroups.find((x) => x.chatId === b.chatId); if (!g) throw404(); telegram.connectGroup({ ...g, wispId: b.wispId }); return { ok: true }; });

// ---- connectors -------------------------------------------------------------
const REDIRECT = `http://127.0.0.1:${PORT}/oauth/google/callback`;
route('PUT', '/api/connectors/google/client', (b) => {
  const cid = clamp(b.clientId, 200).trim(), sec = clamp(b.clientSecret, 200).trim();
  if (!/\.apps\.googleusercontent\.com$/.test(cid)) { const e = new Error('That doesn’t look like a Google OAuth client ID (it ends in .apps.googleusercontent.com).'); e.status = 400; throw e; }
  if (!sec) { const e = new Error('Paste the client secret too.'); e.status = 400; throw e; }
  connectors.setSecret('google:clientId', cid); connectors.setSecret('google:clientSecret', sec);
  save(); return { ok: true };
});
route('DELETE', '/api/connectors/google/client', () => { connectors.setSecret('google:clientId', null); connectors.setSecret('google:clientSecret', null); save(); return { ok: true }; });
route('POST', '/api/connectors/google/auth', (b) => {
  const clientId = connectors.secrets()['google:clientId'];
  if (!clientId) { const e = new Error('Add your Google OAuth client first.'); e.status = 400; throw e; }
  return { url: google.authUrl({ clientId, redirectUri: REDIRECT, meta: { ownerId: b.ownerId || null, reconnect: b.reconnect || null } }) };
});
route('PATCH', '/api/connectors/:cid', (b, { cid }) => {
  const c = connectors.get(cid); if (!c) throw404();
  if (b.enabled !== undefined) c.enabled = !!b.enabled;
  if (b.access !== undefined) c.access = b.access === 'family' ? 'family' : 'private';
  if (b.ownerId !== undefined) c.ownerId = state.settings.telegram.people.some((p) => p.id === b.ownerId) ? b.ownerId : null;
  if (b.config) {
    if (c.type === 'weather') c.config = { units: b.config.units === 'celsius' ? 'celsius' : 'fahrenheit', home: clamp(b.config.home, 100) };
    if (c.type === 'mcp') c.config = { ...c.config, approval: b.config.approval === 'allow' ? 'allow' : 'ask', description: clamp(b.config.description ?? c.config.description, 300) };
  }
  save(); return c;
});
route('DELETE', '/api/connectors/:cid', (b, { cid }) => { connectors.remove(cid); return { ok: true }; });
route('POST', '/api/connectors/mcp', (b) => {
  const name = clamp(b.name, 40).trim();
  const url = clamp(b.url, 500).trim(), command = clamp(b.command, 300).trim();
  if (!name || (!url && !command)) { const e = new Error('Give it a name and either a command or a URL.'); e.status = 400; throw e; }
  const c = { type: 'mcp', key: connectors.slugKey(name), name, access: b.access === 'family' ? 'family' : 'private', config: { url: url || null, command: url ? null : command, args: url ? '' : clamp(b.args, 1000), approval: b.approval === 'allow' ? 'allow' : 'ask', description: clamp(b.description, 300) } };
  connectors.add(c);
  const added = connectors.list().at(-1);
  if (b.env?.trim()) connectors.setSecret(`env:${added.id}`, clamp(b.env, 5000));
  return added;
});
route('POST', '/api/connectors/budget', async (b) => {
  const url = clamp(b.url, 300).trim().replace(/\/+$/, ''), code = clamp(b.passcode, 200);
  if (!/^https?:\/\//.test(url) || !code) { const e = new Error('Add the page address and the family passcode.'); e.status = 400; throw e; }
  const r = await fetch(`${url}/api/state`, { headers: { 'x-family-code': code } }).catch(() => null);
  if (!r || r.status === 401) { const e = new Error(r ? 'The page rejected that passcode.' : 'Could not reach that address.'); e.status = 400; throw e; }
  let c = connectors.list().find((x) => x.type === 'budget');
  if (!c) { connectors.add({ type: 'budget', key: connectors.slugKey('budget'), name: 'Family budget', access: 'family', config: { url } }); c = connectors.list().at(-1); }
  else c.config = { ...c.config, url };
  connectors.setSecret(`budget:${c.id}`, code);
  save();
  return c;
});
route('POST', '/api/connectors/play', async (b) => {
  const pkg = clamp(b.packageName, 150).trim();
  if (!/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/.test(pkg)) { const e = new Error('Enter the app id, like com.example.app.'); e.status = 400; throw e; }
  const keyText = String(b.key || '');
  let email;
  try { email = play.parseKey(keyText).client_email; await play.verify(keyText, pkg); }
  catch (err) { const e = new Error(err.message); e.status = 400; throw e; }
  let c = connectors.list().find((x) => x.type === 'play' && x.config.packageName === pkg);
  if (!c) {
    const nice = pkg.split('.').filter((p) => !['app', 'com', 'mobile', 'android', 'io'].includes(p))[0] || pkg;
    connectors.add({ type: 'play', key: connectors.slugKey(`play_${nice}`), name: `Google Play: ${nice[0].toUpperCase()}${nice.slice(1)}`, access: 'private', ownerId: state.settings.telegram.people.find((p) => p.canApprove)?.id || null, config: { packageName: pkg } });
    c = connectors.list().at(-1);
  }
  c.config = { ...c.config, serviceAccount: email };
  connectors.setSecret(`play:${c.id}`, keyText);
  save();
  return c;
});
route('POST', '/api/connectors/amazon', (b) => {
  const g = connectors.get(b.googleId);
  if (!g || g.type !== 'google') { const e = new Error('Pick a connected Google account first.'); e.status = 400; throw e; }
  let c = connectors.list().find((x) => x.type === 'amazon');
  if (!c) { connectors.add({ type: 'amazon', key: 'amazon', name: 'Amazon', access: 'private', ownerId: g.ownerId || state.settings.telegram.people.find((p) => p.canApprove)?.id || null, config: {} }); c = connectors.list().at(-1); }
  c.config = { ...c.config, googleId: g.id };
  save(); return c;
});

// ---- "sign in to sites" in a Wisp's own browser -------------------------------
const browserConn = (b) => connectors.list().find((c) => c.type === 'browser' && c.id === b?.browser) || connectors.list().find((c) => c.type === 'browser' && !c.config.profile);
route('POST', '/api/wisps/:wispId/signin/start', async (b, { wispId }) => { if (!getWisp(wispId)) throw404(); await signin.start(wispId, clamp(b.url, 500) || 'https://www.amazon.com/', browserConn(b)?.config.profile); return { ok: true }; });
route('POST', '/api/wisps/:wispId/signin/input', async (b, { wispId }) => { await signin.input(wispId, b, browserConn(b)?.config.profile); return { ok: true }; });
route('POST', '/api/wisps/:wispId/signin/stop', async (b, { wispId }) => {
  const site = clamp(b.site, 100).trim();
  const br = browserConn(b);
  await signin.stop(wispId, br?.config.profile);
  if (br && site) {
    br.config.signedIn = [...new Set([...(br.config.signedIn || []), site])];
    // A browser signed in to someone's accounts is theirs alone unless they deliberately share it.
    if (br.access === 'family' && !br.config.signedIn.includes('Amazon')) { br.access = 'private'; br.ownerId = state.settings.telegram.people.find((p) => p.canApprove)?.id || null; }
  }
  save(); return { ok: true, private: br?.access === 'private' };
});
route('POST', '/api/connectors/browser', (b) => {
  const name = clamp(b.name, 40).trim() || 'Work browser';
  const key = connectors.slugKey(name);
  connectors.add({ type: 'browser', key, name, access: 'private', ownerId: state.settings.telegram.people.find((p) => p.canApprove)?.id || null, config: { profile: `browser-${key}` } });
  return connectors.list().at(-1);
});

route('POST', '/api/connectors/:cid/test', async (b, { cid }) => {
  const c = connectors.get(cid); if (!c) throw404();
  if (c.type === 'amazon') {
    const t = amazon.tools(c, { secrets: connectors.secrets, setSecret: connectors.setSecret, save, wisp: state.wisps[0] }).find((x) => x.name === 'amazon_orders');
    const r = await t.handler({ days: 30 }, {});
    if (r.isError) throw new Error(r.content[0].text);
    const lines = r.content[0].text.split('\n').filter((l) => /^(Order|\(no order)/.test(l));
    return { ok: true, text: lines.length ? `Found ${lines.length} Amazon order(s) in the last 30 days. Latest:\n${lines.slice(0, 3).join('\n')}` : r.content[0].text };
  }
  if (['google', 'weather', 'budget', 'play'].includes(c.type)) {
    const mod = c.type === 'google' ? google : await import(`./connectors/${c.type}.js`);
    const tools = mod.tools(c, { secrets: connectors.secrets, setSecret: connectors.setSecret, save });
    const run = async (n, a) => { const t = tools.find((x) => x.name === n); const r = await t.handler(a, {}); if (r.isError) throw new Error(r.content[0].text); return r.content[0].text; };
    if (c.type === 'weather') return { ok: true, text: await run('forecast', { days: 1 }) };
    if (c.type === 'play') return { ok: true, text: await run('play_releases', {}) };
    if (c.type === 'budget') return { ok: true, text: (await run('budget_overview', {})).split('\n').slice(0, 3).join('\n') };
    const mail = await run('gmail_search', { query: 'in:inbox', max_results: 1 });
    const cal = await run('calendar_events', { max_results: 1 });
    return { ok: true, text: `Gmail ✓ (${mail.split('\n')[0].slice(0, 80)})\nCalendar ✓ (${cal.split('\n')[0]})` };
  }
  return { ok: true, text: 'This connector is checked the first time a Wisp uses it.' };
});

// Finish a Google sign-in from the redirect's query string (the callback page, or an address pasted into Wisps
// when Wisps runs on another machine and Google's 127.0.0.1 redirect can't reach it).
async function finishGoogle(params) {
  try {
    if (params.get('error')) throw new Error(params.get('error') === 'access_denied' ? 'You cancelled the Google sign-in.' : params.get('error'));
    const r = await google.finishAuth({ code: params.get('code'), state: params.get('state'), clientId: connectors.secrets()['google:clientId'], clientSecret: connectors.secrets()['google:clientSecret'] });
    let c = connectors.list().find((x) => x.type === 'google' && x.name === r.email);
    if (!c) { connectors.add({ type: 'google', key: connectors.slugKey(`google_${r.email.split('@')[0]}`), name: r.email, ownerId: r.meta.ownerId, access: 'private' }); c = connectors.list().at(-1); }
    c.status = r.missing.length ? 'partial' : 'ok';
    c.missing = r.missing.map((x) => x.split('/').pop());
    connectors.setSecret(`google:${c.id}`, r.tokens);
    save();
    return { good: true, msg: r.missing.length ? `Connected ${r.email}, but some permissions weren't granted (${c.missing.join(', ')}). Reconnect and tick all the boxes to use everything.` : `Connected ${r.email}. You can close this tab.` };
  } catch (e) { return { good: false, msg: e.message }; }
}
route('POST', '/api/connectors/google/finish', async (b) => {
  let u; try { u = new URL(String(b.url || '').trim()); } catch { const e = new Error('Paste the whole address, starting with http://127.0.0.1'); e.status = 400; throw e; }
  const r = await finishGoogle(u.searchParams);
  if (!r.good) { const e = new Error(r.msg); e.status = 400; throw e; }
  return { ok: true, message: r.msg };
});

function throw404() { const e = new Error('Not found'); e.status = 404; throw e; }

// ---- SSE -------------------------------------------------------------------
const clients = new Set();
function sse(req, res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(`event: state\ndata: ${JSON.stringify(fullSnapshot())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
}
const broadcast = (event, data) => { const s = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(s); };
let stateTimer = null;
bus.on('state', () => { clearTimeout(stateTimer); stateTimer = setTimeout(() => broadcast('state', fullSnapshot()), 80); });
bus.on('event', (e) => broadcast('event', e));
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000);

// ---- server ----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!trusted(req)) { res.writeHead(403); return res.end('Forbidden'); }
  try {
    if (url.pathname === '/api/events') return sse(req, res);
    const fm = /^\/api\/wisps\/([\w-]+)\/signin\/frame$/.exec(url.pathname);
    if (fm) {
      const f = await signin.frame(fm[1], browserConn({ browser: url.searchParams.get('browser') })?.config.profile);
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store', 'x-page-url': encodeURIComponent(f.url), 'x-page-title': encodeURIComponent(f.title) });
      return res.end(f.jpg);
    }
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const body = req.method === 'GET' ? {} : await readBody(req);
        return json(res, 200, await r.fn(body, m.groups || {}, url));
      }
      return json(res, 404, { error: 'Not found' });
    }
    if (url.pathname === '/oauth/google/callback') {
      const { good, msg } = await finishGoogle(url.searchParams);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta name="viewport" content="width=device-width"><title>Wisps</title><body style="font:16px system-ui;display:grid;place-items:center;height:90vh;background:#f5f3ee;color:#1c1a17"><div style="text-align:center;max-width:460px;padding:20px"><div style="font-size:44px">${good ? '✅' : '⚠️'}</div><p>${msg.replace(/</g, '&lt;')}</p><p><a href="/">Back to Wisps</a></p></div><script>try{window.opener&&window.opener.postMessage('wisps-oauth','*')}catch{}${good ? 'setTimeout(()=>window.close(),2500)' : ''}</script>`);
    }
    if (url.pathname.startsWith('/vendor/')) {
      const f = VENDOR[url.pathname.slice(8)];
      if (!f) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'max-age=86400' });
      return fs.createReadStream(path.join(NM, f)).pipe(res);
    }
    let file = path.join(PUBLIC, decodeURIComponent(url.pathname));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    if (!e.status) console.error('[http]', req.method, url.pathname, e);
    json(res, e.status || 500, { error: e.message });
  }
});

engine.recoverAfterRestart();
if (!getWisp(state.settings.telegram.defaultWispId) && state.wisps[0]) { state.settings.telegram.defaultWispId = state.wisps[0].id; save(); }
state.wisps.forEach((d) => ensureWispDirs(d.id));
connectors.ensureDefaults();
startScheduler();
amazon.startWatcher();
telegram.startTelegram();
server.listen(PORT, HOST, () => console.log(`Wisps is running → http://localhost:${PORT}  (data: ${DATA_DIR})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flush(); process.exit(0); });
