import assert from "node:assert/strict";
import http from "node:http";
import { test } from "vitest";
import { ConversationProjection } from "../src/conversation.js";
import { type Hub, startHub } from "../src/hub.js";
import { HubClient } from "../src/hub-client.js";
import { SESSION_PATH_PREFIX, sessionBasePath } from "../src/hub-protocol.js";
import { type WebSendRequest, WebUIServer } from "../src/server.js";

interface Sidecar {
	sessionId: string;
	server: WebUIServer;
	client: HubClient;
	sends: WebSendRequest[];
	connect(): Promise<void>;
	stop(): Promise<void>;
}

async function createSidecar(hubUrl: string, sessionId: string, projectName = "demo"): Promise<Sidecar> {
	const conversation = new ConversationProjection({ id: sessionId, cwd: `/workspace/${projectName}`, projectName });
	const sends: WebSendRequest[] = [];
	const server = await WebUIServer.start({
		conversation,
		send: async (request) => {
			sends.push(request);
			return { delivery: request.delivery === "steer" ? "steer" : "immediate" };
		},
	});
	const client = new HubClient({
		hubUrl,
		metadata: () => ({
			sessionId,
			port: server.port,
			projectName,
			cwd: `/workspace/${projectName}`,
			activity: "idle",
			model: "demo/model",
		}),
		token: "b".repeat(40),
		heartbeatIntervalMs: 40,
		timeoutMs: 1_500,
	});
	return {
		sessionId,
		server,
		client,
		sends,
		async connect() {
			await client.start();
			assert.equal(client.statusSnapshot().state, "registered", `sidecar ${sessionId} failed to register`);
			assert.equal(client.statusSnapshot().hubUrl, hubUrl);
		},
		async stop() {
			await client.stop();
			await server.close();
		},
	};
}

async function readSseUntil(response: Response, marker: string): Promise<string> {
	const reader = response.body?.getReader();
	assert.ok(reader, "expected a streaming response body");
	const decoder = new TextDecoder();
	let text = "";
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) break;
		text += decoder.decode(chunk.value, { stream: true });
		if (text.includes(marker)) break;
	}
	await reader.cancel().catch(() => undefined);
	return text;
}


/** Raw Host-header probe: node:http lets a test control the Host that fetch would override. */
function requestStatus(port: number, host: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const request = http.request({ host: "127.0.0.1", port, path: "/", method: "GET", headers: { host } }, (response) => {
			response.resume();
			response.once("end", () => resolve(response.statusCode ?? 0));
		});
		request.once("error", reject);
		request.end();
	});
}

async function waitFor(predicate: () => Promise<boolean> | boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`condition was not met: ${message}`);
}

test("hub lists sessions and proxies each one under its own path prefix", async () => {
	const hub = await startHub({ port: 0 });
	const hubUrl = `http://127.0.0.1:${hub.port}/`;
	const first = await createSidecar(hubUrl, "session-alpha", "alpha");
	const second = await createSidecar(hubUrl, "session-beta", "beta");
	try {
		await first.connect();
		await second.connect();

		const index = await fetch(hubUrl);
		const indexHtml = await index.text();
		assert.equal(index.status, 200);
		assert.match(indexHtml, /session-alpha/);
		assert.match(indexHtml, /session-beta/);
		assert.match(indexHtml, new RegExp(`${SESSION_PATH_PREFIX}session-alpha/`));

		// The session page keeps its own nonce but is served under the hub's base path so that the
		// browser resolves relative asset and API URLs back through this prefix.
		const page = await fetch(`${hubUrl}${sessionBasePath("session-alpha").slice(1)}`);
		const pageHtml = await page.text();
		assert.equal(page.status, 200);
		assert.match(pageHtml, /<base href="\/s\/session-alpha\/" \/>/);
		assert.doesNotMatch(pageHtml, /__PI_CSP_NONCE__/);
		assert.doesNotMatch(pageHtml, /__PI_BASE_HREF__/);

		const script = await fetch(new URL(`${sessionBasePath("session-alpha")}app.js`, hubUrl));
		assert.equal(script.status, 200);
		assert.match(script.headers.get("content-type") ?? "", /javascript/);
		await script.body?.cancel();

		// Mutations arrive with the browser's hub origin; the hub restates it as the session origin
		// so the session keeps its strict same-origin check.
		const lease = await fetch(new URL(`${sessionBasePath("session-alpha")}api/lease`, hubUrl), {
			method: "POST",
			headers: { "content-type": "application/json", origin: hubUrl.slice(0, -1), "x-pi-web-client": "tab-1" },
			body: JSON.stringify({ clientId: "tab-1" }),
		});
		assert.equal(lease.status, 200);
		await lease.body?.cancel();

		const draft = await fetch(new URL(`${sessionBasePath("session-alpha")}api/draft`, hubUrl), {
			method: "POST",
			headers: { "content-type": "application/json", origin: hubUrl.slice(0, -1), "x-pi-web-client": "tab-1" },
			body: JSON.stringify({ requestId: "draft-1", revision: 0, text: "hello from the browser" }),
		});
		assert.equal(draft.status, 200);
		await draft.body?.cancel();

		const sent = await fetch(new URL(`${sessionBasePath("session-alpha")}api/messages`, hubUrl), {
			method: "POST",
			headers: { "content-type": "application/json", origin: hubUrl.slice(0, -1), "x-pi-web-client": "tab-1" },
			body: JSON.stringify({ requestId: "request-1", draftRevision: 1, delivery: "next" }),
		});
		assert.equal(sent.status, 202);
		await sent.body?.cancel();
		assert.equal(first.sends.length, 1);
		assert.equal(first.sends[0]?.text, "hello from the browser");
		// Routing must never leak a session's traffic to another session.
		assert.equal(second.sends.length, 0);

		// A cross-origin mutation is still refused by the owning session.
		const hostile = await fetch(new URL(`${sessionBasePath("session-alpha")}api/lease`, hubUrl), {
			method: "POST",
			headers: { "content-type": "application/json", origin: "http://attacker.invalid", "x-pi-web-client": "tab-1" },
			body: JSON.stringify({ clientId: "tab-1" }),
		});
		assert.equal(hostile.status, 403);
		await hostile.body?.cancel();
	} finally {
		await Promise.all([first.stop(), second.stop()]);
		await hub.close();
	}
});

