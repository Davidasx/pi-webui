/**
 * pi-webui hub: a router, not an agent host.
 *
 * The hub owns the fixed port and nothing else. It keeps a registry of live Pi sessions that
 * registered themselves, serves a small landing page, and proxies every session-scoped request to
 * the in-process web server that lives inside the owning Pi session. It never opens a Pi session,
 * never reads or writes Pi session data, and never constructs an agent runtime, so it cannot
 * compete with a terminal Pi process for session state.
 *
 * Plain Node TypeScript: this file is executed directly by Node's type stripping
 * (`node src/hub.ts`), so the systemd unit needs no build step.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { Agent, createServer, type IncomingMessage, request as proxyRequest, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";

import {
	DEFAULT_HUB_PORT,
	EVENTS_PATH,
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_PATH,
	HELLO_PATH,
	HUB_NAME,
	HUB_PROTOCOL,
	type HubActivity,
	REGISTER_PATH,
	SESSION_PATH_PREFIX,
	SESSIONS_PATH,
	sessionBasePath,
	UNREGISTER_PATH,
} from "./hub-protocol.ts";

export type { HubActivity } from "./hub-protocol.ts";
export { DEFAULT_HUB_PORT, HUB_NAME, HUB_PROTOCOL } from "./hub-protocol.ts";
/** Heartbeat interval the extension uses; exported so both sides agree. */
export const HUB_HEARTBEAT_INTERVAL_MS = HEARTBEAT_INTERVAL_MS;

/** How long a registration survives without a heartbeat. */
const SESSION_TTL_MS = 10_000;
/** How long an expired session stays routable (so a brief stall does not blank a browser tab). */
const SESSION_GRACE_MS = 30_000;
/** Extra hostnames allowed in the Host header, for a user-provided reverse proxy or tunnel. */
const DEFAULT_ALLOWED_HOSTS = ["127.0.0.1", "localhost", "[::1]", "::1"];
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const TOKEN_PATTERN = /^[a-f0-9]{16,128}$/;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SESSIONS = 128;
const HOP_BY_HOP = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);


export interface HubRegistration {
	sessionId: string;
	port: number;
	token: string;
	cwd?: string;
	projectName?: string;
	name?: string;
	model?: string;
	activity?: HubActivity;
	piVersion?: string;
	extensionVersion?: string;
}

export interface HubSessionSummary {
	sessionId: string;
	cwd?: string;
	projectName?: string;
	name?: string;
	model?: string;
	activity: HubActivity;
	registeredAt: number;
	lastSeen: number;
	stale: boolean;
	url: string;
}

interface SessionRecord extends HubSessionSummary {
	port: number;
	token: string;
	piVersion?: string;
	extensionVersion?: string;
}

export interface HubLogger {
	info(message: string): void;
	error(message: string): void;
}

export interface HubOptions {
	port?: number;
	host?: string;
	allowedHosts?: readonly string[];
	logger?: HubLogger;
	ttlMs?: number;
	graceMs?: number;
	/**
	 * Keep the process alive through the listening server. The CLI sets this; tests leave it off so
	 * they can close a hub deterministically without holding the test runner open.
	 */
	keepAlive?: boolean;
}

export interface Hub {
	readonly port: number;
	readonly url: string;
	sessions(): HubSessionSummary[];
	close(): Promise<void>;
}

const silentLogger: HubLogger = { info: () => undefined, error: () => undefined };

function createLogger(quiet: boolean): HubLogger {
	if (quiet) return silentLogger;
	const stamp = () => new Date().toISOString().slice(11, 19);
	return {
		info: (message) => console.log(`[${stamp()}] ${message}`),
		error: (message) => console.error(`[${stamp()}] ${message}`),
	};
}

