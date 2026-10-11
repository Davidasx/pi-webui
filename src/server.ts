import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { HUB_NAME } from "./hub-protocol.js";
import { serveVendoredRoute } from "./vendored-routes.js";

const JSON_LIMIT = 64 * 1024 * 1024;
/** Longest wait for a response to finish flushing before its socket is let go. */
const _RESPONSE_FLUSH_TIMEOUT_MS = 250;
/** Set by the hub on every tunneled request, after it validated Host and Origin itself. */
const HUB_VIA_HEADER = "x-pi-webui-via";
const HUB_ORIGIN_HEADER = "x-pi-webui-origin";

function isHubRequest(request: WebServerRequest): boolean {
	return request.headers[HUB_VIA_HEADER] === HUB_NAME;
}

/**
 * What the session's web API needs from a request, whichever transport delivers it: Node's HTTP
 * server (tests and the optional local listener) or the hub channel's frames.
 */
export interface WebServerRequest {
	method?: string;
	url?: string;
	headers: Record<string, string | string[] | undefined>;
	socket?: { destroySoon?: () => void };
	once(event: string, listener: () => void): unknown;
	off(event: string, listener: () => void): unknown;
	[Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
}

/** The matching response surface. */
export interface WebServerResponse {
	readonly headersSent: boolean;
	readonly destroyed: boolean;
	readonly writableEnded: boolean;
	readonly writableFinished: boolean;
	setHeader(name: string, value: string | string[] | number): void;
	getHeader?(name: string): string | number | string[] | undefined;
	writeHead(status: number, headers?: Record<string, string | string[] | number>): unknown;
	write(chunk: string | Uint8Array): boolean;
	end(chunk?: string | Uint8Array | (() => void), callback?: () => void): void;
	flushHeaders(): void;
	once(event: string, listener: () => void): unknown;
	off(event: string, listener: () => void): unknown;
	destroy?(): void;
}

/** Everything the service needs to know about where the browser sees it. */
export interface WebUIIdentity {
	/** Browser-visible origin, used to validate `Origin` on mutations. */
	origin: string;
	/** Loopback port for the optional local listener; 0 when only the hub serves this session. */
	port?: number;
	/** Local HTTP server backing `port`; only the optional listener passes one. */
	server?: Server;
}

/**
 * agegr/pi-web's frontend contract, answered by this session.
 *
 * Their page is a view over these calls, so serving them is what lets their components run here
 * unchanged instead of being re-drawn.
 */
export interface WebUIPiWebBridge {
	/** Pi's session id, which their `connected` frame echoes back. */
	sessionId(): string;
	/**
	 * Their "generate title": name this session after what it is about. Their own generator writes
	 * an LLM title through Pi's internal `Agent`, which an extension cannot reach, so this names it
	 * from the session's first user message — the name their sidebar would otherwise show anyway.
	 */
	autoName(id: string): Promise<{ title: string; usage?: unknown } | undefined>;
	command(command: Record<string, unknown>): Promise<unknown>;
	state(): Promise<unknown>;
	/** Live agent events, already in their wire shape; returns an unsubscribe function. */
	subscribe(listener: (event: unknown) => void): () => void;
	isRunning(): boolean;
}

/** What the top bar needs from the session: Pi's own controls, not the web layer's. */
export interface WebUISessionControls {
	/** Models this session can switch to. */
	models(): Promise<Array<{ provider: string; id: string; name?: string }>>;
	setModel(provider: string, id: string): Promise<void>;
	setThinkingLevel(level: string): Promise<void>;
	compact(): Promise<void>;
}

export interface WebUIServerOptions {
	/** Their frontend's contract, answered by this session. */
	piWeb?: WebUIPiWebBridge;
	/** Pi's own controls, which the session screen shows when this bridge is absent. */
	controls?: WebUISessionControls;
	maxRequestBytes?: number;
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly closeConnection = false,
	) {
		super(message);
	}
}

export class WebUIServer {
	/** Browser-visible origin: the hub's origin in production, this listener's own in tests. */
	readonly origin: string;
	/** Loopback port of the optional local listener; 0 when only the hub serves this session. */
	readonly port: number;
	private readonly browserOrigin: string;
	private readonly server?: Server;
	private readonly sockets = new Set<Socket>();
	private closed = false;
	private closePromise?: Promise<void>;

