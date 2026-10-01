// Telegram channel: your household chats with Wisps in a family group or by DM,
// and approvers OK risky actions with buttons. Setup: create a bot with @BotFather,
// paste the token in Settings, then send each person their invite link.
import crypto from 'node:crypto';
import { state, save, bus, id, getWisp } from './store.js';
import { chat, resolveApproval, approveProposal } from './engine.js';

// live status for the UI (not persisted)
export const tg = { status: 'off', bot: null, error: null, unknown: [], pendingGroups: [] };
let offset = 0, gen = 0;
const groupLog = new Map(); // chatId -> recent messages, for context
const hinted = new Set();   // unconnected groups we've already explained /connect in
const MAX_AGE_S = 30 * 60;  // after a restart, answer messages up to 30 min old

const cfg = () => state.settings.telegram;
const touch = () => bus.emit('state');
const personByUser = (uid) => cfg().people.find((p) => p.userId === uid);
const approvers = () => cfg().people.filter((p) => p.canApprove && p.userId);
export const inviteLink = (p) => (tg.bot && p.invite ? `https://t.me/${tg.bot.username}?start=${p.invite}` : null);

async function api(method, body = {}, token = cfg().token) {
  const res = await fetch(`${process.env.TELEGRAM_API || 'https://api.telegram.org'}/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(method === 'getUpdates' ? 45000 : 20000), // long poll is 30s
  });
  const j = await res.json().catch(() => ({ ok: false, description: res.statusText }));
  if (!j.ok) throw Object.assign(new Error(`${method}: ${j.description}`), { code: j.error_code });
  return j.result;
}

// ---- formatting & sending --------------------------------------------------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function toHtml(md) {
  return String(md).split(/(```[\s\S]*?```)/g).map((p) => (p.startsWith('```')
    ? `<pre>${esc(p.replace(/^```\w*\n?/, '').replace(/```$/, ''))}</pre>`
    : esc(p)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
      .replace(/\[([^\]]+)\]\((https?:[^)\s"]+)\)/g, '<a href="$2">$1</a>')
      .replace(/^(\s*)[-*]\s+/gm, '$1• '))).join('');
}
const plain = (md) => String(md).replace(/```\w*\n?/g, '').replace(/\*\*(.+?)\*\*/g, '$1');

async function send(chatId, md, { wisp, replyTo, buttons } = {}) {
  if (tg.status !== 'connected') return null;
  const prefix = wisp && state.wisps.length > 1 ? `**${wisp.name}:** ` : '';
  const text = prefix + md;
  const extra = {
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
    ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    link_preview_options: { is_disabled: true },
  };
  try {
    if (toHtml(text).length <= 4000) return await api('sendMessage', { chat_id: chatId, text: toHtml(text), parse_mode: 'HTML', ...extra });
  } catch (e) {
    if (e.code !== 400) { console.error('[telegram] send:', e.message); return null; }
  }
  // too long or formatting rejected: plain text in chunks
  const chunks = plain(text).match(/[\s\S]{1,4000}/g) || [''];
  let last = null;
  for (let i = 0; i < chunks.length; i++) {
    try { last = await api('sendMessage', { chat_id: chatId, text: chunks[i], ...(i === chunks.length - 1 ? extra : {}) }); }
    catch (e) { console.error('[telegram] send:', e.message); }
  }
  return last;
}

function logGroup(chatId, who, text) {
  const log = groupLog.get(chatId) || [];
  log.push({ who, text: String(text).slice(0, 500) });
  groupLog.set(chatId, log.slice(-25));
}

// ---- incoming --------------------------------------------------------------
const toldUnknown = new Map(); // userId -> last time we explained
function noteUnknown(from, where) {
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ');
  console.log(`[telegram] message from someone not on the People list: ${name}${from.username ? ` (@${from.username})` : ''}, id ${from.id}, in ${where}`);
  if (where === 'dm' && Date.now() - (toldUnknown.get(from.id) || 0) > 3600e3) {
    toldUnknown.set(from.id, Date.now());
    const owner = cfg().people.find((p) => p.canApprove)?.name;
    send(from.id, `Hi ${from.first_name || 'there'}! I'm a private assistant and I don't know you yet. ${owner ? `Ask ${owner} to add you` : 'The person who runs me can add you'}: in Wisps → Settings → Telegram, you'll now appear under "Messaged the bot" with a one-click Add button.`);
  }
  tg.unknown = [{ userId: from.id, name: [from.first_name, from.last_name].filter(Boolean).join(' '), username: from.username || '', where, at: new Date().toISOString() },
    ...tg.unknown.filter((u) => u.userId !== from.id)].slice(0, 8);
  touch();
}

