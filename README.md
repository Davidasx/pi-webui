# pi-webui — browser companion for the current Pi session, over a fixed-port hub

**English** | [中文](README.zh-CN.md)

> **Promotion statement**: this project is fully open source (MIT) and is promoted on public boards under the [LINUX DO](https://linux.do) community open-source promotion rules. Thanks to the community for the feedback behind it.

A private browser view of the Pi session that is running in your terminal, shared through one
fixed port across all of your Pi sessions.

This is a port of [`narumiruna/pi-extensions/deprecated/pi-webui`](https://github.com/narumiruna/pi-extensions/tree/main/deprecated/pi-webui)
(MIT, archived upstream) with five deliberate changes:

1. **No authentication.** The hub is loopback-only and answers directly: open
   `http://127.0.0.1:43118/` and you are in. Remote access is the operator's job — put your own
   access control (for example Cloudflare Zero Trust) in front of the hub.
2. **Exactly one port, whatever the number of sessions.** The hub owns the page, the bundle, and
   the web API; each Pi session holds one WebSocket to the hub and nothing listens inside the Pi
   process. Ten sessions cost ten connections, not ten servers.
3. **The hub is a router, never an agent host.** It never opens, reads, or writes a Pi session; it
   forwards the browser's requests to whichever session owns the page.
4. **A UI change needs only a hub restart.** The page and its bundle are served by the hub, so
   editing the interface never requires reloading every Pi session.
5. **The page is agegr/pi-web's own frontend, copied verbatim.** Components, styles, sidebar, panels
   and the API routes behind them come from upstream, so what you see is that interface rather than an
   imitation of it; `src/web/pi-web/PORTING.md` explains how the copy is kept in step.

## Why this design does not fight with the terminal

Other Pi web UIs run a server that *owns* sessions: they construct their own agent runtime,
`SessionManager.open(...)` an existing session file, and then write to the same
`~/.pi/agent/sessions/*.jsonl` that a terminal Pi process is also writing. Pi core keeps no
cross-process lock on session files, so the CLI and the server each keep a stale in-memory view and
silently diverge — the terminal stops seeing browser turns, the browser rolls back, and a rename
can even pin the session to a dead branch. Upstream `agegr/pi-web` calls this out in its own
source ("two processes writing one JSONL is unsupported") and treats cross-process coordination as
out of scope.

pi-webui avoids the whole class of problem structurally:

- Each session answers its own API **from inside its Pi process**: the hub tunnels the browser's
  requests over that session's WebSocket, and no Pi process opens a port.
- Browser input enters through the normal Pi input path
  (`pi.sendUserMessage(content, { deliverAs })`), exactly like terminal typing, so the terminal and
  the browser share one runtime, one conversation tree, and one writer.
- Pi core persists the session; pi-webui never writes session files.
- The hub only routes: it holds a registry of live sessions, a landing page, and a proxy.

The page itself is upstream's: a session sidebar, the chat surface, a file explorer and viewer, git
status and diffs, skills, models, plugins, MCP and settings — every one of those served by the routes
copied from upstream, running against this machine. What is deliberately not here is anything that
would need a second agent process: starting a session from the browser, forking one that is not
running, or a terminal panel. The page lives as long as that Pi session.

## Requirements

- **Node.js ≥ 22.18** for the hub (`bin/pi-webui-hub.mjs` loads the TypeScript source through
  Node's built-in type stripping, so there is no build step). Node 24/26 are what this was tested on.
- Pi Coding Agent, and the extension installed in a session that has `git` available if you use
  the extension itself needs nothing beyond Node and Pi.

## Install

### 1. The extension

Install it from GitHub:

```bash
pi install git:github.com/Davidasx/pi-webui
```

Or load a local checkout for one run, without installing anything:

```bash
pi -e /path/to/pi-webui
```

### 2. The hub (systemd user service)

The extension never spawns the hub: a supervised service owns the fixed port, so it survives Pi
restarts and crashes. `/webui hub` prints this unit with your absolute paths already substituted:

```bash
mkdir -p ~/.config/systemd/user
# paste the unit printed by `/webui hub` into ~/.config/systemd/user/pi-webui-hub.service
systemctl --user daemon-reload
systemctl --user enable --now pi-webui-hub.service
systemctl --user status pi-webui-hub.service
```

The unit looks like this. It lives only in `~/.config/systemd/user/`; this repository ships no
service file:

```ini
[Unit]
Description=pi-webui hub — fixed-port router for Pi session browser views
After=default.target

[Service]
Type=simple
ExecStart=/usr/bin/env node /path/to/pi-webui/bin/pi-webui-hub.mjs
Restart=on-failure
RestartSec=2
# Port, bind address, and allowed host names live in ~/.pi/agent/pi-webui.json:
#   { "hub": { "port": 43118, "allowedHosts": ["pi.example.com"] } }
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
```

Run the hub in the foreground when debugging:

```bash
npm run hub            # or: pi-webui-hub --port 43118
```

## Use

In a terminal Pi session:

| Command | Behavior |
| --- | --- |
| `/webui` | Current-state menu (open, settings, status, help) |
| `/webui open` | Publish this session to the hub and print its link |
| `/webui hub` | Print the systemd unit and install steps |
| `/webui status` | Server, hub, link, startup, settings file path |
| `/webui settings` | TUI settings screen (`startOnSessionStart`, the hub port, allowed hosts) |
| `/webui init` | Create the defaults file without overwriting anything |
| `/webui help` | Command and settings help |

Then open the printed URL, or browse the index at <http://127.0.0.1:43118/>:

- `/` lists every live session (project, model, idle/running, age, path) and updates over
  server-sent events — no page reloads, so scroll position and focus survive.
- `/?session=<sessionId>` is that session's chat page (the same URL shape `agegr/pi-web` uses):
  transcript, streaming assistant text, collapsible tool cards, thinking blocks, errors, and a
  composer that sends text plus sanitized images.
- The top bar mirrors Pi's own controls: **model** (any model this session may use, 500+ here, with a
  filter), **thinking level**, **context usage**, **active/total tools**, **compact**, and the
  connection state. Each one is the same API the terminal uses, so nothing is a web-only shim.
- **Slash commands work.** Type `/` in the composer for the list: registered extension commands
  (`/webui …`), skill commands, prompt templates, plus the built-ins this page implements
  (`/compact`, `/name`, `/thinking`). A registered command is dispatched by Pi itself — it never
  reaches the model as prose — and a built-in the browser cannot run says so instead of silently
  sending text.
- The first tab to open a session holds the editing lease; other tabs stay readable and are marked
  read-only.
- While Pi is idle the composer sends immediately; while Pi is working it offers **Queue next**
  (follow-up) and **Steer**.

If the hub is not running, `/webui open` says so; the session keeps trying and shows the page the
moment the hub answers, so a hub restart needs no session action.

## Security model

- **No authentication, by design.** Any local process can drive a registered session through the
  hub, so treat the port as equivalent to typing in the terminal. Keep it on loopback.
- **Host validation.** The hub answers only for `127.0.0.1`, `localhost`, `::1`, plus any hostname
  in `hub.allowedHosts`. Anything else gets `421`, which also blocks DNS-rebinding attempts.
- **Origin validation.** Session-scoped mutations must arrive with the session's own origin; the hub
  passes the browser's origin on only after checking it against its own Host header, so a page on
  another origin (including a hostile web page in your browser) is refused with `403`.
- **The channel is loopback and same-host.** Only a process on this machine can open a channel, and
  the hub refuses an upgrade whose Host it does not serve. A session can therefore only be reached
  through the hub, never by a page that merely guesses a port.
- **Served pages carry a strict CSP** with a per-response nonce; the session page keeps its own
  nonce-based policy (no CDN, no remote service, no browser storage).
- **Remote access is yours to add.** Front the hub with a tunnel or reverse proxy that does
  authentication (Cloudflare Zero Trust, an SSH tunnel, mTLS, …) and add its hostname to
  `hub.allowedHosts` in the configuration file. pi-webui will not grow its own auth.

## Configuration

There are **no `pi-webui` environment variables**. One file is the single source of truth for both
readers — the hub service and the extension:

```text
$PI_CODING_AGENT_DIR/pi-webui.json      # else ~/.pi/agent/pi-webui.json
```

```json
{
  "startOnSessionStart": false,
  "hub": {
    "port": 43118,
    "allowedHosts": ["pi.example.com"]
  }
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `hub.port` | `43118` | Port the hub service listens on and the extension connects to |
| `hub.allowedHosts` | loopback only | Extra `Host` names to answer for (a tunnel or reverse proxy) |
| `startOnSessionStart` | `false` | Publish this session automatically on every session start |

The hub binds `127.0.0.1` and only `127.0.0.1`; exposing it is the tunnel's job, not a setting. Both
processes read this file the same way, so changing `hub.port` needs no systemd edit and no
`daemon-reload` — write the file and restart the service:

```bash
systemctl --user restart pi-webui-hub.service
```

Running sessions follow a port change on their own: the channel drops, the extension re-reads the
file, and the next retry lands on the new port. `/webui status` prints the effective port, where it
came from, the channel URL, and the file path; `/webui settings` edits the port in place.

For debugging, the hub also accepts `--port <port>` and `--host <host>` flags that override the file
for that one run. The extension always reads the file, so a temporary `--port` is only useful with
the direct URL the hub prints on startup.

`startOnSessionStart` publishes the session automatically on every session start (startup, reload,
new, resume, fork) instead of waiting for `/webui open`. Malformed JSON, or a `hub` value with the
wrong type, is preserved and ignored with a warning; `/webui status` reports the effective values and
the file path. The extension validates strictly before writing (an invalid recognized value sends the
menu to the repair flow), while the hub reports the problem in its log and starts with the default
port instead of refusing to run.

## Protocol (for tooling)

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/_hub/hello` | `GET` | Hub identity, protocol version, and the channel path |
| `/_hub/sessions` | `GET` | Current session list as JSON |
| `/_hub/events` | `GET` | SSE stream of session-list snapshots (`event: sessions`) |
| `/_hub/channel` | WebSocket | Where a session's extension dials in (protocol 2) |
| `/?session=<sessionId>` | `GET` | The app shell; the page reads its session from the query string |
| `/app.{js,css}` | `GET` | The UI bundle, served once by the hub for every session |
| `/api/session/<sessionId>/**` | any | Forwarded to the owning session over its channel |
| `/s/<sessionId>/…` | — | Legacy printed link: redirects to `/?session=<sessionId>` |

The channel carries JSON control frames plus binary bodies for the request and the response, so a
tunnelled server-sent-event stream and an image upload share one connection. Three consequences
worth knowing:

- **A session is listed exactly while it is connected.** There is no heartbeat and no registration:
  connect = listed, disconnect = marked reconnecting for a 30 s grace period (so a hub restart does
  not blank a tab), then forgotten.
- **A restarted hub repopulates itself** as the extensions redial, and nothing else needs to change:
  the socket path comes from the same configuration file the port does.
- **A session with no channel answers with a reconnecting page** instead of a proxy error, and keeps
  its requests queued for a few seconds while the extension comes back.

## Interface

The visual design — the palette, the markdown rules, the tool cards, the thinking blocks, and the
composer — is ported from [`agegr/pi-web`](https://github.com/agegr/pi-web) (MIT). Only the
presentation is shared; the data comes from this session's own extension through the hub.

## Development

```bash
npm install
npm run verify      # biome check + bundle freshness + typecheck + tests
npm run test        # vitest
npm run check       # biome only
npm run typecheck   # bundle freshness + tsc --noEmit
npm run build:web   # rebuild src/web/app.{js,css} with esbuild
npm run hub         # run the hub in the foreground
```

Layout: `src/hub.ts` (the one web server: page, assets, channel registry, tunnel; run directly by
Node through type stripping), `src/hub-channel.ts` (the extension's WebSocket client, with
reconnect), `src/hub-protocol.ts` (shared contract), `src/server.ts` (a session's web API, driven by
the channel and transport-agnostic), `src/vendored-routes.ts` (mounts the API routes copied from
upstream), `src/runtime.ts` (Pi integration: events, commands, the bridge upstream's pages call),
`src/web/pi-web/**` (upstream's frontend and routes, copied verbatim — see `PORTING.md`),
`src/web/session.jsx` (the mount point) and `src/web/shims/**` (their three Next.js imports).

## Behind a proxy or tunnel

Server-sent events are what make the pages live, and Cloudflare's edge is not fully reliable with
them: it has been observed to buffer `text/event-stream` (events arrive late, or only once the
connection closes), and it drops a stream that stays idle for ~100 seconds. The hub and the client
are built so that none of this makes a page go stale:

- Idle streams emit a keep-alive comment every 15s (hub index, 15s for session streams too), which
  keeps the path warm and below the idle cut-off. EventSource reconnects 2s after a cut.
- The hub pushes a session snapshot every 3s even when nothing changed, so "quiet" and "dead" are
  distinguishable from the browser side.
- If the index stream goes silent for 8s, the landing page falls back to polling `/_hub/sessions`
  every 3s and shows `polling` next to the port; it returns to `live` as soon as events flow again.
- The session page does the same trick: when no stream data has arrived for 5s, it refreshes the
  full snapshot over a plain request, so a buffered stream cannot freeze a running turn.

If streaming still misbehaves through your tunnel, in order of what usually helps:

1. Use a **named tunnel**, not a quick tunnel (`trycloudflare.com`): quick tunnels intentionally
   buffer `GET` streams.
2. Make sure the response is not compressed. The pages already send `Cache-Control: no-store` and
   `X-Accel-Buffering: no`, but if you enabled Brotli/compression for the hostname, add a
   Configuration Rule that turns compression off for it.
3. Behind **Cloudflare Access**, the `CF_Authorization` cookie must reach the `/_hub/events` request —
   it does in a normal browser session. If you front the hub with a service token or a header-only
   policy instead, the page loads but its event stream will 403, and only the polling fallback keeps
   it fresh.
4. If a long-lived stream is a hard requirement, terminate TLS somewhere that streams honestly
   (a plain reverse proxy, or a grey-clouded hostname for the hub only).

## Known behavior worth knowing

- The terminal transcript shows the internal `<pi-webui-input nonce="…">` envelope for messages that
  came from the browser; Pi replaces it with the real text before persistence and before the model
  sees it, and the browser page always shows the real text. The envelope is what keeps a
  browser-pasted internal marker from being mistaken for a real one by other extensions, so it is
  intentional rather than cosmetic debt.
- The hub index is a live view of *registered* sessions; a Pi session that exits disappears on its
  own within the expiry window.
- One hub serves one machine and one user's sessions on that loopback interface.
- `pi-webui.json` writes and `/webui init` serialize through a lock file; do not hand-edit that file
  while a save is in flight.

## License

MIT. Upstream: `narumiruna/pi-extensions` (archived `pi-webui`); this fork keeps the original
implementation and tests, and adds the hub, the fixed-port routing, and the no-auth model.
