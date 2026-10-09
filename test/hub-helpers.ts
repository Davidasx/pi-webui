import {
	HEARTBEAT_PATH,
	HELLO_PATH,
	HUB_NAME,
	HUB_PROTOCOL,
	REGISTER_PATH,
	UNREGISTER_PATH,
} from "../src/hub-protocol.js";

export interface HubFetchStubOptions {
	/** Simulate a hub that is not running (connection refused). */
	reachable?: boolean;
	/** Answer registration with this status instead of 200. */
	rejectRegistration?: number;
	/** Answer the health check with a different service identity. */
	impersonate?: string;
	onRequest?: (path: string, body: Record<string, unknown>) => void;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function requestUrl(input: string | URL | Request): URL {
	if (typeof input === "string") return new URL(input);
	if (input instanceof URL) return input;
	return new URL(input.url);
}

function requestBody(init?: RequestInit): Record<string, unknown> {
	if (typeof init?.body !== "string") return {};
	try {
		const parsed: unknown = JSON.parse(init.body);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Deterministic fetch double for hub talking without a real hub process. */
export function hubFetchStub(options: HubFetchStubOptions = {}): typeof fetch {
	const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = requestUrl(input);
		if (options.reachable === false) {
			throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1") });
		}
		const body = requestBody(init);
		options.onRequest?.(url.pathname, body);
		if (url.pathname === HELLO_PATH) {
			return json({ name: options.impersonate ?? HUB_NAME, protocol: HUB_PROTOCOL, port: 43118, sessionCount: 0 });
		}
		if (url.pathname === REGISTER_PATH || url.pathname === HEARTBEAT_PATH || url.pathname === UNREGISTER_PATH) {
			if (options.rejectRegistration && url.pathname === REGISTER_PATH) {
				return json({ error: "rejected" }, options.rejectRegistration);
			}
			return json({ ok: true, basePath: `/s/${String(body.sessionId ?? "session")}/` });
		}
		return json({ error: "not found" }, 404);
	};
	return impl as typeof fetch;
}

/** Minimal stand-in for the in-session loopback server. */
export function stubServerControl(overrides: Record<string, unknown> = {}) {
	return {
		origin: "http://127.0.0.1:1234",
		port: 1234,
		directUrl: () => "http://127.0.0.1:1234/",
		close: async () => undefined,
		...overrides,
	};
}
