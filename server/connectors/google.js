// Google connector: Gmail, Calendar and Drive for one Google account, via your own OAuth client.
import crypto from 'node:crypto';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { netFetch } from './net.js';
import { addInbox } from '../store.js';

export const SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive.readonly',
];

// ---- OAuth (loopback redirect + PKCE) ---------------------------------------
const pending = new Map(); // state -> { verifier, redirectUri, meta, at }

export function authUrl({ clientId, redirectUri, meta }) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const st = crypto.randomBytes(16).toString('hex');
  pending.set(st, { verifier, redirectUri, meta, at: Date.now() });
  for (const [k, v] of pending) if (Date.now() - v.at > 15 * 60000) pending.delete(k);
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
    code_challenge: challenge, code_challenge_method: 'S256', state: st,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export async function finishAuth({ code, state: st, clientId, clientSecret }) {
  const p = pending.get(st);
  if (!p) throw new Error('This sign-in link expired. Start again from Wisps.');
  pending.delete(st);
  const tok = await tokenRequest({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: p.redirectUri, grant_type: 'authorization_code', code_verifier: p.verifier });
  if (!tok.refresh_token) throw new Error('Google did not return a refresh token. Remove Wisps from your Google account permissions and try again.');
  const info = await (await netFetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tok.access_token}` } })).json();
  const granted = String(tok.scope || '').split(' ');
  const missing = SCOPES.filter((s) => s.startsWith('https://') && !granted.includes(s));
  return { email: info.email, tokens: { refresh_token: tok.refresh_token, access_token: tok.access_token, expiry: Date.now() + (tok.expires_in - 60) * 1000 }, missing, meta: p.meta };
}

async function tokenRequest(params) {
  const r = await netFetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error_description || j.error || 'token request failed'), { oauthError: j.error });
  return j;
}

// ---- API client ----------------------------------------------------------------
export function client(conn, { secrets, setSecret, save }) {
  async function accessToken() {
    const key = `google:${conn.id}`;
    const t = secrets()[key];
    if (!t) throw new Error('This Google account is not connected.');
    if (t.access_token && t.expiry > Date.now()) return t.access_token;
    try {
      const j = await tokenRequest({ refresh_token: t.refresh_token, client_id: secrets()['google:clientId'], client_secret: secrets()['google:clientSecret'], grant_type: 'refresh_token' });
      setSecret(key, { ...t, access_token: j.access_token, expiry: Date.now() + (j.expires_in - 60) * 1000 });
      return j.access_token;
    } catch (e) {
      if (e.oauthError === 'invalid_grant') {
        if (conn.status !== 'reconnect') {
          conn.status = 'reconnect'; save();
          addInbox({ wispId: null, kind: 'notice', title: `Reconnect Google (${conn.name})`, body: 'Google stopped letting Wisps use this account. This happens every 7 days while your Google app is in Testing. On this computer, open Wisps → 🔌 Connectors and click **Reconnect**. It takes about 10 seconds. To stop it happening, publish the app in Google Cloud → Google Auth Platform → Audience.' });
        }
        throw new Error(`Google access for ${conn.name} expired. Your owner needs to reconnect it in Wisps → Connectors.`);
      }
      throw e;
    }
  }
  return async function g(url, { method = 'GET', body, raw = false } = {}) {
    const r = await netFetch(url.startsWith('http') ? url : `https://www.googleapis.com${url}`, {
      method, headers: { authorization: `Bearer ${await accessToken()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }, { tries: method === 'GET' ? 3 : 1 }); // never retry sends/creates: a lost response could mean it already happened
    if (raw) { if (!r.ok) throw new Error(`Google API ${r.status}: ${(await r.text()).slice(0, 300)}`); return r; }
    const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Google API ${r.status}: ${j.error?.message || JSON.stringify(j).slice(0, 300)}`);
    return j;
  };
}

