// Family budget connector (example): talks to a self-hosted family-budget web app's API
// with the family passcode. Spending vs limits, entries, logging purchases, accounts and net worth.
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { netFetch } from './net.js';

// The budget's calendar: the server's time zone (set TZ to match your budget app if they differ).
const TZ = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
export function risk(t) {
  if (t === 'budget_delete_entry') return 'destructive';
  if (/^budget_(log_expense|recategorize|set_limit)$/.test(t)) return 'write';
  return 'read';
}

const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
function cal() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  const y = +p.year, m = +p.month, d = +p.day, daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { ym: `${p.year}-${p.month}`, today: `${p.year}-${p.month}-${p.day}`, day: d, daysIn, daysLeft: daysIn - d + 1 };
}
const monthName = (ym) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function findCat(categories, q) {
  const s = String(q || '').trim().toLowerCase();
  const hit = categories.find((c) => c.id === s || c.name.toLowerCase() === s)
    || categories.filter((c) => c.name.toLowerCase().startsWith(s)).at(0)
    || (categories.filter((c) => c.name.toLowerCase().includes(s)).length === 1 ? categories.find((c) => c.name.toLowerCase().includes(s)) : null);
  if (!hit) throw new Error(`No category matches "${q}". Categories: ${categories.map((c) => c.name).join(', ')}`);
  return hit;
}

