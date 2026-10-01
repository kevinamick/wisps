// Clock: fires scheduled tasks and proactive check-ins, and keeps the task queue moving.
import { state, save, getWisp } from './store.js';
import { createTask, checkin, pump, nextRun, live } from './engine.js';

const TICK_MS = 30_000;

export function startScheduler() {
  const tick = () => {
    const nowD = new Date();
    for (const s of state.schedules) {
      if (!s.enabled || new Date(s.nextAt) > nowD) continue;
      const wisp = getWisp(s.wispId);
      s.nextAt = nextRun(s.every, nowD);
      s.lastAt = nowD.toISOString();
      if (s.every.kind === 'once') s.enabled = false; // one-time jobs fire once
      if (!wisp || wisp.paused) continue;
      // don't pile up copies if the previous run is still going
      if (state.tasks.some((t) => t.scheduleId === s.id && ['queued', 'running', 'waiting'].includes(t.status))) continue;
      createTask(s.wispId, { title: s.title, detail: s.detail, source: 'schedule', scheduleId: s.id, origin: s.origin || null });
    }
    for (const wisp of state.wisps) {
      const hb = wisp.heartbeat;
      if (!hb?.enabled || wisp.paused || !wisp.goals?.trim()) continue;
      const due = !hb.lastAt || nowD - new Date(hb.lastAt) >= (hb.everyMin || 120) * 60000;
      const busy = live.wisps[wisp.id]?.chat || state.tasks.some((t) => t.wispId === wisp.id && ['running', 'waiting'].includes(t.status));
      if (due && !busy) checkin(wisp.id).catch((e) => console.error('[checkin]', e));
    }
    save();
    pump();
  };
  setTimeout(tick, 5000);
  return setInterval(tick, TICK_MS);
}