function htmlEscape(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function hostAllowed(host: string | undefined, allowedHosts: readonly string[]): boolean {
	if (!host) return false;
	const name = host.trim().toLowerCase();
	// `[::1]:43118` keeps its brackets in the Host header.
	const withoutPort = name.startsWith("[") ? name.slice(0, name.indexOf("]") + 1) : name.split(":", 1)[0];
	return allowedHosts.includes(withoutPort);
}

function sameOrigin(origin: string, host: string): boolean {
	try {
		return new URL(origin).host.toLowerCase() === host.trim().toLowerCase();
	} catch {
		return false;
	}
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
	const body = JSON.stringify(payload);
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store",
	});
	response.end(body);
}

function sendHtml(response: ServerResponse, status: number, body: string, nonce: string): void {
	response.writeHead(status, {
		"Content-Type": "text/html; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		"Cache-Control": "no-store",
		// Hub pages carry no third-party resources; inline style and script must present the nonce.
		"Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
	});
	response.end(body);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
		total += buffer.byteLength;
		if (total > MAX_BODY_BYTES) return undefined;
		chunks.push(buffer);
	}
	if (total === 0) return {};
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function optionalString(source: Record<string, unknown>, key: string, max = 200): string | undefined {
	const value = source[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, max) : undefined;
}

function parseRegistration(source: Record<string, unknown>): HubRegistration | undefined {
	const sessionId = optionalString(source, "sessionId");
	const token = optionalString(source, "token");
	const port = source.port;
	if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) return undefined;
	if (!token || !TOKEN_PATTERN.test(token)) return undefined;
	if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
	const activity = source.activity;
	return {
		sessionId,
		token,
		port,
		...(optionalString(source, "cwd", 4096) ? { cwd: optionalString(source, "cwd", 4096) as string } : {}),
		...(optionalString(source, "projectName") ? { projectName: optionalString(source, "projectName") as string } : {}),
		...(optionalString(source, "name") ? { name: optionalString(source, "name") as string } : {}),
		...(optionalString(source, "model") ? { model: optionalString(source, "model") as string } : {}),
		...(activity === "idle" || activity === "running" || activity === "unknown" ? { activity } : {}),
		...(optionalString(source, "piVersion") ? { piVersion: optionalString(source, "piVersion") as string } : {}),
		...(optionalString(source, "extensionVersion")
			? { extensionVersion: optionalString(source, "extensionVersion") as string }
			: {}),
	};
}

function secretEqual(a: string, b: string): boolean {
	const left = Buffer.from(a, "utf8");
	const right = Buffer.from(b, "utf8");
	if (left.byteLength !== right.byteLength) return false;
	return timingSafeEqual(left, right);
}

function sessionIdFromPath(pathname: string): { sessionId: string; rest: string } | undefined {
	if (!pathname.startsWith(SESSION_PATH_PREFIX)) return undefined;
	const remainder = pathname.slice(SESSION_PATH_PREFIX.length);
	const slash = remainder.indexOf("/");
	const sessionId = slash === -1 ? remainder : remainder.slice(0, slash);
	if (!SESSION_ID_PATTERN.test(sessionId)) return undefined;
	return { sessionId, rest: slash === -1 ? "/" : remainder.slice(slash) };
}