export function connectGroup({ chatId, name, wispId, replyToAll = false }) {
  cfg().groups = [...cfg().groups.filter((g) => g.chatId !== chatId), { chatId, name, wispId: wispId || cfg().defaultWispId || state.wisps[0]?.id, replyToAll }];
  tg.pendingGroups = tg.pendingGroups.filter((g) => g.chatId !== chatId);
  save();
  const wisp = getWisp(cfg().groups.at(-1).wispId);
  send(chatId, `👋 Hi everyone, I'm ${wisp?.name || 'your Wisp'}! Say my name, @mention me, or reply to one of my messages when you want me. I can answer questions, research things, make plans, and keep track of stuff for the family.${tg.bot?.readsAll ? '' : '\n\n(Right now I only see messages that @mention me or reply to me.)'}`);
}

async function onMessage(m) {
  if (m.date < Date.now() / 1000 - MAX_AGE_S) return;
  const chatId = m.chat.id;
  const group = m.chat.type !== 'private';
  if (m.migrate_to_chat_id) { // group upgraded to supergroup: new id
    const g = cfg().groups.find((x) => x.chatId === chatId);
    if (g) { g.chatId = m.migrate_to_chat_id; save(); }
    return;
  }
  const from = m.from;
  if (!from || from.is_bot) return;
  let text = (m.text || m.caption || '').trim();

  if (!group && text.startsWith('/start')) {
    const code = text.split(/\s+/)[1];
    const p = code && cfg().people.find((x) => x.invite && x.invite === code);
    if (p) {
      Object.assign(p, { userId: from.id, username: from.username || '', invite: null });
      tg.unknown = tg.unknown.filter((u) => u.userId !== from.id);
      save();
      const wisp = getWisp(p.wispId) || getWisp(cfg().defaultWispId) || state.wisps[0];
      return send(chatId, `Hi ${p.name}! 👋 You're connected${wisp ? ` to ${wisp.name}` : ''}. Message me here anytime${p.canApprove ? ", and I'll ask you here before doing anything risky" : ''}.`);
    }
    if (personByUser(from.id)) return send(chatId, 'Hi again! What can I do?');
    toldUnknown.delete(from.id); // /start always gets the explanation
    return noteUnknown(from, 'dm');
  }

  const who = personByUser(from.id);
  const g = group && cfg().groups.find((x) => x.chatId === chatId);
  if (!who) { if (!group || g) noteUnknown(from, group ? m.chat.title : 'dm'); return; }

  const botU = tg.bot.username.toLowerCase();
  const cmd = /^\/(\w+)(?:@(\w+))?\s*(.*)$/s.exec(text);
  if (cmd && (!cmd[2] || cmd[2].toLowerCase() === botU)) {
    const [, name, , arg] = cmd;
    if (name === 'connect' && group) {
      if (!who.canApprove) return send(chatId, 'Only an approver can connect this group.');
      return connectGroup({ chatId, name: m.chat.title });
    }
    if (name === 'disconnect' && group && who.canApprove) {
      cfg().groups = cfg().groups.filter((x) => x.chatId !== chatId); save();
      return send(chatId, "Okay, I'll stay quiet here.");
    }
    if (name === 'wisp') {
      const d = state.wisps.find((x) => x.name.toLowerCase() === arg.trim().toLowerCase());
      if (d && group && g && who.canApprove) { g.wispId = d.id; save(); return send(chatId, `${d.name} is now in this group.`); }
      if (d && !group) { who.wispId = d.id; save(); return send(chatId, `You're now talking to ${d.name}.`); }
      return send(chatId, `Wisps: ${state.wisps.map((x) => x.name).join(', ') || '(none yet)'}. Use /wisp Name to switch.`);
    }
    if (name === 'help') return send(chatId, `Talk to me normally. ${group ? 'In groups, say my name, @mention me, or reply to me.' : ''}\n/wisp Name: switch Wisps\n${group ? '/connect, /disconnect: approvers only' : ''}`);
  }

  let wisp, where, context = '';
  if (group) {
    if (!g) {
      // Not connected: if someone we know is clearly talking to the bot, say how to connect instead of staying silent.
      const called = (m.entities || []).some((e) => e.type === 'mention' && text.substr(e.offset, e.length).toLowerCase() === `@${botU}`)
        || m.reply_to_message?.from?.id === tg.bot.id || state.wisps.some((d) => new RegExp(`\\b${d.name}\\b`, 'i').test(text));
      if (called && !hinted.has(chatId)) {
        hinted.add(chatId);
        send(chatId, who.canApprove ? "I'm not switched on in this group yet. Send /connect here and I'll join in." : `I'm not switched on in this group yet. ${approvers()[0]?.name || 'An approver'} can send /connect to turn me on.`);
      }
      return;
    }
    wisp = getWisp(g.wispId);
    if (!wisp || wisp.paused) return;
    logGroup(chatId, who.name, text || '[non-text message]');
    const ents = m.entities || m.caption_entities || [];
    const mentioned = ents.some((e) => (e.type === 'mention' && text.substr(e.offset, e.length).toLowerCase() === `@${botU}`) || (e.type === 'text_mention' && e.user?.id === tg.bot.id));
    const repliedTo = m.reply_to_message?.from?.id === tg.bot.id;
    const named = new RegExp(`\\b${wisp.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
    if (!(g.replyToAll || mentioned || repliedTo || named)) return;
    where = `in the "${m.chat.title}" Telegram group`;
    const log = (groupLog.get(chatId) || []).slice(0, -1).slice(-10);
    if (log.length) context = `Recent messages in the group, for context:\n${log.map((l) => `${l.who}: ${l.text}`).join('\n')}\n\n`;
    if (repliedTo && m.reply_to_message.text) context += `(${who.name} is replying to your message: "${m.reply_to_message.text.slice(0, 300)}")\n\n`;
    text = text.replace(new RegExp(`@${botU}\\b`, 'ig'), '').trim();
  } else {
    wisp = getWisp(who.wispId) || getWisp(cfg().defaultWispId) || state.wisps[0];
    if (!wisp) return send(chatId, 'There are no Wisps yet. Create one in the Wisps app first.');
    where = 'by direct message on Telegram';
  }
  if (!text) return send(chatId, 'I can only read text for now.', { replyTo: group ? m.message_id : undefined });

  const typing = () => api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  typing();
  const tick = setInterval(typing, 4500);
  try {
    const reply = await chat(wisp.id, text, {
      source: group ? 'Telegram group' : 'Telegram', author: who.name,
      origin: { channel: 'telegram', chatId, who: who.name, personId: who.id, group },
      prompt: `${context}[${who.name}, ${where}]: ${text}`,
    });
    const r = await send(chatId, reply.text, { wisp, replyTo: group ? m.message_id : undefined });
    if (group && r) logGroup(chatId, wisp.name, reply.text);
  } finally { clearInterval(tick); }
}

async function onCallback(cq) {
  const who = personByUser(cq.from.id);
  const [kind, itemId, decision] = String(cq.data).split(':');
  if (!who?.canApprove) return api('answerCallbackQuery', { callback_query_id: cq.id, text: 'Only approvers can decide this.', show_alert: true }).catch(() => {});
  let ok = false;
  if (kind === 'ap') ok = resolveApproval(itemId, decision);
  if (kind === 'pr') ok = approveProposal(itemId, decision === 'yes');
  const verdict = { allow: '✅ Approved', always: '✅ Always allowed', deny: '❌ Denied', yes: '✅ Doing it', no: '👌 Dismissed' }[decision];
  await api('answerCallbackQuery', { callback_query_id: cq.id, text: ok ? verdict : 'Already handled' }).catch(() => {});
  if (cq.message) {
    await api('editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    if (ok) await send(cq.message.chat.id, `${verdict} by ${who.name}.`, { replyTo: cq.message.message_id });
  }
}

function onMembership(mc) {
  if (mc.chat.type === 'private') return;
  const status = mc.new_chat_member?.status;
  if (['member', 'administrator'].includes(status)) {
    if (cfg().groups.some((g) => g.chatId === mc.chat.id)) return;
    const adder = personByUser(mc.from.id);
    if (adder?.canApprove) connectGroup({ chatId: mc.chat.id, name: mc.chat.title });
    else { tg.pendingGroups = [{ chatId: mc.chat.id, name: mc.chat.title }, ...tg.pendingGroups.filter((g) => g.chatId !== mc.chat.id)]; touch(); }
  } else if (['left', 'kicked'].includes(status)) {
    cfg().groups = cfg().groups.filter((g) => g.chatId !== mc.chat.id);
    tg.pendingGroups = tg.pendingGroups.filter((g) => g.chatId !== mc.chat.id);
    save();
  }
}

// ---- polling ---------------------------------------------------------------
async function loop(my) {
  while (my === gen) {
    try {
      tg.polls = (tg.polls || 0) + 1; tg.lastPollAt = new Date().toISOString();
      const updates = await api('getUpdates', { offset, timeout: 30, allowed_updates: ['message', 'callback_query', 'my_chat_member'] });
      tg.lastPollOkAt = new Date().toISOString();
      if (updates.length) { tg.updates = (tg.updates || 0) + updates.length; console.log(`[telegram] received ${updates.length} update(s): ${updates.map((u) => Object.keys(u).filter((k) => k !== 'update_id').join('+')).join(', ')}`); }
      for (const u of updates) {
        offset = u.update_id + 1;
        const p = u.message ? onMessage(u.message) : u.callback_query ? onCallback(u.callback_query) : u.my_chat_member ? onMembership(u.my_chat_member) : null;
        p?.catch?.((e) => console.error('[telegram]', e.message));
      }
      if (tg.status !== 'connected') { tg.status = 'connected'; tg.error = null; touch(); }
    } catch (e) {
      if (my !== gen) return;
      console.error('[telegram] poll error:', e.message, e.cause?.code || '');
      tg.lastPollError = `${new Date().toISOString()} ${e.message}`;
      if (e.code === 401) { tg.status = 'error'; tg.error = 'Telegram rejected the bot token. Paste a new one.'; touch(); return; }
      if (e.code === 409) { tg.error = 'Another program is using this bot token. Only one can poll at a time.'; touch(); }
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function connect() {
  const my = ++gen;
  if (!cfg().token) { Object.assign(tg, { status: 'off', bot: null, error: null }); touch(); return; }
  tg.status = 'connecting'; touch();
  const me = await api('getMe');
  tg.bot = { id: me.id, username: me.username, name: me.first_name, readsAll: !!me.can_read_all_group_messages };
  await api('deleteWebhook').catch(() => {});
  tg.status = 'connected'; tg.error = null; touch();
  console.log(`[telegram] connected as @${me.username}`);
  loop(my);
}

export async function configure(token) {
  token = String(token || '').trim();
  if (token) await api('getMe', {}, token); // validate before saving; throws on a bad token
  cfg().token = token;
  save();
  if (!token) { gen++; Object.assign(tg, { status: 'off', bot: null, error: null }); touch(); return; }
  await connect();
}
export const recheck = () => connect().catch((e) => { tg.status = 'error'; tg.error = e.message; touch(); });

// ---- people ----------------------------------------------------------------
export function newPerson({ name, canApprove = false, userId = null, username = '' }) {
  return { id: id('p'), name: String(name).slice(0, 60).trim(), canApprove: !!canApprove, userId, username, wispId: null, invite: userId ? null : crypto.randomBytes(6).toString('base64url') };
}

// ---- outbound notifications ------------------------------------------------
function onInbox(it) {
  if (tg.status !== 'connected') return;
  const wisp = getWisp(it.wispId);
  const origin = it.origin?.channel === 'telegram' ? it.origin : null;
  const name = wisp?.name || 'Your Wisp';
  if (it.kind === 'approval') {
    const msg = `✋ **${name} needs your OK**${origin?.who ? ` (asked by ${origin.who})` : ''}\n\n**${it.title}**\n${it.body}\n\n_${it.reason}_`.replace(/_(.+)_$/, '$1');
    const buttons = [[{ text: '✅ Approve', callback_data: `ap:${it.id}:allow` }, { text: 'Always', callback_data: `ap:${it.id}:always` }, { text: '❌ Deny', callback_data: `ap:${it.id}:deny` }]];
    for (const p of approvers()) send(p.userId, msg, { buttons });
    return;
  }
  if (it.kind === 'proposal') {
    const buttons = [[{ text: '✅ Do it', callback_data: `pr:${it.taskId}:yes` }, { text: 'Dismiss', callback_data: `pr:${it.taskId}:no` }]];
    for (const p of approvers()) send(p.userId, `💡 **${name} has an idea:** ${it.title}\n\n${it.body}`, { buttons });
    return;
  }
  if (!origin && !cfg().updates) return;
  const icon = { done: '✅', failed: '⚠️', notice: '🔔' }[it.kind] || '';
  const text = it.kind === 'notice' ? `${icon} **${it.title}**\n\n${it.body}` : `${icon} **${it.kind === 'done' ? 'Done' : "Couldn't finish"}: ${it.title}**\n\n${it.body}`;
  if (origin) send(origin.chatId, text, { wisp });
  else for (const p of approvers()) send(p.userId, text, { wisp });
}

export function startTelegram() {
  bus.on('inbox', onInbox);
  if (cfg().token) recheck();
}
