# multi-channel-discord — agent-bus fork

This fork adds an **agent bus**: Claude Code, Codex, Antigravity (agy) or any MCP client, on
any number of machines, talk to each other (and to you) through one Discord bot.

- **Router** (one per bot token) runs anywhere reachable, e.g. as a container:
  `ghcr.io/mickg10/multi-channel-discord:latest` (built by `.github/workflows/image.yml`).
  Env: `DISCORD_BOT_TOKEN`, `DISCORD_ROUTER_SECRET` (required for a non-localhost bind),
  `DISCORD_BUS_CHANNEL` (default bus channel id), `DISCORD_WS_HOST`/`DISCORD_WS_PORT`,
  `DISCORD_BUS_MAX_PER_MIN`, `DISCORD_STATE_DIR` (`/state` in the image).
- **Clients**: the Claude plugin (`/plugin marketplace add mickg10/multi-channel-discord`) or, for
  Codex/agy/others, the plain MCP server `bin/agent-bus-mcp`. Config in
  `~/.claude/channels/discord/.env`: `DISCORD_ROUTER_URL`, `DISCORD_ROUTER_SECRET`,
  `DISCORD_HOST_LABEL`; per agent `DISCORD_AGENT`, `DISCORD_SESSION_NAME`,
  `DISCORD_WAKE=tmux` (+ `DISCORD_WAKE_PANE`) to nudge agents that can't receive pushes.
- **Tools**: `bus_post(text, to?)`, `bus_sessions()`, `check_inbox()`, and channels —
  `channel_list()`, `channel_create(name, topic?)`, `channel_subscribe(channel)`,
  `channel_unsubscribe(channel)`, `channel_post(channel, text, to?)`. `to` = session name/prefix,
  `"human"` (post for the human only) or omitted (broadcast to the channel's audience: everyone on
  the default bus, subscribers elsewhere). Humans address agents with `@name msg` in a bus channel.
- Bot permissions: `101456` (adds Manage Channels for `channel_create`) + Message Content Intent.
- Also fixed: the plugin's `start` script ran the router instead of the client.

---

# multi-channel-discord

Run multiple Claude Code sessions behind one Discord bot. Switch between projects, approve tool calls, and monitor progress — from your phone.

```
You: /switch frontend
You: fix the login bug
[frontend] Reading auth.ts...          ← typing indicator stays active
[frontend] Found the issue — ...       ← Claude replies in Discord

[backend 📪] 1 new message             ← backend finished while you were away
You: /switch backend                   ← flushes the buffered reply
```

## What it does

Anthropic's official Discord plugin connects one Claude Code session per bot. This fork adds a **router** between Discord and your sessions, so you can run as many as you want simultaneously.

**Session management** — `/switch`, `/list`, `/kill`, `/broadcast`, `/spawn` as native Discord slash commands with autocomplete. Sessions auto-name from your git branch.

**Permission relay** — Claude needs to run a command? You get yes/no buttons in Discord. Tap to approve from your phone without touching the terminal.

**Interactive questions** — When Claude needs your input, it sends Discord buttons or select menus instead of walls of text. Pick an option by tapping.

**Skill discovery** — Your Claude Code skills (`/commit`, `/deploy`, etc.) auto-register as Discord slash commands. Type `/` and they're all there.

**Live progress** — Bot shows a typing indicator while Claude works. Progress updates edit a single message instead of spamming new ones.

**Bot presence** — Discord status shows what session is active and how many are connected.

**Buffering** — Replies from inactive sessions are queued and flushed when you switch back. Nothing gets lost.

## Setup

You need [Bun](https://bun.sh) and a Discord account.

### Create the bot

1. [Discord Developer Portal](https://discord.com/developers/applications) → New Application
2. **Bot** → give it a username → **Reset Token** → copy it (shown once)
3. Enable **Message Content Intent** under Privileged Gateway Intents
4. **OAuth2 → URL Generator** → scope: `bot` → permissions: Send Messages, Read Message History, Add Reactions, Attach Files → open the URL → add bot to a server

### Install the plugin

In Claude Code:

```
/plugin marketplace add YassinCh/multi-channel-discord
/plugin install discord@multi-channel-discord
```

### Configure and start

All from Claude Code — no terminal needed:

```
/discord:configure <your-bot-token>
/discord:start-router
```

The router runs in the background. You can also start it manually with `bunx multi-channel-discord` if you prefer a dedicated terminal.

### Launch Claude Code

In any project directory:

```bash
claude --dangerously-load-development-channels plugin:discord@multi-channel-discord
```

### Pair

DM your bot → it replies with a code → run `/discord:access pair <code>` in Claude Code → done.

Then lock it down: `/discord:access policy allowlist`

## Commands

Discord slash commands (ephemeral responses, only you see them):

| Command | What it does |
|---------|-------------|
| `/switch <session>` | Activate a session. Autocompletes names. Flushes buffered messages. |
| `/list` | All sessions with status — active, idle, or N buffered. |
| `/status` | Router uptime, instance count, queued messages. |
| `/kill <session\|all>` | Terminate sessions. |
| `/broadcast <msg>` | Send to every connected session. |
| `/spawn <project>` | Launch Claude Code in a recent project directory. |
| `/help` | Show all commands. |
| `/<skill> [args]` | Any of your Claude Code skills — auto-discovered and registered. |

Claude Code terminal commands (not Discord):

| Command | What it does |
|---------|-------------|
| `/discord:configure` | Save bot token, check status. |
| `/discord:access` | Manage pairing, allowlists, DM policy. |

## How it works

```
Discord DM ──→ Router (bot + WS server) ──→ Active session's Claude Code
                  │
                  ├── Session: feature/login   (Claude Code instance)
                  ├── Session: backend-api      (Claude Code instance)
                  └── Session: infra            (Claude Code instance)
```

The **router** runs the Discord bot, handles access control, manages sessions, and owns all Discord API calls. Each Claude Code instance runs a **plugin** that connects to the router via WebSocket. The plugin exposes tools to Claude (reply, react, edit, fetch, ask) but never talks to Discord directly.

Sessions are named from your git branch, `package.json` name, or directory. Collisions get suffixes (`frontend`, `frontend-2`).

## Tools

These are MCP tools Claude can call when responding to Discord messages:

| Tool | Purpose |
|------|---------|
| `reply` | Send a message. Supports threading (`reply_to`), file attachments, auto-chunking. |
| `react` | Emoji reaction on a message. |
| `edit_message` | Update a sent message in-place (progress updates). |
| `fetch_messages` | Read channel history (max 100 messages). |
| `download_attachment` | Save attachments to local inbox. |
| `ask_user` | Send buttons or select menu, wait for user's choice. |

## Access control

Default policy is `pairing` — unknown senders get a code to approve. Switch to `allowlist` after setup.

```
/discord:access                    # status
/discord:access pair <code>        # approve someone
/discord:access allow <id>         # add by user ID
/discord:access remove <id>        # remove
/discord:access policy allowlist   # recommended after setup
```

Details in [ACCESS.md](./ACCESS.md).

## Updating

```bash
./deploy.sh    # rebuilds and deploys to Claude Code's plugin cache
```

Restart Claude Code sessions after deploying. The router can stay running.

## Development

```bash
bun test       # 100 tests
bun run check  # type checking
```

## License

Apache-2.0. Forked from [Anthropic's official Discord plugin](https://github.com/anthropics/claude-plugins-official).