function formatAge(seconds: number): string {
	if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

function formatDuration(seconds: number): string {
	const total = Math.max(0, Math.round(seconds));
	const minutes = Math.floor(total / 60);
	if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function sessionRowHtml(session: HubSessionSummary, now: number): string {
	const title = session.name ?? session.projectName ?? session.sessionId.slice(0, 8);
	const statusClass = session.stale ? "stale" : session.activity === "running" ? "busy" : "idle";
	const statusText = session.stale ? "stale" : session.activity === "running" ? "running" : "idle";
	return `<li data-session="${htmlEscape(session.sessionId)}" data-registered="${session.registeredAt}" data-seen="${session.lastSeen}">
	<a class="card" href="${htmlEscape(session.url)}">
		<span class="head"><span class="title">${htmlEscape(title)}</span><span class="state ${statusClass}">${statusText}</span></span>
		<span class="meta">${htmlEscape(session.projectName ?? "Pi session")}${
			session.model ? ` &middot; ${htmlEscape(session.model)}` : ""
		}</span>
		<span class="meta dim"><span class="uptime">up ${formatDuration((now - session.registeredAt) / 1000)}</span> &middot; seen <span class="age">${formatAge(
			(now - session.lastSeen) / 1000,
		)}</span> &middot; <code>${htmlEscape(session.sessionId.slice(0, 8))}</code></span>
		<span class="meta dim path">${htmlEscape(session.cwd ?? "")}</span>
	</a>
</li>`;
}

function landingPage(sessions: readonly HubSessionSummary[], port: number, nonce: string): string {
	const now = Date.now();
	const rows = sessions.map((session) => sessionRowHtml(session, now)).join("\n");
	const list = sessions.length ? `<ul class="sessions" id="sessions">\n${rows}\n</ul>` : `<ul class="sessions" id="sessions"></ul>`;
	// Server-rendered rows mean the page is useful without JavaScript; the script only refreshes
	// the list in place from the hub's event stream, so scrolling and focus survive updates.
	const script = `(() => {
	const list = document.getElementById("sessions");
	const empty = document.getElementById("empty");
	const status = document.getElementById("hub-status");
	let sessions = ${JSON.stringify(sessions)};
	const seconds = (value) => Math.max(0, Math.round(value));
	const duration = (value) => {
		const total = seconds(value);
		const minutes = Math.floor(total / 60);
		if (minutes < 60) return minutes + "m " + String(total % 60).padStart(2, "0") + "s";
		return Math.floor(minutes / 60) + "h " + String(minutes % 60).padStart(2, "0") + "m";
	};
	const ago = (value) => {
		const total = seconds(value);
		if (total < 60) return total + "s ago";
		const minutes = Math.floor(total / 60);
		if (minutes < 60) return minutes + "m ago";
		return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m ago";
	};
	const element = (tag, className, text) => {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	};
	const render = () => {
		list.textContent = "";
		empty.hidden = sessions.length > 0;
		const now = Date.now();
		for (const session of sessions) {
			const statusClass = session.stale ? "stale" : session.activity === "running" ? "busy" : "idle";
			const statusText = session.stale ? "stale" : session.activity === "running" ? "running" : "idle";
			const head = element("span", "head");
			head.append(
				element("span", "title", session.name || session.projectName || session.sessionId.slice(0, 8)),
				element("span", "state " + statusClass, statusText),
			);
			const meta = element("span", "meta", (session.projectName || "Pi session") + (session.model ? " · " + session.model : ""));
			const meta2 = element("span", "meta dim");
			const uptime = element("span", "uptime", "up " + duration((now - session.registeredAt) / 1000));
			const age = element("span", "age", ago((now - session.lastSeen) / 1000));
			meta2.append(uptime, document.createTextNode(" · seen "), age, document.createTextNode(" · "), element("code", "", session.sessionId.slice(0, 8)));
			const card = element("a", "card");
			card.href = session.url;
			card.append(head, meta, meta2, element("span", "meta dim path", session.cwd || ""));
			const item = element("li");
			item.append(card);
			list.append(item);
		}
	};
	const refreshAges = () => {
		const now = Date.now();
		for (const session of sessions) {
			const item = list.querySelector('li[data-session="' + session.sessionId + '"]');
			if (!item) continue;
			const uptime = item.querySelector(".uptime");
			const age = item.querySelector(".age");
			if (uptime) uptime.textContent = "up " + duration((now - session.registeredAt) / 1000);
			if (age) age.textContent = ago((now - session.lastSeen) / 1000);
		}
	};
	const events = new EventSource("/_hub/events");
	events.addEventListener("sessions", (event) => {
		sessions = JSON.parse(event.data);
		status.textContent = "live";
		render();
	});
	events.addEventListener("open", () => {
		status.textContent = "live";
	});
	events.addEventListener("error", () => {
		status.textContent = "reconnecting";
	});
	setInterval(refreshAges, 1000);
	render();
})();`;
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<meta name="color-scheme" content="light dark" />
		<title>pi-webui</title>
		<style nonce="${nonce}">
			:root { color-scheme: light dark; --fg: #111; --dim: #666; --bg: #fff; --card: #f5f5f5; --line: #e0e0e0; }
			@media (prefers-color-scheme: dark) {
				:root { --fg: #e8e8e8; --dim: #9a9a9a; --bg: #16181c; --card: #202329; --line: #333842; }
			}
			* { box-sizing: border-box; }
			body { margin: 0 auto; max-width: 52rem; padding: 2rem 1.25rem 4rem; background: var(--bg); color: var(--fg);
				font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
			h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
			.sub { color: var(--dim); margin: 0 0 1.75rem; font-size: .9rem; }
			#hub-status { text-transform: uppercase; letter-spacing: .04em; font-size: .72rem; }
			ul.sessions { list-style: none; margin: 0; padding: 0; display: grid; gap: .75rem; }
			a.card { display: flex; flex-direction: column; gap: .15rem; padding: .85rem 1rem; text-decoration: none;
				color: inherit; background: var(--card); border: 1px solid var(--line); border-radius: 10px; }
			a.card:hover { border-color: var(--fg); }
			.head { display: flex; align-items: center; gap: .5rem; }
			.title { font-weight: 600; }
			.meta { color: var(--dim); font-size: .85rem; }
			.path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .78rem; word-break: break-all; }
			.state { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; padding: .1rem .4rem;
				border-radius: 999px; border: 1px solid var(--line); }
			.state.busy { color: #0a7; border-color: #0a7; }
			.state.idle { color: #888; }
			.state.stale { color: #c60; border-color: #c60; }
			.empty { color: var(--dim); }
			footer { margin-top: 2.5rem; color: var(--dim); font-size: .8rem; }
			code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
		</style>
	</head>
	<body>
		<h1>pi-webui</h1>
		<p class="sub">Live browser companions for Pi sessions on this machine &middot; hub on port ${port} &middot; <span id="hub-status">connecting</span></p>
		${list}
		<p class="empty" id="empty"${sessions.length ? " hidden" : ""}>No Pi session is connected yet. Run Pi in a terminal and use <code>/webui open</code> (or enable "Start WebUI automatically") in the session you want to reach.</p>
		<footer>This hub only routes requests to the Pi session that owns each page. It has no
		authentication of its own: keep it on loopback, and put your own access control in front
		of it (for example a reverse proxy with Cloudflare Zero Trust) before exposing it.</footer>
		<script nonce="${nonce}">${script}</script>
	</body>
</html>
`;
}

function sessionGonePage(sessionId: string, nonce: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>pi-webui</title>
<style nonce="${nonce}">body{margin:0;padding:3rem 1.25rem;font:15px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:40rem;margin-inline:auto}
code{font-family:ui-monospace,Menlo,monospace}</style></head>
<body><h1>That Pi session is not connected</h1>
<p>Session <code>${htmlEscape(sessionId.slice(0, 8))}</code> is not registered with this hub right now.
It may have exited, or the hub may have restarted before the session's next heartbeat.</p>
<p><a href="/">Show connected sessions</a></p></body></html>
`;
}

export async function startHub(options: HubOptions = {}): Promise<Hub> {
	const host = options.host ?? "127.0.0.1";
	const ttlMs = options.ttlMs ?? SESSION_TTL_MS;
	const graceMs = options.graceMs ?? SESSION_GRACE_MS;
	const allowedHosts = options.allowedHosts ?? DEFAULT_ALLOWED_HOSTS;
	const logger = options.logger ?? silentLogger;
	const sessions = new Map<string, SessionRecord>();
	/** Open index streams (`/_hub/events`); the landing page subscribes instead of reloading. */
	const eventClients = new Set<ServerResponse>();
	const agent = new Agent({ keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 128, scheduling: "lifo" });

	const server: Server = createServer((request, response) => {
		void handle(request, response).catch((error: unknown) => {
			logger.error(`request failed: ${error instanceof Error ? error.message : String(error)}`);
			if (!response.headersSent) sendJson(response, 500, { error: "Hub failure" });
			else response.destroy();
		});
	});
	server.on("clientError", (_error, socket) => socket.destroy());

	function summarize(record: SessionRecord): HubSessionSummary {
		const now = Date.now();
		return {
			sessionId: record.sessionId,
			...(record.cwd ? { cwd: record.cwd } : {}),
			...(record.projectName ? { projectName: record.projectName } : {}),
			...(record.name ? { name: record.name } : {}),
			...(record.model ? { model: record.model } : {}),
			activity: record.activity,
			registeredAt: record.registeredAt,
			lastSeen: record.lastSeen,
			stale: now - record.lastSeen > ttlMs,
			url: sessionBasePath(record.sessionId),
		};
	}

	function listSessions(): HubSessionSummary[] {
		return [...sessions.values()]
			.sort((a, b) => b.lastSeen - a.lastSeen)
			.map((record) => summarize(record));
	}

	function requireSession(body: Record<string, unknown>): { record: SessionRecord; token: string } | undefined {
		const sessionId = optionalString(body, "sessionId");
		const token = optionalString(body, "token");
		if (!sessionId || !token) return undefined;
		const record = sessions.get(sessionId);
		if (!record || !secretEqual(record.token, token)) return undefined;
		return { record, token };
	}

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const hostHeader = request.headers.host;
		if (!hostAllowed(hostHeader, allowedHosts)) {
			sendJson(response, 421, {
				error: `Unexpected Host header. Add it to PI_WEBUI_ALLOWED_HOSTS to serve behind a proxy.`,
			});
			return;
		}
		const url = new URL(request.url ?? "/", `http://${hostHeader}`);
		const pathname = url.pathname;
		const method = request.method ?? "GET";

		if (pathname.startsWith("/_hub/")) {
			await handleControl(request, response, pathname, method);
			return;
		}

		if (method !== "GET" && method !== "HEAD") {
			// Session-scoped mutations are proxied below; anything else on the hub origin is refused.
			if (!sessionIdFromPath(pathname)) {
				sendJson(response, 405, { error: "Method not allowed" });
				return;
			}
		}

		const nonce = randomBytes(16).toString("base64url");
		if (pathname === "/" || pathname === "/index.html") {
			sendHtml(response, 200, landingPage(listSessions(), serverPort(), nonce), nonce);
			return;
		}

		if (pathname === "/favicon.ico") {
			response.writeHead(204).end();
			return;
		}

		const target = sessionIdFromPath(pathname);
		if (!target) {
			sendHtml(
				response,
				404,
				`<!doctype html><meta charset="utf-8"><title>pi-webui</title>
<style nonce="${nonce}">body{margin:0;padding:3rem 1.25rem;font:15px/1.6 ui-sans-serif,system-ui,sans-serif}</style>
<p>Unknown hub path. <a href="/">Show connected sessions</a>.</p>`,
				nonce,
			);
			return;
		}
		if (target.rest === "/" && pathname !== sessionBasePath(target.sessionId)) {
			response.writeHead(302, { Location: sessionBasePath(target.sessionId) }).end();
			return;
		}
		const record = sessions.get(target.sessionId);
		if (!record) {
			sendHtml(response, 404, sessionGonePage(target.sessionId, nonce), nonce);
			return;
		}
		proxy(record, target, request, response);
	}

	/**
	 * Control plane. Reads are plain GETs so any local tool or browser can inspect the hub, while
	 * mutations are POSTs. Mutations additionally require a JSON content type: a cross-origin page
	 * cannot send that without a preflight, and the hub never answers one, so another web page
	 * cannot register, refresh, or remove sessions through the browser.
	 */
	async function handleControl(
		request: IncomingMessage,
		response: ServerResponse,
		pathname: string,
		method: string,
	): Promise<void> {
		if (method === "GET" || method === "HEAD") {
			if (pathname === HELLO_PATH) {
				sendJson(response, 200, {
					name: HUB_NAME,
					protocol: HUB_PROTOCOL,
					port: serverPort(),
					sessionCount: sessions.size,
				});
				return;
			}
			if (pathname === SESSIONS_PATH) {
				sendJson(response, 200, { sessions: listSessions() });
				return;
			}
			if (pathname === EVENTS_PATH) {
				streamSessions(request, response);
				return;
			}
			sendJson(response, 404, { error: "Unknown hub endpoint" });
			return;
		}

		if (method !== "POST") return sendJson(response, 405, { error: "Method not allowed" });
		if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
			return sendJson(response, 415, { error: "Expected application/json" });
		}
		const body = await readJsonBody(request);
		if (!body) return sendJson(response, 400, { error: "Invalid JSON body" });

		if (pathname === REGISTER_PATH) {
			const registration = parseRegistration(body);
			if (!registration) return sendJson(response, 400, { error: "Invalid registration" });
			if (!sessions.has(registration.sessionId) && sessions.size >= MAX_SESSIONS) {
				return sendJson(response, 429, { error: "Too many sessions" });
			}
			const now = Date.now();
			const previous = sessions.get(registration.sessionId);
			const record: SessionRecord = {
				sessionId: registration.sessionId,
				port: registration.port,
				token: registration.token,
				activity: registration.activity ?? "unknown",
				registeredAt: previous?.registeredAt ?? now,
				lastSeen: now,
				stale: false,
				url: sessionBasePath(registration.sessionId),
				...(registration.cwd ? { cwd: registration.cwd } : {}),
				...(registration.projectName ? { projectName: registration.projectName } : {}),
				...(registration.name ? { name: registration.name } : {}),
				...(registration.model ? { model: registration.model } : {}),
				...(registration.piVersion ? { piVersion: registration.piVersion } : {}),
				...(registration.extensionVersion ? { extensionVersion: registration.extensionVersion } : {}),
			};
			sessions.set(record.sessionId, record);
			if (!previous) logger.info(`registered session ${record.sessionId.slice(0, 8)} on port ${record.port}`);
			broadcastSessions();
			sendJson(response, 200, {
				ok: true,
				basePath: sessionBasePath(record.sessionId),
				url: sessionBasePath(record.sessionId),
			});
			return;
		}

		if (pathname === HEARTBEAT_PATH) {
			const found = requireSession(body);
			if (!found) return sendJson(response, 404, { ok: false, error: "Unknown session" });
			const metadata = parseRegistration({ ...body, port: found.record.port, token: found.token });
			const wasStale = Date.now() - found.record.lastSeen > ttlMs;
			found.record.lastSeen = Date.now();
			if (metadata) {
				found.record.activity = metadata.activity ?? found.record.activity;
				if (metadata.name !== undefined) found.record.name = metadata.name;
				if (metadata.model !== undefined) found.record.model = metadata.model;
				if (metadata.projectName !== undefined) found.record.projectName = metadata.projectName;
				if (metadata.cwd !== undefined) found.record.cwd = metadata.cwd;
				if (metadata.piVersion !== undefined) found.record.piVersion = metadata.piVersion;
				if (metadata.extensionVersion !== undefined) found.record.extensionVersion = metadata.extensionVersion;
			}
			// A heartbeat also carries activity and model changes, so the index stays current.
			if (wasStale || metadata) broadcastSessions();
			sendJson(response, 200, { ok: true, basePath: sessionBasePath(found.record.sessionId) });
			return;
		}

		if (pathname === UNREGISTER_PATH) {
			const found = requireSession(body);
			if (!found) return sendJson(response, 200, { ok: true });
			sessions.delete(found.record.sessionId);
			logger.info(`unregistered session ${found.record.sessionId.slice(0, 8)}`);
			broadcastSessions();
			sendJson(response, 200, { ok: true });
			return;
		}

		sendJson(response, 404, { error: "Unknown hub endpoint" });
	}

	/** Server-sent events for the session index: pushes on change, keep-alive comments otherwise. */
	function streamSessions(request: IncomingMessage, response: ServerResponse): void {
		response.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-store",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		response.flushHeaders();
		eventClients.add(response);
		response.write(`event: sessions\ndata: ${JSON.stringify(listSessions())}\n\n`);
		const keepAlive = setInterval(() => {
			if (!response.write(": ping\n\n")) {
				clearInterval(keepAlive);
				eventClients.delete(response);
			}
		}, 15_000);
		keepAlive.unref?.();
		const release = () => {
			clearInterval(keepAlive);
			eventClients.delete(response);
		};
		request.once("close", release);
		response.once("close", release);
	}

	function broadcastSessions(): void {
		if (eventClients.size === 0) return;
		const payload = `event: sessions\ndata: ${JSON.stringify(listSessions())}\n\n`;
		for (const client of eventClients) {
			if (client.destroyed || client.writableEnded) {
				eventClients.delete(client);
				continue;
			}
			if (!client.write(payload)) eventClients.delete(client);
		}
	}

	function proxy(
		record: SessionRecord,
		target: { sessionId: string; rest: string },
		request: IncomingMessage,
		response: ServerResponse,
	): void {
		const headers: Record<string, string | string[]> = {};
		for (const [key, value] of Object.entries(request.headers)) {
			if (value === undefined) continue;
			const name = key.toLowerCase();
			if (HOP_BY_HOP.has(name) || name === "host" || name === "expect") continue;
			headers[name] = value;
		}
		const origin = request.headers.origin;
		if (typeof origin === "string" && sameOrigin(origin, request.headers.host ?? "")) {
			// The hub already accepted this origin; restate it as the session's own origin so the
			// session keeps its strict same-origin mutation check without learning about the hub.
			headers.origin = `http://127.0.0.1:${record.port}`;
		}
		headers.host = `127.0.0.1:${record.port}`;
		headers["x-pi-webui-base"] = sessionBasePath(target.sessionId);
		headers["x-pi-webui-via"] = HUB_NAME;

		const upstream = proxyRequest(
			{
				agent,
				host: "127.0.0.1",
				port: record.port,
				method: request.method,
				path: `${target.rest}${urlSearchOf(request)}`,
				headers,
			},
			(upstreamResponse) => {
				const responseHeaders: Record<string, string | string[]> = {};
				for (const [key, value] of Object.entries(upstreamResponse.headers)) {
					if (value === undefined) continue;
					const name = key.toLowerCase();
					if (HOP_BY_HOP.has(name)) continue;
					responseHeaders[name] = value;
				}
				const location = upstreamResponse.headers.location;
				if (typeof location === "string" && location.startsWith("/") && !location.startsWith(SESSION_PATH_PREFIX)) {
					responseHeaders.location = `${SESSION_PATH_PREFIX}${target.sessionId}${location}`;
				}
				response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
				upstreamResponse.pipe(response);
			},
		);
		upstream.on("error", (error: NodeJS.ErrnoException) => {
			const reason = error.code === "ECONNREFUSED" ? "the session stopped listening" : error.message;
			logger.error(`proxy to ${record.sessionId.slice(0, 8)} failed: ${reason}`);
			if (!response.headersSent) {
				sendHtml(response, 502, sessionGonePage(record.sessionId, randomBytes(16).toString("base64url")), randomBytes(16).toString("base64url"));
			}
			else response.destroy();
		});
		request.pipe(upstream);
		// Stop the upstream work only when the browser goes away before the response finished.
		// Watching the request stream instead would abort every bodyless request immediately.
		response.on("close", () => {
			if (!response.writableEnded) upstream.destroy();
		});
	}

	function urlSearchOf(request: IncomingMessage): string {
		const raw = request.url ?? "/";
		const index = raw.indexOf("?");
		return index === -1 ? "" : raw.slice(index);
	}

	function serverPort(): number {
		const address = server.address();
		return address && typeof address !== "string" ? address.port : 0;
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? DEFAULT_HUB_PORT, host, () => {
			server.off("error", reject);
			resolve();
		});
	});

	const sweep = setInterval(() => {
		const now = Date.now();
		for (const [id, record] of sessions) {
			if (now - record.lastSeen > ttlMs + graceMs) {
				sessions.delete(id);
				logger.info(`expired session ${id.slice(0, 8)} (no heartbeat)`);
				broadcastSessions();
			}
		}
	}, 2_000);
	if (!options.keepAlive) {
		sweep.unref();
		server.unref();
	}

	return {
		port: serverPort(),
		url: `http://127.0.0.1:${serverPort()}/`,
		sessions: listSessions,
		close: async () => {
			clearInterval(sweep);
			sessions.clear();
			for (const client of eventClients) client.end();
			eventClients.clear();
			agent.destroy();
			server.closeAllConnections?.();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

export interface HubCliOptions {
	port: number;
	host: string;
	quiet: boolean;
	allowedHosts: readonly string[];
}

export function parseHubArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): HubCliOptions {
	let port = Number.parseInt(env.PI_WEBUI_PORT ?? "", 10);
	let host = env.PI_WEBUI_HOST?.trim() || "127.0.0.1";
	let quiet = env.PI_WEBUI_HUB_QUIET === "1";
	const allowedHosts = [...DEFAULT_ALLOWED_HOSTS];
	for (const extra of (env.PI_WEBUI_ALLOWED_HOSTS ?? "").split(",")) {
		const value = extra.trim().toLowerCase();
		if (value) allowedHosts.push(value);
	}

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			throw new HubCliHelp();
		}
		if (arg === "--quiet" || arg === "-q") {
			quiet = true;
			continue;
		}
		const next = argv[index + 1];
		if (arg === "--port" || arg === "-p") {
			if (!next) throw new Error("--port requires a value");
			port = Number.parseInt(next, 10);
			index += 1;
			continue;
		}
		if (arg === "--host") {
			if (!next) throw new Error("--host requires a value");
			host = next;
			index += 1;
			continue;
		}
		if (arg === "--allow-host") {
			if (!next) throw new Error("--allow-host requires a value");
			allowedHosts.push(next.trim().toLowerCase());
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	if (!Number.isInteger(port) || port < 0 || port > 65535) port = DEFAULT_HUB_PORT;
	return { port, host, quiet, allowedHosts };
}

export class HubCliHelp extends Error {
	constructor() {
		super("help requested");
	}
}

export const HUB_USAGE = `pi-webui-hub — fixed-port router for pi-webui sessions

Usage:
  pi-webui-hub [--port <port>] [--host <host>] [--allow-host <hostname>] [--quiet]

Environment:
  PI_WEBUI_PORT            listen port (default ${DEFAULT_HUB_PORT})
  PI_WEBUI_HOST            bind address (default 127.0.0.1)
  PI_WEBUI_ALLOWED_HOSTS   comma-separated extra Host header names, for a tunnel or reverse proxy
  PI_WEBUI_HUB_QUIET=1     reduce logging

The hub only routes requests to registered Pi sessions. It never starts, reads, or writes a Pi
session, so running it alongside terminal Pi processes cannot conflict with them.
`;

export function generateSessionToken(): string {
	return randomBytes(24).toString("hex");
}

export async function runHubCli(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
	let options: HubCliOptions;
	try {
		options = parseHubArgs(argv, env);
	} catch (error) {
		if (error instanceof HubCliHelp) {
			process.stdout.write(HUB_USAGE);
			return 0;
		}
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HUB_USAGE}`);
		return 2;
	}

	const logger = createLogger(options.quiet);
	const hub = await startHub({
		port: options.port,
		host: options.host,
		allowedHosts: options.allowedHosts,
		logger,
		keepAlive: true,
	});
	logger.info(`${HUB_NAME} listening on ${hub.url}`);

	let closing = false;
	const shutdown = async (signal: string) => {
		if (closing) return;
		closing = true;
		logger.info(`received ${signal}; shutting down`);
		await hub.close();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));

	// The listening server keeps the process alive; signals exit through shutdown().
	return 0;
}

const invokedDirectly =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
	runHubCli(process.argv.slice(2))
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error: unknown) => {
			process.stderr.write(`pi-webui-hub failed: ${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		});
}
