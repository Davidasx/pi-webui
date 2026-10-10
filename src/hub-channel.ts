/**
 * Extension side of the hub channel.
 *
 * The hub owns the browser-facing web surface and reaches a Pi session through one WebSocket on
 * its own port: the extension dials out, announces itself, and then serves the requests the hub
 * routes to it. Nothing else listens, so N sessions cost N connections instead of N servers, and a
 * hub restart cannot strand a session on a stale port — the socket closes, and the next retry lands
 * on whatever the configuration file now says.
 *
 * The channel only carries what the browser asked for; the session stays inside the Pi process.
 */

import {
	type ChannelStatus,
	channelUrl,
	type ExtensionToHubMessage,
	HUB_PROTOCOL,
	type HubSessionInfo,
	type HubToExtensionMessage,
	hubBaseUrl,
	hubSessionUrl,
} from "./hub-protocol.js";
import type { WebServerRequest, WebServerResponse } from "./server.js";

/** One WebSocket, whatever implements it: Node's built-in client, or a test double. */
export interface ChannelSocket {
	readyState: number;
	bufferedAmount?: number;
	binaryType?: string;
	send(data: string | Uint8Array): void;
	close(code?: number, reason?: string): void;
	addEventListener?(type: string, listener: (event: unknown) => void): void;
	removeEventListener?(type: string, listener: (event: unknown) => void): void;
	on?(type: string, listener: (event: unknown) => void): void;
	off?(type: string, listener: (event: unknown) => void): void;
}

export type ChannelSocketFactory = (url: string) => ChannelSocket;

export interface HubChannelOptions {
	/** Session metadata announced on connect and refreshed with `setSession`. */
	session: () => HubSessionInfo;
	/** Serves a browser request the hub routed here (the session's own web API). */
	serve: (request: WebServerRequest, response: WebServerResponse) => Promise<void>;
	hubUrl?: string;
	env?: NodeJS.ProcessEnv;
	protocol?: number;
	createSocket?: ChannelSocketFactory;
	onChange?: (status: ChannelStatus) => void;
	/** Backoff bounds for reconnects; tests tighten them. */
	minRetryMs?: number;
	maxRetryMs?: number;
	/** How long a silent channel is trusted before it is torn down and redialed. */
	silenceMs?: number;
	pingIntervalMs?: number;
}

const OPEN = 1;
const DEFAULT_MIN_RETRY_MS = 500;
const DEFAULT_MAX_RETRY_MS = 8_000;
const DEFAULT_SILENCE_MS = 45_000;
const DEFAULT_PING_INTERVAL_MS = 15_000;
const _MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const _DRAIN_TIMEOUT_MS = 10_000;
const _DRAIN_POLL_MS = 10;

interface PendingRequest {
	close: () => void;
	onClose: (listener: () => void) => void;
}

export class HubChannel {
	private readonly options: HubChannelOptions;
	private readonly env: NodeJS.ProcessEnv;
	private readonly protocol: number;
	private readonly createSocket: ChannelSocketFactory;
	private readonly minRetryMs: number;
	private readonly maxRetryMs: number;
	private readonly silenceMs: number;
	private readonly pingIntervalMs: number;
	private readonly pending = new Map<number, PendingRequest>();
	private nextRequestId = 0;
	private socket?: ChannelSocket;
	private retryTimer?: ReturnType<typeof setTimeout>;
	private pingTimer?: ReturnType<typeof setInterval>;
	private socketListeners: Array<() => void> = [];
	private attempts = 0;
	private closed = false;
	private announced?: HubSessionInfo;
	private lastMessageAt = 0;
	private status: ChannelStatus;

	constructor(options: HubChannelOptions) {
		this.options = options;
		this.env = options.env ?? process.env;
		this.protocol = options.protocol ?? HUB_PROTOCOL;
		this.createSocket = options.createSocket ?? defaultSocketFactory;
		this.minRetryMs = options.minRetryMs ?? DEFAULT_MIN_RETRY_MS;
		this.maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
		this.silenceMs = options.silenceMs ?? DEFAULT_SILENCE_MS;
		this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
		this.status = this.baseStatus("closed");
	}

