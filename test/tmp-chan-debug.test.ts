import { test } from "vitest";
import { ConversationProjection } from "../src/conversation.js";
import { startHub } from "../src/hub.js";
import { HubChannel } from "../src/hub-channel.js";
import { WebUIServer } from "../src/server.js";

test("debug restart", async () => {
	const t0 = Date.now();
	const step = (m: string) => console.log(`[${Date.now() - t0}ms] ${m}`);
	const first = await startHub({ port: 0 });
	const port = first.port;
	const hubUrl = `http://127.0.0.1:${port}/`;
	step(`hub started on ${port}`);
	const conversation = new ConversationProjection({ id: "session-restart", cwd: "/tmp", projectName: "demo" });
	const service = WebUIServer.create({ conversation, send: async () => ({ delivery: "immediate" }) }, hubUrl.replace(/\/+$/, ""));
	const channel = new HubChannel({
		hubUrl,
		minRetryMs: 20,
		maxRetryMs: 60,
		session: () => ({ sessionId: "session-restart", projectName: "demo" }),
		serve: (req, res) => service.serve(req, res),
		onChange: (s) => step(`channel ${s.state}${s.error ? ` (${s.error})` : ""}`),
	});
	channel.start();
	for (let i = 0; i < 100 && channel.statusSnapshot().state !== "connected"; i++) await new Promise((r) => setTimeout(r, 20));
	step("connected");
	await first.close();
	step("first hub closed");
	const replacement = await startHub({ port });
	step("replacement started");
	for (let i = 0; i < 200 && replacement.sessions().length === 0; i++) await new Promise((r) => setTimeout(r, 20));
	step(`sessions=${JSON.stringify(replacement.sessions().map((s) => s.sessionId))}`);
	await replacement.close();
	step("replacement closed");
	channel.stop();
	await service.close();
	step("done");
}, 60000);