test("hub streams server-sent events through the proxy", async () => {
	const hub = await startHub({ port: 0 });
	const hubUrl = `http://127.0.0.1:${hub.port}/`;
	const sidecar = await createSidecar(hubUrl, "session-events");
	try {
		await sidecar.connect();
		const response = await fetch(new URL(`${sessionBasePath("session-events")}api/events?since=0`, hubUrl));
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
		const text = await readSseUntil(response, "event: lease");
		assert.match(text, /event: lease/);
	} finally {
		await sidecar.stop();
		await hub.close();
	}
});

test("unknown, unregistered, and expired sessions answer with a readable page", async () => {
	const hub = await startHub({ port: 0, ttlMs: 120, graceMs: 0 });
	const hubUrl = `http://127.0.0.1:${hub.port}/`;
	const sidecar = await createSidecar(hubUrl, "session-expiring");
	try {
		const missing = await fetch(`${hubUrl}s/nobody-here/`);
		assert.equal(missing.status, 404);
		assert.match(await missing.text(), /not connected/);

		await sidecar.connect();
		await sidecar.client.stop();
		await waitFor(() => hub.sessions().length === 0, "the hub should drop the unregistered session");
		const gone = await fetch(`${hubUrl}${sessionBasePath("session-expiring").slice(1)}`);
		assert.equal(gone.status, 404);
	} finally {
		await sidecar.server.close();
		await hub.close();
	}
});

test("a restarted hub is repopulated by heartbeats without touching Pi sessions", async () => {
	const first = await startHub({ port: 0 });
	const port = first.port;
	const hubUrl = `http://127.0.0.1:${port}/`;
	const sidecar = await createSidecar(hubUrl, "session-restart");
	try {
		await sidecar.connect();
		await first.close();

		const replacement = await startHub({ port });
		try {
			await waitFor(async () => {
				const response = await fetch(new URL(`${sessionBasePath("session-restart")}api/state`, hubUrl)).catch(
					() => undefined,
				);
				if (!response) return false;
				const ok = response.status === 200;
				await response.body?.cancel();
				return ok;
			}, "the session should re-register with the replacement hub");
			assert.equal(replacement.sessions().length, 1);
		} finally {
			await replacement.close();
		}
	} finally {
		await sidecar.stop();
	}
});