// ---- helpers -------------------------------------------------------------------
const ok = (text) => ({ content: [{ type: 'text', text: String(text).slice(0, 60000) }] });
const fail = (e) => ({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
const b64d = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
export const header = (msg, name) => msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';
const htmlToText = (h) => h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim();

export function bodyText(payload) {
  let plain = '', html = '';
  const attachments = [];
  (function walk(p) {
    if (!p) return;
    if (p.filename) attachments.push(`${p.filename} (${p.mimeType}, ${p.body?.size || 0} bytes)`);
    else if (p.mimeType === 'text/plain' && p.body?.data) plain += b64d(p.body.data);
    else if (p.mimeType === 'text/html' && p.body?.data) html += b64d(p.body.data);
    (p.parts || []).forEach(walk);
  })(payload);
  return { text: (plain || htmlToText(html)).trim(), attachments };
}

const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);
function rfc822({ to, cc, subject, body, inReplyTo, references }) {
  const lines = [`To: ${to}`, cc && `Cc: ${cc}`, `Subject: ${encodeHeader(subject || '')}`, inReplyTo && `In-Reply-To: ${inReplyTo}`, references && `References: ${references}`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64'].filter(Boolean);
  // The blank line between headers and body is required; without it the body is lost.
  const b64 = (Buffer.from(body || '').toString('base64').match(/.{1,76}/g) || []).join('\r\n');
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n${b64}\r\n`).toString('base64url');
}

async function composeRequest(g, { to, cc, subject, body, reply_to_message_id }) {
  let threadId, inReplyTo, references;
  if (reply_to_message_id) {
    const orig = await g(`/gmail/v1/users/me/messages/${reply_to_message_id}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Reply-To`);
    threadId = orig.threadId;
    inReplyTo = header(orig, 'Message-ID');
    references = [header(orig, 'References'), inReplyTo].filter(Boolean).join(' ');
    if (!subject) subject = /^re:/i.test(header(orig, 'Subject')) ? header(orig, 'Subject') : `Re: ${header(orig, 'Subject')}`;
    if (!to) to = header(orig, 'Reply-To') || header(orig, 'From');
  }
  if (!to) throw new Error('Missing recipient (to).');
  return { message: { raw: rfc822({ to, cc, subject, body, inReplyTo, references }), ...(threadId ? { threadId } : {}) } };
}

// calendar time: accept "2026-10-01T18:00" (calendar's local time) or a date "2026-10-01" (all day)
const when = (v, tz) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? { date: v } : { dateTime: v.length === 16 ? `${v}:00` : v, timeZone: tz });
const fmtWhen = (w) => w?.date || w?.dateTime || '';

export function risk(t, input) {
  if (t === 'gmail_send') return 'outward';
  if (t === 'calendar_delete_event') return 'destructive';
  if ((t === 'calendar_create_event' || t === 'calendar_update_event') && input.attendees?.length) return 'outward';
  if (/^(gmail_draft|gmail_modify|calendar_create_event|calendar_update_event)$/.test(t)) return 'write';
  return 'read';
}

// ---- tools ---------------------------------------------------------------------
export function tools(conn, ctx) {
  const g = client(conn, ctx);
  let tzCache = null;
  const calTz = async () => (tzCache ||= (await g('/calendar/v3/users/me/settings/timezone').catch(() => ({}))).value || Intl.DateTimeFormat().resolvedOptions().timeZone);
  const wrap = (fn) => async (args) => { try { return ok(await fn(args)); } catch (e) { return fail(e); } };
  const who = conn.name;

  return [
    tool('gmail_search', `Search ${who}'s Gmail. Uses Gmail search syntax, e.g. "is:unread newer_than:2d", "from:school subject:field trip", "has:attachment invoice". Returns ids you can pass to gmail_read.`,
      { query: z.string(), max_results: z.number().int().min(1).max(50).optional() },
      wrap(async ({ query, max_results = 10 }) => {
        const list = await g(`/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${max_results}`);
        if (!list.messages?.length) return 'No messages found.';
        const msgs = await Promise.all(list.messages.map((m) => g(`/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)));
        return msgs.map((m) => `id:${m.id} | ${header(m, 'Date')} | From: ${header(m, 'From')} | ${header(m, 'Subject')}${m.labelIds?.includes('UNREAD') ? ' | UNREAD' : ''}\n   ${m.snippet}`).join('\n');
      })),
    tool('gmail_read', `Read one email from ${who}'s Gmail in full (by id from gmail_search).`,
      { id: z.string() },
      wrap(async ({ id }) => {
        const m = await g(`/gmail/v1/users/me/messages/${id}?format=full`);
        const { text, attachments } = bodyText(m.payload);
        return [`From: ${header(m, 'From')}`, `To: ${header(m, 'To')}`, header(m, 'Cc') && `Cc: ${header(m, 'Cc')}`, `Date: ${header(m, 'Date')}`, `Subject: ${header(m, 'Subject')}`,
          `Labels: ${(m.labelIds || []).join(', ')}`, `Thread: ${m.threadId}`, attachments.length && `Attachments: ${attachments.join('; ')}`, '', text.slice(0, 30000) || '(no text body)'].filter(Boolean).join('\n');
      })),
    tool('gmail_draft', `Create a draft in ${who}'s Gmail (not sent). To reply, pass reply_to_message_id; recipient and subject are filled in from the original.`,
      { to: z.string().optional(), cc: z.string().optional(), subject: z.string().optional(), body: z.string(), reply_to_message_id: z.string().optional() },
      wrap(async (a) => { const d = await g('/gmail/v1/users/me/drafts', { method: 'POST', body: await composeRequest(g, a) }); return `Draft saved (id ${d.id}). It's in ${who}'s Gmail Drafts folder.`; })),
    tool('gmail_send', `Send an email from ${who}'s Gmail. Always needs the owner's approval. Pass reply_to_message_id to reply in-thread.`,
      { to: z.string().optional(), cc: z.string().optional(), subject: z.string().optional(), body: z.string(), reply_to_message_id: z.string().optional() },
      wrap(async (a) => { const m = await g('/gmail/v1/users/me/messages/send', { method: 'POST', body: (await composeRequest(g, a)).message }); return `Sent (id ${m.id}).`; })),
    tool('gmail_modify', 'Change labels on emails. Archive: remove_labels ["INBOX"]. Mark read: remove_labels ["UNREAD"]. Star: add_labels ["STARRED"]. Custom labels by name also work.',
      { ids: z.array(z.string()).min(1), add_labels: z.array(z.string()).optional(), remove_labels: z.array(z.string()).optional() },
      wrap(async ({ ids, add_labels = [], remove_labels = [] }) => {
        const labels = (await g('/gmail/v1/users/me/labels')).labels || [];
        const resolve = (names) => names.map((n) => labels.find((l) => l.id === n || l.name.toLowerCase() === n.toLowerCase())?.id || n);
        await g('/gmail/v1/users/me/messages/batchModify', { method: 'POST', body: { ids, addLabelIds: resolve(add_labels), removeLabelIds: resolve(remove_labels) } });
        return `Updated ${ids.length} message(s).`;
      })),

    tool('calendar_list_calendars', `List ${who}'s calendars (ids for the other calendar tools).`, {},
      wrap(async () => ((await g('/calendar/v3/users/me/calendarList')).items || []).map((c) => `${c.id} | ${c.summary}${c.primary ? ' (primary)' : ''} | access: ${c.accessRole}`).join('\n'))),
    tool('calendar_events', `List events on ${who}'s Google Calendar. Times are ISO dates or datetimes. The default range is the next 7 days.`,
      { time_min: z.string().optional(), time_max: z.string().optional(), query: z.string().optional(), calendar_id: z.string().optional(), max_results: z.number().int().max(100).optional() },
      wrap(async ({ time_min, time_max, query, calendar_id = 'primary', max_results = 30 }) => {
        const tz = await calTz();
        const iso = (v, d) => (v ? new Date(v.length === 10 ? `${v}T00:00:00` : v).toISOString() : d.toISOString());
        const q = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: String(max_results), timeZone: tz,
          timeMin: iso(time_min, new Date()), timeMax: iso(time_max, new Date(Date.now() + 7 * 864e5)), ...(query ? { q: query } : {}) });
        const r = await g(`/calendar/v3/calendars/${encodeURIComponent(calendar_id)}/events?${q}`);
        if (!r.items?.length) return `No events. (Calendar time zone: ${tz})`;
        return `Calendar time zone: ${tz}\n` + r.items.map((e) => `id:${e.id} | ${fmtWhen(e.start)} → ${fmtWhen(e.end)} | ${e.summary || '(no title)'}${e.location ? ` | @ ${e.location}` : ''}${e.attendees?.length ? ` | ${e.attendees.length} guests` : ''}${e.eventType === 'fromGmail' ? ' | added by Gmail from an email (time cannot be edited)' : ''}`).join('\n');
      })),
    tool('calendar_create_event', `Add an event to ${who}'s Google Calendar. start/end are local times in the calendar's time zone, like "2026-10-03T18:30", or dates like "2026-10-03" for all-day events. Adding attendees sends them invites and needs approval.`,
      { summary: z.string(), start: z.string(), end: z.string(), description: z.string().optional(), location: z.string().optional(), attendees: z.array(z.string()).optional(), calendar_id: z.string().optional() },
      wrap(async ({ summary, start, end, description, location, attendees, calendar_id = 'primary' }) => {
        const tz = await calTz();
        const e = await g(`/calendar/v3/calendars/${encodeURIComponent(calendar_id)}/events?sendUpdates=${attendees?.length ? 'all' : 'none'}`, { method: 'POST', body: { summary, description, location, start: when(start, tz), end: when(end, tz), ...(attendees?.length ? { attendees: attendees.map((email) => ({ email })) } : {}) } });
        return `Created "${e.summary}" (${fmtWhen(e.start)}). id:${e.id} ${e.htmlLink}`;
      })),
    tool('calendar_update_event', `Change an event on ${who}'s calendar. Only the fields you pass are changed.`,
      { event_id: z.string(), summary: z.string().optional(), start: z.string().optional(), end: z.string().optional(), description: z.string().optional(), location: z.string().optional(), attendees: z.array(z.string()).optional(), calendar_id: z.string().optional() },
      wrap(async ({ event_id, calendar_id = 'primary', start, end, attendees, ...rest }) => {
        const cur = await g(`/calendar/v3/calendars/${encodeURIComponent(calendar_id)}/events/${event_id}`);
        if (cur.eventType === 'fromGmail' && (start || end || rest.summary || rest.description || rest.location || attendees)) {
          // Google rejects any change to these (even re-saving the same times) with a bare 400 "Bad Request".
          throw new Error(`"${cur.summary}" was added automatically by Gmail from an email, and Google doesn't allow apps to change its time or details. Instead, create a new event with calendar_create_event (clean title, right time, the location), then tell your owner the Gmail-made copy can be removed in Google Calendar, or ask before deleting it with calendar_delete_event.`);
        }
        const tz = await calTz();
        const body = { ...rest, ...(start ? { start: when(start, tz) } : {}), ...(end ? { end: when(end, tz) } : {}), ...(attendees ? { attendees: attendees.map((email) => ({ email })) } : {}) };
        const e = await g(`/calendar/v3/calendars/${encodeURIComponent(calendar_id)}/events/${event_id}?sendUpdates=${attendees?.length ? 'all' : 'none'}`, { method: 'PATCH', body });
        return `Updated "${e.summary}" (${fmtWhen(e.start)}).`;
      })),
    tool('calendar_delete_event', `Delete an event from ${who}'s calendar. Needs approval.`,
      { event_id: z.string(), calendar_id: z.string().optional() },
      wrap(async ({ event_id, calendar_id = 'primary' }) => { await g(`/calendar/v3/calendars/${encodeURIComponent(calendar_id)}/events/${event_id}`, { method: 'DELETE' }); return 'Deleted.'; })),

    tool('drive_search', `Search ${who}'s Google Drive by file name and contents.`,
      { query: z.string(), max_results: z.number().int().max(50).optional() },
      wrap(async ({ query, max_results = 10 }) => {
        const esc = query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const q = new URLSearchParams({ q: `(name contains '${esc}' or fullText contains '${esc}') and trashed = false`, pageSize: String(max_results), fields: 'files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName))', orderBy: 'modifiedTime desc' });
        const r = await g(`/drive/v3/files?${q}`);
        return r.files?.length ? r.files.map((f) => `id:${f.id} | ${f.name} | ${f.mimeType.replace('application/vnd.google-apps.', 'google-')} | modified ${f.modifiedTime.slice(0, 10)} | ${f.webViewLink}`).join('\n') : 'No files found.';
      })),
    tool('drive_read', `Read a file from ${who}'s Google Drive as text. Works for Google Docs, Sheets (as CSV), Slides, and plain-text files.`,
      { file_id: z.string() },
      wrap(async ({ file_id }) => {
        const f = await g(`/drive/v3/files/${file_id}?fields=id,name,mimeType,size`);
        const exp = { 'application/vnd.google-apps.document': 'text/plain', 'application/vnd.google-apps.spreadsheet': 'text/csv', 'application/vnd.google-apps.presentation': 'text/plain' }[f.mimeType];
        let text;
        if (exp) text = await (await g(`/drive/v3/files/${file_id}/export?mimeType=${encodeURIComponent(exp)}`, { raw: true })).text();
        else if (/^text\/|json|xml|csv|markdown/.test(f.mimeType)) text = await (await g(`/drive/v3/files/${file_id}?alt=media`, { raw: true })).text();
        else return `${f.name} is a ${f.mimeType} file, which I can't read as text here.`;
        return `# ${f.name}\n\n${text.slice(0, 50000)}`;
      })),
  ];
}
