/**
 * pi-webui hub: the one web server, and a router rather than an agent host.
 *
 * The hub owns the single configured port. It serves the browser UI, and it reaches a Pi session
 * through a WebSocket that the session's extension dials out on the same port: nothing else listens,
 * so ten sessions cost ten connections instead of ten servers. The hub never opens a Pi session,
 * never reads session files, and never constructs an agent runtime, so it cannot compete with a
 * terminal Pi process for session state.
 *
 * Plain Node TypeScript: this file is executed directly by Node's type stripping
 * (`node src/hub.ts`), so the systemd unit needs no build step.
 */

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type RawData, type WebSocket, WebSocketServer } from "ws";

import {
	CHANNEL_PATH,
	CONFIG_FILE_NAME,
	DEFAULT_HUB_PORT,
	EVENTS_PATH,
	type ExtensionToHubMessage,
	HELLO_PATH,
	HUB_NAME,
	HUB_PROTOCOL,
	type HubActivity,
	type HubSessionInfo,
	type HubToExtensionMessage,
	readHubConfig,
	SESSION_API_PREFIX,
	SESSION_PATH_PREFIX,
	SESSIONS_PATH,
	sessionApiTarget,
	sessionBasePath,
} from "./hub-protocol.ts";

export type { HubActivity } from "./hub-protocol.ts";
export { DEFAULT_HUB_PORT, HUB_NAME, HUB_PROTOCOL } from "./hub-protocol.ts";

/** How often open index streams are refreshed, so a silent stream is detectable. */
const SESSION_TICK_MS = 3_000;
/** How long a browser request waits for a session whose channel is reconnecting. */
const CHANNEL_WAIT_MS = 3_000;
/** A channel that stops sending its keep-alive ping for this long is torn down. */
const CHANNEL_SILENCE_MS = 50_000;
/** How long a disconnected session stays listed, so a browser keeps its context across a restart. */
const SESSION_GRACE_MS = 30_000;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * Paths that sit under the same prefixes as a session id but name one of their own routes
 * (`/api/sessions/ui-state`, `/api/agent/running`, …). They must not be read as a session id: doing
 * so sent them to a session that never exists, whose reply was our HTML page where their frontend
 * expected JSON. `test/hub.test.ts` keeps this list equal to the static routes they ship.
 */
const PI_WEB_STATIC_SEGMENTS = new Set(["search", "ui-state", "new", "running"]);
const MAX_TUNNEL_BYTES = 64 * 1024 * 1024;
const MAX_SESSIONS = 128;
/** Headers that describe the hop, not the request: never forwarded to a session. */
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

/** A session as the hub knows it: metadata from the extension plus connection state. */
export interface HubSessionSummary {
	sessionId: string;
	cwd?: string;
	projectName?: string;
	name?: string;
	model?: string;
	activity: HubActivity;
	registeredAt: number;
	lastSeen: number;
	/** True while the extension is not connected, so the index can show it as reconnecting. */
	stale: boolean;
	url: string;
}

interface SessionRecord {
	session: HubSessionInfo;
	registeredAt: number;
	lastSeen: number;
	channel?: ChannelConnection;
	disconnectedAt?: number;
	waiting?: Array<() => void>;
}

/** One extension's WebSocket, with the requests the browser is waiting on. */
interface ChannelConnection {
	sessionId: string;
	socket: WebSocket;
	connectedAt: number;
	lastPingAt: number;
	nextRequestId: number;
	pending: Map<number, PendingRequest>;
}

interface PendingRequest {
	/** Browser response, when a browser is waiting; absent for internal calls. */
	response?: ServerResponse;
	onChunk?: (chunk: Buffer) => void;
	onEnd?: () => void;
	status?: number;
	headers?: Record<string, string>;
	/** Body arriving for a request still being assembled (never used for responses). */
	finish?: (error?: Error) => void;
}

export interface HubLogger {
	info(message: string): void;
	error(message: string): void;
}

