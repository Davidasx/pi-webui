import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { ConversationProjection } from "../src/conversation.js";
import { type Hub, startHub } from "../src/hub.js";
import { HubChannel } from "../src/hub-channel.js";
import {
	configFilePath,
	DEFAULT_ALLOWED_HOSTS,
	DEFAULT_HUB_PORT,
	readHubConfig,
	SESSION_PATH_PREFIX,
	sessionApiPath,
	sessionBasePath,
} from "../src/hub-protocol.js";
import { type WebSendRequest, WebUIServer } from "../src/server.js";

/**
 * A session stands in for a real Pi process: the same web service the extension builds, driven by
 * the same channel client, dialing a real hub over a real WebSocket.
 */
async function createSession(hub: Hub, hubUrl: string, sessionId: string, projectName = "demo") {
	const conversation = new ConversationProjection({
		id: sessionId,
		cwd: `/workspace/${projectName}`,
		projectName,
	});
	const sends: WebSendRequest[] = [];
	const service = typeService(
		WebUIServer.create(
			{
				conversation,
				send: async (request) => {
					sends.push(request);
					return { delivery: request.delivery === "steer" ? "steer" : "immediate" };
				},
			},
			hubUrl.replace(/\/+$/, ""),
		),
	);
	const channel = new HubChannel({
		hubUrl,
		minRetryMs: 20,
		maxRetryMs: 60,
		session: () => ({
			sessionId,
			projectName,
			cwd: `/workspace/${projectName}`,
			activity: "idle",
			model: "demo/model",
		}),
		serve: (request, response) => service.serve(request, response),
	});
	channel.start();
	await waitFor(() => channel.statusSnapshot().state === "connected", `session ${sessionId} connects`);
	// The client is "connected" as soon as the socket opens; the hub knows the session once it has
	// processed the announcement that follows.
	await waitFor(
		() => hub.sessions().some((entry) => entry.sessionId === sessionId),
		`the hub registers ${sessionId}`,
	);
	return {
		sessionId,
		service,
		channel,
		sends,
		async stop() {
			channel.stop();
			await service.close();
		},
	};
}

function typeService(service: WebUIServer) {
	return service;
}

async function _readSseUntil(response: Response, marker: string): Promise<string> {
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
function requestStatus(port: number, host: string, path = "/"): Promise<number> {
	return new Promise((resolve, reject) => {
		const request = http.request(
			{ host: "127.0.0.1", port, path, method: "GET", headers: { host } },
			(response) => {
				response.resume();
				response.once("end", () => resolve(response.statusCode ?? 0));
			},
		);
		request.once("error", reject);
		request.end();
	});
}

/** An ephemeral port that was just released, so the hub can be told to bind a real number. */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const probe = http.createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const address = probe.address();
			const port = address && typeof address !== "string" ? address.port : 0;
			probe.close(() => resolve(port));
		});
	});
}

async function waitFor(predicate: () => Promise<boolean> | boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`condition was not met: ${message}`);
}

