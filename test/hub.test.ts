import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
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
import { WebUIServer } from "../src/server.js";

/**
 * A session stands in for a real Pi process: the same web service the extension builds, driven by
 * the same channel client, dialing a real hub over a real WebSocket.
 */
async function createSession(hub: Hub, hubUrl: string, sessionId: string, projectName = "demo") {
	const commands: Record<string, unknown>[] = [];
	const service = typeService(
		WebUIServer.create(
			{
				piWeb: {
					sessionId: () => sessionId,
					command: async (command) => {
						commands.push(command);
						return { accepted: true };
					},
					state: async () => ({ model: { provider: "demo", id: "model" } }),
					autoName: async () => undefined,
					isRunning: () => false,
					subscribe: () => () => undefined,
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
		commands,
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
		// The front page is the app itself: the root names the newest session so the browser lands in
		// a working session, and the session list lives in the app's own sidebar.
		const root = await fetch(hubUrl, { redirect: "manual" });
		assert.equal(root.status, 302);
		const target = root.headers.get("location") ?? "";
		assert.match(target, /^\/\?session=/);
		await root.body?.cancel();

		// The list the sidebar shows comes from a session, which reads the sessions on disk.
		const list = await fetch(new URL(`${SESSION_PATH_PREFIX}session-alpha/api/sessions`, hubUrl));
		assert.equal(list.status, 200);
		await list.body?.cancel();
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

		// Their composer's liveness probe: a plain GET that must answer with the live state.
		const probe = await fetch(new URL(`${sessionApiPath("session-alpha")}agent/session-alpha`, hubUrl));
		assert.equal(probe.status, 200);
		assert.equal(((await probe.json()) as { running: boolean }).running, true);

		// A prompt from the browser reaches exactly the session the URL named.
		const sent = await fetch(new URL(`${sessionApiPath("session-alpha")}agent/session-alpha`, hubUrl), {
			method: "POST",
			headers: { "content-type": "application/json", origin: hubUrl.slice(0, -1), "x-pi-web-client": "tab-1" },
			body: JSON.stringify({ type: "prompt", message: "hello from the browser" }),
		});
		assert.equal(sent.status, 200);
		await sent.body?.cancel();
		assert.deepEqual(first.commands, [{ type: "prompt", message: "hello from the browser" }]);
		// Routing must never leak a session's traffic to another session.
		assert.equal(second.commands.length, 0);

		// A cross-origin mutation never reaches the session: the hub forwards no validated origin,
		// and the session's own check refuses it.
		const hostile = await fetch(new URL(`${sessionApiPath("session-alpha")}agent/session-alpha`, hubUrl), {
			method: "POST",
			headers: { "content-type": "application/json", origin: "http://attacker.invalid", "x-pi-web-client": "tab-1" },
			body: JSON.stringify({ type: "prompt", message: "should not arrive" }),
		});
		assert.equal(hostile.status, 403);
		await hostile.body?.cancel();
		assert.equal(first.commands.length, 1);
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
		const response = await fetch(new URL(`${sessionApiPath("session-events")}agent/session-events/events`, hubUrl));
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
		const reader = response.body?.getReader();
		assert.ok(reader, "a streaming response must be readable");
		const decoder = new TextDecoder();
		const first = await reader.read();
		const text = decoder.decode(first.value, { stream: true });
		assert.match(text, /"type":"connected"/, "their composer waits for this frame before sending");
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
		const api = await fetch(new URL(`${sessionApiPath("session-reconnecting")}agent/session-reconnecting`, hubUrl));
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
		// The page stays up: it is the app, whose sidebar lists whatever is connected, not a dead end
		// for the session that just went away. Its API is what reports the session is gone.
		const gone = await fetch(`${hubUrl}?session=session-forgotten`);
		assert.equal(gone.status, 200);
		assert.match(await gone.text(), /id="root"/);
		const api = await fetch(new URL(`${sessionApiPath("session-forgotten")}agent/session-forgotten`, hubUrl));
		assert.equal(api.status, 404);
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
			const state = await fetch(new URL(`${sessionApiPath("session-restart")}agent/session-reconnecting`, hubUrl));
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