export interface HubOptions {
	/** Debug override; the configuration file owns the persistent port. */
	port?: number;
	/** Debug override; the persistent bind address is always loopback. */
	host?: string;
	/**
	 * Environment used to locate the configuration file (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`).
	 * Tests set it; production always reads the real process environment.
	 */
	env?: NodeJS.ProcessEnv;
	logger?: HubLogger;
	/** How long a browser request waits for a reconnecting session before giving up. */
	channelWaitMs?: number;
	/** How long a disconnected session stays listed. */
	graceMs?: number;
	/**
	 * How often every open index stream is refreshed even when nothing changed. This keeps the
	 * browser able to tell "no news" from "the stream died behind a proxy", and keeps intermediaries
	 * that buffer or time out idle streams from going silent.
	 */
	tickMs?: number;
	/** How long a silent channel is tolerated before it is terminated. */
	silenceMs?: number;
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

function createLogger(): HubLogger {
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

function optionalString(source: Record<string, unknown>, key: string, max = 200): string | undefined {
	const value = source[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, max) : undefined;
}

/** Session metadata as a channel announces it. Unknown or malformed fields are dropped. */
function parseSessionInfo(source: Record<string, unknown>): HubSessionInfo | undefined {
	const sessionId = optionalString(source, "sessionId", 80);
	if (!sessionId || !SESSION_ID_PATTERN.test(sessionId)) return undefined;
	const activity = source.activity;
	return {
		sessionId,
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

/**
 * Their paths: `/api/agent/<id>/…`, `/api/sessions/<id>/…`, and the id-less ones the hub answers.
 * Returns the session the request names, or null when the path is not theirs.
 */
function piWebTarget(pathname: string): { sessionId?: string } | null {
	// `/api/session/<id>/…` is the hub's own prefix for a session's API: it is rewritten to the
	// session's path below, so it must not be read as one of their `/api/**` routes here.
	if (pathname.startsWith(SESSION_API_PREFIX)) return null;
	// `sessions/<x>` is a session only when `<x>` looks like one. Their own routes also live under
	// these prefixes — `sessions/ui-state`, `agent/running`, `agent/new` — and treating those as
	// session ids sent them to a session that cannot exist, which answered with our HTML page where
	// their browser expected JSON.
	const agent = /^\/api\/agent\/([^/]+)(?:\/|$)/.exec(pathname);
	const agentId = agent ? decodeURIComponent(agent[1]) : undefined;
	if (agentId && SESSION_ID_PATTERN.test(agentId) && !PI_WEB_STATIC_SEGMENTS.has(agentId)) {
		return { sessionId: agentId };
	}
	const sessions_ = /^\/api\/sessions\/([^/]+)(?:\/|$)/.exec(pathname);
	const sessionSegment = sessions_ ? decodeURIComponent(sessions_[1]) : undefined;
	if (sessionSegment && SESSION_ID_PATTERN.test(sessionSegment) && !PI_WEB_STATIC_SEGMENTS.has(sessionSegment)) {
		return { sessionId: sessionSegment };
	}
	// Every other `/api/**` path is one of the routes a session serves: their frontend asks for
	// files, git, skills, plugins, MCP, models-config and more, and each of those runs inside a
	// session. A path that names a session goes to that session; the rest go to the newest one,
	// which is the session a browser tab is looking at.
	if (pathname.startsWith("/api/")) return {};
	return null;
}

function sessionIdFromPath(pathname: string): { sessionId: string; rest: string } | undefined {
	if (!pathname.startsWith(SESSION_PATH_PREFIX)) return undefined;
	const remainder = pathname.slice(SESSION_PATH_PREFIX.length);
	const slash = remainder.indexOf("/");
	const sessionId = slash === -1 ? remainder : remainder.slice(0, slash);
	if (!SESSION_ID_PATTERN.test(sessionId)) return undefined;
	return { sessionId, rest: slash === -1 ? "/" : remainder.slice(slash) };
}





function sessionGonePage(sessionId: string, nonce: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>pi-webui</title>
<style nonce="${nonce}">body{margin:0;padding:3rem 1.25rem;font:15px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:40rem;margin-inline:auto}
code{font-family:ui-monospace,Menlo,monospace}</style></head>
<body><h1>That Pi session is not connected</h1>
<p>Session <code>${htmlEscape(sessionId.slice(0, 8))}</code> is not connected to this hub right now.
It may have exited, or the hub may have restarted before the session's next reconnect.</p>
<p><a href="/">Show connected sessions</a></p></body></html>
`;
}

/** The session exists but its extension is not answering right now; the page retries on its own. */
function sessionOfflinePage(sessionId: string, label: string | undefined, nonce: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>pi-webui</title>
<style nonce="${nonce}">body{margin:0;padding:3rem 1.25rem;font:15px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:40rem;margin-inline:auto}
code{font-family:ui-monospace,Menlo,monospace}</style></head>
<body><h1>${htmlEscape(label ?? "That Pi session")} is reconnecting</h1>
<p>Session <code>${htmlEscape(sessionId.slice(0, 8))}</code> is listed, but its extension is not
answering at this moment. This page keeps trying; reload in a moment, or watch the index for the
session to come back.</p>
<p><a href="/">Show connected sessions</a></p></body></html>
`;
}

const ASSET_TYPES: Record<string, string> = {
	"app.js": "text/javascript; charset=utf-8",
	"app.css": "text/css; charset=utf-8",
};

const PAGE_SECURITY_HEADERS: Record<string, string> = {
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Cross-Origin-Resource-Policy": "same-origin",
};

/** Header names are case-insensitive in HTTP; mixing spellings produces duplicate headers. */
function lowerCaseHeaders(headers: Record<string, string> | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers ?? {})) result[name.toLowerCase()] = value;
	return result;
}

/** Normalize whatever `ws` hands us (Buffer, ArrayBuffer, or a view) into one Buffer. */
function toBuffer(data: unknown): Buffer {
	if (Buffer.isBuffer(data)) return data;
	if (data instanceof ArrayBuffer) return Buffer.from(data);
	if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	if (Array.isArray(data)) return Buffer.concat((data as Buffer[]).map((chunk) => Buffer.from(chunk)));
	return Buffer.from(String(data), "utf8");
}

export async function startHub(options: HubOptions = {}): Promise<Hub> {
	const config = readHubConfig({ env: options.env });
	const host = options.host ?? "127.0.0.1";
	const graceMs = options.graceMs ?? SESSION_GRACE_MS;
	const channelWaitMs = options.channelWaitMs ?? CHANNEL_WAIT_MS;
	const silenceMs = options.silenceMs ?? CHANNEL_SILENCE_MS;
	const allowedHosts = config.config.allowedHosts;
	const logger = options.logger ?? silentLogger;
	const webRoot = join(fileURLToPath(new URL(".", import.meta.url)), "web");
	const sessions = new Map<string, SessionRecord>();
	/** Open index streams (`/_hub/events`); the landing page subscribes instead of reloading. */
	const eventClients = new Set<ServerResponse>();

	const server: Server = createServer((request, response) => {
		void handle(request, response).catch((error: unknown) => {
			logger.error(`request failed: ${error instanceof Error ? error.message : String(error)}`);
			if (!response.headersSent) sendJson(response, 500, { error: "Hub failure" });
			else response.destroy();
		});
	});
	server.on("clientError", (_error, socket) => socket.destroy());

	// Extensions dial in here. One upgrade, one session, no listening socket in the Pi process.
	const channels = new WebSocketServer({ noServer: true });
	server.on("upgrade", (request, socket, head) => {
		const hostHeader = request.headers.host;
		let path = "/";
		try {
			path = new URL(request.url ?? "/", `http://${hostHeader ?? "127.0.0.1"}`).pathname;
		} catch {
			path = "/";
		}
		if (path !== CHANNEL_PATH || !hostAllowed(hostHeader, allowedHosts)) {
			socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
			socket.destroy();
			return;
		}
		channels.handleUpgrade(request, socket, head, (socket2) => acceptChannel(socket2));
	});

	function summarize(record: SessionRecord): HubSessionSummary {
		const info = record.session;
		return {
			sessionId: info.sessionId,
			...(info.cwd ? { cwd: info.cwd } : {}),
			...(info.projectName ? { projectName: info.projectName } : {}),
			...(info.name ? { name: info.name } : {}),
			...(info.model ? { model: info.model } : {}),
			activity: info.activity ?? "unknown",
			registeredAt: record.registeredAt,
			lastSeen: record.lastSeen,
			stale: record.channel === undefined,
			url: sessionBasePath(info.sessionId),
		};
	}

	function listSessions(): HubSessionSummary[] {
		return [...sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen).map((record) => summarize(record));
	}

	function applySessionInfo(record: SessionRecord, info: HubSessionInfo): void {
		record.session = { ...record.session, ...info };
		record.lastSeen = Date.now();
	}

	/** Resolve a browser request to a session that has a channel, waiting briefly for a reconnect. */
	async function requireChannel(sessionId: string): Promise<ChannelConnection | undefined> {
		const record = sessions.get(sessionId);
		if (!record) return undefined;
		if (record.channel) return record.channel;
		const resumed = await new Promise<ChannelConnection | undefined>((resolve) => {
			const timer = setTimeout(() => resolve(record.channel), channelWaitMs);
			timer.unref?.();
			record.waiting ??= [];
			record.waiting.push(() => {
				clearTimeout(timer);
				resolve(record.channel);
			});
		});
		return resumed;
	}

	async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const hostHeader = request.headers.host;
		if (!hostAllowed(hostHeader, allowedHosts)) {
			sendJson(response, 421, {
				error: `Unexpected Host header. Add the host name to "hub.allowedHosts" in ${config.path} to serve behind a proxy.`,
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

		const nonce = randomBytes(16).toString("base64url");
		if (pathname === "/" || pathname === "/index.html") {
			// The app itself is the front page, as it is on agegr/pi-web's own server: the session
			// list lives in its sidebar, so there is no separate picker page to land on. Without
			// `?session=` the newest connected session is named, and their sidebar switches from
			// there; with it, the page is that session's.
			const selected = url.searchParams.get("session");
			const known = selected && SESSION_ID_PATTERN.test(selected) ? selected : undefined;
			if (known && sessions.has(known)) {
				await sendShell(response);
				return;
			}
			// No session in the URL (or one that is gone): their front page is still the app, and it
			// needs a session to show, so send the browser to the newest connected one. The session
			// list is in the app's own sidebar, which is where a user chooses from here.
			const fallback = known ? undefined : latestSessionId();
			if (fallback) {
				response.writeHead(302, { Location: `/?session=${encodeURIComponent(fallback)}` }).end();
				return;
			}
			// Nothing is connected: the app comes up empty rather than as a dead-end page, and its
			// requests answer 503 the way a missing session should.
			await sendShell(response);
			return;
		}
		if ((method === "GET" || method === "HEAD") && (pathname === "/app.js" || pathname === "/app.css")) {
			await sendAsset(pathname.slice(1), response);
			return;
		}
		if (pathname === "/favicon.ico") {
			response.writeHead(204).end();
			return;
		}

		// agegr/pi-web's frontend speaks these paths; route each one to the session it names.
		const piWeb = piWebTarget(pathname);
		if (piWeb) {
			const target = piWeb.sessionId ?? latestSessionId();
			if (!target) {
				sendJson(response, 503, { error: "No Pi session is connected" });
				return;
			}
			if (!sessions.has(target)) {
				sendHtml(response, 404, sessionGonePage(target, nonce), nonce);
				return;
			}
			await tunnel({ sessionId: target, rest: pathname }, request, response, url.search, method);
			return;
		}

		const apiTarget = sessionApiTarget(pathname);
		if (apiTarget) {
			if (!sessions.has(apiTarget.sessionId)) {
				sendHtml(response, 404, sessionGonePage(apiTarget.sessionId, nonce), nonce);
				return;
			}
			// The session's own API keeps its `/api/...` paths; only the session prefix is the hub's.
			await tunnel(
				{ sessionId: apiTarget.sessionId, rest: `/api${apiTarget.rest}` },
				request,
				response,
				url.search,
				method,
			);
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

		// The page shell and its assets come from the hub: one bundle for every session, and a UI
		// change needs only a hub restart.
		if (target.rest === "/" && (method === "GET" || method === "HEAD")) {
			if (!sessions.has(target.sessionId)) {
				sendHtml(response, 404, sessionGonePage(target.sessionId, nonce), nonce);
				return;
			}
			// The page moved to the root with `?session=`; a printed /s/<id>/ link still lands there.
			response.writeHead(302, { Location: `/?session=${encodeURIComponent(target.sessionId)}` }).end();
			return;
		}
		if (method !== "GET" && method !== "HEAD" && !sessions.has(target.sessionId)) {
			sendHtml(response, 404, sessionGonePage(target.sessionId, nonce), nonce);
			return;
		}
		await tunnel(target, request, response, url.search, method);
	}

	/**
	 * Control plane. Reads are plain GETs so any local tool or browser can inspect the hub; the
	 * extension reaches the hub over its WebSocket, not through these routes.
	 */
	async function handleControl(
		request: IncomingMessage,
		response: ServerResponse,
		pathname: string,
		method: string,
	): Promise<void> {
		if (pathname !== HELLO_PATH && pathname !== SESSIONS_PATH && pathname !== EVENTS_PATH) {
			sendJson(response, 404, { error: "Unknown hub endpoint" });
			return;
		}
		if (method !== "GET" && method !== "HEAD") {
			sendJson(response, 405, { error: "Method not allowed" });
			return;
		}
		if (pathname === HELLO_PATH) {
			sendJson(response, 200, {
				name: HUB_NAME,
				protocol: HUB_PROTOCOL,
				port: serverPort(),
				sessionCount: sessions.size,
				channelPath: CHANNEL_PATH,
			});
			return;
		}
		if (pathname === SESSIONS_PATH) {
			sendJson(response, 200, { sessions: listSessions() });
			return;
		}
		streamSessions(request, response);
	}

	/** Serve the app shell. The session comes from `?session=`, so one shell serves them all. */
	async function sendShell(response: ServerResponse): Promise<void> {
		const template = await readFile(join(webRoot, "index.html"), "utf8");
		const nonce = randomBytes(16).toString("base64url");
		const body = template.replaceAll("__PI_CSP_NONCE__", nonce);
		response.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Content-Length": Buffer.byteLength(body),
			"Cache-Control": "no-store",
			// The page's own components inject inline `<style>` blocks (their panels style
			// themselves that way), and a nonce in `style-src` makes the browser ignore
			// `'unsafe-inline'`, so those blocks were dropped and the panels rendered as bare text.
			// Styles are not executable; the script policy stays nonce-locked.
			"Content-Security-Policy": `default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-${nonce}'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'`,
			...PAGE_SECURITY_HEADERS,
		});
		response.end(body);
	}

	async function sendAsset(name: string, response: ServerResponse): Promise<void> {
		const contentType = ASSET_TYPES[name];
		if (!contentType) {
			sendJson(response, 404, { error: "Unknown asset" });
			return;
		}
		let bytes: Buffer;
		try {
			bytes = await readFile(join(webRoot, name));
		} catch {
			sendJson(response, 404, { error: "Missing asset; run npm run build:web" });
			return;
		}
		response.writeHead(200, {
			"Content-Type": contentType,
			"Content-Length": bytes.byteLength,
			// The bundle is rebuilt on a hub restart; revalidate so a reload always picks it up.
			"Cache-Control": "no-cache",
			...PAGE_SECURITY_HEADERS,
		});
		response.end(bytes);
	}

	/** Forward one browser request to the owning session and stream its answer back. */
	async function tunnel(
		target: { sessionId: string; rest: string },
		request: IncomingMessage,
		response: ServerResponse,
		search: string,
		method: string,
	): Promise<void> {
		const channel = await requireChannel(target.sessionId);
		if (!channel) {
			const freshNonce = randomBytes(16).toString("base64url");
			const record = sessions.get(target.sessionId);
			sendHtml(
				response,
				502,
				record
					? sessionOfflinePage(target.sessionId, record.session.name ?? record.session.projectName, freshNonce)
					: sessionGonePage(target.sessionId, freshNonce),
				freshNonce,
			);
			return;
		}

		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(request.headers)) {
			if (value === undefined) continue;
			const name = key.toLowerCase();
			if (HOP_BY_HOP.has(name) || name === "expect") continue;
			headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
		}
		headers["x-pi-webui-via"] = HUB_NAME;
		// The session trusts the hub's Host and Origin verdict for tunneled requests, so pass along
		// the origin the browser actually used once this hub has checked it against its own Host.
		const origin = request.headers.origin;
		if (typeof origin === "string" && sameOrigin(origin, request.headers.host ?? "")) {
			headers["x-pi-webui-origin"] = origin;
		}

		const body = method === "GET" || method === "HEAD" ? undefined : await readRequestBody(request);
		const id = channel.nextRequestId++;
		const pending: PendingRequest = {
			response,
			status: 200,
			headers: {},
		};
		channel.pending.set(id, pending);

		const release = () => {
			if (!channel.pending.delete(id)) return;
			channel.socket.send(JSON.stringify({ t: "cancel", id } satisfies HubToExtensionMessage));
		};
		response.on("close", () => {
			if (!response.writableEnded) release();
		});

		channel.socket.send(
			JSON.stringify({
				t: "request",
				id,
				method,
				path: `${target.rest}${search}`,
				headers,
				...(body && body.byteLength > 0 ? { hasBody: true } : {}),
			} satisfies HubToExtensionMessage),
		);
		if (body && body.byteLength > 0) channel.socket.send(body);
	}

	async function readRequestBody(request: IncomingMessage): Promise<Buffer | undefined> {
		const chunks: Buffer[] = [];
		let total = 0;
		for await (const chunk of request) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
			total += buffer.byteLength;
			if (total > MAX_TUNNEL_BYTES) throw new Error("request body too large");
			chunks.push(buffer);
		}
		return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
	}

	function acceptChannel(socket: WebSocket): void {
		let connection: ChannelConnection | undefined;
		let handshaken = false;
		/**
		 * Consumers for the binary frames that follow, in order. A control frame that announces a
		 * body pushes one; the next binary frame takes it. Several requests can be in flight at once
		 * (a stream plus a snapshot fetch), so this must be a queue rather than one slot.
		 */
		const bodyQueue: Array<(chunk: Buffer) => void> = [];

		socket.on("message", (data: RawData, isBinary: boolean) => {
			if (isBinary || data instanceof ArrayBuffer || Array.isArray(data)) {
				bodyQueue.shift()?.(toBuffer(data));
				return;
			}
			let message: ExtensionToHubMessage;
			try {
				message = JSON.parse(toBuffer(data).toString("utf8")) as ExtensionToHubMessage;
			} catch {
				return;
			}
			if (!message || typeof message !== "object") return;

			if (message.t === "hello") {
				const info = parseSessionInfo(message.session as unknown as Record<string, unknown>);
				if (!info) {
					socket.send(JSON.stringify({ t: "error", message: "Invalid session announcement" } satisfies HubToExtensionMessage));
					socket.close(1008, "invalid session");
					return;
				}
				if (message.protocol !== HUB_PROTOCOL) {
					socket.send(
						JSON.stringify({
							t: "error",
							message: `The hub speaks protocol ${HUB_PROTOCOL}; restart the hub or update the extension.`,
						} satisfies HubToExtensionMessage),
					);
					socket.close(1002, "protocol mismatch");
					return;
				}
				const existing = sessions.get(info.sessionId);
				if (!existing && sessions.size >= MAX_SESSIONS) {
					socket.send(JSON.stringify({ t: "error", message: "Too many sessions" } satisfies HubToExtensionMessage));
					socket.close(1013, "too many sessions");
					return;
				}
				// A reconnect replaces the previous channel for the same session.
				if (existing?.channel && existing.channel.socket !== socket) existing.channel.socket.close(1000, "replaced");
				handshaken = true;
				const connection2: ChannelConnection = {
					sessionId: info.sessionId,
					socket,
					connectedAt: Date.now(),
					lastPingAt: Date.now(),
					nextRequestId: 0,
					pending: new Map(),
				};
				connection = connection2;
				const now = Date.now();
				const record: SessionRecord = existing ?? { session: info, registeredAt: now, lastSeen: now };
				record.session = info;
				record.channel = connection2;
				record.lastSeen = now;
				delete record.disconnectedAt;
				sessions.set(info.sessionId, record);
				const waiting = record.waiting ?? [];
				record.waiting = [];
				for (const resume of waiting) resume();
				logger.info(`session ${info.sessionId.slice(0, 8)} connected`);
				socket.send(JSON.stringify({ t: "hello-ok", protocol: HUB_PROTOCOL } satisfies HubToExtensionMessage));
				broadcastSessions();
				return;
			}

			if (!handshaken || !connection) return;
			connection.lastPingAt = Date.now();
			const active = connection;
			const record = sessions.get(active.sessionId);

			switch (message.t) {
				case "ping":
					socket.send(JSON.stringify({ t: "pong", id: message.id } satisfies HubToExtensionMessage));
					return;
				case "state": {
					const info = parseSessionInfo(message.session as unknown as Record<string, unknown>);
					if (info && record && info.sessionId === record.session.sessionId) {
						applySessionInfo(record, info);
						broadcastSessions();
					}
					return;
				}
				case "response": {
					const pending = active.pending.get(message.id);
					if (!pending?.response) return;
					pending.status = message.status;
					pending.headers = lowerCaseHeaders(message.headers);
					if (message.hasBody) {
						bodyQueue.push((chunk) => {
							if (pending.response && !pending.response.headersSent) {
								// One canonical spelling per header: a duplicate Content-Length (or any
								// header repeated with different case) is a protocol error downstream.
								const headers = { ...(pending.headers ?? {}) };
								delete headers["transfer-encoding"];
								headers["content-length"] = String(chunk.byteLength);
								pending.response.writeHead(pending.status ?? 200, headers);
							}
							pending.response?.end(chunk);
							pending.onEnd?.();
							active.pending.delete(message.id);
						});
					} else {
						pending.response.writeHead(pending.status, pending.headers);
						pending.response.flushHeaders();
					}
					return;
				}
				case "chunk": {
					const pending = active.pending.get(message.id);
					if (!pending?.response) return;
					bodyQueue.push((chunk) => {
						pending.response?.write(chunk);
					});
					return;
				}
				case "end": {
					const pending = active.pending.get(message.id);
					if (!pending?.response) return;
					active.pending.delete(message.id);
					if (!pending.response.writableEnded) pending.response.end();
					pending.onEnd?.();
					return;
				}
				case "error":
					logger.error(`session ${active.sessionId.slice(0, 8)}: ${message.message}`);
					return;
				default:
					return;
			}
		});

		socket.on("close", () => {
			if (!connection) return;
			const record = sessions.get(connection.sessionId);
			for (const [, pending] of connection.pending) {
				if (pending.response && !pending.response.headersSent) {
					const nonce = randomBytes(16).toString("base64url");
					sendHtml(pending.response, 502, sessionGonePage(connection.sessionId, nonce), nonce);
				} else pending.response?.end();
			}
			connection.pending.clear();
			if (record && record.channel === connection) {
				record.channel = undefined;
				record.disconnectedAt = Date.now();
				logger.info(`session ${connection.sessionId.slice(0, 8)} disconnected`);
				broadcastSessions();
			}
		});

		socket.on("error", () => socket.close());
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
		// EventSource reconnects quickly after an edge cut (Cloudflare ends idle streams at ~100s).
		response.write(`retry: 2000\nevent: sessions\ndata: ${JSON.stringify(listSessions())}\n\n`);
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

	/** The most recently active session, used by their id-less endpoints (models, list). */
	function latestSessionId(): string | undefined {
		return listSessions()[0]?.sessionId;
	}

	function serverPort(): number {
		const address = server.address();
		return address && typeof address !== "string" ? address.port : 0;
	}

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? config.config.port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});

