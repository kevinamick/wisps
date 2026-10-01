// Google Play Console connector: releases, reviews, vitals and the store listing for one app,
// via a Google Cloud service account that has been invited in Play Console → Users and permissions.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { netFetch } from './net.js';

const SCOPES = 'https://www.googleapis.com/auth/androidpublisher https://www.googleapis.com/auth/playdeveloperreporting';
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';

export function risk(t) {
  if (/^play_(reply_review|promote_release|update_rollout|update_listing|update_contact|upload_image|delete_images|submit_data_safety)$/.test(t)) return 'outward';
  return 'read';
}

// ---- service-account auth (JWT bearer grant) ----------------------------------
const tokens = new Map(); // client_email -> { token, exp }
export function parseKey(text) {
  let k;
  try { k = JSON.parse(text); } catch { throw new Error("That file isn't valid JSON."); }
  if (k.type !== 'service_account' || !k.private_key || !k.client_email) throw new Error("That isn't a Google service account key (it should have type \"service_account\").");
  return k;
}
async function accessToken(key) {
  const hit = tokens.get(key.client_email);
  if (hit && hit.exp > Date.now()) return hit.token;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: key.client_email, scope: SCOPES, aud: key.token_uri || 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');
  const r = await netFetch(key.token_uri || 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }) });
  const j = await r.json();
  if (!r.ok) throw new Error(`Google rejected the service account: ${j.error_description || j.error}`);
  tokens.set(key.client_email, { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 });
  return j.access_token;
}