	statusSnapshot(): ChannelStatus {
		return { ...this.status };
	}

	/** The URL a browser uses for this session, once the hub has accepted it. */
	sessionUrl(): string | undefined {
		if (this.status.state !== "connected") return undefined;
		const sessionId = this.announced?.sessionId ?? this.options.session().sessionId;
		return hubSessionUrl(this.status.hubUrl, sessionId);
	}

	channelUrl(): string {
		return channelUrl(this.status.hubUrl);
	}

	/** Dial the hub and keep the channel alive until `stop()`. */
	start(): ChannelStatus {
		if (this.closed) return this.statusSnapshot();
		if (!this.socket) this.dial();
		return this.statusSnapshot();
	}

	/** Force a fresh connection (used by `/webui open` and `/webui status`). */
	reconnect(): ChannelStatus {
		if (this.closed) return this.statusSnapshot();
		this.dropSocket("reconnect requested");
		this.dial();
		return this.statusSnapshot();
	}

	/** Publish session metadata changes to the hub. */
	setSession(session: HubSessionInfo): void {
		this.announced = session;
		if (this.status.state === "connected") {
			this.send({ t: "state", session });
			return;
		}
		this.start();
	}

	stop(): void {
		this.closed = true;
		for (const release of this.pending.values()) release.close();
		this.pending.clear();
		this.dropSocket("channel closed");
		this.update(this.baseStatus("closed"));
	}

	private baseStatus(state: ChannelStatus["state"]): ChannelStatus {
		const hubUrl = this.options.hubUrl ?? hubBaseUrl({ env: this.env });
		return {
			state,
			hubUrl,
			channelUrl: channelUrl(hubUrl),
			protocol: this.protocol,
		};
	}

	private dial(): void {
		const hubUrl = this.options.hubUrl ?? hubBaseUrl({ env: this.env });
		if (hubUrl !== this.status.hubUrl) {
			this.status = { ...this.status, hubUrl, channelUrl: channelUrl(hubUrl) };
		}
		const url = channelUrl(hubUrl);
		this.update({ ...this.status, state: this.attempts === 0 ? "connecting" : "waiting" });
		let socket: ChannelSocket;
		try {
			socket = this.createSocket(url);
		} catch (error) {
			this.fail(error);
			return;
		}
		this.socket = socket;
		if ("binaryType" in socket) socket.binaryType = "arraybuffer";
		this.listen(socket, "open", () => {
			if (this.socket !== socket) return;
			this.lastMessageAt = Date.now();
			this.attempts = 0;
			this.update({ ...this.status, state: "connected", connectedAt: this.lastMessageAt, error: undefined });
			const session = this.options.session();
			this.announced = session;
			this.send({ t: "hello", protocol: this.protocol, session });
			this.startPing();
		});
		this.listen(socket, "message", (event) => {
			if (this.socket !== socket) return;
			this.lastMessageAt = Date.now();
			this.receive(event);
		});
		this.listen(socket, "close", () => {
			if (this.socket !== socket) return;
			this.fail(new Error("the hub closed the channel"));
		});
		this.listen(socket, "error", () => {
			if (this.socket !== socket) return;
			this.fail(new Error(`cannot reach the hub at ${url}`));
		});
	}

	private listen(socket: ChannelSocket, type: string, listener: (event: unknown) => void): void {
		if (socket.addEventListener) {
			socket.addEventListener(type, listener);
			this.socketListeners.push(() => socket.removeEventListener?.(type, listener));
			return;
		}
		socket.on?.(type, listener);
		this.socketListeners.push(() => socket.off?.(type, listener));
	}

	private startPing(): void {
		this.stopPing();
		this.pingTimer = setInterval(() => {
			if (Date.now() - this.lastMessageAt > this.silenceMs) {
				this.dropSocket("the hub stopped answering");
				return;
			}
			this.send({ t: "ping", id: ++this.nextRequestId });
		}, this.pingIntervalMs);
		this.pingTimer.unref?.();
	}

