import { h, render } from 'preact';
import { useState, useEffect, useRef, useMemo, useCallback } from 'preact/hooks';
import htm from 'htm';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

const html = htm.bind(h);
marked.setOptions({ gfm: true, breaks: true });

// ---------- plumbing ----------
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const listeners = new Set();
const onEvent = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
let toastFn = () => {};
const toast = (m) => toastFn(m);

const Md = ({ text, class: cls = '' }) => html`<div class="md ${cls}" dangerouslySetInnerHTML=${{ __html: DOMPurify.sanitize(marked.parse(String(text || ''))) }} />`;
const ago = (iso) => {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};
const until = (iso) => {
  const s = (new Date(iso) - Date.now()) / 1000;
  if (s < 60) return 'any moment';
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86400) return `in ${Math.round(s / 3600)}h`;
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
};
const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
const wispVars = (d) => `--wisp: hsl(${d?.avatar?.hue ?? 24} 72% 52%); --wisp-soft: hsl(${d?.avatar?.hue ?? 24} 72% 52% / .16);`;

// ---------- the Wisp orb avatar ----------
let orbN = 0;
const FACES = ['wisps', 'happy', 'calm', 'wink', 'visor', 'none'];
function Face({ face, c }) {
  switch (face) {
    case 'happy': return html`<g class="eyes" fill="none" stroke=${c} stroke-width="4.5" stroke-linecap="round"><path d="M31 50 q7 -9 14 0"/><path d="M55 50 q7 -9 14 0"/></g>`;
    case 'calm': return html`<g class="eyes" fill="none" stroke=${c} stroke-width="4.5" stroke-linecap="round"><path d="M31 49 q7 6 14 0"/><path d="M55 49 q7 6 14 0"/></g>`;
    case 'wink': return html`<g class="eyes" fill=${c}><ellipse cx="38" cy="48" rx="5.5" ry="7"/><path d="M55 49 q7 -7 14 0" fill="none" stroke=${c} stroke-width="4.5" stroke-linecap="round"/></g>`;
    case 'visor': return html`<g class="eyes"><rect x="27" y="41" width="46" height="14" rx="7" fill=${c} opacity=".85"/><rect x="33" y="45" width="10" height="5" rx="2.5" fill="#fff" opacity=".8"/></g>`;
    case 'none': return null;
    default: return html`<g class="eyes" fill=${c}><ellipse cx="38" cy="48" rx="5.5" ry="7"/><ellipse cx="62" cy="48" rx="5.5" ry="7"/></g>`;
  }
}
function Orb({ avatar = {}, size = 36, state = '' }) {
  const n = useMemo(() => ++orbN, []);
  const { hue = 24, hue2 = 300, face = 'wisps', glow = true } = avatar;
  const ink = `hsl(${hue2} 45% 14%)`;
  return html`<span class="orb ${state}" style="width:${size}px;height:${size}px">
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <radialGradient id="og${n}" cx="36%" cy="30%" r="78%">
          <stop offset="0" stop-color="hsl(${hue} 95% 86%)"/>
          <stop offset=".5" stop-color="hsl(${hue} 78% 60%)"/>
          <stop offset="1" stop-color="hsl(${hue2} 62% 32%)"/>
        </radialGradient>
        <radialGradient id="os${n}" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#fff" stop-opacity=".85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
        <radialGradient id="oh${n}" cx="50%" cy="50%" r="50%"><stop offset=".6" stop-color="hsl(${hue} 90% 60%)" stop-opacity=".35"/><stop offset="1" stop-color="hsl(${hue} 90% 60%)" stop-opacity="0"/></radialGradient>
      </defs>
      ${glow && html`<circle cx="50" cy="52" r="56" fill="url(#oh${n})"/>`}
      <g class="body">
        <circle cx="50" cy="50" r="45" fill="url(#og${n})"/>
        <ellipse cx="37" cy="27" rx="17" ry="10" fill="url(#os${n})" transform="rotate(-20 37 27)"/>
        <${Face} face=${face} c=${ink}/>
      </g>
      ${state === 'working' && html`<circle class="ring" cx="50" cy="50" r="49" fill="none" stroke="hsl(${hue} 80% 55%)" stroke-width="3" stroke-dasharray="40 270" stroke-linecap="round"/>`}
    </svg>
  </span>`;
}

// ---------- status helpers ----------
function wispStatus(wisp, S) {
  const lv = S.live?.wisps?.[wisp.id] || {};
  const tasks = S.tasks.filter((t) => t.wispId === wisp.id);
  const waiting = S.inbox.filter((i) => i.wispId === wisp.id && !i.resolved && (i.kind === 'approval' || i.kind === 'proposal')).length;
  const running = tasks.find((t) => t.status === 'running' || t.status === 'waiting');
  if (wisp.paused) return { orb: 'paused', text: 'Paused', cls: '' };
  if (waiting) return { orb: 'waiting', text: `Needs you · ${waiting}`, cls: 'need' };
  if (running) return { orb: 'working', text: `Working: ${running.title}`, cls: 'busy' };
  if (lv.chat) return { orb: 'thinking', text: 'Replying…', cls: 'busy' };
  if (lv.checkin) return { orb: 'thinking', text: 'Looking around for things to do…', cls: 'busy' };
  const queued = tasks.filter((t) => t.status === 'queued').length;
  if (queued) return { orb: '', text: `${queued} queued`, cls: '' };
  return { orb: '', text: wisp.role || 'Idle', cls: '' };
}

// ---------- App ----------
function App() {
  const [S, setS] = useState(null);
  const [sel, setSel] = useState(() => localStorage.getItem('wisps.sel'));
  const [tab, setTab] = useState('chat');
  const [inbox, setInbox] = useState(false);
  const [modal, setModal] = useState(null);
  const [call, setCall] = useState(false);
  const [msg, setMsg] = useState(null);
  const [conn, setConn] = useState(true);
  const seen = useRef(null);
  toastFn = (m) => { setMsg(m); setTimeout(() => setMsg((x) => (x === m ? null : x)), 2600); };

  useEffect(() => {
    let es;
    const connect = () => {
      es = new EventSource('/api/events');
      es.addEventListener('state', (e) => { setS(JSON.parse(e.data)); setConn(true); });
      es.addEventListener('event', (e) => { const ev = JSON.parse(e.data); listeners.forEach((fn) => fn(ev)); });
      es.onerror = () => setConn(false);
    };
    connect();
    return () => es.close();
  }, []);

  // browser notifications for new inbox items
  useEffect(() => {
    if (!S) return;
    const ids = new Set(S.inbox.map((i) => i.id));
    if (seen.current && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
      for (const it of S.inbox) {
        if (seen.current.has(it.id) || it.resolved) continue;
        const d = S.wisps.find((x) => x.id === it.wispId);
        const head = { approval: 'needs your OK', proposal: 'has an idea', done: 'finished a task', failed: 'hit a problem', notice: 'says' }[it.kind] || '';
        const n = new Notification(`${d?.name || 'Wisps'} ${head}`, { body: it.title, tag: it.id, icon: '/favicon.svg' });
        n.onclick = () => { window.focus(); setInbox(true); };
      }
    }
    seen.current = ids;
  }, [S?.inbox]);

  if (!S) return html`<div class="empty">Connecting to your Wisps…</div>`;
  const wisp = S.wisps.find((d) => d.id === sel) || S.wisps[0];
  if (wisp && wisp.id !== sel) { localStorage.setItem('wisps.sel', wisp.id); setTimeout(() => setSel(wisp.id)); }
  const pick = (id) => { setSel(id); localStorage.setItem('wisps.sel', id); };
  const openInbox = S.inbox.filter((i) => !i.resolved);
  const needs = openInbox.filter((i) => i.kind === 'approval' || i.kind === 'proposal').length;

  return html`<div class="shell" style=${wispVars(wisp)}>
    <${Sidebar} S=${S} sel=${wisp?.id} pick=${pick} onNew=${() => setModal('new')} onSettings=${() => setModal('settings')} onConnectors=${() => setModal('connectors')} onInbox=${() => setInbox(true)} unread=${openInbox.length} needs=${needs} />
    <main class="main">
      ${!conn && html`<div class="pill waiting" style="margin:8px auto 0">Reconnecting to the Wisps server…</div>`}
      ${wisp ? html`
        <div class="top">
          <${Orb} avatar=${wisp.avatar} size=${42} state=${wispStatus(wisp, S).orb} />
          <div class="title">
            <h1>${wisp.name} ${wisp.paused && html`<span class="pill">paused</span>`}</h1>
            <div class="sub">${wispStatus(wisp, S).text} · ${{ opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }[wisp.model] || wisp.model} · ${{ ask: 'Cautious', balanced: 'Balanced', autonomous: 'Autonomous' }[wisp.autonomy]}</div>
          </div>
          <button class="btn" title="Talk out loud" onClick=${() => setCall(true)}>🎙️ <span class="wide">Call</span></button>
          <button class="btn" onClick=${() => setInbox(true)}>Inbox ${needs ? html`<span class="badge">${needs}</span>` : openInbox.length ? html`<span class="badge" style="background:var(--ink-3)">${openInbox.length}</span>` : ''}</button>
        </div>
        <nav class="tabs">
          ${[['chat', 'Chat'], ['work', 'Work'], ['computer', 'Computer'], ['memory', 'Memory'], ['setup', 'Setup']].map(([k, l]) => html`
            <button class="tab ${tab === k ? 'on' : ''}" onClick=${() => setTab(k)}>${l}
              ${k === 'work' && (() => { const n = S.tasks.filter((t) => t.wispId === wisp.id && ['running', 'waiting', 'queued', 'proposed'].includes(t.status)).length; return n ? html`<span class="pill">${n}</span>` : ''; })()}
            </button>`)}
        </nav>
        <div class="view">
          ${tab === 'chat' && html`<${ChatView} key=${wisp.id} wisp=${wisp} S=${S} goWork=${() => setTab('work')} />`}
          ${tab === 'work' && html`<${WorkView} key=${wisp.id} wisp=${wisp} S=${S} />`}
          ${tab === 'computer' && html`<${ComputerView} key=${wisp.id} wisp=${wisp} S=${S} />`}
          ${tab === 'memory' && html`<${MemoryView} key=${wisp.id} wisp=${wisp} S=${S} />`}
          ${tab === 'setup' && html`<${SetupView} key=${wisp.id} wisp=${wisp} S=${S} onDeleted=${() => { setSel(null); setTab('chat'); }} />`}
        </div>` : html`<${Onboarding} onNew=${() => setModal('new')} />`}
    </main>
    ${inbox && html`<${Inbox} S=${S} close=${() => setInbox(false)} pick=${(id) => { pick(id); setTab('work'); setInbox(false); }} />`}
    ${modal === 'new' && html`<${NewWisp} close=${() => setModal(null)} created=${(d) => { pick(d.id); setTab('chat'); setModal(null); }} />`}
    ${modal === 'settings' && html`<${Settings} S=${S} close=${() => setModal(null)} />`}
    ${modal === 'connectors' && html`<${Connectors} S=${S} close=${() => setModal(null)} />`}
    ${call && wisp && html`<${Call} wisp=${wisp} close=${() => setCall(false)} />`}
    ${msg && html`<div class="toast">${msg}</div>`}
  </div>`;
}

