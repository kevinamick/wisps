// Amazon connector. Orders and deliveries come from Amazon's emails in a connected Gmail account
// (no Amazon API exists for personal accounts). Prices are read from product pages, and price
// watches are checked every few hours. Buying happens in the Wisp's own signed-in browser (see
// browser-session.js), and the final "Place your order" click always needs approval.
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { state, save, id, now, addInbox, addChat, getWisp } from '../store.js';
import { client as googleClient, header, bodyText } from './google.js';

const SENDERS = 'from:(auto-confirm@amazon.com OR shipment-tracking@amazon.com OR order-update@amazon.com OR return@amazon.com OR returns@amazon.com OR payments-messages@amazon.com OR no-reply@amazon.com OR marketplace-messages@amazon.com)';
const ORDER_RE = /\b\d{3}-\d{7}-\d{7}\b/;
// Amazon writes in the account's language; e.g. Spanish. Order matters: the first match wins.
const STATUS = [
  [/refund|reembolso|reintegro/i, 'Refunded'], [/return|devoluci[oó]n/i, 'Return'], [/cancel/i, 'Canceled'],
  [/delivered|entregad[oa]|entrega confirmada/i, 'Delivered'], [/out for delivery|en reparto|sali[oó] (para|a) (la )?entrega|en camino hoy/i, 'Out for delivery'],
  [/delay|running late|retras|demorad/i, 'Delayed'], [/shipped|on the way|arriving|enviado|en camino|llega/i, 'Shipped'],
  [/ordered|order of|order confirmation|your amazon\.com order|pedido|orden/i, 'Ordered']];
const NOISE = /expectativas|calific|rate (your|the) (seller|experience)|review|opini[oó]n|how did we do/i;

export function risk(t) { return /^amazon_(watch_price|unwatch)$/.test(t) ? 'write' : 'read'; }