	// A session that vanished stays listed briefly, so a hub or session restart does not blank a
	// browser tab that is already open on it.
	const sweep = setInterval(() => {
		const now = Date.now();
		for (const [id, record] of sessions) {
			if (!record.channel && record.disconnectedAt && now - record.disconnectedAt > graceMs) {
				sessions.delete(id);
				logger.info(`forgot session ${id.slice(0, 8)} (gone for ${Math.round((now - record.disconnectedAt) / 1000)}s)`);
				broadcastSessions();
			}
		}
	}, 2_000);
	const tick = setInterval(() => broadcastSessions(), options.tickMs ?? SESSION_TICK_MS);
	const silence = setInterval(() => {
		const now = Date.now();
		for (const record of sessions.values()) {
			if (record.channel && now - record.channel.lastPingAt > silenceMs) {
				logger.error(`session ${record.session.sessionId.slice(0, 8)} stopped answering; closing its channel`);
				record.channel.socket.terminate();
			}
		}
	}, 5_000);
	if (!options.keepAlive) {
		sweep.unref();
		tick.unref();
		silence.unref();
		server.unref();
	}

	return {
		port: serverPort(),
		url: `http://127.0.0.1:${serverPort()}/`,
		sessions: listSessions,
		close: async () => {
			clearInterval(sweep);
			clearInterval(tick);
			clearInterval(silence);
			// Terminate every channel, including one that has not announced a session yet, and never
			// wait on a close handshake: a hub restart must not hang, and extensions reconnect anyway.
			for (const client of channels.clients) client.terminate();
			sessions.clear();
			for (const client of eventClients) client.end();
			eventClients.clear();
			const closed = new Promise<void>((resolve) => channels.close(() => resolve()));
			const guard = new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 1_000);
				timer.unref?.();
			});
			await Promise.race([closed, guard]);
			server.closeAllConnections?.();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

