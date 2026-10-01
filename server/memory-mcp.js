#!/usr/bin/env node
// Your Wisps' memory for the other AI apps on this machine (Claude Code, Claude Desktop, any MCP client),
// so what one assistant learns about your life the others can use too. Runs over stdio:
//   claude mcp add wisps-memory -- node /path/to/wisps/server/memory-mcp.js
// It reads and writes the same files as the Wisps app (WISPS_DATA picks a different data folder).
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DATA_DIR, memoryFile } from './store.js';
import * as bubbles from './bubbles.js';

// Read the Wisp list fresh each call: the app may add or rename Wisps while this runs.
function wisps() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'state.json'), 'utf8'));
    const def = s.settings?.telegram?.defaultWispId;
    return (s.wisps || []).sort((a, b) => (b.id === def) - (a.id === def));
  } catch { return []; }
}
function pick(name) {
  const all = wisps();
  if (!all.length) throw new Error('No Wisps yet. Create one in the Wisps app first.');
  if (!name) return all[0];
  const w = all.find((d) => d.name.toLowerCase() === name.trim().toLowerCase());
  if (!w) throw new Error(`No Wisp called ${name}. Wisps: ${all.map((d) => d.name).join(', ')}`);
  return w;
}
const text = (t) => ({ content: [{ type: 'text', text: t }] });
const safe = (fn) => async (args) => { try { return text(await fn(args)); } catch (e) { return { ...text(e.message), isError: true }; } };
const wispArg = z.string().optional().describe("Which Wisp's memory (default: the main one)");

const server = new McpServer({ name: 'wisps-memory', version: '1.0.0' });

server.registerTool('wisps_list', { description: 'List the Wisps (personal agents) on this machine whose memory you can use.', inputSchema: {} },
  safe(async () => wisps().map((d) => `${d.name}${d.role ? `: ${d.role}` : ''}`).join('\n') || 'No Wisps yet.'));

server.registerTool('memory_recall', {
  description: "Search the user's personal memory: people, places, plans, events, projects and preferences in their life, as remembered by their Wisps. Use it whenever personal context would help.",
  inputSchema: { query: z.string(), wisp: wispArg },
}, safe(async ({ query, wisp }) => {
  const w = pick(wisp);
  const all = bubbles.view(w.id, null);
  const hits = bubbles.search(w.id, query, null, 8);
  return hits.length ? bubbles.format(hits, all) : `Nothing about that yet.${all.length ? ` Topics remembered: ${all.map((b) => b.title).join(', ')}` : ''}`;
}));

server.registerTool('memory_remember', {
  description: "Save a lasting fact about the user's life into their memory, filed under a topic (a person, place, plan, event, project, preference area or thing).",
  inputSchema: { topic: z.string().describe('e.g. "Mom", "Japan trip"'), fact: z.string().describe('A full sentence'), kind: z.enum(bubbles.KINDS).optional(), related: z.array(z.string()).optional(), wisp: wispArg },
}, safe(async ({ topic, fact, kind, related, wisp }) => {
  const w = pick(wisp);
  const b = bubbles.addFact(w.id, { topic, kind, fact, related: related || [], scope: 'owner' });
  return b ? `Saved under "${b.title}" in ${w.name}'s memory.` : 'Nothing to save.';
}));

server.registerTool('memory_lessons', {
  description: "Read the user's standing preferences and lessons: how they like things done.",
  inputSchema: { wisp: wispArg },
}, safe(async ({ wisp }) => {
  const w = pick(wisp);
  try { return fs.readFileSync(memoryFile(w.id), 'utf8').trim() || 'No lessons yet.'; } catch { return 'No lessons yet.'; }
}));

await server.connect(new StdioServerTransport());
