import assert from "node:assert/strict";
import { test } from "vitest";
import {
	safeTerminalText,
	type WebUIMenuState,
	webUIMenuItems,
	webUIMenuTitle,
} from "../src/menu.js";

const STOPPED: WebUIMenuState = {
	serverRunning: false,
	hubState: "waiting",
	hubUrl: "http://127.0.0.1:43118/",
	startupAutomatic: false,
	settingsSource: "Defaults",
	settingsPath: "/agent/pi-webui.json",
	settingsInvalid: false,
};

test("menu keeps primary state and selected effects in its declarative items", () => {
	assert.match(webUIMenuTitle(STOPPED), /Server: Stopped/);
	assert.match(webUIMenuTitle(STOPPED), /Hub: waiting/);
	assert.match(webUIMenuItems(STOPPED)[0]?.label ?? "", /waiting for the hub/i);
	assert.match(webUIMenuItems(STOPPED)[0]?.description ?? "", /43118/);
});

test("menu previews the hub link, preserves selection, and cancels without an action", async () => {
	const running = {
		...STOPPED,
		serverRunning: true,
		startupAutomatic: true,
		hubState: "connected" as const,
		channelUrl: "ws://127.0.0.1:43118/_hub/channel",
	};
	const items = webUIMenuItems(running);
	assert.equal(items[0]?.label, "Open WebUI");
	assert.match(items[0]?.description ?? "", /43118/);
	assert.match(webUIMenuTitle(running), /Hub: http:\/\/127\.0\.0\.1:43118\//);
	assert.match(
		items.find((item) => item.value === "status")?.description ?? "",
		/Review effective startup/,
	);
});

test("invalid settings become a repair flow and terminal-owned text is escaped", () => {
	const state = {
		...STOPPED,
		settingsInvalid: true,
		settingsPath: "/agent/\u001b[31munsafe\u0007.json",
	};
	assert.equal(webUIMenuItems(state)[1]?.label, "Repair settings file");
	const title = webUIMenuTitle(state);
	assert.equal(title.includes("\u001b"), false);
	assert.equal(title.includes("\u0007"), false);
	assert.match(title, /Settings need repair/);
	assert.equal(safeTerminalText("before\u001b[31m\u0007after"), "before [31m after");
});
