// Persistence: one JSON state file plus per-Wisp folders for chat logs,
// task activity, memory and the Wisp's "computer" (its working directory).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export const DATA_DIR = process.env.WISPS_DATA || path.resolve(import.meta.dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

export const bus = new EventEmitter();
bus.setMaxListeners(100);

export const id = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
export const now = () => new Date().toISOString();

const empty = () => ({
  settings: { telegram: { token: '', people: [], groups: [], defaultWispId: null, updates: true } },
  wisps: [], tasks: [], schedules: [], inbox: [],
});

export const state = load();

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const s = { ...empty(), ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
    s.settings = { ...empty().settings, ...s.settings, telegram: { ...empty().settings.telegram, ...s.settings?.telegram } };
    delete s.settings.whatsapp;
    return s;
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[store] could not read state, starting fresh:', e.message);
    return empty();
  }
}

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 150);
  bus.emit('state');
}
export function flush() {
  clearTimeout(saveTimer);
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ---- per-Wisp folders -------------------------------------------------------
export const wispDir = (wispId) => path.join(DATA_DIR, 'wisps', wispId);
export const computerDir = (wispId) => path.join(wispDir(wispId), 'computer');
export const memoryFile = (wispId) => path.join(wispDir(wispId), 'memory.md');

export function ensureWispDirs(wispId) {
  fs.mkdirSync(computerDir(wispId), { recursive: true });
  fs.mkdirSync(path.join(wispDir(wispId), 'tasks'), { recursive: true });
  if (!fs.existsSync(memoryFile(wispId))) fs.writeFileSync(memoryFile(wispId), '');
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}
function readJsonl(file, limit = 500) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// Chat thread (one continuous conversation per Wisp)
const chatFile = (wispId) => path.join(wispDir(wispId), 'chat.jsonl');
export function addChat(wispId, msg) {
  const m = { id: id('m'), at: now(), ...msg };
  appendJsonl(chatFile(wispId), m);
  bus.emit('event', { type: 'chat', wispId, message: m });
  return m;
}
export const readChat = (wispId, limit) => readJsonl(chatFile(wispId), limit);

// Task activity log ("watch the computer")
const activityFile = (wispId, taskId) => path.join(wispDir(wispId), 'tasks', `${taskId}.jsonl`);
export function addActivity(wispId, taskId, ev) {
  const e = { at: now(), ...ev };
  appendJsonl(activityFile(wispId, taskId), e);
  bus.emit('event', { type: 'activity', wispId, taskId, event: e });
  return e;
}
export const readActivity = (wispId, taskId) => readJsonl(activityFile(wispId, taskId), 2000);

export function readMemory(wispId) {
  try { return fs.readFileSync(memoryFile(wispId), 'utf8'); } catch { return ''; }
}
export function writeMemory(wispId, text) {
  fs.writeFileSync(memoryFile(wispId), text);
  bus.emit('event', { type: 'memory', wispId });
}

// ---- lookups ---------------------------------------------------------------
export const getWisp = (wispId) => state.wisps.find((d) => d.id === wispId);
export const getTask = (taskId) => state.tasks.find((t) => t.id === taskId);

export function addInbox(item) {
  const it = { id: id('in'), at: now(), resolved: false, ...item };
  state.inbox.unshift(it);
  // keep the inbox bounded: drop old resolved items
  const resolved = state.inbox.filter((i) => i.resolved);
  if (resolved.length > 200) {
    const drop = new Set(resolved.slice(200).map((i) => i.id));
    state.inbox = state.inbox.filter((i) => !drop.has(i.id));
  }
  save();
  bus.emit('inbox', it);
  return it;
}

// Public snapshot for the UI (never includes the bot token)
export function snapshot() {
  const { token, ...telegram } = state.settings.telegram;
  return {
    settings: { ...state.settings, telegram: { ...telegram, configured: !!token } },
    wisps: state.wisps,
    tasks: state.tasks.slice(-300),
    schedules: state.schedules,
    inbox: state.inbox.slice(0, 150),
  };
}