export interface HubCliOptions {
	/** Present only when `--port` was passed; otherwise the configuration file decides. */
	port?: number;
	host?: string;
}

/** Debug flags only. Everything persistent lives in the configuration file, never in the environment. */
export function parseHubArgs(argv: readonly string[]): HubCliOptions {
	let port: number | undefined;
	let host: string | undefined;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") throw new HubCliHelp();
		const next = argv[index + 1];
		if (arg === "--port" || arg === "-p") {
			if (!next) throw new Error("--port requires a value");
			const parsed = Number.parseInt(next, 10);
			if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
				throw new Error("--port must be an integer between 1 and 65535");
			}
			port = parsed;
			index += 1;
			continue;
		}
		if (arg === "--host") {
			if (!next) throw new Error("--host requires a value");
			host = next;
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}
	return { ...(port !== undefined ? { port } : {}), ...(host !== undefined ? { host } : {}) };
}

export class HubCliHelp extends Error {
	constructor() {
		super("help requested");
	}
}

export const HUB_USAGE = `pi-webui-hub — fixed-port router for pi-webui sessions

Usage:
  pi-webui-hub [--port <port>] [--host <host>]

The port comes from ${CONFIG_FILE_NAME} in Pi's agent directory (${"$"}PI_CODING_AGENT_DIR, else
~/.pi/agent):

  {
    "hub": {
      "port": ${DEFAULT_HUB_PORT},
      "allowedHosts": ["pi.example.com"]
    }
  }

--port and --host override that file for one debugging run; the extension always reads the file, so
a different --port is only useful together with the direct URL the hub prints. Both the hub and the
extension read the same file: change it and restart the service
(systemctl --user restart pi-webui-hub.service) — no daemon-reload.

The hub only routes requests to registered Pi sessions. It never starts, reads, or writes a Pi
session, so running it alongside terminal Pi processes cannot conflict with them.
`;

export function generateSessionToken(): string {
	return randomBytes(24).toString("hex");
}

export async function runHubCli(argv: readonly string[]): Promise<number> {
	let options: HubCliOptions;
	try {
		options = parseHubArgs(argv);
	} catch (error) {
		if (error instanceof HubCliHelp) {
			process.stdout.write(HUB_USAGE);
			return 0;
		}
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HUB_USAGE}`);
		return 2;
	}

	const logger = createLogger();
	const hub = await startHub({
		...(options.port !== undefined ? { port: options.port } : {}),
		...(options.host !== undefined ? { host: options.host } : {}),
		logger,
		keepAlive: true,
	});
	const config = readHubConfig();
	for (const issue of config.issues) logger.error(issue);
	logger.info(
		`${HUB_NAME} listening on ${hub.url} (config ${config.path}: port ${
			config.portFromFile ? config.config.port : `${DEFAULT_HUB_PORT} by default`
		})`,
	);

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