	private stopPing(): void {
		if (!this.pingTimer) return;
		clearInterval(this.pingTimer);
		this.pingTimer = undefined;
	}

	private fail(error: unknown): void {
		const wasConnected = this.status.state === "connected";
		this.dropSocket(describeError(error));
		if (this.closed) return;
		this.update({
			...this.status,
			state: "waiting",
			connectedAt: undefined,
			...(wasConnected ? {} : { error: describeError(error) }),
		});
		this.scheduleRetry();
	}

	private scheduleRetry(): void {
		if (this.closed || this.retryTimer) return;
		const delay = Math.min(this.minRetryMs * 2 ** Math.min(this.attempts, 5), this.maxRetryMs);
		const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(delay / 4)));
		this.attempts += 1;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined;
			if (!this.closed) this.dial();
		}, delay + jitter);
		this.retryTimer.unref?.();
	}

	private dropSocket(reason: string): void {
		this.stopPing();
		for (const release of this.socketListeners) release();
		this.socketListeners = [];
		const socket = this.socket;
		this.socket = undefined;
		if (socket) {
			try {
				socket.close(1000, reason.slice(0, 120));
			} catch {
				// A socket that is already gone needs no goodbye.
			}
		}
		for (const [, request] of this.pending) request.close();
		this.pending.clear();
	}

	private send(message: ExtensionToHubMessage): void {
		const socket = this.socket;
		if (!socket || socket.readyState !== OPEN) return;
		try {
			socket.send(JSON.stringify(message));
		} catch {
			// A failed write is followed by a close event, which drives the retry.
		}
	}

	private sendBytes(bytes: Uint8Array): void {
		const socket = this.socket;
		if (!socket || socket.readyState !== OPEN) return;
		try {
			socket.send(bytes);
		} catch {
			// As above: the transport reports its own failure.
		}
	}

	private receive(event: unknown): void {
		const data = (event as { data?: unknown }).data;
		if (typeof data === "string") {
			this.receiveControl(data);
			return;
		}
		const bytes = toBytes(data);
		if (!bytes) return;
		this.pendingBodies.shift()?.(bytes);
	}

	/** Consumers for the binary frames that follow, in order (several requests can be in flight). */
	private readonly pendingBodies: Array<(bytes: Uint8Array) => void> = [];

	private receiveControl(raw: string): void {
		let message: HubToExtensionMessage;
		try {
			message = JSON.parse(raw) as HubToExtensionMessage;
		} catch {
			return;
		}
		if (!message || typeof message !== "object") return;
		switch (message.t) {
			case "cancel": {
				const request = this.pending.get(message.id);
				request?.close();
				return;
			}
			case "error":
				this.update({ ...this.status, error: message.message });
				return;
			case "hello-ok":
			case "pong":
				return;
			case "request":
				this.acceptRequest(message);
				return;
			default:
				return;
		}
	}

	private acceptRequest(message: Extract<HubToExtensionMessage, { t: "request" }>): void {
		const listeners = new Set<() => void>();
		let finished = false;
		const finish = () => {
			if (finished) return;
			finished = true;
			listeners.clear();
			this.pending.delete(message.id);
		};
		const request: PendingRequest = {
			close: () => {
				for (const listener of [...listeners]) listener();
				finish();
			},
			onClose: (listener) => {
				if (finished) listener();
				else listeners.add(listener);
			},
		};
		this.pending.set(message.id, request);

		let body: Uint8Array | undefined;
		let bodyResolve: ((bytes: Uint8Array) => void) | undefined;
		const bodyReady = new Promise<Uint8Array>((resolve) => {
			bodyResolve = resolve;
		});
		if (message.hasBody) this.pendingBodies.push((bytes) => bodyResolve?.(bytes));
		else bodyResolve?.(new Uint8Array(0));

		const response = this.createResponse(message.id, request);
		const incoming: WebServerRequest = {
			method: message.method,
			url: message.path,
			headers: message.headers,
			socket: { destroySoon: () => response.end() },
			once: (event, listener) => {
				if (event === "close") request.onClose(listener);
			},
			off: (event, listener) => {
				if (event !== "close") return;
				listeners.delete(listener);
			},
			async *[Symbol.asyncIterator]() {
				body = await bodyReady;
				if (body.byteLength > 0) yield body;
			},
		};

		void (async () => {
			try {
				await this.options.serve(incoming, response);
			} catch {
				// The handler reports its own failures through the response.
			} finally {
				// The handler owns the response: a streaming endpoint returns while its response stays
				// open, so nothing is ended here. Every other path ends the response itself.
				finish();
			}
		})();
	}

	private createResponse(id: number, request: PendingRequest): WebServerResponse {
		const headers: Record<string, string> = {};
		const listeners = new Set<() => void>();
		let status = 200;
		let headSent = false;
		let ended = false;
		let destroyed = false;

		const notify = () => {
			for (const listener of [...listeners]) listener();
		};
		const sendBody = (bytes: Uint8Array) => {
			this.send({ t: "chunk", id });
			this.sendBytes(bytes);
		};
		const ensureHead = (bodyBytes?: Uint8Array) => {
			if (headSent) return;
			headSent = true;
			this.send({
				t: "response",
				id,
				status,
				headers,
				...(bodyBytes && bodyBytes.byteLength > 0 ? { hasBody: true } : {}),
			});
			if (bodyBytes && bodyBytes.byteLength > 0) this.sendBytes(bodyBytes);
		};
		const finish = () => {
			if (ended) return;
			ended = true;
			this.send({ t: "end", id });
			notify();
			request.close();
		};

		const response: WebServerResponse = {
			get headersSent() {
				return headSent;
			},
			get destroyed() {
				return destroyed;
			},
			get writableEnded() {
				return ended;
			},
			get writableFinished() {
				return ended;
			},
			setHeader: (name, value) => {
				headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
			},
			getHeader: (name) => headers[name.toLowerCase()],
			writeHead: (next, extra) => {
				status = next;
				if (extra) {
					for (const [name, value] of Object.entries(extra)) {
						headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
					}
				}
				return response;
			},
			flushHeaders: () => ensureHead(),
			write: (chunk) => {
				if (ended || destroyed) return false;
				const bytes = toBytes(chunk);
				if (!bytes) return true;
				ensureHead();
				sendBody(bytes);
				return true;
			},
			end: (chunk, callback) => {
				const body = typeof chunk === "function" ? undefined : chunk;
				const done = typeof chunk === "function" ? chunk : callback;
				if (ended) {
					done?.();
					return;
				}
				const bytes = body === undefined ? undefined : toBytes(body);
				ensureHead(bytes && bytes.byteLength > 0 ? bytes : undefined);
				finish();
				done?.();
			},
			destroy: () => {
				destroyed = true;
				finish();
			},
			once: (_event, listener) => {
				if (ended) listener();
				else listeners.add(listener);
			},
			off: (_event, listener) => {
				listeners.delete(listener);
			},
		};
		return response;
	}

	private update(next: ChannelStatus): void {
		this.status = next;
		try {
			this.options.onChange?.(this.statusSnapshot());
		} catch {
			// Status observers must never break the channel.
		}
	}
}


function defaultSocketFactory(url: string): ChannelSocket {
	const WebSocketImpl = (globalThis as { WebSocket?: new (url: string) => ChannelSocket }).WebSocket;
	if (!WebSocketImpl) throw new Error("this Node runtime has no WebSocket client");
	return new WebSocketImpl(url);
}

function toBytes(value: unknown): Uint8Array | undefined {
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	if (typeof value === "string") return new TextEncoder().encode(value);
	if (value && typeof value === "object" && "data" in value) {
		return toBytes((value as { data: unknown }).data);
	}
	return undefined;
}

function describeError(error: unknown): string {
	if (error instanceof Error) {
		const cause = (error as { cause?: unknown }).cause;
		if (cause instanceof Error && cause.message) return `${error.message} (${cause.message})`;
		return error.message;
	}
	return String(error);
}

