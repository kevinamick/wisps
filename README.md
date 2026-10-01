# Wisps

Always-on AI agents for you and your household, running on your own machine and powered by your
**Claude Code subscription**: no API key and no per-token bill.

Give a Wisp a goal and it works in the background on its own computer (a folder). It checks in with ideas,
learns from your feedback, and asks before anything risky. Talk to it in the web app, by voice, or on
Telegram, including in a family group chat.

```
npm install
npm start            # → http://localhost:4777
```

Requirements: Node 22+, and [Claude Code](https://claude.com/claude-code) installed and signed in (`claude`).
Wisps runs every agent through the Claude Agent SDK using that sign-in.

## What a Wisp does

| | |
|---|---|
| **Chat** | In the web app, by voice ("Call", in Chrome or Edge), or on Telegram. |
| **Background work** | Bigger jobs become tasks that run on their own. The Work tab shows each step live. |
| **Its own computer** | Each Wisp works in `data/wisps/<id>/computer/`. You can share extra folders in Setup. |
| **Proactive check-ins** | Every few hours it does read-only research toward its goals, then proposes tasks or pings you. |
| **Schedules** | One-time ("Oct 1 at 8am") or recurring ("every weekday at 8"), from chat or the Work tab. |
| **Memory bubbles** | Files the people, places, plans and events in your life into linked "bubbles" as you chat, and brings up the relevant ones when they matter. |
| **Lessons** | Learns how you like things done from 👍/👎 feedback, from what you tell it, and from ideas you dismiss. You can edit both kinds of memory. |
| **Friends' Wisps** | Works things out with friends' Wisps (a time for dinner, who brings what) under sharing rules you set for each friend. Household Wisps can ask each other too. |
| **Approvals** | Risky or outward-facing steps (sending, buying, publishing, deleting) wait for your OK, once per action rather than per click. |

**Autonomy modes:** Cautious, Balanced (the default), and Autonomous. Rules like `Bash(npm test*)` or
`Bash(git push*)` override the mode, and "Always allow" on an approval adds a rule.

## Memory bubbles

Each Wisp keeps two kinds of memory, both in the **Memory** tab:

- **Bubbles** hold what's going on in your life: one per person, place, plan, event, project or thing (say "Mom" or
  "Japan trip"), linked to related bubbles. After each chat, a quick Haiku pass files anything lasting into them.
  You can switch that off with "learn from chats". Before each reply, the Wisp sees pinned bubbles plus the ones
  relevant to the message, and it can `recall` the rest.
- **Lessons** (`memory.md`) hold how you like things done.

Every fact remembers where it was learned. Something said in Sam's DM is used only in Sam's DMs, and something said
in a group only in that group, unless you turn on **share with family** for that bubble. The web app, scheduled
work and check-ins see everything.

**Use your memory in other AI apps.** `server/memory-mcp.js` is an MCP server over the same files:

```
claude mcp add wisps-memory -- node /path/to/wisps/server/memory-mcp.js
```

It gives Claude Code (or any MCP client on this machine) `memory_recall`, `memory_remember`, `memory_lessons` and
`wisps_list`.

## Friends' Wisps

Your Wisp can coordinate with a friend's Wisp running on their own machine. For example: "Find a night this
week that works for Alex, and check what food he likes."

1. Friends' Wisps connect on a **separate port** (`PEER_PORT`, default 4778). It serves only Wisp-to-Wisp
   messages, never the app or its API. Expose just that port, for example
   `tailscale serve --bg --https=8443 http://127.0.0.1:4778` and share the machine with your friend in Tailscale.
2. In Settings → Friends' Wisps, paste that address and your name. Then **Invite** a friend and send them the
   `wisp1.…` code. They paste it under "Got an invite code?" on their side.
3. For each friend, write what your Wisp may share (for example "whether I'm free on weeknights; I'm vegetarian;
   never share my address"), and choose whether it may see your Google Calendar free/busy (times only, no
   details).

When a friend's Wisp messages yours, it gets none of your Wisp's tools, files, connectors or memory. It sees only
your sharing rules (and free/busy, if you turned that on). It can notify you and propose tasks, which wait for
your OK. Your Wisp's first message to a friend in a job waits for your approval unless you turn on "message without
asking". Every conversation is logged under that friend in Settings.

Wisps in the same household can also ask each other things (`ask_wisp`), read-only.

## Telegram and a family group

Each Wisp gets a Telegram bot. No phone number is needed.

1. In Telegram, message **@BotFather** and send `/newbot`. Paste the token in Settings → Telegram.
2. For groups, send `/setprivacy` to @BotFather and choose **Disable**, so the Wisp can hear its name.
3. Add **people** in Settings, starting with yourself. Each person gets an invite link that pairs their Telegram
   account. Everyone else is ignored. **Approvers** get Approve / Deny buttons.
4. Add the bot to a family group. It connects automatically when an approver adds it. It answers when someone
   says its name, @mentions it, or replies to it.

## Connectors (🔌 in the sidebar)

| Connector | What it adds |
|---|---|
| **Google** | Gmail (search, read, draft, send), Calendar, and Drive (read). Uses your own OAuth client; step-by-step setup is in the app. |
| **Web browser** | A headless Chromium per Wisp (Playwright MCP). You can add a separate **private work browser** for your own accounts. |
| **Sign in to sites** | A live view of a Wisp's browser where *you* sign in, so passwords never pass through the agent. |
| **Amazon** | Order and delivery tracking from Amazon's emails, price checks, price-drop alerts, and shopping with one approval per order. |
| **Google Play Console** | Releases, rollouts, reviews, vitals, and the store listing (service account). |
| **Weather** | Open-Meteo forecasts, with no key needed. |
| **Family budget** | Example connector for a self-hosted budget web app's API. |
| **Custom (MCP)** | Any MCP server, as a local command or a remote URL. |

Every connector is **private** (used only for its owner, never in group chats) or **family**. Reads are
automatic. Sending email, inviting people, deleting, purchases, and publishing always ask. Conversations are
kept separate per place (the app, each DM, each group) so private details don't leak between them.

Some sites (Cloudflare-protected pages, Google sign-in, Amazon) may block automated browsers, especially from
cloud servers. Wisps never disguises its browser to get around that.

## Running it on a server

Wisps is happiest on an always-on Linux box or VM:

```
sudo deploy/install-service.sh      # systemd service: starts on boot, restarts on crash
cp deploy/wisps.env.example deploy/wisps.env
```

Keep the web app private: it binds to `127.0.0.1`, and anything that can reach it can run commands as the
Wisp. To reach it from your devices, use [Tailscale](https://tailscale.com) (`tailscale serve --bg --https=443
http://127.0.0.1:4777`, then set `ALLOWED_HOSTS` in `deploy/wisps.env`) or an SSH tunnel. Telegram works
without any of that.

`deploy/push.sh` syncs code from your dev machine to the server (set `WISPS_VM=user@host`) and restarts it
once no agent is busy.

## Where things live

* `data/state.json`: Wisps, tasks, schedules, inbox, and settings
* `data/wisps/<id>/`: `chat.jsonl`, `memory.md`, `tasks/*.jsonl` (activity), `computer/`, and browser profiles
* `data/secrets.json` (mode 600): bot token, OAuth clients and tokens, and connector secrets

`data/` is never committed. Environment variables: `PORT` (4777), `WISPS_DATA`, `WISPS_MAX_PARALLEL` (3),
`CLAUDE_BIN`, `ALLOWED_HOSTS`, and `TELEGRAM_API` (for testing against a mock).

## License

MIT. See [LICENSE](LICENSE).
