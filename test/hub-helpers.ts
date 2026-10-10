import { type ChannelSocket, HubChannel, type HubChannelOptions } from "../src/hub-channel.js";
import { type ChannelStatus, HUB_PROTOCOL } from "../src/hub-protocol.js";
import type { WebServerRequest, WebServerResponse } from "../src/server.js";

/**
 * Fakes for the two ends of the channel.
 *
 * `stubServerControl` stands in for the session's web service (what the hub drives), and
 * `fakeChannelSocket` is a WebSocket that a test drives by hand, so a channel test never needs a
 * real hub or a real socket.
 */

export function stubServerControl(overrides: Record<string, unknown> = {}) {
	return {
		origin: "http://127.0.0.1:43118",
		serve: async (request: WebServerRequest, response: WebServerResponse) => {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ path: request.url ?? "/" }));
		},
		close: async () => undefined,
		...overrides,
	};
}

export interface FakeChannelSocket extends ChannelSocket {
	/** The URL the client dialed, so a test can assert channel discovery. */
	url: string;
	/** Messages the client sent, in order: parsed JSON or raw bytes. */
	sent: Array<Record<string, unknown> | Uint8Array>;
	/** Deliver a message from the hub. */
	emitMessage(data: string | Uint8Array): void;
	/** Simulate the hub closing the connection. */
	emitClose(): void;
	/** Simulate the hub accepting the connection: the client's "open" listeners run. */
	open(): void;
	closed: boolean;
}

export function fakeChannelSocket(url = "ws://127.0.0.1:43118/_hub/channel"): FakeChannelSocket {
	const listeners = new Map<string, Set<(event: unknown) => void>>();
	const sent: Array<Record<string, unknown> | Uint8Array> = [];
	let readyState = 0;
	const socket: FakeChannelSocket = {
		url,
		sent,
		closed: false,
		readyState,
		bufferedAmount: 0,
		binaryType: "arraybuffer",
		send(data) {
			if (typeof data === "string") sent.push(JSON.parse(data) as Record<string, unknown>);
			else sent.push(data);
		},
		close() {
			socket.closed = true;
			readyState = 3;
			socket.readyState = 3;
			socket.emitClose();
		},
		addEventListener(type, listener) {
			const set = listeners.get(type) ?? new Set();
			set.add(listener);
			listeners.set(type, set);
		},
		removeEventListener(type, listener) {
			listeners.get(type)?.delete(listener);
		},
		emitMessage(data) {
			for (const listener of listeners.get("message") ?? []) listener({ data });
		},
		emitClose() {
			for (const listener of listeners.get("close") ?? []) listener({});
		},
		/** Open the socket and announce the session, as a real hub connection does. */
		open() {
			readyState = 1;
			socket.readyState = 1;
			for (const listener of listeners.get("open") ?? []) listener({});
		},
	};
	return socket;
}

export function channelStatus(overrides: Partial<ChannelStatus> = {}): ChannelStatus {
	return {
		state: "connected",
		hubUrl: "http://127.0.0.1:43118/",
		channelUrl: "ws://127.0.0.1:43118/_hub/channel",
		protocol: 2,
		...overrides,
	};
}

export function channelOptions(overrides: Partial<HubChannelOptions> = {}): HubChannelOptions {
	return {
		session: () => ({ sessionId: "session-alpha", activity: "idle", projectName: "demo" }),
		serve: async () => undefined,
		createSocket: () => fakeChannelSocket(),
		minRetryMs: 1,
		maxRetryMs: 2,
		...overrides,
	};
}

/** A channel that connects the moment it is started, so a test gets a live link deterministically. */
export function stubChannel(overrides: Partial<HubChannelOptions> = {}): HubChannel {
	const socket = fakeChannelSocket();
	const channel = new HubChannel({
		session: () => ({ sessionId: "session-stub", activity: "idle" }),
		serve: async () => undefined,
		minRetryMs: 5,
		maxRetryMs: 10,
		...overrides,
		createSocket: overrides.createSocket ?? (() => socket),
	});
	const connect = () => {
		socket.open();
		socket.emitMessage(JSON.stringify({ t: "hello-ok", protocol: HUB_PROTOCOL }));
	};
	for (const method of ["start", "reconnect"] as const) {
		const original = channel[method].bind(channel);
		channel[method] = () => {
			const status = original();
			connect();
			return status;
		};
	}
	return channel;
}

/** A channel whose socket never opens, standing in for a hub that is not running. */
export function unreachableChannel(overrides: Partial<HubChannelOptions> = {}): HubChannel {
	return new HubChannel({
		session: () => ({ sessionId: "session-stub", activity: "idle" }),
		serve: async () => undefined,
		minRetryMs: 60_000,
		maxRetryMs: 60_000,
		...overrides,
		createSocket: () => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:43118");
		},
	});
}