export function client(key) {
  g.token = () => accessToken(key);
  return g;
  async function g(url, { method = 'GET', body } = {}) {
    const r = await netFetch(url, { method, headers: { authorization: `Bearer ${await accessToken(key)}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const j = r.status === 204 ? {} : await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = j.error?.message || JSON.stringify(j).slice(0, 300);
      if (r.status === 403 && /reporting/i.test(url)) throw new Error(`Vitals unavailable: ${msg}. Enable the "Google Play Developer Reporting API" in the service account's Google Cloud project, and give it "View app information" in Play Console.`);
      if (r.status === 403 || r.status === 401) throw new Error(`Play Console says no: ${msg}. Check this service account's app permissions in Play Console → Users and permissions.`);
      throw new Error(`Play API ${r.status}: ${msg}`);
    }
    return j;
  }
}

// Run fn inside a temporary edit; commit only when asked.
async function withEdit(g, pkg, fn, { commit = false } = {}) {
  const edit = await g(`${API}/${pkg}/edits`, { method: 'POST', body: {} });
  const base = `${API}/${pkg}/edits/${edit.id}`;
  try {
    const out = await fn(base);
    if (commit) {
      try { await g(`${base}:commit`, { method: 'POST' }); }
      catch (e) {
        if (!/changesNotSentForReview/i.test(e.message)) throw e;
        await g(`${base}:commit?changesNotSentForReview=true`, { method: 'POST' });
        return `${out}\n(Saved in Play Console but not yet sent for review. Send it for review from Publishing overview.)`;
      }
    } else await g(base, { method: 'DELETE' }).catch(() => {});
    return out;
  } catch (e) {
    await g(base, { method: 'DELETE' }).catch(() => {});
    throw e;
  }
}

const fmtRelease = (r) => `${r.name || '(unnamed)'} | builds ${(r.versionCodes || []).join(', ') || '-'} | ${r.status}${r.userFraction ? ` at ${Math.round(r.userFraction * 100)}%` : ''}${r.releaseNotes?.length ? `\n      notes (${r.releaseNotes[0].language}): ${r.releaseNotes[0].text.replace(/\n/g, ' ').slice(0, 200)}` : ''}`;
const TRACK_NAMES = { internal: 'Internal testing', alpha: 'Closed testing (alpha)', beta: 'Open testing (beta)', production: 'Production' };

export function tools(conn, { secrets, allowedDirs = [] }) {
  const pkg = conn.config.packageName;
  // Files the Wisp may upload: only from its own computer or folders shared with it.
  const readable = (p) => {
    const abs = path.resolve(allowedDirs[0] || '.', String(p).replace(/^~(?=\/)/, process.env.HOME));
    if (!allowedDirs.some((d) => abs === d || abs.startsWith(d + path.sep))) throw new Error(`${p} is outside your computer and shared folders.`);
    if (!fs.existsSync(abs)) throw new Error(`No file at ${abs}`);
    return abs;
  };
  const key = () => { const t = secrets()[`play:${conn.id}`]; if (!t) throw new Error('No service account key saved (Wisps → Connectors).'); return parseKey(t); };
  const g = (...a) => client(key())(...a);
  g.token = () => client(key()).token();
  const wrap = (fn) => async (a) => { try { return { content: [{ type: 'text', text: String(await fn(a)).slice(0, 60000) }] }; } catch (e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }; } };
  const trackArg = z.enum(['internal', 'alpha', 'beta', 'production']).or(z.string());

  return [
    tool('play_releases', `Every Google Play track for ${pkg} (internal, closed, open, production) with its releases: builds, status, rollout %, and release notes.`, {},
      wrap(() => withEdit(g, pkg, async (base) => {
        const { tracks = [] } = await g(`${base}/tracks`);
        if (!tracks.length) return 'No tracks yet.';
        return tracks.map((t) => `${TRACK_NAMES[t.track] || t.track}:\n${(t.releases || []).map((r) => `  - ${fmtRelease(r)}`).join('\n') || '  (no releases)'}`).join('\n');
      }))),

    tool('play_listing', `The Play Store listing for ${pkg}: titles, short and full descriptions per language, and contact details.`, {},
      wrap(() => withEdit(g, pkg, async (base) => {
        const [{ listings = [] }, details] = await Promise.all([g(`${base}/listings`), g(`${base}/details`)]);
        return [`Default language: ${details.defaultLanguage || '?'} | contact: ${details.contactEmail || '-'} ${details.contactWebsite || ''}`,
          ...listings.map((l) => `\n[${l.language}] ${l.title}\nShort: ${l.shortDescription}\nFull: ${String(l.fullDescription || '').slice(0, 1500)}`)].join('\n');
      }))),

    tool('play_reviews', `Recent Google Play reviews of ${pkg} (Google only returns reviews from about the last week), with rating, text, device, app version, and any developer reply.`,
      { max_results: z.number().int().min(1).max(100).optional() },
      wrap(async ({ max_results = 30 }) => {
        const r = await g(`${API}/${pkg}/reviews?maxResults=${max_results}`);
        if (!r.reviews?.length) return 'No reviews from the last week.';
        return r.reviews.map((rv) => {
          const [u, dev] = [rv.comments?.find((c) => c.userComment)?.userComment, rv.comments?.find((c) => c.developerComment)?.developerComment];
          const when = u?.lastModified?.seconds ? new Date(u.lastModified.seconds * 1000).toISOString().slice(0, 10) : '';
          return `id:${rv.reviewId} | ${'★'.repeat(u?.starRating || 0)}${'☆'.repeat(5 - (u?.starRating || 0))} | ${rv.authorName || 'Anonymous'} | ${when} | v${u?.appVersionName || '?'} | ${u?.deviceMetadata?.productName || u?.device || ''}\n   "${(u?.text || '').trim()}"${dev ? `\n   ↳ your reply: "${dev.text.trim()}"` : ''}`;
        }).join('\n');
      })),

    tool('play_reply_review', 'Post a public developer reply to a Google Play review (replaces any earlier reply). Always needs approval. Keep it short, warm, and specific.',
      { review_id: z.string(), text: z.string().max(350) },
      wrap(async ({ review_id, text }) => { await g(`${API}/${pkg}/reviews/${encodeURIComponent(review_id)}:reply`, { method: 'POST', body: { replyText: text } }); return 'Reply posted.'; })),

    tool('play_vitals', `Android vitals for ${pkg}: daily user-perceived crash rate and ANR rate over the last 4 weeks.`, {},
      wrap(async () => {
        const R = `https://playdeveloperreporting.googleapis.com/v1beta1/apps/${pkg}`;
        const end = new Date(Date.now() - 2 * 864e5), start = new Date(end - 28 * 864e5);
        const d = (x) => ({ year: x.getUTCFullYear(), month: x.getUTCMonth() + 1, day: x.getUTCDate() });
        const q = (metrics) => ({ timelineSpec: { aggregationPeriod: 'DAILY', startTime: d(start), endTime: d(end) }, metrics });
        const [crash, anr] = await Promise.all([
          g(`${R}/crashRateMetricSet:query`, { method: 'POST', body: q(['userPerceivedCrashRate', 'crashRate', 'distinctUsers']) }),
          g(`${R}/anrRateMetricSet:query`, { method: 'POST', body: q(['userPerceivedAnrRate', 'anrRate']) }),
        ]);
        const pct = (m) => (m?.decimalValue?.value != null ? `${(Number(m.decimalValue.value) * 100).toFixed(2)}%` : '-');
        const rows = (res, names) => (res.rows || []).map((row) => `${row.startTime.year}-${String(row.startTime.month).padStart(2, '0')}-${String(row.startTime.day).padStart(2, '0')}: ${names.map((n) => `${n} ${n === 'distinctUsers' ? row.metrics.find((m) => m.metric === n)?.decimalValue?.value ?? '-' : pct(row.metrics.find((m) => m.metric === n))}`).join(', ')}`);
        const c = rows(crash, ['userPerceivedCrashRate', 'crashRate', 'distinctUsers']), a = rows(anr, ['userPerceivedAnrRate', 'anrRate']);
        return `Google's bad-behavior thresholds: user-perceived crash rate 1.09%, ANR rate 0.47%.\n\nCrashes:\n${c.join('\n') || '(no data yet: needs enough daily users)'}\n\nANRs:\n${a.join('\n') || '(no data yet)'}`;
      })),

    tool('play_promote_release', 'Copy the newest release from one track to another (e.g. internal → production), optionally as a staged rollout. This publishes to real users, so it always needs approval.',
      { from_track: trackArg, to_track: trackArg, rollout_percent: z.number().min(0.1).max(100).optional(), release_notes: z.string().max(500).optional() },
      wrap(({ from_track, to_track, rollout_percent = 100, release_notes }) => withEdit(g, pkg, async (base) => {
        const src = await g(`${base}/tracks/${from_track}`);
        const rel = (src.releases || []).find((r) => ['completed', 'inProgress'].includes(r.status)) || src.releases?.[0];
        if (!rel) throw new Error(`No release on ${from_track} to promote.`);
        const staged = rollout_percent < 100;
        const release = { name: rel.name, versionCodes: rel.versionCodes, status: staged ? 'inProgress' : 'completed', ...(staged ? { userFraction: rollout_percent / 100 } : {}),
          releaseNotes: release_notes ? [{ language: rel.releaseNotes?.[0]?.language || 'en-US', text: release_notes }] : rel.releaseNotes };
        await g(`${base}/tracks/${to_track}`, { method: 'PUT', body: { track: to_track, releases: [release] } });
        return `Promoted ${rel.name || rel.versionCodes} from ${from_track} to ${to_track}${staged ? ` at ${rollout_percent}%` : ''}.`;
      }, { commit: true }))),

    tool('play_update_rollout', 'Change a staged rollout on a track: set a new percentage, halt it, resume it, or complete it (100%). Always needs approval.',
      { track: trackArg, action: z.enum(['set_percent', 'halt', 'resume', 'complete']), percent: z.number().min(0.1).max(99.9).optional() },
      wrap(({ track, action, percent }) => withEdit(g, pkg, async (base) => {
        const t = await g(`${base}/tracks/${track}`);
        const rel = (t.releases || []).find((r) => ['inProgress', 'halted'].includes(r.status));
        if (!rel) throw new Error(`No staged rollout on ${track}.`);
        if (action === 'set_percent' && !percent) throw new Error('Give a percent.');
        const next = action === 'complete' ? { ...rel, status: 'completed', userFraction: undefined }
          : action === 'halt' ? { ...rel, status: 'halted' }
          : { ...rel, status: 'inProgress', userFraction: action === 'set_percent' ? percent / 100 : rel.userFraction };
        await g(`${base}/tracks/${track}`, { method: 'PUT', body: { track, releases: (t.releases || []).map((r) => (r === rel ? next : r)) } });
        return `${track}: ${rel.name || rel.versionCodes} is now ${next.status}${next.userFraction ? ` at ${Math.round(next.userFraction * 1000) / 10}%` : ''}.`;
      }, { commit: true }))),

    tool('play_update_listing', 'Update the Play Store listing text for one language (only the fields you pass change). Publishes publicly, so it always needs approval. Limits: title 30, short description 80, full description 4000 characters.',
      { language: z.string().optional().describe('e.g. en-US (default)'), title: z.string().max(30).optional(), short_description: z.string().max(80).optional(), full_description: z.string().max(4000).optional(), video: z.string().optional().describe('YouTube URL') },
      wrap(({ language = 'en-US', title, short_description, full_description, video }) => withEdit(g, pkg, async (base) => {
        const cur = await g(`${base}/listings/${language}`).catch(() => ({}));
        const next = { language, title: title ?? cur.title, shortDescription: short_description ?? cur.shortDescription, fullDescription: full_description ?? cur.fullDescription, ...(video ?? cur.video ? { video: video ?? cur.video } : {}) };
        if (!next.title || !next.shortDescription || !next.fullDescription) throw new Error('A new listing needs a title, short description, and full description.');
        await g(`${base}/listings/${language}`, { method: 'PUT', body: next });
        return `Listing (${language}) updated: "${next.title}".`;
      }, { commit: true }))),

    tool('play_update_contact', 'Set the store contact details shown to users (email is required by Google; website and phone are optional). Always needs approval.',
      { email: z.string().optional(), website: z.string().optional(), phone: z.string().optional(), default_language: z.string().optional() },
      wrap(({ email, website, phone, default_language }) => withEdit(g, pkg, async (base) => {
        const cur = await g(`${base}/details`);
        const next = { ...cur, ...(email ? { contactEmail: email } : {}), ...(website ? { contactWebsite: website } : {}), ...(phone ? { contactPhone: phone } : {}), ...(default_language ? { defaultLanguage: default_language } : {}) };
        await g(`${base}/details`, { method: 'PUT', body: next });
        return `Contact details: ${next.contactEmail || '-'} | ${next.contactWebsite || '-'} | ${next.contactPhone || '-'}`;
      }, { commit: true }))),

    tool('play_upload_image', 'Upload a store graphic from your computer or a shared folder. Types: icon (512x512 PNG), featureGraphic (1024x500 PNG/JPG), phoneScreenshots (2-8 of them, 16:9 or 9:16, at least 320px), sevenInchScreenshots, tenInchScreenshots. Pass several files to upload a set. replace=true first removes the existing images of that type. Always needs approval.',
      { image_type: z.enum(['icon', 'featureGraphic', 'phoneScreenshots', 'sevenInchScreenshots', 'tenInchScreenshots', 'tvBanner']), files: z.array(z.string()).min(1).max(8), language: z.string().optional(), replace: z.boolean().optional() },
      wrap(({ image_type, files, language = 'en-US', replace = true }) => withEdit(g, pkg, async (base) => {
        const paths = files.map(readable);
        if (replace) await g(`${base}/listings/${language}/${image_type}`, { method: 'DELETE' });
        const uploadBase = base.replace('/androidpublisher/v3/', '/upload/androidpublisher/v3/');
        for (const p of paths) {
          const type = /\.jpe?g$/i.test(p) ? 'image/jpeg' : 'image/png';
          const r = await fetch(`${uploadBase}/listings/${language}/${image_type}?uploadType=media`, { method: 'POST', headers: { authorization: `Bearer ${await g.token()}`, 'content-type': type }, body: fs.readFileSync(p) });
          if (!r.ok) throw new Error(`Upload of ${path.basename(p)} failed: ${(await r.json().catch(() => ({}))).error?.message || r.status}`);
        }
        return `Uploaded ${paths.length} ${image_type} image(s) for ${language}.`;
      }, { commit: true }))),

    tool('play_submit_data_safety', "Submit the Data safety form using Play Console's CSV format. Get the template from Play Console → App content → Data safety → Import from CSV (download the template or an export), fill it in, save it in your computer, and pass its path. Always needs approval.",
      { csv_file: z.string() },
      wrap(async ({ csv_file }) => {
        const csv = fs.readFileSync(readable(csv_file), 'utf8');
        if (!/Question ID|Response ID/i.test(csv.split('\n')[0])) throw new Error("That doesn't look like Play's Data safety CSV (the header should include Question ID and Response ID columns).");
        await g(`${API}/${pkg}/dataSafety`, { method: 'POST', body: { safetyLabels: csv } });
        return 'Data safety form submitted. Check it in Play Console → App content → Data safety.';
      })),
  ];
}

// Used when saving the key: proves the account can open an edit for this app.
export async function verify(keyText, pkg) {
  const g = client(parseKey(keyText));
  const edit = await g(`${API}/${pkg}/edits`, { method: 'POST', body: {} });
  await g(`${API}/${pkg}/edits/${edit.id}`, { method: 'DELETE' }).catch(() => {});
  return true;
}
