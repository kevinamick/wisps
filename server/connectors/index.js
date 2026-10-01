// Connectors give Wisps access to your accounts and tools (Gmail, Calendar, Drive, a browser,
// weather, any MCP server). Each one has an owner and an access level, and every tool has a
// risk level that feeds the approval policy.
import fs from 'node:fs';
import path from 'node:path';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { state, save, id, DATA_DIR, wispDir, computerDir } from '../store.js';
import * as google from './google.js';
import * as weather from './weather.js';
import * as budget from './budget.js';
import * as play from './play.js';
import * as amazon from './amazon.js';
import * as signin from '../browser-session.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');

// ---- secrets (tokens never go in state.json or to the browser) --------------
let secretCache = null;
export function secrets() {
  if (!secretCache) { try { secretCache = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')); } catch { secretCache = {}; } }
  return secretCache;
}
export function setSecret(key, value) {
  const s = secrets();
  if (value == null) delete s[key]; else s[key] = value;
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.chmodSync(SECRETS_FILE, 0o600);
}

// ---- registry ----------------------------------------------------------------
const TYPES = { google, weather, budget, play, amazon };
export const list = () => (state.connectors ||= []);
export const get = (cid) => list().find((c) => c.id === cid);

export function ensureDefaults() {
  if (!list().some((c) => c.type === 'weather')) list().push({ id: id('c'), type: 'weather', key: 'weather', name: 'Weather', enabled: true, access: 'family', config: { units: 'fahrenheit', home: '' } });
  if (!list().some((c) => c.type === 'browser')) list().push({ id: id('c'), type: 'browser', key: 'browser', name: 'Web browser', enabled: true, access: 'family', config: {} });
  save();
}

export function slugKey(base) {
  const b = String(base).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'mcp';
  let k = b, n = 2;
  while (k === 'wisp' || list().some((c) => c.key === k)) k = `${b}_${n++}`;
  return k;
}

export function add(c) { list().push({ id: id('c'), enabled: true, access: 'private', ownerId: null, config: {}, ...c }); save(); }
export function remove(cid) {
  const c = get(cid);
  if (!c) return;
  state.connectors = list().filter((x) => x.id !== cid);
  for (const k of Object.keys(secrets())) if (k.endsWith(`:${cid}`)) setSecret(k, null);
  for (const d of state.wisps) if (d.connectors) delete d.connectors[cid];
  save();
}

const enabledFor = (wisp, c) => c.enabled && c.status !== 'reconnect' && (wisp.connectors?.[c.id] ?? true);
const owner = (c) => c.ownerId && state.settings.telegram.people.find((p) => p.id === c.ownerId);

// Who is asking? origin = null for the web app, scheduled work and check-ins (you, the owner).
export function canAccess(c, origin) {
  if (!origin || c.access === 'family') return { ok: true };
  if (origin.group) return { ok: false, why: `${c.name} is private, so it can't be used in a group chat. Ask in a direct message or in the Wisps app.` };
  if (c.ownerId && origin.personId === c.ownerId) return { ok: true };
  if (!c.ownerId && state.settings.telegram.people.find((p) => p.id === origin.personId)?.canApprove) return { ok: true };
  return { ok: false, why: `${c.name} is private to ${owner(c)?.name || 'the owner'}. ${origin.who || 'This person'} can't use it.` };
}

// ---- tool lookup & risk ------------------------------------------------------
// risk: 'read' (allowed) | 'write' (allowed unless Cautious) | 'outward' / 'destructive' (always ask)
const BROWSER_READ = new Set(['browser_navigate', 'browser_navigate_back', 'browser_snapshot', 'browser_take_screenshot', 'browser_wait_for', 'browser_console_messages', 'browser_network_requests', 'browser_tabs', 'browser_close', 'browser_resize', 'browser_install', 'browser_hover']);
const BROWSER_OUTWARD = new Set(['browser_file_upload']);
// The last click of a purchase (Amazon's "Place your order", "Buy now", etc.) always needs approval.
// So is the click that submits or publishes a form (e.g. Play Console declarations and releases).
const PUBLISH_RE = /\b(submit|publish|send\b[^"]{0,40}\bfor review|for review|start roll-?out|roll ?out to|save( changes| draft)?|confirm)\b/i;
// Signing a document (lease, contract, e-signature) is never done without approval. "Sign in/up/out" is not signing.
const SIGN_RE = /\b(adopt and sign|finish(ed)? signing|e-?sign(ature)?|i agree|accept (and|&) sign|sign(?![ -]?(in|up|out|on)\b)(\s+(here|now|document|lease|agreement|all))?)\b/i;
// Amazon's checkout buttons by id, for scripts that click without visible text.
const CHECKOUT_IDS_RE = /placeYourOrder|submitOrderButton|bottomSubmitOrderButton|turbo-checkout-pyo|buy-now-button|submit\.buy-now|place-order|placeorder/i;
const PURCHASE_RE = /place (your )?order|buy now|complete (your )?(purchase|order)|submit (your )?order|pay now|confirm (and pay|purchase|order|payment)|1-click|start (your )?(subscription|free trial)/i;

export function toolInfo(fullName, input) {
  const m = /^mcp__(.+?)__(.+)$/.exec(fullName);
  if (!m) return null;
  const c = list().find((x) => x.key === m[1]);
  if (!c) return null;
  const tool = m[2];
  let risk = 'write';
  if (TYPES[c.type]?.risk) risk = TYPES[c.type].risk(tool, input || {});
  else if (c.type === 'browser') {
    // Only what a person would read counts (button labels, typed text, script source), not option names like "submit": true.
    const said = [input?.element, input?.text, input?.key, input?.function, input?.code, input?.values && JSON.stringify(input.values), input?.fields && JSON.stringify(input.fields)].filter(Boolean).join(' ');
    const commits = [PURCHASE_RE, PUBLISH_RE, SIGN_RE].some((re) => re.test(said)) || CHECKOUT_IDS_RE.test(said) || (/evaluate|run_code/.test(tool) && /\.submit\(|requestSubmit/.test(said));
    risk = BROWSER_READ.has(tool) ? 'read' : BROWSER_OUTWARD.has(tool) || commits ? 'outward' : 'write';
  }
  else if (c.type === 'mcp') risk = c.config.approval === 'allow' ? 'write' : 'outward';
  return { connector: c, tool, risk };
}

// ---- building MCP servers for a run -----------------------------------------
export function servers(wisp, origin = null) {
  const owner = state.settings.telegram.people.find((p) => p.canApprove)?.name;
  const out = {};
  for (const c of list()) {
    if (!enabledFor(wisp, c)) continue;
    try {
      if (TYPES[c.type]?.tools) out[c.key] = createSdkMcpServer({ name: c.key, version: '1.0.0', tools: TYPES[c.type].tools(c, { secrets, setSecret, save, origin, owner, wisp, allowedDirs: [computerDir(wisp.id), ...(wisp.grants || [])] }) });
      else if (c.type === 'browser' && signin.isOpen(wisp.id, c.config.profile)) continue; // you're signing in to a site in it right now
      else if (c.type === 'browser') out[c.key] = {
        type: 'stdio', command: process.execPath,
        args: [path.join(ROOT, 'node_modules/@playwright/mcp/cli.js'), '--headless', '--browser', 'chromium',
          '--user-data-dir', signin.profileDir(wisp.id, c.config.profile), '--output-dir', path.join(computerDir(wisp.id), 'browser'),
          '--viewport-size', `${signin.VIEWPORT.width},${signin.VIEWPORT.height}`],
      };
      else if (c.type === 'mcp') {
        const env = parseKV(secrets()[`env:${c.id}`]);
        out[c.key] = c.config.url
          ? { type: c.config.url.includes('/sse') ? 'sse' : 'http', url: c.config.url, headers: env }
          : { type: 'stdio', command: c.config.command, args: splitArgs(c.config.args || ''), env: { ...process.env, ...env } };
      }
    } catch (e) { console.error(`[connectors] ${c.name}:`, e.message); }
  }
  return out;
}

export function describe(wisp) {
  const cs = list().filter((c) => enabledFor(wisp, c));
  if (!cs.length) return '';
  const lines = cs.map((c) => {
    const what = { amazon: `Amazon order history and delivery status from Amazon's emails, price checks, and price watches (amazon_watch_price notifies the approver when a price drops). These tools are about orders already placed, not shopping (see the web browser for shopping)`, play: `the Google Play Console for ${c.config.packageName}: tracks and releases, rollout %, recent reviews (and replying), crash and ANR vitals, and the store listing. Promoting builds, changing rollouts, and replying to reviews publish to real users and always need approval`, budget: `the family budget page (${c.config.url}): this month's spending vs category limits, entries, logging purchases, fixing categories, changing limits, account balances, net worth, and money flows. Log cash purchases when someone mentions them. For "how are we doing" questions, start with budget_overview`, google: 'Gmail, Google Calendar, Google Drive', weather: 'weather forecasts', browser: `${c.config.profile && c.config.profile !== 'browser-profile' ? `a separate PRIVATE browser for ${owner(c)?.name || 'your owner'}'s own accounts. Use it only when they ask, never for anyone else or in group chats. ` : ''}a real web browser (headless Chromium) for sites that need clicking, forms, or logins. Screenshots and downloads are saved in your computer under browser/.${c.config.signedIn?.length ? ` It is signed in to: ${c.config.signedIn.join(', ')}.` : ''}${c.config.signedIn?.includes('Amazon') ? ` SHOPPING: you CAN shop on Amazon with this browser${c.access === 'family' ? ' for anyone in the household' : ''}. Search, add items to the cart (for groceries, use Amazon Fresh or Whole Foods and choose the requested delivery window), go to checkout, and check the address, payment, total, and delivery time. Post those details in the chat, then click "Place your order". That click pauses for the approver's OK, so tell the person asking that it's waiting for the approver. For a future date, use schedule_task with run_at. Never change addresses, payment methods, or account settings, and never show or discuss the account's order history with anyone except its owner.` : ''} Only the final, committing step pauses for approval (Place your order, Buy now, Pay, Save, Submit, Publish, Send for review, Sign), so do the whole job first (search, cart, checkout, filling forms) and ask once at the end. Right before that click, post a summary in the chat (items, total, delivery time, address, payment). Prefer snapshot and click over evaluate scripts, and never use a script to press a committing button${c.config.signedIn?.includes('Google Play Console') ? '. For Google Play Console, work from play-checklist/README.md in your computer when it exists, and cross-check answers against the app\u2019s code' : ''}`, mcp: c.config.description || 'custom tools' }[c.type];
    const who = c.access === 'family' ? 'anyone in the household can use it' : `private to ${owner(c)?.name || 'your owner'}: never use it for others, and never share its contents in group chats`;
    return `- ${c.name} (tools mcp__${c.key}__*): ${what}. Access: ${who}.${c.type === 'weather' && c.config.home ? ` Home location: ${c.config.home}.` : ''}`;
  });
  return `## Connectors\n${lines.join('\n')}\nSending email, inviting people, and deleting always pause for approval, and so do other outward actions. Prefer drafts when unsure. Prefer the browser only when web search or fetch isn't enough.\n`;
}

// ---- helpers -----------------------------------------------------------------
export function parseKV(text) {
  const o = {};
  for (const line of String(text || '').split('\n')) { const m = /^\s*([\w.-]+)\s*[=:]\s*(.*)$/.exec(line); if (m) o[m[1]] = m[2].trim(); }
  return o;
}
function splitArgs(s) { return (String(s).match(/"[^"]*"|'[^']*'|\S+/g) || []).map((a) => a.replace(/^["']|["']$/g, '')); }

// Public view for the UI
export function publicList() {
  return list().map((c) => ({ ...c, hasEnv: !!secrets()[`env:${c.id}`] }));
}
