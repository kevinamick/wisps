// Decides whether a Wisp may use a tool on its own, must ask you first, or is blocked.
import path from 'node:path';
import os from 'node:os';
import { computerDir } from './store.js';
import { toolInfo, canAccess } from './connectors/index.js';

// Actions that always need your OK unless you've written an explicit allow rule.
const RISKY_BASH = [
  /\bsudo\b/, /\bsu\s/, /\brm\s+-\w*[rf]\w*\s+(\/|~|\$HOME|\.\.)/, /\bgit\s+push\b/, /\bgit\s+reset\s+--hard\b/,
  /\b(npm|pnpm|yarn)\s+publish\b/, /\bssh\b/, /\bscp\b/, /\brsync\b.*:/, /\bmkfs\b/, /\bdd\s+if=/,
  /\b(shutdown|reboot|poweroff)\b/, /\bkill(all)?\s+-9\b/, /\bpkill\b/, /\bchmod\s+-R\b/, /\bchown\b/,
  /\bcurl\b[^|;&]*\s(-X\s*(POST|PUT|PATCH|DELETE)|-d\b|--data|-F\b|--form|-T\b)/i,
  /\bwget\b[^|;&]*--post/i, /\bcrontab\b/, /\bsystemctl\b/, /\bdocker\s+(rm|rmi|system\s+prune)\b/,
  /\b(gh|gh-axi)\s+(pr|issue|release|repo)\s+(create|merge|close|delete|edit|comment)\b/,
  /\bvercel\b.*--prod/, /\bfly\s+deploy\b/,
];

const PRIMARY = {
  Bash: 'command', Read: 'file_path', Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path', WebFetch: 'url', WebSearch: 'query', Glob: 'pattern', Grep: 'pattern',
};
const FILE_WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export const primaryArg = (tool, input) => String(input?.[PRIMARY[tool]] ?? '');

const expand = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const within = (p, dir) => { const r = path.relative(dir, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const globToRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 's');

// Rule syntax mirrors Claude Code: "Tool" or "Tool(glob on its main argument)", e.g. "Bash(npm test*)".
export function parseRule(pattern) {
  const m = /^([\w.*-]+)(?:\((.*)\))?$/s.exec(pattern.trim());
  return m ? { tool: m[1], arg: m[2] ?? null } : null;
}
function ruleMatches(rule, tool, input) {
  const r = parseRule(rule.pattern);
  if (!r || !globToRe(r.tool).test(tool)) return false;
  return r.arg == null || globToRe(r.arg).test(primaryArg(tool, input));
}

// Suggest an "always allow" rule for an approval: narrow for Bash, tool-wide otherwise.
export function suggestRule(tool, input) {
  if (tool === 'Bash') {
    const words = primaryArg(tool, input).trim().split(/\s+/).slice(0, 2).join(' ');
    return `Bash(${words}*)`;
  }
  if (tool === 'WebFetch') {
    try { return `WebFetch(${new URL(input.url).origin}/*)`; } catch { /* fall through */ }
  }
  if (FILE_WRITERS.has(tool) && input?.file_path) return `${tool}(${path.dirname(expand(input.file_path))}/*)`;
  return tool;
}

/**
 * @returns {{decision:'allow'|'ask'|'deny', reason:string}}
 * mode: 'ask' | 'balanced' | 'autonomous'; kind: 'chat' | 'task' | 'checkin'
 */
export function evaluate(wisp, tool, input, { blockedPath, kind, origin } = {}) {
  // Talking to a friend's Wisp acts on your behalf outside this machine, so it asks unless a rule says otherwise.
  if (tool.startsWith('mcp__wisp__') && tool !== 'mcp__wisp__message_contact') return { decision: 'allow', reason: 'Wisp tool' };

  // Connectors: access (whose account is it, and who's asking?) is checked before any rule.
  const conn = tool.startsWith('mcp__') ? toolInfo(tool, input) : null;
  if (conn) {
    const access = canAccess(conn.connector, origin);
    if (!access.ok) return { decision: 'deny', reason: access.why };
  }

  // Your explicit rules win: deny > ask > allow
  const hits = (wisp.rules || []).filter((r) => ruleMatches(r, tool, input));
  for (const b of ['deny', 'ask', 'allow']) {
    const hit = hits.find((r) => r.behavior === b);
    if (hit) return { decision: b, reason: `Your rule: ${hit.pattern}` };
  }

  if (kind === 'checkin' && !(conn && conn.risk === 'read')) return { decision: 'deny', reason: 'Check-ins are read-only research. Propose a task instead.' };
  if (kind === 'household' && !(conn && conn.risk === 'read')) return { decision: 'deny', reason: 'Answering another Wisp is read-only.' };
  if (tool === 'mcp__wisp__message_contact') return { decision: 'ask', reason: "Talks to a friend's Wisp on your behalf" };

  const mode = wisp.autonomy || 'balanced';
  if (conn) {
    const n = conn.connector.name;
    if (conn.risk === 'read') return { decision: 'allow', reason: `Reads from ${n}` };
    if (conn.risk === 'outward') return { decision: 'ask', reason: `Acts outside on your behalf via ${n} (sends, invites, or posts)` };
    if (conn.risk === 'destructive') return { decision: 'ask', reason: `Deletes something in ${n}` };
    return mode === 'ask' ? { decision: 'ask', reason: `Changes something in ${n}` } : { decision: 'allow', reason: `Routine change in ${n}` };
  }

  const home = computerDir(wisp.id);
  const granted = [home, ...(wisp.grants || []).map(expand)];
  const inGranted = (p) => granted.some((d) => within(path.resolve(home, expand(p)), d));

  if (tool === 'WebSearch' || tool === 'WebFetch') return { decision: 'allow', reason: 'Web research' };
  if (tool === 'TodoWrite' || tool === 'Read' || tool === 'Glob' || tool === 'Grep') return { decision: 'allow', reason: 'Read-only' };

  if (FILE_WRITERS.has(tool)) {
    const p = primaryArg(tool, input);
    if (within(path.resolve(home, expand(p)), home)) return { decision: 'allow', reason: 'Inside its own computer' };
    if (mode === 'autonomous' && inGranted(p)) return { decision: 'allow', reason: 'Inside a folder you granted' };
    return { decision: 'ask', reason: inGranted(p) ? 'Changes a file in a folder you shared' : 'Changes a file outside its computer' };
  }

  if (tool === 'Bash') {
    const cmd = primaryArg(tool, input);
    if (RISKY_BASH.some((re) => re.test(cmd))) return { decision: 'ask', reason: 'Potentially risky or outward-facing command' };
    if (mode === 'ask') return { decision: 'ask', reason: 'You asked to approve every command' };
    if (blockedPath && !inGranted(blockedPath)) return { decision: 'ask', reason: `Touches ${blockedPath}, outside its computer` };
    return { decision: 'allow', reason: mode === 'autonomous' ? 'Autonomous mode' : 'Routine command in its computer' };
  }

  return mode === 'autonomous' ? { decision: 'allow', reason: 'Autonomous mode' } : { decision: 'ask', reason: `Uses ${tool}` };
}