function Sidebar({ S, sel, pick, onNew, onSettings, onConnectors, onInbox, unread, needs }) {
  const rl = S.live?.rateLimit;
  const win = rl?.unifiedWindows?.five_hour || (rl?.rateLimitType === 'five_hour' ? rl : null);
  const util = win?.utilization ?? rl?.utilization;
  const resets = win?.resetsAt || rl?.resetsAt;
  return html`<aside class="side">
    <div class="brand"><${Orb} avatar=${{ hue: 24, hue2: 310, face: 'wisps', glow: false }} size=${24} /> Wisps <small>on Claude</small></div>
    <div class="wisplist">
      ${S.wisps.map((d) => { const st = wispStatus(d, S); return html`
        <button class="wisprow ${d.id === sel ? 'sel' : ''}" onClick=${() => pick(d.id)} style=${wispVars(d)}>
          <${Orb} avatar=${d.avatar} size=${34} state=${st.orb} />
          <span class="who"><span class="nm">${d.name}</span><span class="st ${st.cls}">${st.text}</span></span>
        </button>`; })}
      <button class="wisprow" onClick=${onNew}><span style="width:34px;height:34px;border-radius:50%;border:1.5px dashed var(--line-2);display:grid;place-items:center;color:var(--ink-3);font-size:18px;flex:none">+</span><span class="who wide"><span class="nm" style="color:var(--ink-2)">New Wisp</span></span></button>
    </div>
    <div class="side-foot">
      ${util != null && html`<div class="usage" title="Your Claude subscription's rolling usage window">Claude usage (5-hour window): ${Math.round(util * 100)}%${resets ? ` · resets ${new Date(resets * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}<div class="bar"><i style="width:${Math.min(100, util * 100)}%"></i></div></div>`}
      <button class="btn ghost block wide" onClick=${onConnectors} style="justify-content:flex-start">🔌 Connectors</button>
      <button class="btn ghost block wide" onClick=${onSettings} style="justify-content:flex-start">⚙️ Settings & Telegram</button>
      <button class="btn ghost mobile-only" onClick=${onConnectors}>🔌</button>
      <button class="btn ghost mobile-only" onClick=${onSettings}>⚙️</button>
    </div>
  </aside>`;
}

function Onboarding({ onNew }) {
  return html`<div class="welcome" style="padding-top:12vh">
    <${Orb} avatar=${{ hue: 24, hue2: 310, face: 'happy' }} size=${110} />
    <h2>Meet your Wisps</h2>
    <p class="muted" style="max-width:520px;margin:0 auto">Wisps are always-on agents that run on this machine using your Claude Code subscription. Give one a goal. It works in the background on its own computer, checks in with ideas, learns from your feedback, and asks before doing anything risky.</p>
    <div style="margin-top:22px"><button class="btn accent" onClick=${onNew}>Create your first Wisp</button></div>
  </div>`;
}

// ---------- Chat ----------
function ChatView({ wisp, S, goWork }) {
  const [msgs, setMsgs] = useState(null);
  const [draft, setDraft] = useState(null);
  const [text, setText] = useState('');
  const box = useRef(null), ta = useRef(null), stick = useRef(true);
  const busy = !!S.live?.wisps?.[wisp.id]?.chat;

  useEffect(() => { api('GET', `/api/wisps/${wisp.id}/chat`).then(setMsgs); }, [wisp.id]);
  useEffect(() => onEvent((e) => {
    if (e.wispId !== wisp.id) return;
    if (e.type === 'chat') setMsgs((m) => (m && !m.some((x) => x.id === e.message.id) ? [...m, e.message] : m));
    if (e.type === 'chatStart') setDraft({ text: '', steps: [] });
    if (e.type === 'chatDelta') setDraft((d) => d && { ...d, text: d.text + e.delta });
    if (e.type === 'chatBreak') setDraft((d) => d && { ...d, text: d.text && !d.text.endsWith('\n\n') ? d.text + '\n\n' : d.text });
    if (e.type === 'chatStep') setDraft((d) => d && { ...d, steps: [...d.steps, e.step] });
    if (e.type === 'chatEnd') setDraft(null);
  }), [wisp.id]);
  useEffect(() => { const el = box.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [msgs, draft]);

  const send = async (t = text) => {
    t = t.trim();
    if (!t) return;
    setText(''); stick.current = true;
    if (ta.current) ta.current.style.height = 'auto';
    await api('POST', `/api/wisps/${wisp.id}/chat`, { text: t }).catch((e) => toast(e.message));
  };
  const grow = (e) => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(200, e.target.scrollHeight) + 'px'; };
  const suggestions = wisp.goals?.trim()
    ? ['What are you working on?', 'What could you do for me today?', 'Check in now and suggest something useful']
    : ['Help me set your goals', 'What can you do?', 'Research the best budget espresso machines and save a report'];

  return html`<div class="chat">
    <div class="msgs" ref=${box} onScroll=${(e) => { const el = e.target; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
      <div class="msgs-inner">
        ${msgs && !msgs.length && !draft && html`<div class="welcome">
          <${Orb} avatar=${wisp.avatar} size=${96} />
          <h2>Hi, I'm ${wisp.name}.</h2>
          <p class="muted" style="max-width:480px;margin:0 auto">${wisp.role || 'Your always-on agent.'} Tell me what you need. Quick questions I'll answer here, and bigger jobs I'll take on in the background.</p>
          <div class="chips">${suggestions.map((s) => html`<button class="chip" onClick=${() => send(s)}>${s}</button>`)}</div>
        </div>`}
        ${(msgs || []).map((m) => html`<${Message} key=${m.id} m=${m} wisp=${wisp} S=${S} goWork=${goWork} />`)}
        ${draft && html`<div class="msg wisp"><${Orb} avatar=${wisp.avatar} size=${30} state="thinking" />
          <div class="content">
            ${draft.steps.length > 0 && html`<div class="steps">${draft.steps.map((s) => html`<span class="step"><b>${toolLabel(s.tool)}</b> ${s.summary}</span>`)}</div>`}
            ${draft.text ? html`<${Md} text=${draft.text} />` : html`<div class="typing"><i/><i/><i/></div>`}
          </div></div>`}
      </div>
    </div>
    <div class="composer">
      <div class="composer-inner">
        <textarea ref=${ta} rows="1" placeholder=${`Message ${wisp.name}…`} value=${text} onInput=${grow}
          onKeyDown=${(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } }} />
        ${busy && html`<button class="btn icon ghost" title="Stop" onClick=${() => api('POST', `/api/wisps/${wisp.id}/stop`)}>■</button>`}
        <button class="btn icon accent" title="Send" disabled=${!text.trim()} onClick=${() => send()}>↑</button>
      </div>
      <div class="hint" style="text-align:center">${busy ? `${wisp.name} is replying. New messages will queue.` : html`Enter to send · Shift+Enter for a new line · <a href="#" onClick=${(e) => { e.preventDefault(); if (confirm('Start a fresh conversation? Memory and goals are kept.')) api('POST', `/api/wisps/${wisp.id}/chat/reset`); }}>New conversation</a>`}</div>
    </div>
  </div>`;
}

const TOOL_LABELS = { Bash: 'Ran', Read: 'Read', Write: 'Wrote', Edit: 'Edited', MultiEdit: 'Edited', Glob: 'Found', Grep: 'Searched', WebSearch: 'Searched web', WebFetch: 'Opened', TodoWrite: 'Planned' };
const connKind = (t) => { const m = /^mcp__.+?__(gmail|calendar|drive|browser|forecast)/.exec(t); return m && m[1]; };
const toolLabel = (t = '') => TOOL_LABELS[t] || (t.startsWith('mcp__wisp__') ? '•' : { gmail: 'Gmail', calendar: 'Calendar', drive: 'Drive', browser: 'Browser', forecast: 'Weather' }[connKind(t)] || t.replace(/^mcp__(.+?)__/, '$1 · '));
const toolIcon = (t = '') => ({ Bash: '⌘', Read: '📄', Write: '✏️', Edit: '✏️', MultiEdit: '✏️', Glob: '🔎', Grep: '🔎', WebSearch: '🌐', WebFetch: '🌐', TodoWrite: '☑️' }[t] || (t.startsWith('mcp__wisp__') ? '●' : { gmail: '✉️', calendar: '📅', drive: '📁', browser: '🧭', forecast: '⛅' }[connKind(t)] || '🔌'));

function Message({ m, wisp, S, goWork }) {
  if (m.role === 'user') return html`<div class="msg user"><div><div class="bubble">${m.text}</div>${m.source && m.source !== 'web' && html`<div class="src">${m.author ? `${m.author} · ` : ''}via ${m.source}</div>`}</div></div>`;
  if (m.role === 'event') {
    const item = m.inboxId && S.inbox.find((i) => i.id === m.inboxId);
    return html`<div class="msg event"><span class="ev">${m.kind === 'memory' ? '🧠' : m.kind === 'approval' ? '✋' : m.kind === 'peer' ? '' : '·'} ${m.text}
      ${item && !item.resolved && html`<button class="btn sm ok" onClick=${() => api('POST', `/api/inbox/${item.id}/resolve`, { decision: 'allow' })}>Approve</button><button class="btn sm" onClick=${() => api('POST', `/api/inbox/${item.id}/resolve`, { decision: 'deny' })}>Deny</button>`}
      ${item?.resolved && html`<b>${item.resolution === 'deny' ? 'denied' : item.resolution === 'expired' ? 'expired' : 'approved'}</b>`}</span></div>`;
  }
  const task = m.taskId && S.tasks.find((t) => t.id === m.taskId);
  return html`<div class="msg wisp"><${Orb} avatar=${wisp.avatar} size=${30} />
    <div class="content">
      ${m.steps?.length > 0 && html`<div class="steps">${m.steps.map((s) => html`<span class="step"><b>${toolLabel(s.tool)}</b> ${s.summary}</span>`)}</div>`}
      ${m.kind === 'report' ? html`<div class="report"><${Md} text=${m.text} />
        <div class="foot"><${Feedback} task=${task} /><span class="grow"/><button class="btn sm ghost" onClick=${goWork}>See the work →</button></div></div>`
        : html`<${Md} text=${m.text} />`}
    </div></div>`;
}

function Feedback({ task }) {
  const [open, setOpen] = useState(null);
  const [note, setNote] = useState('');
  if (!task || task.status !== 'done') return null;
  if (task.feedback) return html`<span class="muted" style="font-size:12.5px">${task.feedback.rating === 'up' ? '👍' : '👎'} Thanks. ${task.feedback.note ? 'Noted.' : ''}</span>`;
  const send = (rating) => { api('POST', `/api/tasks/${task.id}/feedback`, { rating, note }); setOpen(null); toast('Feedback saved. Your Wisp will learn from it.'); };
  if (open) return html`<div class="row grow"><input class="in grow" style="padding:5px 10px" placeholder=${open === 'up' ? 'What was good? (optional)' : 'What should it do differently?'} value=${note} onInput=${(e) => setNote(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && send(open)} autofocus /><button class="btn sm primary" onClick=${() => send(open)}>Send</button></div>`;
  return html`<button class="btn sm ghost" title="Good work" onClick=${() => setOpen('up')}>👍</button><button class="btn sm ghost" title="Not quite" onClick=${() => setOpen('down')}>👎</button>`;
}

// ---------- Work ----------
function WorkView({ wisp, S }) {
  const tasks = S.tasks.filter((t) => t.wispId === wisp.id);
  const [sel, setSel] = useState(null);
  const [adding, setAdding] = useState(false);
  const cur = tasks.find((t) => t.id === sel);
  const groups = [
    ['Needs you', tasks.filter((t) => t.status === 'proposed' || t.status === 'waiting')],
    ['Working on', tasks.filter((t) => t.status === 'running')],
    ['Up next', tasks.filter((t) => t.status === 'queued')],
    ['Done', tasks.filter((t) => ['done', 'failed', 'cancelled'].includes(t.status)).reverse().slice(0, 40)],
  ];
  return html`<div class="work ${cur || adding ? 'has-sel' : ''}">
    <div class="work-list">
      <button class="btn accent block" onClick=${() => { setAdding(true); setSel(null); }}>+ Give ${wisp.name} a task</button>
      ${groups.map(([name, list]) => list.length > 0 && html`<div>
        <div class="group-h">${name}<span>${list.length}</span></div>
        ${list.map((t) => html`<button class="task ${t.id === sel ? 'sel' : ''}" onClick=${() => { setSel(t.id); setAdding(false); }}>
          <div class="t">${t.title}</div>
          <div class="m"><span class="pill ${t.status}">${t.status === 'waiting' ? 'needs OK' : t.status === 'proposed' ? 'idea' : t.status}</span>
            <span>${{ you: 'from you', chat: 'from chat', wisp: 'its idea', schedule: 'recurring' }[t.source] || ''}</span><span>${ago(t.endedAt || t.startedAt || t.createdAt)}</span></div>
        </button>`)}
      </div>`)}
      ${!tasks.length && html`<div class="empty" style="padding:30px 10px">No tasks yet. Give ${wisp.name} one, ask in chat, or let it propose ideas at check-ins.</div>`}
      <${Schedules} wisp=${wisp} S=${S} />
    </div>
    <div class="work-detail">
      ${adding ? html`<${NewTask} wisp=${wisp} done=${(t) => { setAdding(false); t && setSel(t.id); }} />`
        : cur ? html`<${TaskDetail} key=${cur.id} task=${cur} wisp=${wisp} back=${() => setSel(null)} />`
        : html`<div class="empty"><${Orb} avatar=${wisp.avatar} size=${64} state=${wispStatus(wisp, S).orb} /><p>Pick a task to watch ${wisp.name} work, live.</p></div>`}
    </div>
  </div>`;
}

function NewTask({ wisp, done }) {
  const [title, setTitle] = useState(''); const [detail, setDetail] = useState('');
  const go = async () => { const t = await api('POST', `/api/wisps/${wisp.id}/tasks`, { title, detail }); toast(`${wisp.name} is on it.`); done(t); };
  return html`<div style="max-width:640px;display:flex;flex-direction:column;gap:14px">
    <button class="btn ghost sm mobile-only" style="align-self:flex-start" onClick=${() => done(null)}>← Back</button>
    <h2 style="margin:0">New task for ${wisp.name}</h2>
    <div><label class="lbl">What should it do?</label><input class="in" placeholder="e.g. Compare 3 CRM tools for a 5-person team" value=${title} onInput=${(e) => setTitle(e.target.value)} autofocus /></div>
    <div><label class="lbl">Details</label><textarea class="in" rows="6" placeholder="Context, constraints, what a great result looks like, where to save it…" value=${detail} onInput=${(e) => setDetail(e.target.value)} /></div>
    <div class="row"><button class="btn accent" disabled=${!title.trim()} onClick=${go}>Start in background</button><button class="btn ghost" onClick=${() => done(null)}>Cancel</button></div>
    <div class="hint">It runs on ${wisp.name}'s own computer and pauses for your OK before anything risky (${{ ask: 'cautious', balanced: 'balanced', autonomous: 'autonomous' }[wisp.autonomy]} mode).</div>
  </div>`;
}

function TaskDetail({ task, wisp, back }) {
  const [feed, setFeed] = useState([]);
  const end = useRef(null);
  useEffect(() => { api('GET', `/api/tasks/${task.id}/activity`).then(setFeed); }, [task.id]);
  useEffect(() => onEvent((e) => { if (e.type === 'activity' && e.taskId === task.id) setFeed((f) => [...f, e.event]); }), [task.id]);
  const active = ['running', 'waiting'].includes(task.status);
  useEffect(() => { if (active) end.current?.scrollIntoView({ block: 'nearest' }); }, [feed.length]);
  const results = useMemo(() => Object.fromEntries(feed.filter((e) => e.kind === 'tool_result').map((e) => [e.id, e])), [feed]);

  return html`<div style="max-width:820px">
    <button class="btn ghost sm mobile-only" onClick=${back}>← Tasks</button>
    <div class="row" style="align-items:flex-start">
      <h2 class="grow" style="margin:0 0 6px;font-size:20px;letter-spacing:-.01em">${task.title}</h2>
      ${task.status === 'proposed' && html`<button class="btn ok" onClick=${() => api('POST', `/api/tasks/${task.id}/decide`, { approve: true })}>Do it</button><button class="btn" onClick=${() => api('POST', `/api/tasks/${task.id}/decide`, { approve: false })}>Dismiss</button>`}
      ${['running', 'waiting', 'queued'].includes(task.status) && html`<button class="btn danger" onClick=${() => api('POST', `/api/tasks/${task.id}/cancel`)}>Stop</button>`}
      ${['done', 'failed', 'cancelled'].includes(task.status) && html`<button class="btn" onClick=${() => api('POST', `/api/tasks/${task.id}/retry`).then(() => toast('Queued again'))}>↻ Run again</button>`}
    </div>
    <div class="row muted" style="font-size:13px;gap:12px">
      <span class="pill ${task.status}">${task.status}</span>
      ${active && html`<span class="live">live</span>`}
      <span>created ${ago(task.createdAt)}</span>
      ${task.endedAt && task.startedAt && html`<span>took ${Math.max(1, Math.round((new Date(task.endedAt) - new Date(task.startedAt)) / 60000))}m</span>`}
      ${task.costUsd > 0 && html`<span title="API-equivalent value; covered by your subscription">≈$${task.costUsd.toFixed(2)} of subscription usage</span>`}
    </div>
    ${(task.detail || task.why) && html`<details open=${task.status === 'proposed'} style="margin-top:12px"><summary class="muted" style="cursor:pointer;font-size:13px">Instructions</summary><div class="card" style="margin-top:8px;padding:12px 14px"><${Md} text=${task.detail + (task.why ? `\n\n**Why:** ${task.why}` : '')} /></div></details>`}
    <div class="feed">
      ${feed.filter((e, i) => !(e.kind === 'text' && feed.slice(i + 1).some((x) => x.kind === 'end' && x.text?.trim() === e.text.trim()))).map((e, i) => html`<${FeedItem} key=${i} e=${e} result=${e.kind === 'tool' ? results[e.id] : null} />`)}
      ${active && html`<div class="fe muted"><div class="typing"><i/><i/><i/></div></div>`}
      <div ref=${end}></div>
    </div>
    ${task.status === 'done' && html`<div class="row" style="margin-top:12px"><span class="muted" style="font-size:13px">How did ${wisp.name} do?</span><${Feedback} task=${task} /></div>`}
  </div>`;
}

function FeedItem({ e, result }) {
  if (e.kind === 'tool') return html`<div class="fe tool ${result?.isError ? 'err' : ''}"><span class="ico">${toolIcon(e.tool)}</span>
    <div class="what"><b>${toolLabel(e.tool)}</b>${e.summary}
      ${result && html`<details><summary>${result.isError ? 'error ▸' : 'output ▸'}</summary><pre>${result.output || '(empty)'}</pre></details>`}</div></div>`;
  if (e.kind === 'text') return html`<div class="fe text"><${Md} text=${e.text} /></div>`;
  if (e.kind === 'policy' && e.decision !== 'allow') return html`<div class="fe gate">✋ ${e.decision === 'ask' ? 'Asked you' : 'Blocked'}: ${e.reason}</div>`;
  if (e.kind === 'approval') return html`<div class="fe gate" style="color:${e.decision === 'allow' ? 'var(--ok)' : 'var(--bad)'}">${e.decision === 'allow' ? '✓ You approved' : '✗ You declined'}</div>`;
  if (e.kind === 'end') return html`<div class="fe end ${e.status}"><div style="font-weight:650;margin-bottom:6px">${e.status === 'done' ? '✅ Result' : e.status === 'failed' ? '⚠️ Failed' : '■ Stopped'}</div><${Md} text=${e.text} /></div>`;
  return null;
}

function Schedules({ wisp, S }) {
  const list = S.schedules.filter((s) => s.wispId === wisp.id);
  const [form, setForm] = useState(null);
  const save = async () => {
    const every = form.freq === 'once' ? { kind: 'once', at: form.at } : form.freq === 'daily' ? { kind: 'daily', time: form.time } : { kind: 'interval', minutes: Number(form.freq) };
    await api('POST', '/api/schedules', { wispId: wisp.id, title: form.title, detail: form.detail, every });
    setForm(null); toast('Recurring task saved');
  };
  const desc = (e) => (e.kind === 'once' ? `Once, ${new Date(e.at).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : e.kind === 'daily' ? `Daily at ${e.time}` : e.minutes % 60 === 0 ? `Every ${e.minutes / 60}h` : `Every ${e.minutes}m`);
  return html`<div>
    <div class="group-h">Recurring<button class="btn sm ghost" onClick=${() => setForm(form ? null : { title: '', detail: '', freq: 'daily', time: '08:00' })}>${form ? 'Cancel' : '+ Add'}</button></div>
    ${form && html`<div class="card" style="padding:12px;display:flex;flex-direction:column;gap:8px;margin-bottom:8px">
      <input class="in" placeholder="e.g. Morning briefing" value=${form.title} onInput=${(e) => setForm({ ...form, title: e.target.value })} />
      <textarea class="in" rows="3" placeholder="What to do each time" value=${form.detail} onInput=${(e) => setForm({ ...form, detail: e.target.value })} />
      <div class="row"><select class="in" style="width:auto" value=${form.freq} onChange=${(e) => setForm({ ...form, freq: e.target.value })}>
        <option value="once">Once, at…</option><option value="daily">Daily at…</option><option value="30">Every 30 min</option><option value="60">Every hour</option><option value="180">Every 3 hours</option><option value="720">Every 12 hours</option></select>
        ${form.freq === 'daily' && html`<input class="in" type="time" style="width:auto" value=${form.time} onInput=${(e) => setForm({ ...form, time: e.target.value })} />`}
        ${form.freq === 'once' && html`<input class="in" type="datetime-local" style="width:auto" value=${form.at || ''} onInput=${(e) => setForm({ ...form, at: e.target.value })} />`}
        <button class="btn primary sm" disabled=${!form.title.trim()} onClick=${save}>Save</button></div>
    </div>`}
    ${list.map((s) => html`<div class="task" style="cursor:default">
      <div class="row"><div class="t grow">${s.title}</div>
        <label class="switch" title="On/off"><input type="checkbox" checked=${s.enabled} onChange=${(e) => api('PATCH', `/api/schedules/${s.id}`, { enabled: e.target.checked })} /><span></span></label></div>
      <div class="m"><span>${desc(s.every)}</span>${s.enabled ? html`<span>next ${until(s.nextAt)}</span>` : s.every.kind === 'once' && s.lastAt ? html`<span>done</span>` : ''}<span class="grow"/>
        <button class="btn sm ghost" onClick=${() => api('POST', `/api/schedules/${s.id}/run`).then(() => toast('Started'))}>Run now</button>
        <button class="btn sm ghost danger" onClick=${() => confirm('Delete this recurring task?') && api('DELETE', `/api/schedules/${s.id}`)}>✕</button></div>
    </div>`)}
    ${!list.length && !form && html`<div class="hint" style="padding:0 4px">Nothing recurring yet. Try a daily briefing, or ask in chat: “every weekday at 8, send me…”</div>`}
  </div>`;
}

// ---------- Computer ----------
function ComputerView({ wisp, S }) {
  const [dir, setDir] = useState('');
  const [listing, setListing] = useState(null);
  const [file, setFile] = useState(null);
  const load = useCallback(() => api('GET', `/api/wisps/${wisp.id}/files?path=${encodeURIComponent(dir)}`).then(setListing).catch(() => setDir('')), [wisp.id, dir]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { let t; return onEvent((e) => { if (e.wispId === wisp.id && e.type === 'activity' && e.event.kind === 'tool_result') { clearTimeout(t); t = setTimeout(load, 600); } }); }, [load]);
  const open = async (name) => { const p = dir ? `${dir}/${name}` : name; setFile(await api('GET', `/api/wisps/${wisp.id}/files?path=${encodeURIComponent(p)}`)); };
  const parts = dir ? dir.split('/') : [];
  const working = S.tasks.find((t) => t.wispId === wisp.id && ['running', 'waiting'].includes(t.status));
  return html`<div class="files ${file ? 'has-sel' : ''}">
    <div class="list">
      <div class="row" style="padding:0 4px 8px"><span class="grow muted" style="font-size:12.5px">${wisp.name}'s computer${working ? html` · <span class="live">working</span>` : ''}</span><button class="btn sm ghost" onClick=${load}>↻</button></div>
      <div class="crumbs"><button onClick=${() => { setDir(''); setFile(null); }}>🏠</button>${parts.map((p, i) => html`<span class="muted">/</span><button onClick=${() => { setDir(parts.slice(0, i + 1).join('/')); setFile(null); }}>${p}</button>`)}</div>
      ${listing?.entries?.map((e) => html`<button class="fileitem ${file?.path === (dir ? `${dir}/${e.name}` : e.name) ? 'sel' : ''}" onClick=${() => (e.dir ? (setDir(dir ? `${dir}/${e.name}` : e.name), setFile(null)) : open(e.name))}>
        <span>${e.dir ? '📁' : fileIcon(e.name)}</span><span class="n">${e.name}</span><span class="s">${e.dir ? '' : bytes(e.size)} · ${ago(e.mtime)}</span></button>`)}
      ${listing?.entries?.length === 0 && html`<div class="hint" style="padding:10px">Empty for now. Files ${wisp.name} creates show up here as it works.</div>`}
      <div class="hint" style="padding:12px 4px;word-break:break-all">On disk: ${S.dataDir}/wisps/${wisp.id}/computer</div>
    </div>
    <div class="viewer">
      ${file ? html`<div>
        <div class="row" style="margin-bottom:10px"><button class="btn ghost sm mobile-only" onClick=${() => setFile(null)}>←</button><b class="grow" style="word-break:break-all">${file.path}</b><span class="muted" style="font-size:12.5px">${bytes(file.size)}</span></div>
        ${file.binary ? html`<div class="empty">Binary file. Open it from disk.</div>` : /\.(md|markdown)$/i.test(file.path) ? html`<div class="card"><${Md} text=${file.content} /></div>` : html`<pre class="codeview">${file.content}</pre>`}
      </div>` : html`<div class="empty">Select a file to preview it.</div>`}
    </div>
  </div>`;
}
const fileIcon = (n) => (/\.(md|txt)$/i.test(n) ? '📝' : /\.(png|jpe?g|gif|svg|webp)$/i.test(n) ? '🖼️' : /\.(csv|xlsx?)$/i.test(n) ? '📊' : /\.(html?)$/i.test(n) ? '🌐' : /\.(js|ts|py|sh|json|css)$/i.test(n) ? '⌨️' : '📄');

// ---------- Memory ----------
const KIND_ICON = { person: '🧑', place: '📍', plan: '🗺️', event: '📅', preference: '💛', project: '🛠️', thing: '📦', topic: '💭' };
const scopeLabel = (scope, S) => {
  if (scope === 'owner') return null;
  if (scope === 'family') return 'family';
  const [k, v] = scope.split(':');
  if (k === 'person') return `from ${S.settings.telegram.people.find((p) => p.id === v)?.name || 'someone'}'s DMs`;
  if (k === 'group') return `from ${S.settings.telegram.groups.find((g) => String(g.chatId) === v)?.name || 'a group'}`;
  return null;
};

function MemoryView({ wisp, S }) {
  return html`<div class="setup">
    <${Bubbles} wisp=${wisp} S=${S} />
    <${Lessons} wisp=${wisp} />
  </div>`;
}

function Bubbles({ wisp, S }) {
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(null);
  const load = () => api('GET', `/api/wisps/${wisp.id}/bubbles`).then(setList);
  useEffect(() => { load(); }, [wisp.id]);
  useEffect(() => onEvent((e) => { if (e.type === 'bubbles' && e.wispId === wisp.id) load(); }), [wisp.id]);
  if (!list) return html`<div class="card"><h3>Memory bubbles</h3><div class="hint">Loading…</div></div>`;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = list.filter((b) => words.every((w) => b.title.toLowerCase().includes(w) || (b.aliases || []).some((a) => a.toLowerCase().includes(w)) || b.facts.some((f) => f.text.toLowerCase().includes(w))))
    .sort((a, b) => (!!b.pinned - !!a.pinned) || (new Date(b.updatedAt) - new Date(a.updatedAt)));
  const title = (id) => list.find((b) => b.id === id)?.title;
  const sel = list.find((b) => b.id === open);
  return html`<div class="card">
    <div class="row"><h3 class="grow" style="margin:0">Memory bubbles</h3>
      <label class="row" style="gap:6px;font-size:13px" title="After each chat, a quick pass files anything lasting into bubbles"><label class="switch"><input type="checkbox" checked=${wisp.capture !== false} onChange=${(e) => api('PATCH', `/api/wisps/${wisp.id}`, { capture: e.target.checked })} /><span></span></label>learn from chats</label></div>
    <div class="hint">What's going on in your life, as ${wisp.name} understands it: people, places, plans, events. Each bubble links to related ones, and ${wisp.name} brings up the relevant ones when they matter. Things learned in someone's DM or a group stay there unless you share the bubble with the family.</div>
    <div class="row" style="margin-top:10px"><input class="in grow" style="width:auto" placeholder="Search memories…" value=${q} onInput=${(e) => setQ(e.target.value)} /><button class="btn" onClick=${() => setAdding({ topic: '', kind: 'person', fact: '' })}>+ Bubble</button></div>
    ${adding && html`<div class="item" style="margin-top:10px;box-shadow:none">
      <div class="two"><input class="in" placeholder="Title (e.g. Mom, Japan trip)" value=${adding.topic} onInput=${(e) => setAdding({ ...adding, topic: e.target.value })} />
        <select class="in" value=${adding.kind} onChange=${(e) => setAdding({ ...adding, kind: e.target.value })}>${Object.keys(KIND_ICON).map((k) => html`<option value=${k}>${KIND_ICON[k]} ${k}</option>`)}</select></div>
      <input class="in" style="margin-top:8px" placeholder="First thing to remember" value=${adding.fact} onInput=${(e) => setAdding({ ...adding, fact: e.target.value })} />
      <div class="row" style="margin-top:8px;justify-content:flex-end"><button class="btn ghost" onClick=${() => setAdding(null)}>Cancel</button><button class="btn primary" disabled=${!adding.topic.trim() || !adding.fact.trim()} onClick=${() => api('POST', `/api/wisps/${wisp.id}/bubbles`, adding).then((b) => { setAdding(null); setOpen(b.id); load(); }).catch((e) => toast(e.message))}>Add</button></div></div>`}
    <div class="bubbles">
      ${shown.map((b) => html`<button class="bubble-card ${b.id === open ? 'on' : ''}" onClick=${() => setOpen(b.id === open ? null : b.id)}>
        <span class="bt">${KIND_ICON[b.kind] || '💭'} ${b.title}${b.pinned ? ' 📌' : ''}</span>
        <span class="bs">${b.facts.length} note${b.facts.length === 1 ? '' : 's'}${b.links?.length ? ` · ↔ ${b.links.map(title).filter(Boolean).slice(0, 2).join(', ')}${b.links.length > 2 ? '…' : ''}` : ''}${b.shared ? ' · family' : ''}</span>
      </button>`)}
    </div>
    ${!list.length && html`<div class="hint" style="padding:8px 0">No bubbles yet. As you chat, ${wisp.name} files away the people, plans and places that come up.</div>`}
    ${list.length > 0 && !shown.length && html`<div class="hint" style="padding:8px 0">Nothing matches.</div>`}
    ${sel && html`<${BubbleEditor} key=${sel.id + sel.updatedAt} b=${sel} list=${list} wisp=${wisp} S=${S} close=${() => setOpen(null)} />`}
  </div>`;
}

function BubbleEditor({ b, list, wisp, S, close }) {
  const [f, setF] = useState(() => ({ title: b.title, kind: b.kind, facts: b.facts.map((x) => ({ ...x })), links: [...(b.links || [])], aliases: (b.aliases || []).join(', ') }));
  const [note, setNote] = useState('');
  const [link, setLink] = useState('');
  const url = `/api/wisps/${wisp.id}/bubbles/${b.id}`;
  const patch = (body) => api('PATCH', url, body).catch((e) => toast(e.message));
  const dirty = f.title !== b.title || f.kind !== b.kind || f.aliases !== (b.aliases || []).join(', ') || JSON.stringify(f.facts.map((x) => [x.id, x.text])) !== JSON.stringify(b.facts.map((x) => [x.id, x.text])) || JSON.stringify(f.links) !== JSON.stringify(b.links || []);
  const others = list.filter((x) => x.id !== b.id);
  return html`<div class="item" style="margin-top:12px;box-shadow:none">
    <div class="row"><input class="in grow" style="width:auto;font-weight:600" value=${f.title} onInput=${(e) => setF({ ...f, title: e.target.value })} />
      <select class="in" style="width:auto" value=${f.kind} onChange=${(e) => setF({ ...f, kind: e.target.value })}>${Object.keys(KIND_ICON).map((k) => html`<option value=${k}>${KIND_ICON[k]} ${k}</option>`)}</select>
      <button class="btn sm ghost" onClick=${close}>✕</button></div>
    <label class="lbl" style="margin-top:10px">Also known as</label>
    <input class="in" placeholder="Other names, comma-separated (e.g. Mum, Linda)" value=${f.aliases} onInput=${(e) => setF({ ...f, aliases: e.target.value })} />
    <label class="lbl" style="margin-top:10px">Notes</label>
    ${f.facts.map((x, i) => html`<div class="rule"><input class="in grow" style="width:auto" value=${x.text} onInput=${(e) => setF({ ...f, facts: f.facts.map((y, j) => (j === i ? { ...y, text: e.target.value } : y)) })} />
      ${scopeLabel(x.scope, S) && html`<span class="pill" title="Only used there">${scopeLabel(x.scope, S)}</span>`}
      <span class="muted" style="font-size:12px;flex:none">${x.at ? ago(x.at) : 'new'}</span>
      <button class="btn sm ghost" onClick=${() => setF({ ...f, facts: f.facts.filter((_, j) => j !== i) })}>✕</button></div>`)}
    <div class="row" style="margin-top:6px"><input class="in grow" style="width:auto" placeholder="Add a note" value=${note} onInput=${(e) => setNote(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && note.trim()) { setF({ ...f, facts: [...f.facts, { text: note.trim() }] }); setNote(''); } }} />
      <button class="btn sm" disabled=${!note.trim()} onClick=${() => { setF({ ...f, facts: [...f.facts, { text: note.trim() }] }); setNote(''); }}>Add</button></div>
    <label class="lbl" style="margin-top:10px">Linked bubbles</label>
    <div class="row" style="flex-wrap:wrap;gap:6px">${f.links.map((l) => html`<span class="chip" style="padding:3px 10px">${list.find((x) => x.id === l)?.title || '?'} <a href="#" onClick=${(e) => { e.preventDefault(); setF({ ...f, links: f.links.filter((y) => y !== l) }); }}>✕</a></span>`)}
      <select class="in" style="width:auto;padding:5px 8px" value=${link} onChange=${(e) => { if (e.target.value) setF({ ...f, links: [...new Set([...f.links, e.target.value])] }); setLink(''); }}>
        <option value="">+ link to…</option>${others.filter((x) => !f.links.includes(x.id)).map((x) => html`<option value=${x.id}>${x.title}</option>`)}</select></div>
    <div class="row" style="margin-top:14px;flex-wrap:wrap">
      <button class="btn primary" disabled=${!dirty} onClick=${() => patch({ title: f.title, kind: f.kind, facts: f.facts, links: f.links, aliases: f.aliases.split(',') }).then(() => toast('Saved'))}>Save</button>
      <label class="row" style="gap:6px;font-size:13px" title="Pinned bubbles are always in mind"><label class="switch"><input type="checkbox" checked=${b.pinned} onChange=${(e) => patch({ pinned: e.target.checked })} /><span></span></label>pin</label>
      <label class="row" style="gap:6px;font-size:13px" title="Usable in every DM and in family groups, not just where it was learned"><label class="switch"><input type="checkbox" checked=${b.shared} onChange=${(e) => patch({ shared: e.target.checked })} /><span></span></label>share with family</label>
      <span class="grow"/>
      ${others.length > 0 && html`<select class="in" style="width:auto;padding:5px 8px" value="" onChange=${(e) => { const from = others.find((x) => x.id === e.target.value); if (from && confirm(`Merge “${from.title}” into “${b.title}”?`)) api('POST', `${url}/merge`, { from: from.id }).then(() => toast('Merged')); }}>
        <option value="">Merge in…</option>${others.map((x) => html`<option value=${x.id}>${x.title}</option>`)}</select>`}
      <button class="btn danger" onClick=${() => confirm(`Forget everything in “${b.title}”?`) && api('DELETE', url).then(close)}>Forget</button>
    </div>
  </div>`;
}

function Lessons({ wisp }) {
  const [text, setText] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = () => api('GET', `/api/wisps/${wisp.id}/memory`).then((r) => { setText(r.text); setDirty(false); });
  useEffect(() => { load(); }, [wisp.id]);
  useEffect(() => onEvent((e) => { if (e.type === 'memory' && e.wispId === wisp.id && !dirty) load(); }), [wisp.id, dirty]);
  return html`<div class="card">
      <h3>Lessons: how you like things done</h3>
      <div class="hint">${wisp.name} adds to this when you give 👍/👎 on its work, when you tell it how you like things, and when you dismiss its ideas. It reads this before every job. Edit freely.</div>
      <textarea class="in" style="min-height:300px;font-family:var(--mono);font-size:13px" value=${text ?? ''} placeholder="Nothing yet. Lessons appear as you work together." onInput=${(e) => { setText(e.target.value); setDirty(true); }} />
      <div class="row" style="margin-top:10px">
        <button class="btn primary" disabled=${!dirty} onClick=${() => api('PUT', `/api/wisps/${wisp.id}/memory`, { text }).then(() => { setDirty(false); toast('Memory saved'); })}>Save</button>
        <button class="btn" disabled=${busy || !text?.trim()} onClick=${async () => { setBusy(true); try { const r = await api('POST', `/api/wisps/${wisp.id}/memory/tidy`); setText(r.text); toast('Tidied up'); } finally { setBusy(false); } }}>${busy ? 'Tidying…' : '✨ Tidy up'}</button>
        ${dirty && html`<button class="btn ghost" onClick=${load}>Discard</button>`}
      </div>
    </div>`;
}

// ---------- Setup ----------
function AvatarDesigner({ avatar, onChange, name }) {
  return html`<div class="designer">
    <${Orb} avatar=${avatar} size=${120} />
    <div class="ctl">
      <div><label class="lbl">Color</label><input type="range" class="hue" min="0" max="359" value=${avatar.hue} onInput=${(e) => onChange({ ...avatar, hue: +e.target.value })} /></div>
      <div><label class="lbl">Shade</label><input type="range" class="hue" min="0" max="359" value=${avatar.hue2} onInput=${(e) => onChange({ ...avatar, hue2: +e.target.value })} /></div>
      <div><label class="lbl">Face</label><div class="faces">${FACES.map((f) => html`<button class=${avatar.face === f ? 'on' : ''} title=${f} onClick=${() => onChange({ ...avatar, face: f })}><${Orb} avatar=${{ ...avatar, face: f, glow: false }} size=${34} /></button>`)}</div></div>
    </div>
  </div>`;
}

const MODES = [
  ['ask', 'Cautious', 'Approves every command and any change outside its computer.'],
  ['balanced', 'Balanced', 'Works freely in its own computer. Asks before risky or outside actions.'],
  ['autonomous', 'Autonomous', 'Acts on its own, even in folders you share. Still asks before risky or outward-facing actions.'],
];

function SetupView({ wisp, S, onDeleted }) {
  const [f, setF] = useState(() => structuredClone(wisp));
  const [newRule, setNewRule] = useState({ pattern: '', behavior: 'allow' });
  const [grant, setGrant] = useState('');
  useEffect(() => { setF((cur) => ({ ...cur, rules: wisp.rules, heartbeat: { ...cur.heartbeat, lastAt: wisp.heartbeat?.lastAt, lastSummary: wisp.heartbeat?.lastSummary } })); }, [wisp.rules, wisp.heartbeat?.lastAt]);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const dirty = JSON.stringify({ ...f, heartbeat: { ...f.heartbeat, lastAt: 0, lastSummary: 0 } }) !== JSON.stringify({ ...wisp, heartbeat: { ...wisp.heartbeat, lastAt: 0, lastSummary: 0 } });
  const save = async () => { await api('PATCH', `/api/wisps/${wisp.id}`, f); toast('Saved'); };
  const checkinBusy = S.live?.wisps?.[wisp.id]?.checkin;
  return html`<div class="setup">
    <div class="card"><h3>Look</h3><div class="hint">Design ${f.name}'s avatar.</div><${AvatarDesigner} avatar=${f.avatar} name=${f.name} onChange=${(a) => set('avatar', a)} /></div>
    <div class="card"><h3>Identity</h3><div class="hint">Who ${f.name} is and how it should behave.</div>
      <div class="two"><div><label class="lbl">Name</label><input class="in" value=${f.name} onInput=${(e) => set('name', e.target.value)} /></div>
        <div><label class="lbl">Role</label><input class="in" placeholder="e.g. Research assistant" value=${f.role} onInput=${(e) => set('role', e.target.value)} /></div></div>
      <div style="margin-top:12px"><label class="lbl">Personality & standing instructions</label><textarea class="in" rows="4" placeholder="Tone, habits, standards, things it should always or never do…" value=${f.persona} onInput=${(e) => set('persona', e.target.value)} /></div>
      <div style="margin-top:12px"><label class="lbl">Model</label><select class="in" style="width:auto" value=${f.model} onChange=${(e) => set('model', e.target.value)}>
        <option value="opus">Opus (most capable, uses more of your plan)</option><option value="sonnet">Sonnet (balanced)</option><option value="haiku">Haiku (fast, light)</option></select></div>
    </div>
    <div class="card"><h3>Goals</h3><div class="hint">What ${f.name} works toward. At check-ins it looks for ways to move these forward.</div>
      <textarea class="in" rows="5" placeholder="- Keep me on top of AI news that matters for my job\n- Track prices on the 3 things on my wishlist\n- Help me plan a trip to Japan in April" value=${f.goals} onInput=${(e) => set('goals', e.target.value)} /></div>
    <div class="card"><h3>Autonomy</h3><div class="hint">When ${f.name} acts alone and when it asks you first.</div>
      <div class="modes">${MODES.map(([k, t, d]) => html`<button class="mode ${f.autonomy === k ? 'on' : ''}" onClick=${() => set('autonomy', k)}><b>${t}</b><span>${d}</span></button>`)}</div>
      <label class="lbl" style="margin-top:16px">Rules</label>
      <div class="hint" style="margin:0 0 6px">Your rules override the mode. Format: <code>Tool</code> or <code>Tool(pattern*)</code>, e.g. <code>Bash(npm test*)</code>, <code>WebFetch(https://github.com/*)</code>, <code>Bash(git push*)</code>.</div>
      ${f.rules.map((r, i) => html`<div class="rule"><span class="pill ${r.behavior === 'allow' ? 'done' : r.behavior === 'deny' ? 'failed' : 'waiting'}">${r.behavior}</span><code>${r.pattern}</code><button class="btn sm ghost" onClick=${() => set('rules', f.rules.filter((_, j) => j !== i))}>✕</button></div>`)}
      <div class="row" style="margin-top:8px"><select class="in" style="width:auto" value=${newRule.behavior} onChange=${(e) => setNewRule({ ...newRule, behavior: e.target.value })}><option value="allow">Always allow</option><option value="ask">Always ask</option><option value="deny">Never allow</option></select>
        <input class="in grow" style="width:auto" placeholder="Bash(npm test*)" value=${newRule.pattern} onInput=${(e) => setNewRule({ ...newRule, pattern: e.target.value })} />
        <button class="btn" disabled=${!newRule.pattern.trim()} onClick=${() => { set('rules', [...f.rules, { ...newRule, pattern: newRule.pattern.trim() }]); setNewRule({ pattern: '', behavior: 'allow' }); }}>Add</button></div>
    </div>
    <div class="card"><h3>Access to your files</h3><div class="hint">${f.name} always has its own computer. Share extra folders from this machine so it can read and work in them.</div>
      ${f.grants.map((g, i) => html`<div class="rule"><span>📁</span><code>${g}</code><button class="btn sm ghost" onClick=${() => set('grants', f.grants.filter((_, j) => j !== i))}>✕</button></div>`)}
      <div class="row" style="margin-top:8px"><input class="in grow" style="width:auto" placeholder="~/Documents/projects" value=${grant} onInput=${(e) => setGrant(e.target.value)} /><button class="btn" disabled=${!grant.trim()} onClick=${() => { set('grants', [...f.grants, grant.trim()]); setGrant(''); }}>Share folder</button></div>
    </div>
    <div class="card"><h3>Connectors</h3><div class="hint">Which of your connected accounts and tools ${f.name} can use. Add more in 🔌 Connectors.</div>
      ${S.connectors.map((c) => html`<div class="rule"><span>${CONN_ICON[c.type] || '🔌'}</span><span class="grow">${c.name} <span class="muted" style="font-size:12.5px">· ${c.access === 'family' ? 'family' : 'private'}${!c.enabled ? ' · turned off' : ''}</span></span>
        <label class="switch"><input type="checkbox" checked=${f.connectors?.[c.id] ?? true} onChange=${(e) => set('connectors', { ...(f.connectors || {}), [c.id]: e.target.checked })} /><span></span></label></div>`)}
    </div>
    <div class="card"><h3>Proactive check-ins</h3><div class="hint">Every so often ${f.name} does read-only research toward its goals, then proposes tasks or pings you. Check-ins need goals, and each one uses some of your plan.</div>
      <div class="row"><label class="switch"><input type="checkbox" checked=${f.heartbeat?.enabled} onChange=${(e) => set('heartbeat', { ...f.heartbeat, enabled: e.target.checked })} /><span></span></label>
        <span>Check in every</span><select class="in" style="width:auto" value=${f.heartbeat?.everyMin} onChange=${(e) => set('heartbeat', { ...f.heartbeat, everyMin: +e.target.value })}>
          ${[30, 60, 120, 240, 480, 1440].map((m) => html`<option value=${m}>${m < 60 ? `${m} min` : m === 1440 ? 'day' : `${m / 60} hours`}</option>`)}</select>
        <span class="grow"/><button class="btn sm" disabled=${checkinBusy} onClick=${() => api('POST', `/api/wisps/${wisp.id}/checkin`).then(() => toast('Checking in…'))}>${checkinBusy ? 'Checking in…' : 'Check in now'}</button></div>
      ${wisp.heartbeat?.lastAt && html`<div style="margin-top:12px" class="card"><div class="muted" style="font-size:12.5px;margin-bottom:4px">Last check-in ${ago(wisp.heartbeat.lastAt)}</div><${Md} text=${wisp.heartbeat.lastSummary || ''} /></div>`}
    </div>
    <div class="card"><h3>Controls</h3>
      <div class="row">
        <button class="btn" onClick=${() => api('PATCH', `/api/wisps/${wisp.id}`, { paused: !wisp.paused })}>${wisp.paused ? '▶ Resume' : '⏸ Pause'} ${wisp.name}</button>
        <button class="btn" onClick=${() => api('POST', `/api/wisps/${wisp.id}/stop`).then(() => toast('Stopped current work'))}>■ Stop current work</button>
        <span class="grow"/>
        <button class="btn danger" onClick=${async () => { if (confirm(`Delete ${wisp.name}? Its files stay on disk.`)) { const r = await api('DELETE', `/api/wisps/${wisp.id}`); toast(r.note); onDeleted(); } }}>Delete</button>
      </div>
    </div>
    ${dirty && html`<div class="savebar"><button class="btn ghost" onClick=${() => setF(structuredClone(wisp))}>Discard</button><button class="btn accent" onClick=${save}>Save changes</button></div>`}
  </div>`;
}

// ---------- Inbox ----------
function Inbox({ S, close, pick }) {
  const [deny, setDeny] = useState({});
  const open = S.inbox.filter((i) => !i.resolved);
  const recent = S.inbox.filter((i) => i.resolved).slice(0, 15);
  const order = { approval: 0, proposal: 1, failed: 2, notice: 3, done: 4 };
  open.sort((a, b) => order[a.kind] - order[b.kind]);
  const resolve = (it, decision, message) => api('POST', `/api/inbox/${it.id}/resolve`, { decision, message });
  const Item = ({ it, past }) => {
    const d = S.wisps.find((x) => x.id === it.wispId);
    const label = { approval: 'needs your OK', proposal: 'has an idea', done: 'finished', failed: "couldn't finish", notice: 'says' }[it.kind];
    return html`<div class="item ${!past ? it.kind : ''}" style=${wispVars(d) + (past ? 'opacity:.65;box-shadow:none' : '')}>
      <div class="who">${d && html`<${Orb} avatar=${d.avatar} size=${20} />`}<b style="color:var(--ink)">${d?.name || 'Wisps'}</b> ${label}<span class="grow"/>${ago(it.at)}</div>
      <div class="ttl">${it.title}</div>
      ${!past && it.body && html`<${Md} text=${it.kind === 'done' || it.kind === 'failed' ? it.body.slice(0, 400) + (it.body.length > 400 ? '…' : '') : it.body} />`}
      ${!past && it.reason && html`<div class="reason">✋ ${it.reason}</div>`}
      ${past && html`<div class="muted" style="font-size:12px">${it.resolution}</div>`}
      ${!past && it.kind === 'approval' && html`${deny[it.id] !== undefined ? html`<div class="row"><input class="in grow" style="width:auto" placeholder="Tell it why, or what to do instead (optional)" value=${deny[it.id]} onInput=${(e) => setDeny({ ...deny, [it.id]: e.target.value })} autofocus /><button class="btn" onClick=${() => resolve(it, 'deny', deny[it.id])}>Deny</button></div>`
        : html`<div class="row"><button class="btn ok" onClick=${() => resolve(it, 'allow')}>Approve</button><button class="btn" title=${`Add rule: allow ${it.rule}`} onClick=${() => resolve(it, 'always')}>Always allow</button><button class="btn ghost" onClick=${() => setDeny({ ...deny, [it.id]: '' })}>Deny…</button></div>
          <div class="hint">"Always allow" adds the rule <code>${it.rule}</code></div>`}`}
      ${!past && it.kind === 'proposal' && html`<div class="row"><button class="btn ok" onClick=${() => resolve(it, 'allow')}>Do it</button><button class="btn" onClick=${() => resolve(it, 'deny')}>Dismiss</button></div>`}
      ${!past && ['done', 'failed', 'notice'].includes(it.kind) && html`<div class="row" style="margin-top:8px">${it.taskId && html`<button class="btn sm" onClick=${() => { resolve(it, 'read'); pick(it.wispId); }}>Open</button>`}<button class="btn sm ghost" onClick=${() => resolve(it, 'read')}>Dismiss</button></div>`}
    </div>`;
  };
  return html`<div class="scrim" onClick=${close}></div>
  <aside class="drawer">
    <div class="hd"><h2>Inbox</h2>${open.some((i) => !['approval', 'proposal'].includes(i.kind)) && html`<button class="btn sm ghost" onClick=${() => api('POST', '/api/inbox/clear')}>Clear updates</button>`}<button class="btn icon ghost" onClick=${close}>✕</button></div>
    <div class="bd">
      ${!open.length && html`<div class="empty">All caught up ✨</div>`}
      ${open.map((it) => Item({ it }))}
      ${recent.length > 0 && html`<div class="group-h" style="margin-top:12px">Earlier</div>${recent.map((it) => Item({ it, past: true }))}`}
    </div>
  </aside>`;
}

// ---------- modals ----------
const PRESETS = [
  { name: 'Scout', role: 'Research assistant', goals: '- Research topics I ask about and write clear, sourced reports\n- Keep me updated on news in my areas of interest', avatar: { hue: 200, hue2: 250, face: 'wisps', glow: true } },
  { name: 'Sunny', role: 'Personal chief of staff', goals: '- Help me plan my week and stay on top of to-dos\n- Draft messages and docs for me to review', avatar: { hue: 38, hue2: 12, face: 'happy', glow: true } },
  { name: 'Byte', role: 'Coding partner', goals: '- Build small tools and scripts I ask for\n- Keep my side projects moving', avatar: { hue: 150, hue2: 200, face: 'visor', glow: true } },
];
function NewWisp({ close, created }) {
  const [f, setF] = useState({ name: '', role: '', goals: '', model: 'sonnet', autonomy: 'balanced', avatar: { hue: Math.floor(Math.random() * 360), hue2: 290, face: 'wisps', glow: true } });
  const go = async () => created(await api('POST', '/api/wisps', { ...f, name: f.name.trim() || 'Wisp' }));
  return html`<div class="scrim" onClick=${close}></div><div class="modal" style=${wispVars(f)}>
    <h2>New Wisp</h2>
    <div class="row" style="margin-bottom:14px"><span class="muted" style="font-size:13px">Start from:</span>${PRESETS.map((p) => html`<button class="chip" onClick=${() => setF({ ...f, ...p })}><${Orb} avatar=${p.avatar} size=${18} /> ${p.name}</button>`)}</div>
    <${AvatarDesigner} avatar=${f.avatar} onChange=${(a) => setF({ ...f, avatar: a })} />
    <div class="two" style="margin-top:14px"><div><label class="lbl">Name</label><input class="in" value=${f.name} placeholder="Give it a name" onInput=${(e) => setF({ ...f, name: e.target.value })} /></div>
      <div><label class="lbl">Role</label><input class="in" value=${f.role} placeholder="What it's for" onInput=${(e) => setF({ ...f, role: e.target.value })} /></div></div>
    <div style="margin-top:12px"><label class="lbl">Goals <span class="muted" style="font-weight:400">(optional; you can set these later)</span></label><textarea class="in" rows="3" value=${f.goals} onInput=${(e) => setF({ ...f, goals: e.target.value })} /></div>
    <div class="row" style="margin-top:18px;justify-content:flex-end"><button class="btn ghost" onClick=${close}>Cancel</button><button class="btn accent" onClick=${go}>Create ${f.name.trim() || 'Wisp'}</button></div>
  </div>`;
}

function Settings({ S, close }) {
  const [perm, setPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  return html`<div class="scrim" onClick=${close}></div><div class="modal" style="width:min(680px, calc(100vw - 24px))">
    <h2>Settings</h2>
    <${TelegramSettings} S=${S} />
    <${FriendsSettings} S=${S} />
    <div class="card" style="margin:12px 0"><h3>Desktop notifications</h3><div class="hint">Get a ping when a Wisp needs your OK or finishes a task while this tab is in the background.</div>
      ${perm === 'granted' ? html`<span class="pill done">On</span>` : perm === 'unsupported' ? html`<span class="muted">Not supported in this browser</span>` : html`<button class="btn" onClick=${() => Notification.requestPermission().then(setPerm)}>Turn on</button>`}</div>
    <div class="card"><h3>Powered by your Claude subscription</h3><div class="hint" style="margin:0">Wisps runs every agent through the Claude Code CLI on this machine, signed in with your Claude plan, so there's no API key and no per-token bill. Heavy use counts against your plan's usage limits. Data lives in <code>${S.dataDir}</code>.</div></div>
    <div class="row" style="margin-top:16px;justify-content:flex-end"><button class="btn primary" onClick=${close}>Done</button></div>
  </div>`;
}

function TelegramSettings({ S }) {
  const t = S.settings.telegram, live = S.telegram || {};
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [np, setNp] = useState({ name: '', canApprove: false });
  const put = (patch) => api('PUT', '/api/telegram/config', patch).catch((e) => toast(e.message));
  const connected = live.status === 'connected' && live.bot;
  const link = (p) => connected && p.invite ? `https://t.me/${live.bot.username}?start=${p.invite}` : null;
  const copy = (text) => navigator.clipboard.writeText(text).then(() => toast('Link copied'), () => prompt('Copy this link:', text));
  const wispSelect = (value, onChange) => html`<select class="in" style="width:auto;padding:5px 8px" value=${value || S.wisps[0]?.id || ''} onChange=${(e) => onChange(e.target.value)}>${S.wisps.map((d) => html`<option value=${d.id}>${d.name}</option>`)}</select>`;
  const connect = async () => { setBusy(true); try { await api('PUT', '/api/telegram/token', { token }); setToken(''); toast('Bot connected'); } catch (e) { toast(e.message.includes('Unauthorized') ? 'Telegram rejected that token. Check it and try again.' : e.message); } finally { setBusy(false); } };

  return html`<div class="card">
    <h3>Telegram</h3>
    <div class="hint">Chat with your Wisps from your phone, in a family group or by direct message. Approvers get Approve / Deny buttons when a Wisp needs an OK.</div>

    ${!t.configured || live.status === 'error' ? html`
      ${live.error && html`<div class="pill failed" style="margin-bottom:10px;white-space:normal">${live.error}</div>`}
      <ol style="margin:0 0 12px;padding-left:20px;font-size:14px;color:var(--ink-2);line-height:1.7">
        <li>In Telegram, open <a href="https://t.me/BotFather" target="_blank" rel="noopener"><b>@BotFather</b></a> and send <code>/newbot</code>.</li>
        <li>Give it your Wisp's name (e.g. <i>Sunny</i>) and a username ending in <code>bot</code>.</li>
        <li>Copy the token it gives you and paste it here.</li>
      </ol>
      <div class="row"><input class="in grow" style="width:auto" type="password" autocomplete="off" placeholder="123456789:AAH…" value=${token} onInput=${(e) => setToken(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && token.trim() && connect()} />
        <button class="btn accent" disabled=${busy || !token.trim()} onClick=${connect}>${busy ? 'Checking…' : 'Connect bot'}</button></div>`
    : connected ? html`
      <div class="row"><span class="pill done">Connected</span><a href=${`https://t.me/${live.bot.username}`} target="_blank" rel="noopener">@${live.bot.username}</a><span class="grow"/>
        <button class="btn sm ghost danger" onClick=${() => confirm('Disconnect the Telegram bot from Wisps?') && api('PUT', '/api/telegram/token', { token: '' })}>Disconnect</button></div>
      ${!live.bot.readsAll && html`<div class="item" style="margin-top:12px;box-shadow:none;border-color:color-mix(in srgb, var(--warn) 45%, var(--line))">
        <div style="font-weight:600;margin-bottom:4px">One more step for groups</div>
        <div style="font-size:13.5px;color:var(--ink-2)">Right now the bot only sees group messages that @mention it or reply to it. To let it answer when someone says its name, and follow the conversation, send <code>/setprivacy</code> to @BotFather, pick your bot, and choose <b>Disable</b>. Then remove the bot from the group and add it back (or make it a group admin).</div>
        <button class="btn sm" style="margin-top:8px" onClick=${() => api('POST', '/api/telegram/recheck').then(() => toast('Rechecked'))}>I did it. Recheck.</button></div>`}`
    : html`<span class="live">Connecting…</span>`}

    <label class="lbl" style="margin-top:18px">People</label>
    <div class="hint" style="margin:0 0 6px">Only people on this list can talk to your Wisps. Add someone, then send them their invite link. Opening it in Telegram connects them. Add yourself first.</div>
    ${t.people.map((p, i) => html`<div class="rule" style="flex-wrap:wrap">
      <b style="min-width:70px">${p.name}</b>
      ${p.userId ? html`<span class="pill done">linked${p.username ? ` · @${p.username}` : ''}</span>`
        : link(p) ? html`<span class="row" style="gap:6px;flex:1;min-width:0"><code style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:12px">${link(p)}</code><button class="btn sm" onClick=${() => copy(link(p))}>Copy invite link</button></span>`
        : html`<span class="muted" style="font-size:13px">connect the bot to get an invite link</span>`}
      <span class="grow"/>
      <label class="row" style="gap:6px;font-size:13px;flex:none" title="Gets approval requests and can approve risky actions"><label class="switch"><input type="checkbox" checked=${p.canApprove} onChange=${(e) => put({ people: t.people.map((x, j) => (j === i ? { ...x, canApprove: e.target.checked } : x)) })} /><span></span></label>approver</label>
      <button class="btn sm ghost" onClick=${() => confirm(`Remove ${p.name}?`) && put({ people: t.people.filter((_, j) => j !== i) })}>✕</button></div>`)}
    <div class="row" style="margin-top:8px">
      <input class="in grow" style="width:auto" placeholder="Name (e.g. Alex)" value=${np.name} onInput=${(e) => setNp({ ...np, name: e.target.value })} onKeyDown=${(e) => e.key === 'Enter' && np.name.trim() && api('POST', '/api/telegram/people', np).then(() => setNp({ name: '', canApprove: false }))} />
      <label class="row" style="gap:6px;font-size:13px"><input type="checkbox" checked=${np.canApprove} onChange=${(e) => setNp({ ...np, canApprove: e.target.checked })} />approver</label>
      <button class="btn" disabled=${!np.name.trim()} onClick=${() => api('POST', '/api/telegram/people', np).then(() => setNp({ name: '', canApprove: false }))}>Add person</button>
    </div>
    ${live.unknown?.length > 0 && html`<div class="hint" style="margin-top:10px">Messaged the bot but not on your list: ${live.unknown.map((u) => html`<button class="chip" style="margin:4px 4px 0 0;padding:3px 10px" onClick=${() => api('POST', '/api/telegram/people', { userId: u.userId, name: u.name })}>+ ${u.name || 'Unknown'}${u.username ? ` (@${u.username})` : ''}</button>`)}</div>`}

    ${connected && html`
      <label class="lbl" style="margin-top:18px">Family groups</label>
      <div class="hint" style="margin:0 0 6px">In Telegram, make a group with your family and add <b>@${live.bot.username}</b>. When an approver adds it, the group connects on its own. In the group, the Wisp replies when someone says its name, @mentions it, or replies to it.</div>
      ${t.groups.map((g, i) => html`<div class="rule">
        <span>👨‍👩‍👧</span><b class="grow" style="min-width:0;overflow:hidden;text-overflow:ellipsis">${g.name}</b>
        ${wispSelect(g.wispId, (v) => put({ groups: t.groups.map((x, j) => (j === i ? { ...x, wispId: v } : x)) }))}
        <label class="row" style="gap:6px;font-size:13px;flex:none" title="Reply to every message, not only when called"><label class="switch"><input type="checkbox" checked=${g.replyToAll} onChange=${(e) => put({ groups: t.groups.map((x, j) => (j === i ? { ...x, replyToAll: e.target.checked } : x)) })} /><span></span></label>every msg</label>
        <button class="btn sm ghost" title="Stop replying in this group" onClick=${() => put({ groups: t.groups.filter((_, j) => j !== i) })}>✕</button></div>`)}
      ${live.pendingGroups?.map((g) => html`<div class="rule"><span>➕</span><span class="grow">${g.name} <span class="muted">(added by someone who isn't an approver)</span></span><button class="btn sm" onClick=${() => api('POST', '/api/telegram/groups/connect', { chatId: g.chatId, wispId: t.defaultWispId || S.wisps[0]?.id })}>Connect</button></div>`)}
      ${!t.groups.length && !live.pendingGroups?.length && html`<div class="hint">No groups yet.</div>`}

      <label class="lbl" style="margin-top:18px">Direct messages</label>
      <div class="row"><span class="muted" style="font-size:14px">DMs go to</span>${wispSelect(t.defaultWispId, (v) => put({ defaultWispId: v }))}<span class="hint" style="margin:0">(anyone can switch with <code>/wisp Name</code>)</span></div>
      <label class="row" style="margin-top:10px;gap:8px;font-size:14px"><label class="switch"><input type="checkbox" checked=${t.updates} onChange=${(e) => put({ updates: e.target.checked })} /><span></span></label>Send results of tasks started in the app to approvers on Telegram</label>`}
  </div>`;
}

// ---------- Friends' Wisps ----------
function FriendsSettings({ S }) {
  const peer = S.peer || {};
  const [addr, setAddr] = useState(peer.publicUrl || '');
  const [me, setMe] = useState(peer.name || '');
  const [inv, setInv] = useState({ name: '' });
  const [code, setCode] = useState(null);
  const [accept, setAccept] = useState('');
  const [busy, setBusy] = useState(false);
  const [logFor, setLogFor] = useState(null);
  const [edit, setEdit] = useState({});
  const copy = (text) => navigator.clipboard.writeText(text).then(() => toast('Copied'), () => prompt('Copy this:', text));
  const put = (body) => api('PUT', '/api/peer/settings', body).then(() => toast('Saved')).catch((e) => toast(e.message));
  const patch = (c, body) => api('PATCH', `/api/contacts/${c.id}`, body).catch((e) => toast(e.message));
  const wispSelect = (value, onChange) => html`<select class="in" style="width:auto;padding:5px 8px" value=${value || S.wisps[0]?.id || ''} onChange=${(e) => onChange(e.target.value)}>${S.wisps.map((d) => html`<option value=${d.id}>${d.name}</option>`)}</select>`;
  return html`<div class="card" style="margin-top:12px">
    <h3>Friends' Wisps</h3>
    <div class="hint">Let your Wisp work things out with friends' Wisps: find a time for dinner, compare plans, pass messages along. You decide what it may share with each friend. Nothing is agreed without your OK, and you can read every conversation here.</div>

    <label class="lbl" style="margin-top:12px">Your peer address</label>
    <div class="hint" style="margin:0 0 6px">Friends' Wisps reach yours on port <code>${peer.port}</code>, which serves only Wisp-to-Wisp messages, never this app. Expose just that port, for example with <code>tailscale serve --bg --https=8443 http://127.0.0.1:${peer.port}</code> plus a Tailscale share, then paste the address here.</div>
    <div class="row"><input class="in grow" style="width:auto" placeholder="https://my-wisps.tailnet.ts.net:8443" value=${addr} onInput=${(e) => setAddr(e.target.value)} />
      <input class="in" style="width:150px" placeholder="Your name" title="How friends' Wisps know you" value=${me} onInput=${(e) => setMe(e.target.value)} />
      <button class="btn" disabled=${addr === (peer.publicUrl || '') && me === (peer.name || '')} onClick=${() => put({ publicUrl: addr, name: me })}>Save</button></div>

    <label class="lbl" style="margin-top:16px">Friends</label>
    ${(S.contacts || []).map((c) => { const e = edit[c.id]; return html`<div class="item" style="box-shadow:none;margin-bottom:8px">
      <div class="row" style="flex-wrap:wrap"><b>${c.name}</b>${c.status === 'linked' ? html`<span class="pill done">paired</span>` : html`<span class="pill waiting">invite sent</span>`}
        ${c.lastAt && html`<span class="muted" style="font-size:12.5px">last talked ${ago(c.lastAt)}</span>`}<span class="grow"/>
        <span class="muted" style="font-size:13px">answered by</span>${wispSelect(c.wispId, (v) => patch(c, { wispId: v }))}</div>
      <label class="lbl" style="margin-top:8px">What your Wisp may share with ${c.name}</label>
      <textarea class="in" rows="3" value=${e ?? c.share} placeholder="e.g. Whether I'm free on weeknights. I'm vegetarian. Never share my address." onInput=${(ev) => setEdit({ ...edit, [c.id]: ev.target.value })} />
      <div class="row" style="margin-top:8px;flex-wrap:wrap">
        ${e !== undefined && e !== c.share && html`<button class="btn sm primary" onClick=${() => patch(c, { share: e }).then(() => { setEdit({ ...edit, [c.id]: undefined }); toast('Saved'); })}>Save rules</button>`}
        <label class="row" style="gap:6px;font-size:13px" title="Their Wisp can see when you're busy (no event details), from your Google Calendar"><label class="switch"><input type="checkbox" checked=${c.availability} onChange=${(ev) => patch(c, { availability: ev.target.checked })} /><span></span></label>free/busy</label>
        <label class="row" style="gap:6px;font-size:13px" title="Let your Wisp message theirs without asking you first"><label class="switch"><input type="checkbox" checked=${c.sendApproval === 'allow'} onChange=${(ev) => patch(c, { sendApproval: ev.target.checked ? 'allow' : 'ask' })} /><span></span></label>message without asking</label>
        <span class="grow"/>
        <button class="btn sm" onClick=${() => (logFor?.id === c.id ? setLogFor(null) : api('GET', `/api/contacts/${c.id}/log`).then((l) => setLogFor({ id: c.id, l })))}>${logFor?.id === c.id ? 'Hide' : 'Conversations'}</button>
        <button class="btn sm ghost danger" onClick=${() => confirm(`Remove ${c.name}? Their Wisp won't be able to reach yours.`) && api('DELETE', `/api/contacts/${c.id}`)}>Remove</button></div>
      ${logFor?.id === c.id && html`<div style="margin-top:10px;max-height:320px;overflow:auto">${logFor.l.length ? logFor.l.map((x) => html`<div style="margin:6px 0;font-size:13.5px"><span class="muted" style="font-size:12px">${ago(x.at)} · ${x.dir === 'out' ? `you${x.wisp ? ` (${x.wisp})` : ''}` : `${c.name}'s Wisp`}</span><${Md} text=${x.text} /></div>`) : html`<div class="hint">No messages yet.</div>`}</div>`}
    </div>`; })}
    ${!(S.contacts || []).length && html`<div class="hint">No friends yet.</div>`}

    <div class="two" style="margin-top:10px">
      <div><label class="lbl">Invite a friend</label>
        <div class="row"><input class="in grow" style="width:auto" placeholder="Their name" value=${inv.name} onInput=${(e) => setInv({ ...inv, name: e.target.value })} />
          <button class="btn" disabled=${!inv.name.trim() || !peer.publicUrl} title=${peer.publicUrl ? '' : 'Set your peer address first'} onClick=${() => api('POST', '/api/contacts/invite', inv).then((r) => { setCode({ name: inv.name, code: r.code }); setInv({ name: '' }); }).catch((e) => toast(e.message))}>Invite</button></div>
        ${code && html`<div class="hint">Send ${code.name} this code. They paste it into their Wisps under Settings → Friends' Wisps.<div class="row" style="margin-top:6px"><code style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:12px">${code.code}</code><button class="btn sm" onClick=${() => copy(code.code)}>Copy</button></div></div>`}</div>
      <div><label class="lbl">Got an invite code?</label>
        <div class="row"><input class="in grow" style="width:auto" placeholder="wisp1.…" value=${accept} onInput=${(e) => setAccept(e.target.value)} />
          <button class="btn" disabled=${busy || !accept.trim() || !peer.publicUrl} title=${peer.publicUrl ? '' : 'Set your peer address first'} onClick=${async () => { setBusy(true); try { const c = await api('POST', '/api/contacts/accept', { code: accept }); setAccept(''); toast(`Paired with ${c.name}`); } catch (e) { toast(e.message); } finally { setBusy(false); } }}>${busy ? 'Pairing…' : 'Pair'}</button></div></div>
    </div>
  </div>`;
}

// ---------- Connectors ----------
const CONN_ICON = { google: '✉️', weather: '⛅', browser: '🧭', mcp: '🔌', budget: '💰', play: '▶️', amazon: '📦' };
function Connectors({ S, close }) {
  const [adding, setAdding] = useState(false);
  const google = S.connectors.filter((c) => c.type === 'google');
  const others = S.connectors.filter((c) => c.type !== 'google');
  return html`<div class="scrim" onClick=${close}></div><div class="modal" style="width:min(720px, calc(100vw - 24px))">
    <h2>Connectors</h2>
    <p class="muted" style="margin:-6px 0 14px;font-size:14px">Give your Wisps access to your accounts and tools. <b>Private</b> connectors are only used for their owner, in the app or their DMs, never in group chats. <b>Family</b> connectors work for everyone. Sending, inviting, and deleting always wait for your OK.</p>
    <${GoogleCard} S=${S} accounts=${google} />
    ${!S.connectors.some((c) => c.type === 'budget') && html`<${BudgetSetup} />`}
    ${!S.connectors.some((c) => c.type === 'play') && html`<${PlaySetup} />`}
    ${!S.connectors.some((c) => c.type === 'amazon') && html`<${AmazonSetup} S=${S} />`}
    ${others.map((c) => html`<${ConnectorCard} key=${c.id} S=${S} c=${c} />`)}
    <div class="row" style="margin:-4px 0 12px"><button class="btn sm ghost" onClick=${() => api('POST', '/api/connectors/browser', { name: 'Work browser' }).then(() => toast('Added a private Work browser'))}>+ Add a private browser (for your own accounts)</button></div>
    ${adding ? html`<${AddMcp} done=${() => setAdding(false)} />` : html`<div class="card" style="margin-top:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap"><span style="font-size:22px">🔌</span><div class="grow"><b>Custom connector (MCP)</b><div class="hint" style="margin:2px 0 0">Plug in any MCP server: Notion, Todoist, Home Assistant, GitHub, Slack…</div></div><button class="btn" onClick=${() => setAdding(true)}>Add</button></div>`}
    <div class="row" style="margin-top:16px;justify-content:flex-end"><button class="btn primary" onClick=${close}>Done</button></div>
  </div>`;
}

function AccessPicker({ S, c, showOwner = true }) {
  const people = S.settings.telegram.people;
  return html`<div class="row" style="gap:8px">
    <select class="in" style="width:auto;padding:5px 8px" value=${c.access} onChange=${(e) => api('PATCH', `/api/connectors/${c.id}`, { access: e.target.value })}>
      <option value="private">🔒 Private</option><option value="family">👨‍👩‍👧 Family</option></select>
    ${showOwner && c.access === 'private' && people.length > 0 && html`<span class="muted" style="font-size:13px">owner</span><select class="in" style="width:auto;padding:5px 8px" value=${c.ownerId || ''} onChange=${(e) => api('PATCH', `/api/connectors/${c.id}`, { ownerId: e.target.value || null })}>
      <option value="">Me (approvers)</option>${people.map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select>`}
  </div>`;
}

function TestButton({ c }) {
  const [r, setR] = useState(null);
  return html`<span><button class="btn sm ghost" onClick=${() => { setR('…'); api('POST', `/api/connectors/${c.id}/test`).then((x) => setR(x.text), (e) => setR('⚠️ ' + e.message)); }}>Test</button>
    ${r && html`<pre class="codeview" style="margin-top:8px;font-size:12px;white-space:pre-wrap">${r}</pre>`}</span>`;
}

function GoogleCard({ S, accounts }) {
  const [cid, setCid] = useState(''); const [sec, setSec] = useState('');
  const [owner, setOwner] = useState(S.settings.telegram.people.find((p) => p.canApprove)?.id || '');
  const people = S.settings.telegram.people;
  const saveClient = () => api('PUT', '/api/connectors/google/client', { clientId: cid, clientSecret: sec }).then(() => { setCid(''); setSec(''); toast('Saved. Now connect an account.'); }, (e) => toast(e.message));
  const [pasting, setPasting] = useState(false); const [landed, setLanded] = useState('');
  const connect = async (reconnect) => { const { url } = await api('POST', '/api/connectors/google/auth', { ownerId: owner || null, reconnect }); window.open(url, '_blank', 'width=520,height=700'); if (!['localhost', '127.0.0.1'].includes(location.hostname)) setPasting(true); };
  const L = (href, text) => html`<a href=${href} target="_blank" rel="noopener">${text}</a>`;
  return html`<div class="card" style="margin-bottom:12px">
    <div class="row"><span style="font-size:22px">✉️📅</span><div class="grow"><h3 style="margin:0">Google: Gmail, Calendar & Drive</h3><div class="hint" style="margin:2px 0 0">Read and draft email (sending asks you first), manage calendars, and read Docs, Sheets, and files.</div></div></div>
    ${!S.googleClient ? html`<div style="margin-top:12px">
      <div class="hint" style="margin:0 0 8px">One-time setup (about 10 minutes). Google needs you to create your own free "app" so your data goes straight from Google to this computer.</div>
      <ol style="margin:0 0 12px;padding-left:20px;font-size:14px;color:var(--ink-2);line-height:1.75">
        <li>${L('https://console.cloud.google.com/projectcreate', 'Create a Google Cloud project')} named "Wisps" (free, no billing needed).</li>
        <li>${L('https://console.cloud.google.com/flows/enableapi?apiid=gmail.googleapis.com,calendar-json.googleapis.com,drive.googleapis.com', 'Enable the Gmail, Calendar, and Drive APIs')} for that project.</li>
        <li>Open ${L('https://console.cloud.google.com/auth/overview', 'Google Auth Platform')} → <b>Get started</b>: app name "Wisps", your email, audience <b>External</b>, and finish.</li>
        <li>In ${L('https://console.cloud.google.com/auth/audience', 'Audience')}, click <b>Publish app</b>. (If you leave it in Testing, Google makes you reconnect every 7 days.)</li>
        <li>In ${L('https://console.cloud.google.com/auth/clients', 'Clients')} → <b>Create client</b> → type <b>Desktop app</b> → Create. Copy the client ID and secret here:</li>
      </ol>
      <div class="two"><input class="in" placeholder="Client ID (….apps.googleusercontent.com)" value=${cid} onInput=${(e) => setCid(e.target.value)} />
        <input class="in" type="password" placeholder="Client secret" value=${sec} onInput=${(e) => setSec(e.target.value)} /></div>
      <div class="row" style="margin-top:8px"><button class="btn accent" disabled=${!cid.trim() || !sec.trim()} onClick=${saveClient}>Save</button></div>
    </div>` : html`<div style="margin-top:12px">
      ${accounts.map((c) => html`<div class="rule" style="flex-wrap:wrap">
        <b class="grow" style="min-width:160px">${c.name}</b>
        ${c.status === 'reconnect' ? html`<span class="pill failed">needs reconnect</span>` : c.status === 'partial' ? html`<span class="pill waiting" title=${'Missing: ' + (c.missing || []).join(', ')}>some permissions missing</span>` : html`<span class="pill done">connected</span>`}
        <${AccessPicker} S=${S} c=${c} />
        <label class="switch" title="On/off"><input type="checkbox" checked=${c.enabled} onChange=${(e) => api('PATCH', `/api/connectors/${c.id}`, { enabled: e.target.checked })} /><span></span></label>
        <${TestButton} c=${c} />
        ${c.status === 'reconnect' || c.status === 'partial' ? html`<button class="btn sm" onClick=${() => connect(c.id)}>Reconnect</button>` : ''}
        <button class="btn sm ghost danger" onClick=${() => confirm(`Disconnect ${c.name}?`) && api('DELETE', `/api/connectors/${c.id}`)}>✕</button></div>`)}
      <div class="row" style="margin-top:10px">
        ${people.length > 0 && html`<span class="muted" style="font-size:13px">Whose account?</span><select class="in" style="width:auto;padding:5px 8px" value=${owner} onChange=${(e) => setOwner(e.target.value)}><option value="">Mine</option>${people.map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select>`}
        <button class="btn accent" onClick=${() => connect()}>+ Connect a Google account</button>
        <span class="grow"/><button class="btn sm ghost" onClick=${() => confirm('Remove your Google OAuth client from Wisps?') && api('DELETE', '/api/connectors/google/client')}>Change OAuth client</button>
      </div>
      ${pasting && html`<div class="item" style="margin-top:10px;box-shadow:none">
        <div style="font-size:13.5px;margin-bottom:6px">After you approve, Google opens a page at <code>127.0.0.1</code> that <b>won't load</b>. That's expected, because Wisps runs on another machine. Copy that page's whole address from the address bar and paste it here:</div>
        <div class="row"><input class="in grow" style="width:auto" placeholder="http://127.0.0.1:4777/oauth/google/callback?state=…&code=…" value=${landed} onInput=${(e) => setLanded(e.target.value)} />
          <button class="btn accent" disabled=${!landed.includes('code=')} onClick=${() => api('POST', '/api/connectors/google/finish', { url: landed }).then((r) => { toast(r.message); setPasting(false); setLanded(''); }, (e) => toast(e.message))}>Finish</button></div></div>`}
      <div class="hint">Google will say <i>"Google hasn't verified this app."</i> That's expected for your own app: click <b>Advanced → Go to Wisps</b>, and tick every permission box.</div>
      <details class="hint" style="margin-top:6px"><summary style="cursor:pointer">Seeing <i>"Access blocked: Wisps has not completed the Google verification process"</i>?</summary>
        <div style="margin-top:6px">Your Google app is still in <b>Testing</b>. In ${L('https://console.cloud.google.com/auth/audience', 'Google Auth Platform → Audience')}, click <b>Publish app</b> (recommended). Or, under <b>Test users</b>, add the Gmail address you're connecting. With test users, Google makes you reconnect every 7 days, and Wisps will remind you.</div></details>
    </div>`}
  </div>`;
}

function ConnectorCard({ S, c }) {
  const [home, setHome] = useState(c.config?.home || '');
  const [code, setCode] = useState('');
  const [signIn, setSignIn] = useState(null);
  const gmail = c.type === 'amazon' && S.connectors.find((x) => x.id === c.config.googleId);
  const title = { weather: 'Weather', browser: c.name || 'Web browser', mcp: c.name, budget: 'Family budget', play: c.name, amazon: 'Amazon' }[c.type];
  const desc = { weather: 'Forecasts from Open-Meteo. Free, no key needed.', browser: html`Each Wisp gets its own headless Chromium for sites that need clicking, forms, or logging in. Screenshots and downloads land in its computer.${c.config?.signedIn?.length ? html` <b>Signed in to:</b> ${c.config.signedIn.join(', ')}.` : ''}`, mcp: c.config?.url || `${c.config?.command} ${c.config?.args || ''}`, amazon: html`Orders and deliveries from ${gmail?.name || '(pick a Gmail)'}'s Amazon emails, price checks, and price watches${(S.amazonWatches || []).length ? ` (${S.amazonWatches.length} watching)` : ''}. To let your Wisps shop, sign in to Amazon in its browser. Checkout always waits for your OK.`, play: html`Releases, rollouts, reviews, and vitals for <code>${c.config?.packageName}</code> via <code style="font-size:11.5px">${c.config?.serviceAccount}</code>`, budget: html`Spending vs limits, entries, logging purchases, balances, and net worth from <a href=${c.config?.url} target="_blank" rel="noopener">${c.config?.url?.replace(/^https?:\/\//, '')}</a>` }[c.type];
  return html`<div class="card" style="margin-bottom:12px">
    <div class="row"><span style="font-size:22px">${CONN_ICON[c.type]}</span><div class="grow" style="min-width:0"><h3 style="margin:0">${title}</h3><div class="hint" style="margin:2px 0 0;overflow-wrap:anywhere">${desc}</div></div>
      <label class="switch" title="On/off"><input type="checkbox" checked=${c.enabled} onChange=${(e) => api('PATCH', `/api/connectors/${c.id}`, { enabled: e.target.checked })} /><span></span></label></div>
    <div class="row" style="margin-top:10px">
      <${AccessPicker} S=${S} c=${c} showOwner=${c.type === 'mcp'} />
      ${c.type === 'weather' && html`<input class="in" style="width:170px;padding:5px 10px" placeholder="Home city" value=${home} onInput=${(e) => setHome(e.target.value)} onBlur=${() => api('PATCH', `/api/connectors/${c.id}`, { config: { ...c.config, home } })} />
        <select class="in" style="width:auto;padding:5px 8px" value=${c.config.units} onChange=${(e) => api('PATCH', `/api/connectors/${c.id}`, { config: { ...c.config, home, units: e.target.value } })}><option value="fahrenheit">°F</option><option value="celsius">°C</option></select>
        <${TestButton} c=${c} />`}
      ${c.type === 'browser' && html`<span class="grow"/>${c.config.profile && html`<button class="btn sm" onClick=${() => setSignIn({ url: 'https://play.google.com/console', site: 'Google Play Console' })}>Sign in to Play Console</button>`}<button class="btn sm" onClick=${() => setSignIn({ url: '', site: '' })}>Sign in to a site…</button>${c.config.profile && html`<button class="btn sm ghost danger" onClick=${() => confirm(`Remove ${c.name}? Its sign-ins are forgotten.`) && api('DELETE', `/api/connectors/${c.id}`)}>✕</button>`}`}
      ${c.type === 'amazon' && html`<${TestButton} c=${c} /><span class="grow"/><button class="btn sm accent" onClick=${() => setSignIn({ url: 'https://www.amazon.com/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.com%2F&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=usflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0', site: 'Amazon' })}>Sign in to Amazon for shopping</button><button class="btn sm ghost danger" onClick=${() => confirm('Remove the Amazon connector?') && api('DELETE', `/api/connectors/${c.id}`)}>✕</button>`}
      ${c.type === 'play' && html`<${TestButton} c=${c} /><span class="grow"/><${PlayKeyButton} pkg=${c.config.packageName} label="Replace key" /><button class="btn sm ghost danger" onClick=${() => confirm(`Remove ${c.name}?`) && api('DELETE', `/api/connectors/${c.id}`)}>✕</button>`}
      ${c.type === 'budget' && html`<${TestButton} c=${c} /><span class="grow"/>
        <input class="in" type="password" style="width:170px;padding:5px 10px" placeholder="New passcode" value=${code} onInput=${(e) => setCode(e.target.value)} />
        <button class="btn sm" disabled=${!code} onClick=${() => api('POST', '/api/connectors/budget', { url: c.config.url, passcode: code }).then(() => { setCode(''); toast('Passcode updated'); }, (e) => toast(e.message))}>Update</button>
        <button class="btn sm ghost danger" onClick=${() => confirm('Remove the budget connector?') && api('DELETE', `/api/connectors/${c.id}`)}>✕</button>`}
      ${c.type === 'mcp' && html`<select class="in" style="width:auto;padding:5px 8px" value=${c.config.approval} onChange=${(e) => api('PATCH', `/api/connectors/${c.id}`, { config: { approval: e.target.value } })}><option value="ask">Ask before each action</option><option value="allow">Allow (Cautious mode still asks)</option></select>
        <span class="grow"/><button class="btn sm ghost danger" onClick=${() => confirm(`Remove ${c.name}?`) && api('DELETE', `/api/connectors/${c.id}`)}>Remove</button>`}
    </div>
    ${signIn && html`<${SignInBrowser} S=${S} url=${signIn.url} site=${signIn.site} browser=${c.type === 'browser' ? c.id : undefined} close=${() => setSignIn(null)} />`}
  </div>`;
}

function PlayKeyButton({ pkg, label = 'Choose key file…', primary = false, onDone }) {
  const [busy, setBusy] = useState(false);
  const input = useRef(null);
  const pick = async (e) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    setBusy(true);
    try { await api('POST', '/api/connectors/play', { packageName: pkg, key: await file.text() }); toast('Google Play connected'); onDone?.(); }
    catch (err) { toast(err.message); } finally { setBusy(false); }
  };
  return html`<span><input ref=${input} type="file" accept=".json,application/json" style="display:none" onChange=${pick} />
    <button class=${`btn ${primary ? 'accent' : 'sm'}`} disabled=${busy || !pkg} onClick=${() => input.current.click()}>${busy ? 'Checking with Google…' : label}</button></span>`;
}

function AmazonSetup({ S }) {
  const google = S.connectors.filter((c) => c.type === 'google');
  const [gid, setGid] = useState(google[0]?.id || '');
  return html`<div class="card" style="margin-bottom:12px">
    <div class="row"><span style="font-size:22px">📦</span><div class="grow"><h3 style="margin:0">Amazon</h3><div class="hint" style="margin:2px 0 0">Order and delivery tracking, price checks, price-drop alerts, and shopping with your approval.</div></div></div>
    ${google.length ? html`<div class="row" style="margin-top:10px"><span class="muted" style="font-size:13px">Amazon emails go to</span>
        <select class="in" style="width:auto;padding:5px 8px" value=${gid} onChange=${(e) => setGid(e.target.value)}>${google.map((g) => html`<option value=${g.id}>${g.name}</option>`)}</select>
        <button class="btn accent" onClick=${() => api('POST', '/api/connectors/amazon', { googleId: gid }).then(() => toast('Amazon connected'), (e) => toast(e.message))}>Connect</button></div>`
      : html`<div class="hint">Connect the Google account that receives your Amazon emails first (above).</div>`}
  </div>`;
}

// Live view of a Wisp's own browser so you can sign in to a site yourself (password and codes never go through the Wisp).
function SignInBrowser({ S, url, site, browser, close }) {
  const [wispId, setWispId] = useState(S.wisps[0]?.id);
  const [started, setStarted] = useState(false);
  const [src, setSrc] = useState(null);
  const [page, setPage] = useState({ url: '', title: '' });
  const [addr, setAddr] = useState(url || '');
  const [siteName, setSiteName] = useState(site || '');
  const [err, setErr] = useState(null);
  const img = useRef(null), box = useRef(null), alive = useRef(true);
  const start = async () => { setErr(null); try { await api('POST', `/api/wisps/${wispId}/signin/start`, { url: addr, browser }); setStarted(true); } catch (e) { setErr(e.message); } };
  useEffect(() => { if (url) start(); return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (!started) return;
    let t, last;
    const tick = async () => {
      try {
        const r = await fetch(`/api/wisps/${wispId}/signin/frame?browser=${browser || ''}&t=${Date.now()}`);
        if (r.ok) {
          const u = URL.createObjectURL(await r.blob());
          setSrc(u); if (last) URL.revokeObjectURL(last); last = u;
          const pu = decodeURIComponent(r.headers.get('x-page-url') || '');
          setPage({ url: pu, title: decodeURIComponent(r.headers.get('x-page-title') || '') });
          if (!siteName && pu) try { setSiteName(new URL(pu).hostname.replace(/^www\./, '')); } catch {}
        }
      } catch {}
      if (alive.current) t = setTimeout(tick, 900);
    };
    tick();
    return () => clearTimeout(t);
  }, [started]);
  const send = (ev) => api('POST', `/api/wisps/${wispId}/signin/input`, { ...ev, browser }).catch((e) => setErr(e.message));
  const click = (e) => { const r = img.current.getBoundingClientRect(); send({ type: 'click', x: Math.round(((e.clientX - r.left) / r.width) * 1100), y: Math.round(((e.clientY - r.top) / r.height) * 760) }); box.current.focus(); };
  const SPECIAL = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
  const key = (e) => {
    if (e.target !== box.current) return;
    if (SPECIAL.has(e.key)) { e.preventDefault(); send({ type: 'key', key: e.key }); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { e.preventDefault(); send({ type: 'type', text: e.key }); }
  };
  const finish = async (done) => { const r = await api('POST', `/api/wisps/${wispId}/signin/stop`, { site: done ? siteName : '', browser }).catch(() => ({})); if (done) toast(`Saved. ${S.wisps.find((d) => d.id === wispId)?.name} stays signed in to ${siteName || 'that site'}${r.private ? '. Its browser is now private to you' : ''}.`); close(); };
  return html`<div class="scrim" style="z-index:55"></div>
  <div class="modal" style="z-index:56;width:calc(100vw - 16px);max-width:1400px;height:calc(100dvh - 16px);max-height:none;overflow:hidden;display:flex;flex-direction:column;padding:12px">
    <div class="row" style="margin-bottom:8px">
      <b class="grow">Sign in${siteName ? ` to ${siteName}` : ''} in ${S.wisps.length > 1 ? '' : `${S.wisps[0]?.name}'s `}browser</b>
      ${S.wisps.length > 1 && !started && html`<select class="in" style="width:auto;padding:4px 8px" value=${wispId} onChange=${(e) => setWispId(e.target.value)}>${S.wisps.map((d) => html`<option value=${d.id}>${d.name}</option>`)}</select>`}
      <button class="btn sm ghost" onClick=${() => finish(false)}>Cancel</button>
      <button class="btn sm ok" disabled=${!started} onClick=${() => finish(true)}>Done, I'm signed in</button>
    </div>
    <div class="row" style="margin-bottom:8px;gap:6px">
      <button class="btn sm" disabled=${!started} onClick=${() => send({ type: 'back' })}>←</button>
      <input class="in grow" style="width:auto;padding:5px 10px;font-size:13px" placeholder="https://www.example.com/login" value=${started && document.activeElement?.dataset?.addr !== '1' ? page.url || addr : addr} data-addr="1"
        onFocus=${(e) => setAddr(page.url || addr)} onInput=${(e) => setAddr(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') { started ? send({ type: 'navigate', url: addr }) : start(); e.target.blur(); } }} />
      ${!started && html`<button class="btn sm accent" disabled=${!addr.trim()} onClick=${start}>Open</button>`}
    </div>
    ${err && html`<div class="pill failed" style="margin-bottom:8px;white-space:normal">${err}</div>`}
    <div style="flex:1;min-height:0;display:flex;align-items:flex-start;justify-content:center">
    <div ref=${box} tabIndex="0" onKeyDown=${key} onPaste=${(e) => { e.preventDefault(); send({ type: 'type', text: e.clipboardData.getData('text') }); }}
      onWheel=${(e) => { e.preventDefault(); send({ type: 'scroll', deltaY: e.deltaY }); }}
      style="outline:none;border:1px solid var(--line-2);border-radius:10px;overflow:hidden;background:#fff;aspect-ratio:1100/760;width:min(100%, calc((100dvh - 150px) * 1100 / 760));display:grid;place-items:center;cursor:pointer;flex:none">
      ${src ? html`<img ref=${img} src=${src} onClick=${click} style="width:100%;height:100%;display:block;user-select:none" draggable="false" />` : html`<span class="muted">${started ? 'Loading…' : 'Enter an address and press Open.'}</span>`}
    </div>
    </div>
    <div class="hint" style="flex:none;margin-top:6px">Click the page, then type as usual: keys, Enter, and paste all go to the site. You enter the password and 2-step code yourself, and they never pass through ${S.wisps.find((d) => d.id === wispId)?.name || 'the Wisp'}. Tick "Keep me signed in" if the site offers it, then press <b>Done</b>.</div>
  </div>`;
}

function PlaySetup() {
  const [pkg, setPkg] = useState('');
  return html`<div class="card" style="margin-bottom:12px">
    <div class="row"><span style="font-size:22px">▶️</span><div class="grow"><h3 style="margin:0">Google Play Console</h3><div class="hint" style="margin:2px 0 0">Releases, rollouts, reviews, and crash/ANR vitals for one of your apps.</div></div></div>
    <ol style="margin:10px 0;padding-left:20px;font-size:14px;color:var(--ink-2);line-height:1.7">
      <li>Use a Google Cloud <b>service account key</b> (a .json file) that's invited to your app in Play Console → <b>Users and permissions</b>. If your app already publishes from CI (e.g. EAS or fastlane), you can reuse that key.</li>
      <li>For reviews and vitals, that account also needs <b>View app information</b> and <b>Reply to reviews</b>. For vitals, enable the <a href="https://console.cloud.google.com/apis/library/playdeveloperreporting.googleapis.com" target="_blank" rel="noopener">Play Developer Reporting API</a> in its Cloud project.</li>
    </ol>
    <div class="row"><input class="in" style="width:260px" placeholder="app.example.android" value=${pkg} onInput=${(e) => setPkg(e.target.value.trim())} /><${PlayKeyButton} pkg=${pkg} primary /></div>
    <div class="hint">Wisps checks the key with Google before saving it, and stores it privately on this computer.</div>
  </div>`;
}

function BudgetSetup() {
  const [url, setUrl] = useState(''); const [code, setCode] = useState('');
  return html`<div class="card" style="margin-bottom:12px">
    <div class="row"><span style="font-size:22px">💰</span><div class="grow"><h3 style="margin:0">Family budget page</h3><div class="hint" style="margin:2px 0 0">Connect your family-budget site so Wisps can check spending, log purchases, and see balances.</div></div></div>
    <div class="row" style="margin-top:10px"><input class="in grow" style="width:auto" placeholder="https://your-budget.vercel.app" value=${url} onInput=${(e) => setUrl(e.target.value)} />
      <input class="in" type="password" style="width:160px" placeholder="Family passcode" value=${code} onInput=${(e) => setCode(e.target.value)} />
      <button class="btn accent" disabled=${!url.trim() || !code} onClick=${() => api('POST', '/api/connectors/budget', { url, passcode: code }).then(() => toast('Budget connected'), (e) => toast(e.message))}>Connect</button></div>
  </div>`;
}

function AddMcp({ done }) {
  const [f, setF] = useState({ name: '', kind: 'command', command: 'npx', args: '-y ', url: '', env: '', approval: 'ask', access: 'private', description: '' });
  const set = (k, v) => setF({ ...f, [k]: v });
  const save = () => api('POST', '/api/connectors/mcp', { ...f, command: f.kind === 'command' ? f.command : '', url: f.kind === 'url' ? f.url : '' }).then(() => { toast(`Added ${f.name}`); done(); }, (e) => toast(e.message));
  return html`<div class="card" style="margin-top:12px;display:flex;flex-direction:column;gap:10px">
    <h3 style="margin:0">Add a custom connector</h3>
    <div class="two"><div><label class="lbl">Name</label><input class="in" placeholder="e.g. Todoist" value=${f.name} onInput=${(e) => set('name', e.target.value)} /></div>
      <div><label class="lbl">What it's for (helps the Wisp)</label><input class="in" placeholder="Our family to-do lists" value=${f.description} onInput=${(e) => set('description', e.target.value)} /></div></div>
    <div class="row"><label class="row" style="gap:6px"><input type="radio" checked=${f.kind === 'command'} onChange=${() => set('kind', 'command')} />Runs locally (command)</label><label class="row" style="gap:6px"><input type="radio" checked=${f.kind === 'url'} onChange=${() => set('kind', 'url')} />Remote (URL)</label></div>
    ${f.kind === 'command' ? html`<div class="row"><input class="in" style="width:110px" value=${f.command} onInput=${(e) => set('command', e.target.value)} /><input class="in grow" style="width:auto" placeholder="-y @some/mcp-server --flag" value=${f.args} onInput=${(e) => set('args', e.target.value)} /></div>`
      : html`<input class="in" placeholder="https://example.com/mcp" value=${f.url} onInput=${(e) => set('url', e.target.value)} />`}
    <div><label class="lbl">${f.kind === 'command' ? 'Environment variables' : 'Headers'} (one per line: KEY=value, stored privately)</label><textarea class="in" rows="2" style="font-family:var(--mono);font-size:13px;min-height:60px" placeholder=${f.kind === 'command' ? 'API_TOKEN=…' : 'Authorization=Bearer …'} value=${f.env} onInput=${(e) => set('env', e.target.value)} /></div>
    <div class="row"><select class="in" style="width:auto" value=${f.access} onChange=${(e) => set('access', e.target.value)}><option value="private">🔒 Private</option><option value="family">👨‍👩‍👧 Family</option></select>
      <select class="in" style="width:auto" value=${f.approval} onChange=${(e) => set('approval', e.target.value)}><option value="ask">Ask before each action</option><option value="allow">Allow its actions</option></select>
      <span class="grow"/><button class="btn ghost" onClick=${done}>Cancel</button><button class="btn accent" disabled=${!f.name.trim() || !(f.kind === 'url' ? f.url.trim() : f.command.trim())} onClick=${save}>Add connector</button></div>
  </div>`;
}

// ---------- Voice call ----------
function Call({ wisp, close }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const [phase, setPhase] = useState(SR ? 'listening' : 'unsupported');
  const [heard, setHeard] = useState('');
  const [said, setSaid] = useState('');
  const rec = useRef(null), alive = useRef(true), waiting = useRef(false);

  const listen = useCallback(() => {
    if (!alive.current || !SR) return;
    const r = new SR();
    r.lang = navigator.language || 'en-US'; r.interimResults = true; r.continuous = false;
    let final = '';
    r.onresult = (e) => { let t = ''; for (const res of e.results) { t += res[0].transcript; if (res.isFinal) final = t; } setHeard(t); };
    r.onend = () => {
      if (!alive.current) return;
      if (final.trim()) { waiting.current = true; setPhase('thinking'); api('POST', `/api/wisps/${wisp.id}/chat`, { text: final.trim(), source: 'voice' }); }
      else setTimeout(listen, 250);
    };
    r.onerror = (e) => { if (e.error === 'not-allowed') setPhase('denied'); };
    rec.current = r; setPhase('listening'); setHeard('');
    try { r.start(); } catch { /* already started */ }
  }, [wisp.id]);

  useEffect(() => { listen(); return () => { alive.current = false; rec.current?.abort(); speechSynthesis.cancel(); }; }, []);
  useEffect(() => onEvent((e) => {
    if (e.wispId !== wisp.id || e.type !== 'chat' || e.message.role !== 'wisp' || !waiting.current) return;
    waiting.current = false;
    const plain = e.message.text.replace(/```[\s\S]*?```/g, ' (code omitted) ').replace(/[*_#>`|]/g, '').replace(/\[(.*?)\]\(.*?\)/g, '$1');
    setSaid(plain.slice(0, 400)); setPhase('speaking');
    const u = new SpeechSynthesisUtterance(plain.slice(0, 1500));
    u.rate = 1.05; u.onend = () => listen();
    speechSynthesis.speak(u);
  }), [listen]);

  return html`<div class="call" style=${wispVars(wisp)}>
    <${Orb} avatar=${wisp.avatar} size=${180} state=${phase === 'thinking' ? 'thinking' : phase === 'speaking' ? 'working' : ''} />
    <div style="font-size:22px;font-weight:650">${wisp.name}</div>
    <div class="muted">${{ listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking', unsupported: 'Voice needs Chrome or Edge (Web Speech API).', denied: 'Microphone blocked. Allow it in your browser to talk.' }[phase]}</div>
    <div class="cap">${phase === 'speaking' ? said : ''}</div>
    <div class="you">${heard && `“${heard}”`}</div>
    <div class="row">${phase === 'speaking' && html`<button class="btn" onClick=${() => { speechSynthesis.cancel(); listen(); }}>Interrupt</button>`}<button class="btn" style="background:var(--bad);border-color:var(--bad);color:#fff" onClick=${close}>End call</button></div>
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