const wrap = (fn) => async (a) => { try { return { content: [{ type: 'text', text: String(await fn(a)).slice(0, 60000) }] }; } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }; } };
const clean = (t) => String(t).replace(/[\u034f\u200b-\u200f\u2060\ufeff\u00ad]/g, '').replace(/https?:\/\/\S+/g, '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

// ---- prices ----------------------------------------------------------------------
export function asinOf(url) { return (/(?:\/dp\/|\/gp\/product\/|\/ASIN\/)([A-Z0-9]{10})/i.exec(url) || [])[1]?.toUpperCase() || null; }
function parsePrice(html) {
  if (/captcha|Robot Check|api-services-support@amazon\.com/i.test(html) && !/productTitle/.test(html)) return { blocked: true };
  const title = (/<span[^>]*id="productTitle"[^>]*>([\s\S]*?)<\/span>/.exec(html) || [])[1]?.replace(/\s+/g, ' ').trim();
  const core = (/id="(?:corePrice_feature_div|corePriceDisplay_desktop_feature_div|apex_desktop)"[\s\S]{0,4000}/.exec(html) || [html])[0];
  const m = /<span class="a-offscreen">\s*\$([\d,]+\.\d{2})\s*<\/span>/.exec(core) || /"priceAmount":\s*([\d.]+)/.exec(html)
    || /<span class="a-price-whole">([\d,]+)<span class="a-price-decimal">\.<\/span><\/span><span class="a-price-fraction">(\d{2})/.exec(core);
  const price = m ? Number((m[2] ? `${m[1]}.${m[2]}` : m[1]).replace(/,/g, '')) : null;
  const unavailable = /Currently unavailable|We don't know when or if this item will be back/i.test(html);
  return { title, price, unavailable };
}
// A plain, honest page request. If Amazon answers with its robot check, we report that and try again
// on the next round. We don't disguise requests to get around it.
export async function checkPrice(url) {
  const asin = asinOf(url);
  const target = asin ? `https://www.amazon.com/dp/${asin}` : url;
  const r = await fetch(target, { headers: { 'user-agent': 'Wisps/0.1 (personal price watch)', 'accept-language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(20000) });
  const got = parsePrice(await r.text());
  if (got.blocked || (!got.price && !got.unavailable)) throw new Error("Amazon didn't allow an automated price check just now (robot check). Wisps will retry on the next round. For a guaranteed price, open the link or ask me to look it up another way.");
  return { ...got, url: target, asin };
}

// ---- price watches (checked every few hours) ----------------------------------
const watches = () => (state.amazonWatches ||= []);
export function startWatcher() {
  const run = async () => {
    for (const w of watches()) {
      if (Date.now() - new Date(w.checkedAt || 0) < 3.5 * 3600e3) continue;
      try {
        const r = await checkPrice(w.url);
        w.checkedAt = now(); w.error = null;
        if (r.title) w.title = r.title;
        if (r.price != null) {
          w.lastPrice = r.price;
          w.lowest = Math.min(w.lowest ?? Infinity, r.price);
          if (r.price <= w.target && w.notifiedAt !== r.price) {
            w.notifiedAt = r.price;
            const wisp = getWisp(w.wispId);
            const msg = `**${w.title || 'Watched item'}** is now **$${r.price.toFixed(2)}** (your target: $${w.target.toFixed(2)}).\n${w.url}`;
            addInbox({ wispId: w.wispId, kind: 'notice', title: `Price drop: ${(w.title || 'Amazon item').slice(0, 60)} → $${r.price.toFixed(2)}`, body: msg });
            if (wisp) addChat(wisp.id, { role: 'wisp', kind: 'notice', text: `🔔 Price drop! ${msg}${w.note ? `\n\n(You wanted this for: ${w.note})` : ''}` });
          }
          if (r.price > w.target) w.notifiedAt = null; // re-arm after it goes back up
        }
      } catch (e) { w.checkedAt = now(); w.error = e.message; }
      save();
      await new Promise((r) => setTimeout(r, 20000)); // be gentle with Amazon
    }
  };
  setTimeout(run, 60e3);
  return setInterval(run, 30 * 60e3);
}

// ---- tools -----------------------------------------------------------------------
export function tools(conn, ctx) {
  const google = state.connectors.find((c) => c.id === conn.config.googleId);
  const gmail = () => { if (!google) throw new Error('Pick the Gmail account that gets your Amazon emails (Wisps → Connectors → Amazon).'); return googleClient(google, ctx); };
  const wispId = ctx.wisp?.id;

  async function orderMail(query, max) {
    const g = gmail();
    const list = await g(`/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${max}`);
    const ids = (list.messages || []).map((m) => m.id);
    const out = [];
    for (let i = 0; i < ids.length; i += 8) {
      out.push(...await Promise.all(ids.slice(i, i + 8).map(async (mid) => {
        const m = await g(`/gmail/v1/users/me/messages/${mid}?format=full`);
        const text = clean(bodyText(m.payload).text);
        const subject = clean(header(m, 'Subject'));
        if (NOISE.test(subject)) return null;
        return { id: mid, date: new Date(Number(m.internalDate)), subject, snippet: clean(m.snippet), text, order: (ORDER_RE.exec(`${subject} ${text}`) || [])[0] || null,
          status: (STATUS.find(([re]) => re.test(subject)) || STATUS.find(([re]) => re.test(clean(m.snippet))) || [null, 'Update'])[1] };
      })));
    }
    return out.filter(Boolean);
  }

  return [
    tool('amazon_orders', `Recent Amazon orders and their delivery status, from the Amazon emails in ${google?.name || 'the connected Gmail'}. Newest first, grouped by order number.`,
      { days: z.number().int().min(1).max(180).optional(), search: z.string().optional().describe('Words to look for, e.g. an item name') },
      wrap(async ({ days = 30, search }) => {
        const mails = await orderMail(`${SENDERS} newer_than:${days}d${search ? ` ${search}` : ''}`, 60);
        if (!mails.length) return `No Amazon order emails in the last ${days} days${search ? ` matching "${search}"` : ''}.`;
        const groups = new Map();
        for (const m of mails) { const k = m.order || `mail:${m.id}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
        return [...groups.entries()].map(([k, ms]) => {
          const latest = ms[0];
          const arriving = /(Arriving|Delivered|Expected|Now expected|Llega|Llegar[aá]|Entrega (estimada|prevista)|Fecha de entrega|Entregado)[^.\n]{0,60}/i.exec(`${latest.subject} ${latest.snippet} ${latest.text}`)?.[0];
          const total = /(Order Total|Grand Total|Total del pedido|Total)[:\s]*(US)?\$\s?[\d,]+[.,]\d{2}/i.exec(ms.map((x) => x.text).join(' '))?.[0];
          return `${k.startsWith('mail:') ? '(no order #)' : `Order ${k}`} | ${latest.status} | last update ${latest.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}${arriving ? ` | ${arriving.trim()}` : ''}${total ? ` | ${total}` : ''}\n   ${latest.subject}${ms.length > 1 ? `\n   history: ${ms.map((x) => x.status).reverse().join(' → ')}` : ''}`;
        }).join('\n');
      })),

    tool('amazon_order_details', 'Every Amazon email about one order (full text): items, prices, address, delivery updates, return and refund info.',
      { order_number: z.string().regex(ORDER_RE) },
      wrap(async ({ order_number }) => {
        const mails = await orderMail(`${SENDERS} "${order_number}"`, 20);
        if (!mails.length) return `No emails found for order ${order_number}.`;
        return mails.reverse().map((m) => `--- ${m.date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })} | ${m.status} | ${m.subject}\n${m.text.slice(0, 3000)}`).join('\n\n');
      })),

    tool('amazon_price_check', "Current price and availability of an Amazon product (from a product link or ASIN).",
      { url: z.string().describe('amazon.com product link or 10-character ASIN') },
      wrap(async ({ url }) => {
        const r = await checkPrice(/^[A-Z0-9]{10}$/i.test(url) ? `https://www.amazon.com/dp/${url}` : url);
        return `${r.title || '(title not found)'}\n${r.unavailable ? 'Currently unavailable' : r.price != null ? `Price: $${r.price.toFixed(2)}` : 'Price not found on the page'}\n${r.url}`;
      })),

    tool('amazon_watch_price', 'Watch an Amazon product and notify the owner (inbox + Telegram) when its price drops to the target or below. Checked every few hours.',
      { url: z.string(), target_price: z.number().positive(), note: z.string().optional().describe('Why they want it / who it is for') },
      wrap(async ({ url, target_price, note }) => {
        const r = await checkPrice(url).catch((e) => ({ error: e.message }));
        const w = { id: id('w'), wispId, url: r.url || url, asin: asinOf(url), title: r.title || null, target: target_price, note: note || '', lastPrice: r.price ?? null, lowest: r.price ?? null, checkedAt: now(), createdAt: now() };
        watches().push(w); save();
        return `Watching "${w.title || w.url}" for $${target_price.toFixed(2)} or less.${r.price != null ? ` It's $${r.price.toFixed(2)} now.` : r.error ? ` (Couldn't read the price just now: ${r.error})` : ''}`;
      })),

    tool('amazon_watches', 'List the Amazon price watches.', {},
      wrap(async () => watches().map((w) => `id:${w.id} | ${w.title || w.url} | target $${w.target.toFixed(2)} | now ${w.lastPrice != null ? `$${w.lastPrice.toFixed(2)}` : '?'} | lowest seen ${w.lowest != null ? `$${w.lowest.toFixed(2)}` : '?'}${w.note ? ` | for: ${w.note}` : ''}${w.error ? ` | last check failed: ${w.error}` : ''}`).join('\n') || 'No price watches.')),

    tool('amazon_unwatch', 'Stop watching an Amazon product price.', { watch_id: z.string() },
      wrap(async ({ watch_id }) => { const n = watches().length; state.amazonWatches = watches().filter((w) => w.id !== watch_id); save(); return n === watches().length ? 'No such watch.' : 'Stopped watching.'; })),
  ];
}
