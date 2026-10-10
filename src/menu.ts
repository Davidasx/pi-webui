export type WebUIMenuAction = "open" | "settings" | "repair" | "status" | "help";

export interface WebUIMenuState {
	serverRunning: boolean;
	hubState: "connected" | "connecting" | "waiting" | "closed";
	hubUrl: string;
	channelUrl?: string;
	startupAutomatic: boolean;
	settingsSource: string;
	settingsPath: string;
	settingsInvalid: boolean;
}

export interface WebUIMenuItem {
	value: WebUIMenuAction;
	label: string;
	description?: string;
}

export function webUIMenuItems(state: WebUIMenuState): WebUIMenuItem[] {
	const primary: WebUIMenuItem =
		state.hubState === "connected"
			? {
					value: "open",
					label: "Open WebUI",
					description: `Show this session's link through the hub at ${safeTerminalText(state.hubUrl)}.`,
				}
			: {
					value: "open",
					label: "Open WebUI (waiting for the hub)",
					description: `The hub at ${safeTerminalText(state.hubUrl)} is not answering; this session reconnects on its own and prints the hub service setup.`,
				};
	const settings: WebUIMenuItem = state.settingsInvalid
		? {
				value: "repair",
				label: "Repair settings file",
				description:
					"Safe defaults are active; inspect the preserved invalid JSON before reloading.",
			}
		: {
				value: "settings",
				label: "Settings",
				description: `Startup: ${startupLabel(state)}. Changes save immediately and apply on the next session initialization.`,
			};
	return [
		primary,
		settings,
		{
			value: "status",
			label: "Status & diagnostics",
			description: "Review effective startup, settings source, image limits, hub state, and server state.",
		},
		{
			value: "help",
			label: "Help",
			description: "Review the browser workflow, direct commands, and advanced settings path.",
		},
	];
}

export function webUIMenuTitle(state: WebUIMenuState): string {
	const lines = [
		"Pi WebUI",
		`Server: ${state.serverRunning ? "Running" : "Stopped"} · Hub: ${hubLabel(state)} · Startup: ${startupLabel(state)} · Source: ${safeTerminalText(state.settingsSource)}`,
	];
	if (state.settingsInvalid) {
		lines.push(
			"Settings need repair · Safe defaults are active",
			`File: ${safeTerminalText(state.settingsPath)}`,
		);
	}
	return lines.join("\n");
}

export function safeTerminalText(value: unknown): string {
	return [...String(value)]
		.map((character) => {
			const code = character.charCodeAt(0);
			return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? " " : character;
		})
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

function hubLabel(state: WebUIMenuState): string {
	if (state.hubState === "connected") return safeTerminalText(state.hubUrl);
	if (state.hubState === "closed") return "not started";
	return state.hubState === "connecting" ? "connecting" : "waiting";
}

function startupLabel(state: WebUIMenuState): string {
	return state.startupAutomatic ? "Every session" : "Manual";
}