test("hub lists sessions, serves the page, and tunnels each session's API", async () => {
	const hub = await startHub({ port: 0 });
	const hubUrl = `http://127.0.0.1:${hub.port}/`;
	const first = await createSession(hub, hubUrl, "session-alpha", "alpha");
	const second = await createSession(hub, hubUrl, "session-beta", "beta");
	try {
		const index = await fetch(hubUrl);
		const indexHtml = await index.text();
		assert.equal(index.status, 200);
		assert.match(indexHtml, /session-alpha/);
		assert.match(indexHtml, /session-beta/);
		assert.match(indexHtml, new RegExp(`${SESSION_PATH_PREFIX}session-alpha/`));

		// The hub serves the page shell at the root, selected with ?session=, so a UI change needs
		// only a hub restart.
		const page = await fetch(`${hubUrl}?session=session-alpha`);
		const pageHtml = await page.text();
		assert.equal(page.status, 200);
		assert.doesNotMatch(pageHtml, /__PI_CSP_NONCE__/);
		assert.match(pageHtml, /src="\/app.js"/);
		assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);

		// The bundle is one file for every session, served from the hub root.
		const script = await fetch(`${hubUrl}app.js`);
		assert.equal(script.status, 200);
		assert.match(script.headers.get("content-type") ?? "", /javascript/);
		await script.body?.cancel();

		// A printed /s/<id>/ link still works and forwards to the query-parameter page.
		const legacy = await fetch(`${hubUrl}${sessionBasePath("session-alpha").slice(1)}`, { redirect: "manual" });
		assert.equal(legacy.status, 302);
		assert.equal(legacy.headers.get("location"), "/?session=session-alpha");
		await legacy.body?.cancel();

		const state = await fetch(new URL(`${sessionApiPath("session-alpha")}state`, hubUrl));
		assert.equal(state.status, 200);
		assert.equal(((await state.json()) as { session: { projectName: string } }).session.projectName, "alpha");

		const lease = await fetch(new URL(`${sessionApiPath("session-alpha")}lease`, hubUrl), {
			method: "POST",
			headers: { "content-type": "application/json", origin: hubUrl.slice(0, -1), "x-pi-web-client": "tab-1" },
			body: JSON.stringify({ clientId: "tab-1" }),
		});
		assert.equal(lease.status, 200);
		await lease.body?.cancel();

		const draft = await fetch(new URL(`${sessionApiPath("session-alpha")}draft`, hubUrl), {
			method: "POST",
			headers: { "content-type": "application/json", origin: hubUrl.slice(0, -1), "x-pi-web-client": "tab-1" },
			body: JSON.stringify({ requestId: "draft-1", revision: 0, text: "hello from the browser" }),
		});
		assert.equal(draft.status, 200);
		await draft.body?.cancel();

		const sent = await fetch(new URL(`${sessionApiPath("session-alpha")}messages`, hubUrl), {
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

		// A cross-origin mutation never reaches the session: the hub forwards no validated origin,
		// and the session's own check refuses it.
		const hostile = await fetch(new URL(`${sessionApiPath("session-alpha")}lease`, hubUrl), {
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

test("hub streams a session's server-sent events through the channel", async () => {
	const hub = await startHub({ port: 0 });
	const hubUrl = `http://127.0.0.1:${hub.port}/`;
	const session = await createSession(hub, hubUrl, "session-events");
	try {
		const response = await fetch(new URL(`${sessionApiPath("session-events")}events?since=0`, hubUrl));
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
		const reader = response.body?.getReader();
		assert.ok(reader, "a streaming response must be readable");
		const decoder = new TextDecoder();
		let text = "";
		for (let attempt = 0; attempt < 50 && !text.includes("event: lease"); attempt += 1) {
			const chunk = await reader.read();
			if (chunk.done) break;
			text += decoder.decode(chunk.value, { stream: true });
		}
		assert.match(text, /retry: 2000/);
		assert.match(text, /event: lease/);
		// A streaming response must outlive the handler call that set it up: returning from the
		// handler must not end the stream.
		const closedEarly = await Promise.race([
			reader.read().then((chunk) => chunk.done),
			new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_500)),
		]);
		assert.equal(closedEarly, false, "the event stream closed instead of staying open");
		await reader.cancel().catch(() => undefined);
	} finally {
		await session.stop();
		await hub.close();
	}
});

test("a session whose channel dropped answers with a reconnecting page", async () => {
	const hub = await startHub({ port: 0, channelWaitMs: 50, graceMs: 30_000 });
	const hubUrl = `http://127.0.0.1:${hub.port}/`;
	const session = await createSession(hub, hubUrl, "session-reconnecting");
	try {
		const missing = await fetch(`${hubUrl}s/nobody-here/`);
		assert.equal(missing.status, 404);
		assert.match(await missing.text(), /not connected/);

		// The channel is the only registration path, so dropping it marks the session reconnecting.
		session.channel.stop();
		await waitFor(() => hub.sessions()[0]?.stale === true, "the hub marks a session without a channel");
		const offline = await fetch(`${hubUrl}?session=session-reconnecting`);
		assert.equal(offline.status, 200, "the page stays available while a session reconnects");
		const api = await fetch(new URL(`${sessionApiPath("session-reconnecting")}state`, hubUrl));
		assert.equal(api.status, 502);
		assert.match(await api.text(), /reconnecting/);
	} finally {
		await session.stop();
		await hub.close();
	}
});

test("the hub forgets a session once its grace period passes", async () => {
	const hub = await startHub({ port: 0, channelWaitMs: 50, graceMs: 50 });
	const hubUrl = `http://127.0.0.1:${hub.port}/`;
	const session = await createSession(hub, hubUrl, "session-forgotten");
	try {
		session.channel.stop();
		await waitFor(() => hub.sessions().length === 0, "the hub forgets a session after its grace period");
		const gone = await fetch(`${hubUrl}?session=session-forgotten`);
		assert.equal(gone.status, 404);
		assert.match(await gone.text(), /not connected/);
	} finally {
		await session.stop();
		await hub.close();
	}
});

test("a restarted hub is repopulated by reconnecting sessions", async () => {
	const first = await startHub({ port: 0 });
	const port = first.port;
	const hubUrl = `http://127.0.0.1:${port}/`;
	const session = await createSession(first, hubUrl, "session-restart");
	try {
		await first.close();
		const replacement = await startHub({ port });
		try {
			await waitFor(
				() => replacement.sessions().length === 1 && replacement.sessions()[0]?.stale === false,
				"the session reconnects to the replacement hub",
			);
			const state = await fetch(new URL(`${sessionApiPath("session-restart")}state`, hubUrl));
			assert.equal(state.status, 200);
			await state.body?.cancel();
		} finally {
			await replacement.close();
		}
	} finally {
		await session.stop();
	}
});

test("hub host validation stays strict and the control plane is read-only", async () => {
	// Allowed host names come from the configuration file, like every other hub setting.
	const dir = mkdtempSync(join(tmpdir(), "pi-webui-hosts-"));
	writeFileSync(join(dir, "pi-webui.json"), JSON.stringify({ hub: { allowedHosts: ["pi.example.com"] } }));
	const hub = await startHub({ port: 0, env: { PI_CODING_AGENT_DIR: dir } });
	const hubUrl = `http://127.0.0.1:${hub.port}/`;
	try {
		// `fetch` treats Host as a forbidden header, so drive these probes with node:http.
		assert.equal(await requestStatus(hub.port, "attacker.invalid"), 421);
		assert.equal(await requestStatus(hub.port, `pi.example.com:${hub.port}`), 200);

		const hello = (await (await fetch(`${hubUrl}_hub/hello`)).json()) as Record<string, unknown>;
		assert.equal(hello.name, "pi-webui-hub");
		assert.equal(hello.protocol, 2);
		assert.equal(hello.port, hub.port);
		assert.equal(hello.sessionCount, 0);

		const sessionsRead = await fetch(`${hubUrl}_hub/sessions`);
		assert.equal(sessionsRead.status, 200);
		assert.deepEqual(await sessionsRead.json(), { sessions: [] });

		// The old HTTP registration routes are gone: a channel is the only way in.
		for (const path of ["_hub/register", "_hub/heartbeat", "_hub/unregister"]) {
			const response = await fetch(`${hubUrl}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			assert.equal(response.status, 404, `${path} must no longer exist`);
			await response.body?.cancel();
		}
	} finally {
		await hub.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the session index page streams updates instead of reloading", async () => {
	const hub = await startHub({ port: 0 });
	const hubUrl = `http://127.0.0.1:${hub.port}/`;
	const session = await createSession(hub, hubUrl, "session-streamed");
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

		// Connecting another session must push a new snapshot to the open stream.
		const extra = await createSession(hub, hubUrl, "session-pushed");
		try {
			for (let attempt = 0; attempt < 100 && !text.includes("session-pushed"); attempt += 1) {
				const chunk = await reader.read();
				if (chunk.done) break;
				text += decoder.decode(chunk.value, { stream: true });
			}
			assert.match(text, /session-pushed/);
		} finally {
			await extra.stop();
		}
		await reader.cancel().catch(() => undefined);
	} finally {
		await session.stop();
		await hub.close();
	}
});

test("the hub and the extension agree by reading one configuration file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-webui-config-"));
	const configPath = join(dir, "pi-webui.json");
	const port = await freePort();
	writeFileSync(configPath, JSON.stringify({ hub: { port, allowedHosts: ["pi.example.com"] } }, null, 2));
	const env = { PI_CODING_AGENT_DIR: dir };
	const hub = await startHub({ env });
	const hubUrl = `http://127.0.0.1:${hub.port}/`;
	const session = await createSession(hub, hubUrl, "session-config");
	try {
		// The service took its port from the file, with no flag and no environment variable.
		assert.equal(hub.port, port);
		const read = readHubConfig({ env });
		assert.equal(read.path, configPath);
		assert.equal(read.config.port, port);
		assert.equal(read.portFromFile, true);
		assert.deepEqual(read.issues, []);
		assert.ok(read.config.allowedHosts.includes("pi.example.com"));

		// An extension with the same agent directory derives that exact hub URL from the file.
		const channel = new HubChannel({
			env,
			session: () => ({ sessionId: "session-config-derived" }),
			serve: async () => undefined,
			minRetryMs: 20,
			maxRetryMs: 60,
		});
		assert.equal(channel.statusSnapshot().hubUrl, `http://127.0.0.1:${port}/`);
		assert.equal(channel.channelUrl(), `ws://127.0.0.1:${port}/_hub/channel`);
		channel.start();
		await waitFor(() => channel.statusSnapshot().state === "connected", "the derived channel connects");
		assert.equal(channel.sessionUrl(), `${hubUrl}?session=session-config-derived`);
		channel.stop();
		await waitFor(
			() => hub.sessions().find((entry) => entry.sessionId === "session-config-derived")?.stale === true,
			"the derived session is marked reconnecting after it stops",
		);
	} finally {
		await session.stop();
		await hub.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("readHubConfig reports unusable values and falls back without refusing to start", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-webui-config-"));
	const configPath = join(dir, "pi-webui.json");
	try {
		assert.equal(readHubConfig({ env: { PI_CODING_AGENT_DIR: dir } }).config.port, DEFAULT_HUB_PORT);
		assert.equal(readHubConfig({ env: { PI_CODING_AGENT_DIR: dir } }).exists, false);

		writeFileSync(configPath, "{ not json");
		const malformed = readHubConfig({ env: { PI_CODING_AGENT_DIR: dir } });
		assert.equal(malformed.config.port, DEFAULT_HUB_PORT);
		assert.equal(malformed.issues.length, 1);

		writeFileSync(configPath, JSON.stringify({ hub: { port: 70_000, allowedHosts: ["ok.example", 7] } }));
		const invalid = readHubConfig({ env: { PI_CODING_AGENT_DIR: dir } });
		assert.equal(invalid.config.port, DEFAULT_HUB_PORT, "an out-of-range port falls back to the default");
		assert.equal(invalid.portFromFile, false);
		assert.equal(invalid.issues.length, 2);
		assert.deepEqual(invalid.config.allowedHosts, [...DEFAULT_ALLOWED_HOSTS, "ok.example"]);

		writeFileSync(configPath, JSON.stringify({ hub: "not-an-object" }));
		assert.equal(readHubConfig({ env: { PI_CODING_AGENT_DIR: dir } }).config.port, DEFAULT_HUB_PORT);

		// Pi's own agent directory convention, with no pi-webui variable of our own.
		assert.equal(configFilePath({ PI_CODING_AGENT_DIR: "/opt/agent" }), "/opt/agent/pi-webui.json");
		assert.equal(configFilePath({ HOME: "/home/someone" }), "/home/someone/.pi/agent/pi-webui.json");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the index keeps ticking so a silent stream is detectable", async () => {
	const hub = await startHub({ port: 0, tickMs: 40 });
	const hubUrl = `http://127.0.0.1:${hub.port}/`;
	try {
		const response = await fetch(`${hubUrl}_hub/events`);
		const reader = response.body?.getReader();
		assert.ok(reader);
		const decoder = new TextDecoder();
		let text = decoder.decode((await reader.read()).value);
		const first = text.length;
		for (let attempt = 0; attempt < 50 && text.length === first; attempt += 1) {
			const chunk = await reader.read();
			if (chunk.done) break;
			text += decoder.decode(chunk.value, { stream: true });
		}
		assert.ok(text.length > first, "a quiet registry should still produce periodic snapshots");
		assert.match(text, /retry: 2000/);
		await reader.cancel().catch(() => undefined);
	} finally {
		await hub.close();
	}
});