export function tools(conn, { secrets, origin, owner }) {
  const base = String(conn.config.url || '').replace(/\/+$/, '');
  async function call(path, body) {
    const code = secrets()[`budget:${conn.id}`];
    if (!base || !code) throw new Error('The budget connector is missing its URL or passcode (Wisps → Connectors).');
    const r = await netFetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'x-family-code': code, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }, { tries: body ? 1 : 3 }); // don't double-log a purchase
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) throw new Error('The budget page rejected the family passcode. Update it in Wisps → Connectors.');
    if (!r.ok) throw new Error(j.error || `budget page error ${r.status}`);
    return j;
  }
  const state = (ym) => call(`/api/state${ym ? `?ym=${ym}` : ''}`);
  const wrap = (fn) => async (a) => { try { return { content: [{ type: 'text', text: String(await fn(a)).slice(0, 60000) }] }; } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }; } };
  const ymArg = z.string().regex(/^\d{4}-\d{2}$/).optional().describe('Month as YYYY-MM (default: this month)');
  const catName = (cats, id) => cats.find((c) => c.id === id)?.name || id;

  return [
    tool('budget_overview', "How the family's month is going: total spent vs budget, what's left per day, and every category's spending vs its limit (over-budget ones first).",
      { month: ymArg },
      wrap(async ({ month }) => {
        const s = await state(month);
        const c = cal(), current = s.ym === c.ym;
        const by = {};
        for (const e of s.entries) by[e.cat] = (by[e.cat] || 0) + e.amt;
        const spent = s.entries.reduce((t, e) => t + e.amt, 0);
        const limit = s.settings.categories.reduce((t, x) => t + (+x.limit || 0), 0);
        const rows = s.settings.categories.map((x) => ({ ...x, spent: by[x.id] || 0, pct: x.limit > 0 ? (by[x.id] || 0) / x.limit : null }))
          .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
        const out = [`${monthName(s.ym)}${current ? `: day ${c.day} of ${c.daysIn} (${c.daysLeft} days left, counting today)` : ''}`,
          `Spent ${money(spent)} of ${money0(limit)} (${limit ? Math.round((spent / limit) * 100) : 0}%). ${spent <= limit ? `Left: ${money(limit - spent)}${current ? `, about ${money((limit - spent) / Math.max(c.daysLeft, 1))} per day` : ''}` : `Over by ${money(spent - limit)}`}.`,
          current && limit ? `On-pace spending by today would be ${money0((limit * c.day) / c.daysIn)}.` : '',
          s.prev.spent ? `Last month (${monthName(s.prev.ym)}): ${money(s.prev.spent)}.` : '', '', 'By category (spent / limit):'];
        for (const r of rows) {
          if (!(r.limit > 0)) { if (r.spent) out.push(`- ${r.name}: ${money(r.spent)} (no limit)`); continue; }
          const flag = r.spent > r.limit ? `OVER by ${money(r.spent - r.limit)}` : r.pct >= 0.8 ? `${Math.round(r.pct * 100)}%, ${money(r.limit - r.spent)} left` : `${money(r.limit - r.spent)} left`;
          out.push(`- ${r.name}: ${money(r.spent)} / ${money0(r.limit)}: ${flag}${s.prev.byCat[r.id] ? ` (last month ${money0(s.prev.byCat[r.id])})` : ''}`);
        }
        const uncategorized = Object.keys(by).filter((id) => !s.settings.categories.some((x) => x.id === id));
        if (uncategorized.length) out.push(`- Other/unknown categories: ${uncategorized.map((id) => `${id} ${money(by[id])}`).join(', ')}`);
        out.push('', `Last bank import: ${s.lastSync ? new Date(s.lastSync).toLocaleString('en-US', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }) + ' ET' : 'never'}.${s.lastImportError ? ` Import problem: ${s.lastImportError}` : ''}`);
        return out.filter((l, i) => l !== false && !(l === '' && out[i - 1] === '')).join('\n');
      })),

    tool('budget_entries', 'List budget entries (expenses; negative amounts are refunds), newest first. Filter by category and/or text in the note or payer/account.',
      { month: ymArg, category: z.string().optional(), search: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
      wrap(async ({ month, category, search, limit = 40 }) => {
        const s = await state(month);
        const cats = s.settings.categories;
        let es = s.entries;
        if (category) { const c = findCat(cats, category); es = es.filter((e) => e.cat === c.id); }
        if (search) { const q = search.toLowerCase(); es = es.filter((e) => `${e.note} ${e.by}`.toLowerCase().includes(q)); }
        es = [...es].sort((a, b) => b.date.localeCompare(a.date) || b.ts - a.ts);
        const total = es.reduce((t, e) => t + e.amt, 0);
        return `${es.length} entries in ${monthName(s.ym)}, totaling ${money(total)}${es.length > limit ? ` (showing ${limit})` : ''}:\n` +
          es.slice(0, limit).map((e) => `id:${e.id} | ${e.date} | ${money(e.amt)} | ${catName(cats, e.cat)} | ${e.note || '-'} | ${e.by}${e.source === 'manual' ? ' (logged by hand)' : ''}`).join('\n');
      })),

    tool('budget_log_expense', 'Log a purchase on the family budget (for cash or anything the bank sync will not pick up). Use a negative amount for a refund.',
      { amount: z.number(), category: z.string().describe('Category name'), note: z.string().optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Default today'), by: z.string().optional().describe('Who spent it; defaults to whoever asked') },
      wrap(async ({ amount, category, note = '', date, by }) => {
        const s = await state();
        const c = findCat(s.settings.categories, category);
        const who = by || origin?.who || owner || 'Wisps';
        const r = await call('/api/entry', { action: 'add', amt: amount, cat: c.id, note, date: date || cal().today, by: who });
        return `Logged ${money(r.entry.amt)} to ${c.name} on ${r.entry.date} (by ${who}). id:${r.entry.id}`;
      })),

    tool('budget_recategorize', "Move an entry to a different category. For bank imports, the page remembers this for the merchant's future charges.",
      { entry_id: z.string(), category: z.string() },
      wrap(async ({ entry_id, category }) => {
        const s = await state();
        const c = findCat(s.settings.categories, category);
        await call('/api/entry', { action: 'recat', id: entry_id, cat: c.id });
        return `Moved to ${c.name}.`;
      })),

    tool('budget_delete_entry', 'Remove an entry from the budget (e.g. a duplicate). Needs approval.',
      { entry_id: z.string() },
      wrap(async ({ entry_id }) => { await call('/api/entry', { action: 'delete', id: entry_id }); return 'Removed.'; })),

    tool('budget_set_limit', "Change a category's monthly limit.",
      { category: z.string(), limit: z.number().min(0) },
      wrap(async ({ category, limit }) => {
        const s = await state();
        const c = findCat(s.settings.categories, category);
        const categories = s.settings.categories.map((x) => (x.id === c.id ? { ...x, limit } : x));
        await call('/api/settings', { categories, members: s.settings.members, excluded_accounts: s.settings.excluded_accounts || [] });
        return `${c.name} limit: ${money0(c.limit)} → ${money0(limit)}.`;
      })),

    tool('family_accounts', 'Bank, card, and investment account balances grouped into cash, invested, and owed, plus net worth and how it has changed. Optionally includes investment holdings.',
      { include_holdings: z.boolean().optional() },
      wrap(async ({ include_holdings = false }) => {
        const w = await call('/api/wealth');
        const acc = (w.accounts || []).filter((a) => !a.excluded);
        const label = (k) => w.kinds?.[k]?.label || k;
        const sum = (b) => acc.filter((a) => a.bucket === b).reduce((t, a) => t + Math.abs(+a.balance || 0), 0);
        const cash = sum('cash'), inv = sum('invested'), debt = sum('debt');
        const out = [`Balances as of ${w.asOf ? new Date(w.asOf).toLocaleString('en-US', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }) + ' ET' : 'unknown'}`,
          `Net worth: ${money0(cash + inv - debt)} (invested ${money0(inv)}, cash ${money0(cash)}, owed ${money0(debt)})`];
        const h = w.history || [];
        const nw = (r) => r.invested + r.cash - r.debt; // history stores debt as a positive amount owed
        if (h.length > 1) {
          const last = h.at(-1);
          for (const days of [30, 90, 365]) {
            const target = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
            if (h[0].day > target) break; // history doesn't reach back that far
            const past = h.find((r) => r.day >= target);
            if (past && past !== last) out.push(`Change over ${days} days: ${money0(nw(last) - nw(past))}`);
          }
        }
        for (const b of ['cash', 'invested', 'debt']) {
          const list = acc.filter((a) => a.bucket === b);
          if (!list.length) continue;
          out.push('', { cash: 'Cash', invested: 'Invested', debt: 'Owed' }[b] + ':');
          for (const a of list.sort((x, y) => Math.abs(y.balance) - Math.abs(x.balance))) {
            out.push(`- ${a.org ? `${a.org}: ` : ''}${a.name} (${label(a.kind)}): ${money(+a.balance)}${a.available != null && a.available !== a.balance && b === 'cash' ? `, available ${money(+a.available)}` : ''}`);
            if (include_holdings) for (const x of (a.holdings || []).slice(0, 15)) out.push(`    · ${x.symbol || x.description || 'holding'}: ${money0(+x.market_value || +x.value || 0)}`);
          }
        }
        return out.join('\n');
      })),

    tool('family_money_flows', 'Money in and out by month: paychecks (income), retirement and HSA contributions, company stock vests, moves into and out of savings, and dividends.',
      { months: z.number().int().min(1).max(12).optional() },
      wrap(async ({ months = 3 }) => {
        const w = await call('/api/wealth');
        const yms = [...new Set((w.flows || []).map((f) => f.ym))].sort().slice(-months);
        const names = { income: 'Take-home pay', contribution: 'Retirement/HSA contributions', vesting: 'Company stock vests', savings_in: 'Moved into savings', savings_out: 'Taken out of savings', dividend: 'Dividends' };
        const out = [];
        for (const ym of yms) {
          const fs = w.flows.filter((f) => f.ym === ym);
          out.push(`${monthName(ym)}:`);
          for (const [k, n] of Object.entries(names)) { const t = fs.filter((f) => f.kind === k).reduce((s, f) => s + Math.abs(+f.amt), 0); if (t) out.push(`- ${n}: ${money0(t)}`); }
          const sp = w.spending?.byMonth?.[ym];
          if (sp != null) out.push(`- Budget spending: ${money0(typeof sp === 'object' ? sp.total ?? 0 : sp)}`);
        }
        return out.join('\n') || 'No money flows recorded yet.';
      })),
  ];
}