test("hub host validation and control-plane content types stay strict", async () => {
	const hub = await startHub({ port: 0, allowedHosts: ["127.0.0.1", "localhost", "pi.example.com"] });
	const hubUrl = `http://127.0.0.1:${hub.port}/`;
	try {
		// `fetch` treats Host as a forbidden header, so drive these two probes with node:http.
		assert.equal(await requestStatus(hub.port, "attacker.invalid"), 421);
		assert.equal(await requestStatus(hub.port, `pi.example.com:${hub.port}`), 200);

		const wrongType = await fetch(`${hubUrl}_hub/register`, {
			method: "POST",
			headers: { "content-type": "text/plain" },
			body: "{}",
		});
		assert.equal(wrongType.status, 415);
		await wrongType.body?.cancel();

		const invalid = await fetch(`${hubUrl}_hub/register`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionId: "bad id", port: 70000, token: "nope" }),
		});
		assert.equal(invalid.status, 400);
		await invalid.body?.cancel();

		const hello: unknown = await (await fetch(`${hubUrl}_hub/hello`)).json();
		assert.deepEqual(hello, { name: "pi-webui-hub", protocol: 1, port: hub.port, sessionCount: 0 });

		// Reads are GETs; mutations stay POST-only with a JSON content type.
		const sessionsRead = await fetch(`${hubUrl}_hub/sessions`);
		assert.equal(sessionsRead.status, 200);
		assert.deepEqual(await sessionsRead.json(), { sessions: [] });
		const mutatingRead = await fetch(`${hubUrl}_hub/register`);
		assert.equal(mutatingRead.status, 404);
		await mutatingRead.body?.cancel();
	} finally {
		await hub.close();
	}
});

test("hub sessions stay routable during the grace period after a missed heartbeat", async () => {
	const hub: Hub = await startHub({ port: 0, ttlMs: 60, graceMs: 5_000 });
	const hubUrl = `http://127.0.0.1:${hub.port}/`;
	const conversation = new ConversationProjection({ id: "session-stale", cwd: "/workspace/demo", projectName: "demo" });
	const server = await WebUIServer.start({ conversation, send: async () => ({ delivery: "immediate" }) });
	try {
		// Register without a heartbeat loop: the hub must keep routing to a session that went quiet
		// until the grace period is over.
		const registered = await fetch(`${hubUrl}_hub/register`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ sessionId: "session-stale", port: server.port, token: "d".repeat(40), projectName: "demo" }),
		});
		assert.equal(registered.status, 200);
		await registered.body?.cancel();

		await new Promise((resolve) => setTimeout(resolve, 150));
		const summary = hub.sessions()[0];
		assert.equal(summary?.stale, true, "a session past its TTL should be marked stale");
		const stillRoutable = await fetch(new URL(`${sessionBasePath("session-stale")}api/state`, hubUrl));
		assert.equal(stillRoutable.status, 200);
		await stillRoutable.body?.cancel();
	} finally {
		await server.close();
		await hub.close();
	}
});

test("the session index page streams updates instead of reloading", async () => {
	const hub = await startHub({ port: 0 });
	const hubUrl = `http://127.0.0.1:${hub.port}/`;
	const sidecar = await createSidecar(hubUrl, "session-streamed");
	try {
		const page = await fetch(hubUrl);
		const html = await page.text();
		assert.doesNotMatch(html, /http-equiv="refresh"/, "the index must not reload itself");
		assert.match(html, /new EventSource\("\/_hub\/events"\)/);
		assert.match(html, /<script nonce="[A-Za-z0-9_-]+">/);
		assert.match(html, /<ul class="sessions" id="sessions">/);
		const nonce = /<script nonce="([A-Za-z0-9_-]+)">/.exec(html)?.[1];
		assert.ok(nonce);
		const policy = page.headers.get("content-security-policy") ?? "";
		assert.match(policy, /default-src 'none'/);
		assert.match(policy, new RegExp(`style-src 'nonce-${nonce}'`));
		assert.match(policy, new RegExp(`script-src 'nonce-${nonce}'`));

		const events = await fetch(`${hubUrl}_hub/events`);
		assert.equal(events.status, 200);
		assert.match(events.headers.get("content-type") ?? "", /text\/event-stream/);
		const reader = events.body?.getReader();
		assert.ok(reader);
		const decoder = new TextDecoder();
		let text = decoder.decode((await reader.read()).value);
		assert.match(text, /event: sessions/);

		// Registering a session must push a new snapshot to the open stream.
		await sidecar.client.start();
		const pushed = await (async () => {
			for (let attempt = 0; attempt < 50; attempt += 1) {
				const chunk = await reader.read();
				if (chunk.done) break;
				text += decoder.decode(chunk.value, { stream: true });
				if (text.includes("session-streamed")) return text;
			}
			return text;
		})();
		assert.match(pushed, /session-streamed/);
		await reader.cancel().catch(() => undefined);
	} finally {
		await sidecar.stop();
		await hub.close();
	}
});
