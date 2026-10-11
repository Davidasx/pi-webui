import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { type WebUIPiWebBridge, WebUIServer } from "../src/server.js";
import { setLiveSession } from "../src/web/pi-web/lib/rpc-manager.js";

/**
 * What their frontend is owed, over HTTP.
 *
 * These are the calls their page actually makes, asserted on the wire rather than on our source: the
 * composer's liveness probe, the event stream's first frame, the command shapes their buttons send,
 * and the file route that fills their explorer. Every case here is one that was once broken, so a
 * regression fails a test instead of a browser.
 */

interface Harness {
	server: WebUIServer;
	commands: Record<string, unknown>[];
	named: string[];
	events: Record<string, unknown>[];
	emit(event: Record<string, unknown>): void;
	stop(): Promise<void>;
}

async function harness(overrides: Partial<WebUIPiWebBridge> = {}): Promise<Harness> {
	const commands: Record<string, unknown>[] = [];
	const named: string[] = [];
	const listeners = new Set<(event: Record<string, unknown>) => void>();
	const bridge: WebUIPiWebBridge = {
		sessionId: () => "01a1-session",
		autoName: async (id) => {
			if (id !== "01a1-session") return undefined;
			const title = "named from the browser";
			named.push(title);
			return { title };
		},
		command: async (command) => {
			commands.push(command);
			if (command.type === "get_tools") {
				return [
					{ name: "read", description: "Read a file", active: true },
					{ name: "bash", description: "Run a command", active: false },
				];
			}
			if (command.type === "get_state") {
				return {
					model: { provider: "ustc", id: "deepseek-flash" },
					contextUsage: { percent: 12.5, contextWindow: 1_000_000, tokens: 125_000 },
					systemPrompt: "You are an expert coding assistant.",
					thinkingLevel: "high",
					isStreaming: false,
					isPromptRunning: false,
					isBashRunning: false,
					isCompacting: false,
					extensionStatuses: [],
					extensionWidgets: [],
					queuedMessages: { steering: [], followUp: [] },
				};
			}
			return { accepted: true };
		},
		state: async () => ({ model: { provider: "ustc", id: "deepseek-flash" }, isPromptRunning: false }),
		isRunning: () => false,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		...overrides,
	};
	const server = await WebUIServer.start({ piWeb: bridge });
	return {
		server,
		commands,
		named,
		events: [],
		emit: (event) => {
			for (const listener of listeners) listener(event);
		},
		stop: () => server.close(),
	};
}

