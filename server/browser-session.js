// "Sign in to sites": a live view of a Wisp's own browser inside Wisps, so you can log in to a site
// (Amazon, etc.) yourself: your password and 2-step codes never pass through the Wisp. The login
// cookies stay in the Wisp's browser profile, which its browser connector then reuses.
import path from 'node:path';
import { wispDir } from './store.js';

export const VIEWPORT = { width: 1100, height: 760 };
// Each browser connector has its own profile folder (cookies, logins), so a private work browser and the
// family shopping browser never share a sign-in.
const safe = (p) => String(p || 'browser-profile').replace(/[^\w-]/g, '') || 'browser-profile';
export const profileDir = (wispId, profile) => path.join(wispDir(wispId), safe(profile));

const sessions = new Map(); // `${wispId}/${profile}` -> { ctx, page, touched, timer }
const keyOf = (wispId, profile) => `${wispId}/${safe(profile)}`;
export const isOpen = (wispId, profile) => sessions.has(keyOf(wispId, profile));

async function get(wispId, profile) {
  const s = sessions.get(keyOf(wispId, profile));
  if (!s) throw Object.assign(new Error('No sign-in browser open.'), { status: 409 });
  s.touched = Date.now();
  if (s.page.isClosed()) s.page = s.ctx.pages().find((p) => !p.isClosed()) || await s.ctx.newPage();
  return s;
}

export async function start(wispId, url, profile) {
  const key = keyOf(wispId, profile);
  if (sessions.has(key)) { const s = await get(wispId, profile); if (url) await s.page.goto(url).catch(() => {}); return; }
  const { chromium } = await import('playwright');
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profileDir(wispId, profile), { headless: true, channel: 'chromium', viewport: VIEWPORT, locale: 'en-US' });
  } catch (e) {
    if (/ProcessSingleton|already in use|lock/i.test(e.message)) throw Object.assign(new Error('The Wisp is using its browser right now. Try again in a minute.'), { status: 409 });
    throw e;
  }
  const page = ctx.pages()[0] || await ctx.newPage();
  // A new tab opened by the site (e.g. "Sign in with…") becomes the one you see.
  ctx.on('page', (p) => { const s = sessions.get(key); if (s) s.page = p; });
  const s = { ctx, page, touched: Date.now() };
  s.timer = setInterval(() => { if (Date.now() - s.touched > 15 * 60e3) stop(wispId, profile); }, 60e3);
  sessions.set(key, s);
  if (url) await page.goto(url, { timeout: 45000 }).catch(() => {});
}

export async function frame(wispId, profile) {
  const s = await get(wispId, profile);
  const jpg = await s.page.screenshot({ type: 'jpeg', quality: 60, timeout: 15000 });
  return { jpg, url: s.page.url(), title: await s.page.title().catch(() => '') };
}

export async function input(wispId, ev, profile) {
  const { page } = await get(wispId, profile);
  if (ev.type === 'click') await page.mouse.click(Number(ev.x), Number(ev.y));
  else if (ev.type === 'type') await page.keyboard.type(String(ev.text || ''), { delay: 25 });
  else if (ev.type === 'key') await page.keyboard.press(String(ev.key));
  else if (ev.type === 'scroll') await page.mouse.wheel(0, Number(ev.deltaY) || 0);
  else if (ev.type === 'navigate') await page.goto(/^https?:\/\//.test(ev.url) ? ev.url : `https://${ev.url}`, { timeout: 45000 }).catch(() => {});
  else if (ev.type === 'back') await page.goBack().catch(() => {});
  await page.waitForTimeout(350);
}

export async function stop(wispId, profile) {
  const s = sessions.get(keyOf(wispId, profile));
  if (!s) return;
  sessions.delete(keyOf(wispId, profile));
  clearInterval(s.timer);
  await s.ctx.close().catch(() => {});
}
