# Porting agegr/pi-web's interface, verbatim

`src/web/pi-web/` is a **byte-identical copy** of the frontend of
[`agegr/pi-web`](https://github.com/agegr/pi-web) (MIT — see `LICENSE.agegr-pi-web`), taken at the
revision this port was made from, together with the API routes those pages call. The files are not
edited: when something does not fit, we adapt around them (a shim, an adapter, or a wrapper), so that a
later refresh of the copy stays a copy. `scripts/vendor-web.mjs` does the copying and re-running it is
idempotent.

Copying it verbatim is what makes the browser UI *actually* the same interface rather than an
imitation. What follows is what that requires of us.

## What is copied

| Copied | Why |
| --- | --- |
| `components/**`, `hooks/**`, `lib/**` | Their application shell, chat surface, sidebar, panels, and the client that drives all of it |
| `app/globals.css`, `app/settings.css`, `app/sidebar.css`, `app/sidebar-menu.css`, `lib/theme.ts` | Imported by their `app/layout.tsx` rather than a component, so following imports alone would miss them |
| `app/api/**` (except the three routes below) | Their endpoints for sessions, files, git, skills, plugins, models, MCP, subagents and settings — they already do the work, against this machine's own file system |

Two mechanical rewrites are applied to every copied file, and nothing else:

1. the `@/…` path alias becomes a relative path, because we bundle with esbuild rather than Next;
2. extensionless relative imports get a `.js` suffix, the convention the copied files use.

Their `next/image`, `next/navigation` and `next/server` imports are pointed at `src/web/shims/`. The
browser bundle aliases them; the copied routes and the extension's Node loader cannot use an alias, so
the copy imports the shim directly.

## What stays ours

| Ours | Why |
| --- | --- |
| `app/api/agent/[id]/route.ts`, `app/api/agent/[id]/events/route.ts`, `app/api/agent/new/route.ts` | These talk to the agent. In their server that means spawning a `pi` child over RPC; here the agent is the process the extension is already inside |
| `lib/rpc-manager.ts` | The one adapter: their routes call it as a registry of live sessions, and it answers with **this** session. `scripts/vendor-web.mjs` resolves the path but never writes the file |
| `src/vendored-routes.ts` | Mounts their route handlers on our server: path matching, request/response bridging, lazy loading |
| `src/hub.ts`, `src/hub-channel.ts`, `src/hub-protocol.ts` | The hub owns the single port, serves the page, and tunnels each session's API over one WebSocket |
| `src/web/session.jsx`, `src/web/shims/**` | The mount point and the three shims |

## The contract, and who answers it

| Endpoint | Who answers |
| --- | --- |
| `GET /api/sessions`, `/api/sessions/<id>`, `/search`, `/export`, `/context`, `/ui-state` | Their routes, reading Pi's session files through their own `session-reader` |
| `GET /api/files/<segments>`, `/api/git/*`, `/api/skills`, `/api/plugins`, `/api/models*`, `/api/tools/settings`, `/api/mcp`, `/api/subagents/*`, `/api/home`, `/api/cwd/*`, `/api/project-trust` | Their routes, against this machine |
| `GET /api/agent/<id>` | Ours: their composer's liveness probe, answered with the live state |
| `GET /api/agent/<id>/events` | Ours: Pi's own events, mapped by **their** `lib/agent-event-wire.ts` |
| `POST /api/agent/<id>` | Ours: their RPC-shaped commands, run through Pi's API |
| `POST /api/sessions/<id>/auto-name` | Ours: their title generator, driven through `ctx.modelRegistry` |

Their `lib/rpc-manager.ts` calls are answered by the adapter: `getRpcSession(id)` is this session when
the id matches, and `undefined` otherwise, which leaves every other id to their own disk-reading paths.
`evictIfDiskAhead()` answers `false` on purpose: their server needs it because a separate `pi` child
may write the file behind its back, while here the process *is* the writer, so memory is always the
newest copy.

## Things that behave differently here

- **Titles.** Their `generateSessionTitle` runs unchanged, with their prompt and parser, through
  `ctx.modelRegistry.streamSimple`. If that call fails, the title falls back to the session's first
  line — the text their sidebar shows for an unnamed session anyway.
- **Slash commands.** Commands Pi registers, skills and prompt templates are dispatched by Pi
  (`expandPromptTemplates`). The built-ins with an API on this side run (`/compact`, `/name`,
  `/thinking`); the terminal-only ones (`/tree`, `/settings`, `/model`, …) answer with a visible
  message naming the button in this page that does the same thing, instead of appearing to run.
- **Extension UI requests** (`select`/`confirm`/`custom` dialogs raised by *other* extensions) are not
  mirrored into the page: Pi hands those to the terminal, and an extension cannot read another
  extension's pending requests. Statuses and widgets that arrive as events are shown; ones set before
  the page opened are not.
- **Content-Security-Policy.** The page allows inline styles (`style-src 'self' 'unsafe-inline'`),
  because their components style themselves with inline `<style>` blocks. Scripts stay nonce-locked.
- **Forking a session that is not running** answers with an explanation rather than starting one: that
  needs a `pi` process, and the run belongs in a terminal.

## Keeping the copy current

```sh
git clone https://github.com/agegr/pi-web "$PI_TMPDIR/pi-web"
node scripts/vendor-web.mjs --from "$PI_TMPDIR/pi-web"   # idempotent: a second run writes nothing
npm run verify                                            # biome, bundle freshness, tsc, tests
```

`test/web-ui-contract.test.ts` checks the copy's shape (the shims, the owned routes, the licence), and
`test/browser-contract.test.ts` checks what their page is owed over HTTP.
