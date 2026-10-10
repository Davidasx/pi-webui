import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { HubClient } from "../src/hub-client.js";
import { DEFAULT_HUB_PORT, HEARTBEAT_PATH, hubBaseUrl, hubSessionUrl, REGISTER_PATH } from "../src/hub-protocol.js";
import { hubFetchStub } from "./hub-helpers.js";

const METADATA = { sessionId: "session-1", port: 1234, projectName: "demo", activity: "idle" as const };
const TOKEN = "e".repeat(40);
const HUB_URL = "http://127.0.0.1:43118/";

test("hub urls come from the configuration file, with the default as fallback", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-webui-client-config-"));
	try {
		writeFileSync(join(dir, "pi-webui.json"), JSON.stringify({ hub: { port: 9_000 } }));
		assert.equal(hubBaseUrl({ env: { PI_CODING_AGENT_DIR: dir } }), "http://127.0.0.1:9000/");
		assert.equal(hubBaseUrl({ env: { PI_CODING_AGENT_DIR: join(dir, "absent") } }), `http://127.0.0.1:${DEFAULT_HUB_PORT}/`);
		assert.equal(hubSessionUrl("http://127.0.0.1:9000/", "abc"), "http://127.0.0.1:9000/s/abc/");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("client registers, publishes a session url, and keeps the registration alive", async () => {
	const requests: string[] = [];
	const client = new HubClient({
		hubUrl: HUB_URL,
		token: TOKEN,
		metadata: () => METADATA,
		heartbeatIntervalMs: 10,
		fetchImpl: hubFetchStub({ onRequest: (path) => requests.push(path) }),
	});
	const status = await client.start();
	assert.equal(status.state, "registered");
	assert.equal(status.sessionUrl, "http://127.0.0.1:43118/s/session-1/");
	assert.equal(status.basePath, "/s/session-1/");
	assert.deepEqual(requests.slice(0, 2), ["/_hub/hello", REGISTER_PATH]);
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.ok(requests.includes(HEARTBEAT_PATH), "heartbeats should continue after registration");
	await client.stop();
	const after = requests.length;
	await new Promise((resolve) => setTimeout(resolve, 40));
	assert.equal(requests.length, after, "stop() must clear the heartbeat timer");
	assert.equal(client.statusSnapshot().state, "disabled");
});

test("client degrades to a session-only link when the hub is absent or foreign", async () => {
	const absent = new HubClient({
		hubUrl: HUB_URL,
		token: TOKEN,
		metadata: () => METADATA,
		fetchImpl: hubFetchStub({ reachable: false }),
	});
	const absentStatus = await absent.start();
	assert.equal(absentStatus.state, "unreachable");
	assert.match(absentStatus.lastError ?? "", /ECONNREFUSED/);
	assert.equal(absentStatus.sessionUrl, undefined);
	await absent.stop();

	const foreign = new HubClient({
		hubUrl: HUB_URL,
		token: TOKEN,
		metadata: () => METADATA,
		fetchImpl: hubFetchStub({ impersonate: "something-else" }),
	});
	const foreignStatus = await foreign.start();
	assert.equal(foreignStatus.state, "unreachable");
	assert.match(foreignStatus.lastError ?? "", /another service is listening/);
	await foreign.stop();
});

test("client re-registers after a hub restart and reports rejections", async () => {
	const heartbeatPaths: string[] = [];
	// Pretend the hub forgot us: the next heartbeat answers 404 and the client must register again.
	const forgetting = new HubClient({
		hubUrl: HUB_URL,
		token: TOKEN,
		metadata: () => METADATA,
		heartbeatIntervalMs: 10,
		fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			if (url.pathname === HEARTBEAT_PATH) {
				heartbeatPaths.push(HEARTBEAT_PATH);
				return new Response(JSON.stringify({ ok: false }), { status: 404 });
			}
			return await hubFetchStub({ onRequest: (path) => heartbeatPaths.push(path) })(input as never, init);
		}) as typeof fetch,
	});
	const forgotten = await forgetting.start();
	assert.equal(forgotten.state, "registered");
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(
		forgetting.statusSnapshot().state,
		"registered",
		"a 404 heartbeat must trigger a fresh registration instead of leaving the session invisible",
	);
	assert.ok(
		heartbeatPaths.filter((path) => path === REGISTER_PATH).length >= 2,
		"the client should register again after the hub forgets the session",
	);
	await forgetting.stop();

	const rejected = new HubClient({
		hubUrl: HUB_URL,
		token: TOKEN,
		metadata: () => METADATA,
		fetchImpl: hubFetchStub({ rejectRegistration: 429 }),
	});
	const rejectedStatus = await rejected.start();
	assert.equal(rejectedStatus.state, "unreachable");
	assert.match(rejectedStatus.lastError ?? "", /HTTP 429/);
	await rejected.stop();
});