	private constructor(
		private readonly options: WebUIServerOptions,
		identity: WebUIIdentity,
	) {
		this.origin = identity.origin;
		this.browserOrigin = identity.origin;
		this.port = identity.port ?? 0;
		this.server = identity.server;
		// Only the optional local listener owns sockets; over the channel there is nothing to track.
		this.server?.on("connection", (socket) => {
			this.sockets.add(socket);
			socket.once("close", () => this.sockets.delete(socket));
		});
		this.server?.unref();
	}

	static async start(options: WebUIServerOptions): Promise<WebUIServer> {
		let instance: WebUIServer | undefined;
		const server = createServer((request, response) => {
			if (!instance) {
				response.writeHead(503).end();
				return;
			}
			void instance.serve(request, response);
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => {
				server.off("error", reject);
				resolve();
			});
		});
		const address = server.address();
		if (!address || typeof address === "string") {
			server.close();
			throw new Error("Pi WebUI server did not receive a TCP port");
		}
		instance = new WebUIServer(options, {
			origin: `http://127.0.0.1:${address.port}`,
			port: address.port,
			server,
		});
		return instance;
	}

	/**
	 * Build the service without a listener: the hub drives it over the channel, so a session owns
	 * no port. `origin` is the browser-visible origin (the hub's), which mutations are checked
	 * against.
	 */
	static create(options: WebUIServerOptions, origin: string): WebUIServer {
		return new WebUIServer(options, { origin });
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closePromise = this.closeNow();
		return this.closePromise;
	}

	private async closeNow(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.server?.closeAllConnections?.();
		for (const socket of this.sockets) socket.destroy();
		if (this.server) await new Promise<void>((resolve) => this.server?.close(() => resolve()));
	}

	/**
	 * Serve one browser request, whichever transport delivered it: Node's HTTP server (tests and the
	 * optional local listener) or the hub channel's frames.
	 */
	async serve(request: WebServerRequest, response: WebServerResponse): Promise<void> {
		this.secureHeaders(response);
		try {
			if (this.closed) throw new HttpError(410, "Pi session ended");
			// The hub validates Host and Origin itself before it tunnels a request here, and says so;
			// a direct caller (the optional local listener) still has to match this browser origin.
			if (!isHubRequest(request) && request.headers.host !== new URL(this.browserOrigin).host) {
				throw new HttpError(421, "Unexpected Host header");
			}
			const url = new URL(request.url ?? "/", this.browserOrigin);
			const payload = this.options.piWeb;
			if (request.method === "GET" && /^\/api\/agent\/[^/]+\/state$/.test(url.pathname)) {
				const state = payload ? await payload.state() : undefined;
				this.json(response, 200, state ? { running: true, state } : { running: false });
				return;
			}
			if (request.method === "POST" && /^\/api\/agent\/[^/]+\/lease$/.test(url.pathname)) {
				// Their lease renews the session's live event streams and reports how many it
				// renewed; a 0 tells their client to reconnect the stream it thought it held. This
				// server holds one stream per open browser tab, so that count is the honest answer.
				this.json(response, 200, { success: true, renewed: this.piWebStreams > 0 ? 1 : 0 });
				return;
			}
			// Their liveness/idle probe: a plain GET on the agent endpoint. It must answer 200 with
			// the live state, because their client treats any other status as "the session is gone"
			// and retries in a loop while the composer waits.
			if (request.method === "GET" && /^\/api\/agent\/[^/]+$/.test(url.pathname)) {
				const state = payload ? await payload.state() : undefined;
				this.json(response, 200, { running: state !== undefined, ...(state ? { state } : {}) });
				return;
			}
			// Their title button. Their own route is copied too, but it reaches for the live
			// `AgentSession` internals; this answers with the name their sidebar itself derives.
			if (request.method === "POST" && /^\/api\/sessions\/[^/]+\/auto-name$/.test(url.pathname)) {
				this.assertMutation(request);
				const named = await payload?.autoName(decodeURIComponent(url.pathname.split("/")[3] ?? ""));
				if (!named) throw new HttpError(404, "Session not found");
				this.json(response, 200, { title: named.title, usage: named.usage ?? null });
				return;
			}
			if (request.method === "GET" && /^\/api\/agent\/[^/]+\/events$/.test(url.pathname)) {
				this.piWebEvents(request, response);
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/agent/new") {
				throw new HttpError(501, "Starting sessions from the browser is not supported here.");
			}
			if (request.method === "POST" && /^\/api\/agent\/[^/]+$/.test(url.pathname)) {
				this.assertMutation(request);
				if (!payload) throw new HttpError(503, "This session is not available");
				const command = await readJson(request, JSON_LIMIT);
				if (!isRecord(command)) throw new HttpError(400, "Invalid command");
				this.json(response, 200, { success: true, data: await payload.command(command) });
				return;
			}
			// files, git, skills, models, MCP, session reads and so on, run against this machine.
			if ((request.method ?? "GET") !== "OPTIONS" && url.pathname.startsWith("/api/")) {
				if (await serveVendoredRoute(request, response, this.origin)) return;
			}
			throw new HttpError(404, "Not found");
		} catch (error) {
			const expectedError = error instanceof HttpError;
			const status = expectedError ? error.status : 500;
			const message = expectedError ? error.message : "Internal server error";
			if (error instanceof HttpError && error.closeConnection)
				response.setHeader("Connection", "close");
			this.json(response, status, { error: message });
			if (error instanceof HttpError && error.closeConnection) request.socket?.destroySoon?.();
		}
	}



	private assertMutation(request: WebServerRequest): void {
		// Behind the hub, the browser's origin is whatever host the operator uses (a tunnel hostname),
		// so accept the origin the hub already checked against its own Host header.
		const origin = request.headers.origin;
		if (origin === undefined && isHubRequest(request)) return;
		const viaHub = isHubRequest(request) ? request.headers[HUB_ORIGIN_HEADER] : undefined;
		const expected = typeof viaHub === "string" ? viaHub : this.browserOrigin;
		if (origin !== expected) throw new HttpError(403, "Unexpected Origin");
	}




	/** Their event stream: `data:` frames of agent events, with comment heartbeats. */
	private piWebStreams = 0;

	private piWebEvents(request: WebServerRequest, response: WebServerResponse): void {
		const payload = this.options.piWeb;
		response.writeHead(200, {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		});
		response.flushHeaders();
		const write = (event: unknown) => {
			const accepted = response.write(`data: ${JSON.stringify(event)}\n\n`);
			if (!accepted) unsubscribe();
		};
		const unsubscribe = payload
			? payload.subscribe((event) => write(event))
			: () => undefined;
		const heartbeat = setInterval(() => {
			if (!response.write(":\n\n")) {
				clearInterval(heartbeat);
				unsubscribe();
			}
		}, 15_000);
		heartbeat.unref?.();
		this.piWebStreams += 1;
		const release = () => {
			this.piWebStreams = Math.max(0, this.piWebStreams - 1);
			clearInterval(heartbeat);
			unsubscribe();
		};
		request.once("close", release);
		response.once("close", release);
		// A comment byte flushes the headers without claiming the agent is ready, exactly as their
		// stream does; the client keeps waiting for the `connected` data frame.
		response.write(":\n\n");
		write({
			type: "connected",
			sessionId: payload?.sessionId() ?? null,
			isStreaming: payload?.isRunning() ?? false,
			pendingExtensionUiIds: [],
		});
	}










	/**
	 * The page shell is served by the hub, so a session response is data only and carries no nonce.
	 */
	private secureHeaders(response: WebServerResponse): void {
		response.setHeader("Cache-Control", "no-store");
		response.setHeader(
			"Content-Security-Policy",
			"default-src 'none'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
		);
		response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("X-Frame-Options", "DENY");
		response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
	}

	private json(response: WebServerResponse, status: number, value: unknown): void {
		if (response.headersSent || response.writableEnded) return;
		const body = JSON.stringify(value);
		response.writeHead(status, {
			"Content-Type": "application/json; charset=utf-8",
			"Content-Length": Buffer.byteLength(body),
		});
		response.end(body);
	}
}





async function readJson(request: WebServerRequest, limit: number): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += bytes.byteLength;
		if (total > limit) throw new HttpError(413, "Request body is too large", true);
		chunks.push(bytes);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} catch {
		throw new HttpError(400, "Invalid JSON body");
	}
}





function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function _isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

