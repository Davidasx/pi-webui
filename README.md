# pi-webui — browser companion for the current Pi session, over a fixed-port hub

A private browser view of the Pi session that is running in your terminal, shared through one
fixed port across all of your Pi sessions.

This is a port of [`narumiruna/pi-extensions/deprecated/pi-webui`](https://github.com/narumiruna/pi-extensions/tree/main/deprecated/pi-webui)
(MIT, archived upstream) with three deliberate changes:

1. **No authentication.** The session server and the hub are loopback-only and answer directly:
   open `http://127.0.0.1:43118/` and you are in. Remote access is the operator's job — put your
   own access control (for example Cloudflare Zero Trust) in front of the hub.
2. **One fixed port for every session.** A small hub service owns the port and routes requests to
   the Pi session that owns each page, so `/s/<sessionId>/` addresses a session.
3. **The hub is a router, never an agent host.** The hub never opens, reads, or writes a Pi
   session; it only forwards HTTP and server-sent events between the browser and the sessions that
   registered with it.

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

- The HTTP server runs **inside the Pi process** (`server.listen(0, "127.0.0.1")`), one per session.
- Browser input enters through the normal Pi input path
  (`pi.sendUserMessage(content, { deliverAs })`), exactly like terminal typing, so the terminal and
  the browser share one runtime, one conversation tree, and one writer.
- Pi core persists the session; pi-webui never writes session files.
- The hub only routes: it holds a registry of live sessions, a landing page, and a proxy.

The trade-off is scope: one session per page, no session manager, no shell, file browser, git UI,
or task board, and the page lives only as long as that Pi session.

## Requirements

- **Node.js ≥ 22.18** for the hub (`bin/pi-webui-hub.mjs` loads the TypeScript source through
  Node's built-in type stripping, so there is no build step). Node 24/26 are what this was tested on.
- Pi Coding Agent 1.x, and the extension installed in a session that has `git` available if you use
  the image pipeline's optional formats (sharp handles PNG/JPEG/WebP/GIF/BMP/TIFF/HEIF/AVIF).

## Install

### 1. The extension

Add the checkout to Pi's package list (the same way other local extensions are installed):

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": ["/path/to/pi-webui"]
}
```

Or install it ad hoc for one run:

```bash
pi -e /path/to/pi-webui
pi install /path/to/pi-webui      # permanent, package form
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
Environment=PI_WEBUI_PORT=43118
# Extra Host header names, needed only when a tunnel or reverse proxy fronts the hub.
Environment=PI_WEBUI_ALLOWED_HOSTS=pi.example.com
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
| `/webui status` | Server, hub, link, startup, image limits, settings path |
| `/webui settings` | TUI settings screen (`startOnSessionStart` is the only exposed switch) |
| `/webui init` | Create the defaults file without overwriting anything |
| `/webui help` | Command and settings help |

Then open the printed URL, or browse the index at <http://127.0.0.1:43118/>:

- `/` lists every live session (project, model, idle/running, age, path) and updates over
  server-sent events — no page reloads, so scroll position and focus survive.
- `/s/<sessionId>/` is that session's chat page: transcript, streaming assistant text, tool
  activity, errors, and a composer that sends text plus sanitized images.
- The first tab to open a session holds the editing lease; other tabs stay readable and are marked
  read-only.
- While Pi is idle the composer sends immediately; while Pi is working it offers **Queue next**
  (follow-up) and **Steer**.

If the hub is not running, `/webui open` says so and falls back to a session-only link on an
ephemeral port, so the extension stays useful without the service.

## Security model

- **No authentication, by design.** Any local process can drive a registered session through the
  hub, so treat the port as equivalent to typing in the terminal. Keep it on loopback.
- **Host validation.** The hub answers only for `127.0.0.1`, `localhost`, `::1`, plus any hostname
  in `PI_WEBUI_ALLOWED_HOSTS`. Anything else gets `421`, which also blocks DNS-rebinding attempts.
- **Origin validation.** Session-scoped mutations must arrive with the session's own origin; the hub
  restates a validated browser origin as the session origin when it proxies, so a page on another
  origin (including a hostile web page in your browser) is refused with `403`.
- **Cross-origin control-plane writes are blocked.** `/_hub/register|heartbeat|unregister` require a
  JSON content type, which a cross-origin page cannot send without a preflight the hub never answers.
- **Served pages carry a strict CSP** with a per-response nonce; the session page keeps its own
  nonce-based policy (no CDN, no remote service, no browser storage).
- **Remote access is yours to add.** Front the hub with a tunnel or reverse proxy that does
  authentication (Cloudflare Zero Trust, an SSH tunnel, mTLS, …) and add its hostname to
  `PI_WEBUI_ALLOWED_HOSTS`. pi-webui will not grow its own auth.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_WEBUI_PORT` | `43118` | Fixed hub port (set it in the unit) |
| `PI_WEBUI_HOST` | `127.0.0.1` | Hub bind address |
| `PI_WEBUI_ALLOWED_HOSTS` | — | Comma-separated extra `Host` names (proxy/tunnel) |
| `PI_WEBUI_HUB_URL` | derived from `PI_WEBUI_PORT` | Full hub base URL for the extension |
| `PI_WEBUI_HUB_QUIET` | — | `1` reduces hub logging |

Extension settings live in one global file, `<getAgentDir()>/pi-webui.json`
(`~/.pi/agent/pi-webui.json`):

```json
{
  "startOnSessionStart": false,
  "retainSentImages": false,
  "maxImages": 8,
  "maxImageBytes": 10485760,
  "maxBatchBytes": 41943040,
  "maxImagePixels": 50000000
}
```

`startOnSessionStart` publishes the session automatically on every session start (startup, reload,
new, resume, fork) instead of waiting for `/webui open`. Malformed JSON is preserved, ignored with a
warning, and never rewritten; `/webui status` reports the effective values and their source.

## Protocol (for tooling)

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/_hub/hello` | `GET` | Hub identity and protocol version |
| `/_hub/sessions` | `GET` | Current registry as JSON |
| `/_hub/events` | `GET` | SSE stream of registry snapshots (`event: sessions`) |
| `/_hub/register` | `POST` | Announce a session (session id, loopback port, token, metadata) |
| `/_hub/heartbeat` | `POST` | Refresh the registration and metadata |
| `/_hub/unregister` | `POST` | Remove the registration (best effort; entries also expire) |
| `/s/<sessionId>/**` | any | Proxied to the owning session with the prefix stripped |

Registrations expire after roughly 40s without a heartbeat, and stay routable through a grace period
so a brief stall never blanks an open tab. A restarted hub is repopulated by the next heartbeat —
sessions do not need to restart.

## Development

```bash
npm install
npm run verify      # biome check + typecheck + 195 tests
npm run test        # vitest
npm run check       # biome only
npm run typecheck   # bundle freshness + tsc --noEmit
npm run build:web   # rebuild src/web/app.{js,css} with esbuild
npm run hub         # run the hub in the foreground
```

Layout: `src/hub.ts` (router, run directly by Node through type stripping), `src/hub-client.ts`
(registration/heartbeat), `src/hub-protocol.ts` (shared contract), `src/server.ts` (in-session
server), `src/runtime.ts` (Pi integration), `src/web/ui/*` (React client, bundled into
`src/web/app.js`).

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
