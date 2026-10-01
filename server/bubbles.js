// Memory bubbles: what's going on in your life, kept as small topic clusters (a person, a place,
// a plan, an event…) that link to each other over time. Lessons about *how* to work for you stay
// in memory.md; bubbles hold the context. Every fact remembers where it was learned, so something
// said in one person's DM never surfaces in the family group or in someone else's DM.
import fs from 'node:fs';
import path from 'node:path';
import { wispDir, id, now, bus, state } from './store.js';

export const KINDS = ['person', 'place', 'plan', 'event', 'preference', 'project', 'thing', 'topic'];
export const MAX_FACTS = 25; // past this, a bubble gets condensed

const file = (wispId) => path.join(wispDir(wispId), 'bubbles.json');

// Always read from disk: the memory MCP server (another process) can write here too.
export function load(wispId) {
  try { return JSON.parse(fs.readFileSync(file(wispId), 'utf8')); } catch { return []; }
}
function write(wispId, bubbles) {
  fs.mkdirSync(wispDir(wispId), { recursive: true });
  const tmp = `${file(wispId)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(bubbles, null, 2));
  fs.renameSync(tmp, file(wispId));
  bus.emit('event', { type: 'bubbles', wispId });
}

// ---- who may see what ------------------------------------------------------------
// origin = null for you (the web app, scheduled work, check-ins, other AI apps on this machine).
export function scopeOf(origin) {
  if (!origin) return 'owner';
  if (origin.group) return `group:${origin.chatId}`;
  return `person:${origin.personId}`;
}
const isApprover = (personId) => !!state.settings?.telegram?.people?.find((p) => p.id === personId)?.canApprove;
function visible(bubble, fact, origin) {
  if (!origin) return true;
  if (bubble.shared || fact.scope === 'family') return true;
  if (origin.group) return fact.scope === `group:${origin.chatId}`;
  if (fact.scope === `person:${origin.personId}`) return true;
  return fact.scope === 'owner' && isApprover(origin.personId); // an approver's DM is the owner on the go
}
// The bubbles this origin may see, each holding only the facts it may see.
export function view(wispId, origin) {
  return load(wispId)
    .map((b) => ({ ...b, facts: b.facts.filter((f) => visible(b, f, origin)) }))
    .filter((b) => b.facts.length);
}

// ---- matching ----------------------------------------------------------------------
const STOP = new Set('the and for are was were with that this from have has had you your our their them they she him her his its not but can will would should could about into what when where which who whom how why all any some just like then than there here very also been being does did doing done more most much many such only own same too out off over under again once ok okay yes yeah please thanks thank'.split(' '));
export const tokens = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
const norm = (s) => tokens(s).join(' ');
const sameTitle = (a, b) => norm(a) === norm(b) && norm(a) !== '';

function score(bubble, qset) {
  if (!qset.size) return 0;
  let s = 0;
  for (const w of tokens(bubble.title)) if (qset.has(w)) s += 4;
  for (const a of bubble.aliases || []) for (const w of tokens(a)) if (qset.has(w)) s += 3;
  for (const f of bubble.facts) for (const w of new Set(tokens(f.text))) if (qset.has(w)) s += 1;
  return s;
}
const recency = (b) => Math.max(0, 1 - (Date.now() - new Date(b.updatedAt)) / (60 * 864e5)); // fades over ~2 months

export function search(wispId, query, origin, limit = 8) {
  const qset = new Set(tokens(query));
  const all = view(wispId, origin);
  const byId = new Map(all.map((b) => [b.id, b]));
  const ranked = all.map((b) => ({ b, s: score(b, qset) })).filter((x) => x.s > 0)
    .sort((x, y) => (y.s + recency(y.b)) - (x.s + recency(x.b)) || (!!y.b.pinned - !!x.b.pinned));
  // A bubble pulls in the bubbles it's linked to, the way one memory brings back another.
  const out = new Map();
  for (const { b } of ranked) {
    if (out.size >= limit) break;
    out.set(b.id, b);
    for (const lid of b.links || []) { const l = byId.get(lid); if (l && out.size < limit) out.set(l.id, l); }
  }
  return [...out.values()];
}

const factLine = (f) => `  - ${f.text}${f.at ? ` (${f.at.slice(0, 10)})` : ''}`;
export function format(bubbles, all = bubbles) {
  const title = new Map(all.map((b) => [b.id, b.title]));
  return bubbles.map((b) => {
    const links = (b.links || []).map((l) => title.get(l)).filter(Boolean);
    return `• ${b.title} [${b.kind}]${links.length ? ` ↔ ${links.join(', ')}` : ''}\n${b.facts.slice(-12).map(factLine).join('\n')}`;
  }).join('\n');
}

// What a run sees up front: pinned bubbles, the ones relevant to this prompt, and an index of the rest.
export function promptSection(wispId, text, origin) {
  const all = view(wispId, origin);
  if (!all.length) return '';
  const pinned = all.filter((b) => b.pinned);
  const hits = search(wispId, text, origin, 6).filter((b) => !b.pinned);
  const shown = [...pinned, ...hits].slice(0, 10);
  const ids = new Set(shown.map((b) => b.id));
  const rest = all.filter((b) => !ids.has(b.id)).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 60);
  return `## Memory bubbles: what's going on in your owner's life
${shown.length ? format(shown, all) : '(none relevant to this message)'}
${rest.length ? `\nOther bubbles you can look up with recall: ${rest.map((b) => b.title).join(' · ')}\n` : ''}`;
}

// ---- writing -----------------------------------------------------------------------
// Same fact, reworded: most of the words overlap ("Linda turns 60 in March" vs "Linda (mom) turns 60 in March").
const similar = (a, b) => {
  const x = new Set(tokens(a)), y = new Set(tokens(b));
  if (!x.size || !y.size) return norm(a) === norm(b);
  const both = [...x].filter((w) => y.has(w)).length;
  return both / (x.size + y.size - both) >= 0.75;
};

// File a fact into the bubble for `topic`, creating it if needed. Returns the bubble.
export function addFact(wispId, { topic, kind = 'topic', fact, related = [], origin = null, scope = scopeOf(origin) }) {
  topic = String(topic || '').trim().slice(0, 80);
  fact = String(fact || '').trim().slice(0, 500);
  if (!topic || !fact) return null;
  const bubbles = load(wispId);
  let b = bubbles.find((x) => sameTitle(x.title, topic) || (x.aliases || []).some((a) => sameTitle(a, topic)));
  if (!b) {
    b = { id: id('b'), title: topic, kind: KINDS.includes(kind) ? kind : 'topic', aliases: [], facts: [], links: [], shared: false, pinned: false, createdAt: now(), updatedAt: now() };
    bubbles.push(b);
  }
  const dup = b.facts.find((f) => f.scope === scope && similar(f.text, fact));
  if (dup) { dup.text = fact.length >= dup.text.length ? fact : dup.text; dup.at = now(); }
  else b.facts.push({ id: id('f'), text: fact, scope, at: now() });
  b.updatedAt = now();
  for (const r of related) {
    const other = bubbles.find((x) => x !== b && (sameTitle(x.title, r) || (x.aliases || []).some((a) => sameTitle(a, r))));
    if (!other) continue;
    if (!b.links.includes(other.id)) b.links.push(other.id);
    if (!other.links.includes(b.id)) other.links.push(b.id);
  }
  write(wispId, bubbles);
  return b;
}

export function update(wispId, bubbleId, patch) {
  const bubbles = load(wispId);
  const b = bubbles.find((x) => x.id === bubbleId);
  if (!b) return null;
  if (patch.title !== undefined && String(patch.title).trim()) b.title = String(patch.title).trim().slice(0, 80);
  if (patch.kind !== undefined && KINDS.includes(patch.kind)) b.kind = patch.kind;
  if (patch.shared !== undefined) b.shared = !!patch.shared;
  if (patch.pinned !== undefined) b.pinned = !!patch.pinned;
  if (Array.isArray(patch.aliases)) b.aliases = patch.aliases.map((a) => String(a).trim().slice(0, 80)).filter(Boolean).slice(0, 10);
  if (Array.isArray(patch.facts)) {
    // edits from the app: keep each fact's scope, drop removed ones, add new ones as yours
    const old = new Map(b.facts.map((f) => [f.id, f]));
    b.facts = patch.facts.map((f) => String(f.text || '').trim() && (old.get(f.id) ? { ...old.get(f.id), text: String(f.text).trim().slice(0, 500) } : { id: id('f'), text: String(f.text).trim().slice(0, 500), scope: 'owner', at: now() })).filter(Boolean);
  }
  if (Array.isArray(patch.links)) {
    const ids = new Set(bubbles.map((x) => x.id));
    const next = [...new Set(patch.links)].filter((l) => ids.has(l) && l !== b.id);
    for (const x of bubbles) {
      if (x === b) continue;
      const linked = next.includes(x.id);
      x.links = linked ? [...new Set([...(x.links || []), b.id])] : (x.links || []).filter((l) => l !== b.id);
    }
    b.links = next;
  }
  b.updatedAt = now();
  write(wispId, bubbles);
  return b;
}

export function remove(wispId, bubbleId) {
  const bubbles = load(wispId).filter((x) => x.id !== bubbleId);
  for (const x of bubbles) x.links = (x.links || []).filter((l) => l !== bubbleId);
  write(wispId, bubbles);
}

// Fold bubble `fromId` into `intoId` (same person under two names, say).
export function merge(wispId, intoId, fromId) {
  const bubbles = load(wispId);
  const into = bubbles.find((x) => x.id === intoId), from = bubbles.find((x) => x.id === fromId);
  if (!into || !from || into === from) return null;
  into.facts.push(...from.facts);
  into.aliases = [...new Set([...(into.aliases || []), from.title, ...(from.aliases || [])])].filter((a) => !sameTitle(a, into.title)).slice(0, 10);
  into.links = [...new Set([...into.links, ...from.links])].filter((l) => l !== into.id && l !== from.id);
  into.shared ||= from.shared; into.pinned ||= from.pinned; into.updatedAt = now();
  const rest = bubbles.filter((x) => x !== from);
  for (const x of rest) if (x !== into && x.links?.includes(from.id)) x.links = [...new Set(x.links.map((l) => (l === from.id ? into.id : l)))].filter((l) => l !== x.id);
  write(wispId, rest);
  return into;
}

// Replace one scope's facts in a bubble with a condensed list (used by the engine's tidy-up pass).
export function replaceFacts(wispId, bubbleId, scope, texts) {
  const bubbles = load(wispId);
  const b = bubbles.find((x) => x.id === bubbleId);
  if (!b || !texts.length) return;
  b.facts = [...b.facts.filter((f) => f.scope !== scope), ...texts.map((t) => ({ id: id('f'), text: String(t).trim().slice(0, 500), scope, at: now() }))];
  write(wispId, bubbles);
}