function post(server: WebUIServer, path: string, body: unknown): Promise<Response> {
	return fetch(`${server.origin}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", origin: server.origin },
		body: JSON.stringify(body),
	});
}

test("their liveness probe answers with the live state instead of an error", async () => {
	const app = await harness();
	try {
		// Their grace loop treats any other status as "the session is gone" and retries forever while
		// the composer waits, so this one call has to be a plain 200.
		const probe = await fetch(`${app.server.origin}/api/agent/01a1-session`);
		assert.equal(probe.status, 200);
		const body = (await probe.json()) as { running: boolean; state: { model: { id: string } } };
		assert.equal(body.running, true);
		assert.equal(body.state.model.id, "deepseek-flash");
	} finally {
		await app.stop();
	}
});

test("a prompt from the browser reaches the session as their command shape", async () => {
	const app = await harness();
	try {
		const response = await post(app.server, "/api/agent/01a1-session", {
			type: "prompt",
			message: "hello from the browser",
		});
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { success: true, data: { accepted: true } });
		assert.deepEqual(app.commands, [{ type: "prompt", message: "hello from the browser" }]);
	} finally {
		await app.stop();
	}
});

test("the event stream opens with their connected frame", async () => {
	const app = await harness();
	try {
		const response = await fetch(`${app.server.origin}/api/agent/01a1-session/events`);
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
		const reader = response.body?.getReader();
		assert.ok(reader);
		const decoder = new TextDecoder();
		let text = decoder.decode((await reader.read()).value, { stream: true });
		// Their composer waits for this frame before it will send anything: without it `handleSend`
		// blocks on the event connection and the message never leaves the page.
		while (!text.includes("data:")) text += decoder.decode((await reader.read()).value, { stream: true });
		const frame = JSON.parse(/data: (.+)/.exec(text)?.[1] ?? "{}") as Record<string, unknown>;
		assert.equal(frame.type, "connected");
		assert.equal(frame.sessionId, "01a1-session");
		assert.equal(typeof frame.isStreaming, "boolean");
		assert.deepEqual(frame.pendingExtensionUiIds, []);

		// A live event follows as another data frame, in the shape their reducer takes.
		app.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
		for (let attempt = 0; attempt < 20 && !text.includes("text_delta"); attempt += 1) {
			text += decoder.decode((await reader.read()).value, { stream: true });
		}
		assert.match(text, /text_delta/);
		await reader.cancel().catch(() => undefined);
	} finally {
		await app.stop();
	}
});

test("get_state and get_tools answer in their shapes", async () => {
	const app = await harness();
	try {
		const state = await post(app.server, "/api/agent/01a1-session", { type: "get_state" });
		const { data } = (await state.json()) as { data: Record<string, unknown> };
		assert.deepEqual(data.model, { provider: "ustc", id: "deepseek-flash" });
		assert.deepEqual(data.contextUsage, { percent: 12.5, contextWindow: 1_000_000, tokens: 125_000 });
		assert.equal(typeof data.systemPrompt, "string");
		assert.equal(data.thinkingLevel, "high");
		// Their top bar reads these flags to tell a model run from a command run.
		for (const key of ["isStreaming", "isPromptRunning", "isBashRunning", "isCompacting"]) {
			assert.equal(typeof data[key], "boolean", `${key} is a boolean`);
		}
		assert.deepEqual(data.queuedMessages, { steering: [], followUp: [] });

		// Their tool picker calls `.filter` on this result, so it must be the array itself.
		const tools = await post(app.server, "/api/agent/01a1-session", { type: "get_tools" });
		const listed = (await tools.json()) as { data: Array<{ name: string; active: boolean }> };
		assert.ok(Array.isArray(listed.data), "get_tools answers with an array");
		assert.deepEqual(listed.data[0], { name: "read", description: "Read a file", active: true });
	} finally {
		await app.stop();
	}
});

test("the title button answers with a title and names the session", async () => {
	const app = await harness();
	try {
		const response = await post(app.server, "/api/sessions/01a1-session/auto-name", {});
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { title: "named from the browser", usage: null });
		assert.deepEqual(app.named, ["named from the browser"]);

		// A request for a session this process does not own must not rename this one.
		const other = await post(app.server, "/api/sessions/01a2-other/auto-name", {});
		assert.equal(other.status, 404);
		assert.deepEqual(app.named, ["named from the browser"]);
	} finally {
		await app.stop();
	}
});

test("their copied routes serve the file explorer, including non-ASCII paths", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "pi-webui-files-"));
	const folder = path.join(directory, "会话 dir");
	await mkdir(folder);
	await writeFile(path.join(folder, "notes.md"), "# hello\n");
	const app = await harness();
	try {
		// The route only serves paths inside a root the session has allowed, which registration does.
		setLiveSession({
			sessionId: "01a1-session",
			cwd: directory,
			sessionFile: undefined,
			inner: {} as never,
			isAlive: () => true,
			isRunning: () => false,
			evictIfDiskAhead: () => false,
			send: async () => ({}),
		});

		const encoded = folder
			.split("/")
			.filter(Boolean)
			.map((segment) => encodeURIComponent(segment))
			.join("/");
		const listing = await fetch(`${app.server.origin}/api/files/${encoded}?type=list`);
		const listingBody = await listing.text();
		assert.equal(listing.status, 200, listingBody);
		const body = JSON.parse(listingBody) as { entries: Array<{ name: string }> };
		assert.deepEqual(
			body.entries.map((entry) => entry.name),
			["notes.md"],
		);

		const file = await fetch(`${app.server.origin}/api/files/${encoded}/notes.md?type=read`);
		assert.equal(file.status, 200);
		assert.match(JSON.stringify(await file.json()), /hello/);
	} finally {
		setLiveSession(undefined);
		await app.stop();
		await rm(directory, { recursive: true, force: true });
	}
});
