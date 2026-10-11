import { basename } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { HubChannel, type HubChannelOptions } from "./hub-channel.js";
import { HUB_UNIT_NAME, hubInstallSteps, packageVersion, renderHubUnit } from "./hub-install.js";
import {
	type ChannelStatus,
	CONFIG_FILE_NAME,
	channelUrl,
	HUB_PROTOCOL,
	type HubConfigRead,
	type HubSessionInfo,
	hubBaseUrl,
	readHubConfig,
} from "./hub-protocol.js";
import { safeTerminalText, type WebUIMenuState, webUIMenuItems, webUIMenuTitle } from "./menu.js";
import {
	WebUIServer,
	type WebUIServerOptions,
} from "./server.js";
import {
	DEFAULT_SETTINGS,
	initializeSettings,
	loadSettings,
	type SettingsLoadResult,
	saveSettings,
	type WebUISettings,
} from "./settings.js";
import { toClientAgentEvent } from "./web/pi-web/lib/agent-event-wire.js";
import { type LiveSession, setLiveSession } from "./web/pi-web/lib/rpc-manager.js";
import { invalidateSessionListCache } from "./web/pi-web/lib/session-reader.js";
import { computeSessionStats } from "./web/pi-web/lib/session-stats.js";
import { generateSessionTitle } from "./web/pi-web/lib/session-title.js";
import type { SessionEntry } from "./web/pi-web/lib/types.js";

const WIDGET_KEY = "webui";
const ACTIVITY_STATUS_KEY = "webui:activity";
const EXPERIMENTAL_WARNING =
	"pi-webui is experimental; its browser workflow and package API may change.";
const INPUT_HEADER = /^<pi-webui-input nonce="([0-9a-f-]+)">\n/;
const INPUT_FOOTER = "\n</pi-webui-input>";
const CHANNEL_CONNECT_WAIT_MS = 1_500;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Pi's built-in slash commands belong to the terminal UI, not to the prompt path. The browser
 * implements the ones it can and names the others, so typing `/tree` here never silently reaches
 * the model as prose.
 */
const BUILTIN_COMMANDS: ReadonlyArray<{
	name: string;
	description: string;
	support: "compact" | "name" | "thinking" | "models" | "terminal";
}> = [
	{ name: "compact", description: "Compact the session context", support: "compact" },
	{ name: "name", description: "Set the session name", support: "name" },
	{ name: "thinking", description: "Set the thinking level", support: "thinking" },
	{ name: "model", description: "Switch models from the top bar", support: "models" },
	{ name: "settings", description: "Pi settings live in the terminal", support: "terminal" },
	{ name: "tree", description: "Branch navigation needs the terminal", support: "terminal" },
	{ name: "fork", description: "Forking needs the terminal", support: "terminal" },
	{ name: "clone", description: "Cloning needs the terminal", support: "terminal" },
	{ name: "new", description: "New sessions start in the terminal", support: "terminal" },
	{ name: "resume", description: "Switching sessions needs the terminal", support: "terminal" },
	{ name: "export", description: "Export runs in the terminal", support: "terminal" },
	{ name: "share", description: "Sharing runs in the terminal", support: "terminal" },
	{ name: "login", description: "Provider login runs in the terminal", support: "terminal" },
	{ name: "logout", description: "Provider logout runs in the terminal", support: "terminal" },
	{ name: "scoped-models", description: "Model scoping runs in the terminal", support: "terminal" },
	{ name: "import", description: "Importing runs in the terminal", support: "terminal" },
	{ name: "copy", description: "Copying the last reply runs in the terminal", support: "terminal" },
	{ name: "session", description: "Session stats are in the top bar too", support: "terminal" },
	{ name: "bug", description: "Bug reports run in the terminal", support: "terminal" },
	{ name: "changelog", description: "The changelog shows in the terminal", support: "terminal" },
	{ name: "hotkeys", description: "Keybindings belong to the terminal", support: "terminal" },
	{ name: "trust", description: "Project trust is chosen in the terminal", support: "terminal" },
	{ name: "reload", description: "Reloading runs in the terminal", support: "terminal" },
	{ name: "quit", description: "Quitting belongs to the terminal", support: "terminal" },
];
const COMMAND_USAGE = "Usage: /webui [open|hub|settings|status|help|init]";
const COMMAND_COMPLETIONS = [
	{ value: "open", label: "open", description: "Open this session in the browser" },
	{ value: "hub", label: "hub", description: "Show the systemd unit for the shared hub" },
	{ value: "settings", label: "settings", description: "Open WebUI settings" },
	{ value: "status", label: "status", description: "Show effective WebUI settings and state" },
	{ value: "help", label: "help", description: "Show WebUI command help" },
	{ value: "init", label: "init", description: "Create the default WebUI settings file" },
];

type ServerControl = Pick<WebUIServer, "serve" | "close" | "origin">;
type LatestEventHandler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
type LatestExtensionAPI = ExtensionAPI & {
	on(event: "agent_settled", handler: LatestEventHandler): void;
};

interface PendingBrowserInput {
	resolve(): void;
	reject(error: Error): void;
	text: string;
	retainedImageIds: string[];
}

interface AcceptedBrowserInput {
	text: string;
	retainedImageIds: string[];
}

export interface RuntimeDependencies {
	loadSettings: typeof loadSettings;
	saveSettings: typeof saveSettings;
	initializeSettings: typeof initializeSettings;
	createService(options: WebUIServerOptions, origin: string): ServerControl | Promise<ServerControl>;
	createChannel(options: HubChannelOptions): HubChannel;
}

const DEFAULT_DEPENDENCIES: RuntimeDependencies = {
	loadSettings,
	saveSettings,
	initializeSettings,
	createService: (options, origin) => WebUIServer.create(options, origin),
	createChannel: (options) => new HubChannel(options),
};

/** Their composed images, as Pi's image content blocks. */
function browserPromptImages(value: unknown): Array<{ type: "image"; data: string; mimeType: string }> {
	if (!Array.isArray(value)) return [];
	const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const data = entry.data;
		const mimeType = entry.mimeType;
		if (typeof data === "string" && typeof mimeType === "string" && data.length > 0) {
			images.push({ type: "image", data, mimeType });
		}
	}
	return images;
}

/** The text of a message's content, whether it is one string or content blocks. */
function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => {
			return typeof block === "object" && block !== null && (block as { type?: string }).type === "text";
		})
		.map((block) => block.text)
		.join("\n");
}

/** One line of a message, short enough to be a session name. */
function firstLine(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= SESSION_NAME_MAX_LENGTH) return flat;
	return `${flat.slice(0, SESSION_NAME_MAX_LENGTH - 1).trimEnd()}\u2026`;
}

const SESSION_NAME_MAX_LENGTH = 72;

export class WebUIRuntime {
	private readonly dependencies: RuntimeDependencies;
	private context?: ExtensionContext;
	/** The command context Pi hands `/webui`, which is the only place tree navigation exists. */
	private commandContext?: ExtensionCommandContext;
	private server?: ServerControl;
	private serverStarting?: Promise<ServerControl>;
	private hub?: HubChannel;
	private hubStatus: ChannelStatus = idleChannelStatus();
	private sessionAbort = new AbortController();
	private generation = 0;
	private closed = true;
	/** Whether a run is streaming right now, which their UI labels differently from a command run. */
	private streaming = false;
	private bashRunning = false;
	private compacting = false;
	private readonly activeMessageIds = new Map<string, string>();
	private readonly finalMessageTimers = new Set<ReturnType<typeof setTimeout>>();
	private readonly pendingBrowserInputs = new Map<string, PendingBrowserInput>();
	private readonly acceptedBrowserInputs = new Map<string, AcceptedBrowserInput>();
	private readonly piWebListeners = new Set<(event: unknown) => void>();
	private settings: WebUISettings = { ...DEFAULT_SETTINGS };
	private settingsDocument?: Record<string, unknown> = {};
	private settingsPath = "pi-webui.json";
	private settingsSource: SettingsLoadResult["source"] = "defaults";
	private settingsSaveQueue: Promise<void> = Promise.resolve();
	private activityId = 0;

	constructor(
		private readonly pi: ExtensionAPI,
		dependencies: Partial<RuntimeDependencies> = {},
	) {
		this.dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencies };
	}

	register(): void {
		this.pi.registerCommand("webui", {
			description: "Manage the local web companion for this Pi session",
			getArgumentCompletions: (prefix) => {
				const normalized = prefix.trimStart().toLowerCase();
				if (/\s/.test(normalized)) return null;
				const matches = COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(normalized));
				return matches.length > 0 ? matches : null;
			},
			handler: async (args, ctx) => {
				this.context = ctx;
				// Pi offers tree navigation (`ctx.navigateTree`) to a command handler only, and their
				// branch navigation and "edit from here" both go through it.
				this.commandContext = ctx;
				const action = args.trim().toLowerCase();
				try {
					if (!action) {
						await this.showMenu(ctx);
						return;
					}
					if (action === "open") {
						await this.openWebUI(ctx);
						return;
					}
					if (action === "hub") {
						await this.showHub(ctx);
						return;
					}
					if (action === "settings") {
						await this.showSettings(ctx);
						return;
					}
					if (action === "status") {
						this.showStatus(ctx);
						return;
					}
					if (action === "help") {
						this.showHelp(ctx);
						return;
					}
					if (action === "init") {
						await this.initializeSettings(ctx);
						return;
					}
					if (ctx.hasUI) ctx.ui.notify(COMMAND_USAGE, "warning");
				} catch (error) {
					if (ctx.hasUI) {
						const message = `Pi WebUI command failed: ${formatError(error)}`;
						ctx.ui.notify(
							action === "open" || !action ? `${message}. Retry with /webui open.` : message,
							"error",
						);
					}
				}
			},
		});

		this.pi.on("session_start", async (_event, ctx) => this.start(ctx));
		this.pi.on("session_shutdown", async (_event, ctx) => this.shutdown(ctx));
		this.pi.on("session_tree", async (_event, ctx) => {
			this.captureContext(ctx);
			this.cancelPendingMessages();
		});
		this.pi.on("session_info_changed", async (event, ctx) => {
			this.captureContext(ctx);
			this.publishSessionInfo();
			this.emitPiWebEvent({ type: "session_info_changed", name: event.name });
		});
		this.pi.on("model_select", async (_event, ctx) => {
			this.captureContext(ctx);
			this.publishSessionInfo();
		});
		this.pi.on("thinking_level_select", async (event, ctx) => {
			this.captureContext(ctx);
			if (isRecord(event)) this.emitPiWebEvent({ type: "thinking_level_changed", level: event.level });
		});
		this.pi.on("session_before_compact", async (_event, ctx) => {
			this.captureContext(ctx);
			this.compacting = true;
			this.publishSessionInfo();
		});
		this.pi.on("session_compact", async (_event, ctx) => {
			this.compacting = false;
			this.captureContext(ctx);
		});
		this.pi.on("input", (event) => {
			if (event.source !== "extension") return;
			// Keep the envelope through later handlers so copied internal markers remain browser-originated.
			const wrapped = parseBrowserInput(event.text);
			if (!wrapped) return;
			const pending = this.pendingBrowserInputs.get(wrapped.nonce);
			if (!pending) return;
			this.acceptedBrowserInputs.set(wrapped.nonce, {
				text: pending.text,
				retainedImageIds: [...pending.retainedImageIds],
			});
			this.settleBrowserInput(wrapped.nonce);
		});
		this.pi.on("message_start", async (event, ctx) => {
			this.captureContext(ctx);
			this.streaming = true;
			const started = sanitizeBrowserMessageEvent(event, this.acceptedBrowserInputs, false);
			// Their client opens a streaming bubble from this snapshot and then applies deltas.
			if (isRecord(started)) this.emitPiWebEvent({ ...started, type: "message_start" });
		});
		this.pi.on("message_update", async (event, ctx) => {
			this.captureContext(ctx);
			this.streaming = true;
			// Every delta reaches the browser, which is what makes the answer appear as it is written
			// instead of all at once when the turn ends.
			if (isRecord(event)) this.emitPiWebEvent({ ...event, type: "message_update" });
		});
		this.pi.on("message_end", async (event, ctx) => {
			this.captureContext(ctx);
			if (isRecord(event) && isRecord(event.message)) {
				this.emitPiWebEvent({ type: "message_end", message: event.message });
			}
			const sanitized = sanitizeBrowserMessageEvent(event, this.acceptedBrowserInputs, true);
			// Pi applies this replacement before persistence and before the prompt reaches the model.
			if (sanitized !== event && isRecord(sanitized) && isRecord(sanitized.message)) {
				return { message: sanitized.message as unknown as typeof event.message };
			}
		});
		this.pi.on("tool_execution_start", async (event, ctx) => {
			this.captureContext(ctx);
			if (isRecord(event) && event.toolName === "bash") this.bashRunning = true;
			if (isRecord(event)) this.emitPiWebEvent({ ...event, type: "tool_execution_start" });
		});
		this.pi.on("tool_execution_update", async (event, ctx) => {
			this.captureContext(ctx);
			if (isRecord(event)) this.emitPiWebEvent({ ...event, type: "tool_execution_update" });
		});
		this.pi.on("tool_execution_end", async (event, ctx) => {
			this.captureContext(ctx);
			if (isRecord(event) && event.toolName === "bash") this.bashRunning = false;
			if (isRecord(event)) this.emitPiWebEvent({ ...event, type: "tool_execution_end" });
		});
		this.pi.on("agent_start", async (_event, ctx) => {
			this.captureContext(ctx);
			this.streaming = true;
			this.publishSessionInfo();
			this.emitPiWebEvent({ type: "agent_start" });
		});
		(this.pi as LatestExtensionAPI).on("agent_settled", async (_event, ctx) => {
			this.captureContext(ctx);
			if (ctx.isIdle() && !ctx.hasPendingMessages()) {
				this.streaming = false;
				this.bashRunning = false;
				this.acceptedBrowserInputs.clear();
				this.publishSessionInfo();
				this.emitPiWebEvent({ type: "agent_settled", aborted: false });
				this.emitPiWebEvent({ type: "agent_end", messages: [], willRetry: false });
			}
		});
	}

	async start(ctx: ExtensionContext): Promise<void> {
		const generation = ++this.generation;
		this.closed = true;
		this.sessionAbort.abort();
		this.cancelPendingMessages();
		this.cancelBrowserInputs("The Pi session changed before the browser prompt was accepted.");
		this.acceptedBrowserInputs.clear();
		await this.releaseServer();
		if (generation !== this.generation) return;
		await this.settingsSaveQueue;
		if (generation !== this.generation) return;
		const settingsResult = await this.dependencies.loadSettings();
		if (generation !== this.generation) return;
		this.applySettingsResult(settingsResult);
		this.sessionAbort = new AbortController();
		this.context = ctx;
		this.closed = false;
		this.registerLiveSession();
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		this.activityId += 1;
		ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);
		if (ctx.hasUI) ctx.ui.notify(EXPERIMENTAL_WARNING, "warning");
		if (settingsResult.warning) ctx.ui.notify(settingsResult.warning, "warning");
		if (!this.settings.startOnSessionStart) return;
		try {
			await this.presentLink(ctx);
		} catch (error) {
			if (generation !== this.generation || this.closed) return;
			ctx.ui.notify(`Pi WebUI could not start: ${formatError(error)}`, "error");
		}
	}

	async shutdown(ctx: ExtensionContext): Promise<void> {
		const generation = ++this.generation;
		this.closed = true;
		setLiveSession(undefined);
		this.sessionAbort.abort();
		this.cancelPendingMessages();
		this.cancelBrowserInputs("The Pi session ended before the browser prompt was accepted.");
		this.acceptedBrowserInputs.clear();
		await this.settingsSaveQueue;
		if (generation !== this.generation) return;
		await this.releaseServer();
		if (generation !== this.generation) return;
		this.context = undefined;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		this.activityId += 1;
		ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);
	}

	private captureContext(ctx: ExtensionContext): void {
		if (!this.closed) this.context = ctx;
	}



	private cancelPendingMessages(): void {
		this.activeMessageIds.clear();
		for (const timer of this.finalMessageTimers) clearTimeout(timer);
		this.finalMessageTimers.clear();
	}


	private async presentLink(ctx: ExtensionContext): Promise<void> {
		const service = await this.ensureService();
		const channel = this.ensureChannel(service);
		const status = await this.waitForChannel();
		if (status.state === "connected" && channel.sessionUrl()) {
			const url = channel.sessionUrl() as string;
			ctx.ui.setWidget(WIDGET_KEY, [`🌐 Pi WebUI: ${url}`]);
			ctx.ui.notify(`Pi WebUI: ${url}`, "info");
			return;
		}
		const reason = status.error ?? "no answer";
		ctx.ui.setWidget(WIDGET_KEY, [`🌐 Pi WebUI (waiting for the hub)`]);
		ctx.ui.notify(
			`Pi WebUI: the hub at ${status.hubUrl} did not answer (${reason}).\nThis session stays ready and connects as soon as the hub runs.\nInstall or restart it with /webui hub.`,
			"warning",
		);
	}

	/**
	 * Give a fresh connection a moment to settle so `/webui open` reports what actually happened
	 * instead of racing the handshake.
	 */
	private async waitForChannel(): Promise<ChannelStatus> {
		const deadline = Date.now() + CHANNEL_CONNECT_WAIT_MS;
		while (this.hubStatus.state !== "connected" && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return this.hubStatus;
	}

	private async openWebUI(ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.mode === "print" || ctx.mode === "json") return;
		const activityId = ++this.activityId;
		ctx.ui.setStatus(
			ACTIVITY_STATUS_KEY,
			this.server ? "Creating fresh WebUI link…" : "Starting WebUI…",
		);
		try {
			await this.presentLink(ctx);
		} finally {
			if (activityId === this.activityId) {
				ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);
			}
		}
	}

	private menuState(): WebUIMenuState {
		return {
			serverRunning: this.server !== undefined,
			hubState: this.hubStatus.state,
			hubUrl: this.hubStatus.hubUrl,
			channelUrl: this.hubStatus.channelUrl,
			startupAutomatic: this.settings.startOnSessionStart,
			settingsSource:
				this.settingsDocument === undefined
					? "Defaults (invalid file ignored)"
					: this.settingsSource === "settings file"
						? "Settings file"
						: "Defaults",
			settingsPath: this.settingsPath,
			settingsInvalid: this.settingsDocument === undefined,
		};
	}

	/**
	 * Serialize one settings patch through the save queue, mirroring the accepted document back into
	 * memory. Shared by every editable row so they cannot drift in locking, validation, or error text.
	 */
	private async persistSettings(
		patch: Partial<WebUISettings>,
		ctx: ExtensionCommandContext,
		generation: number,
	): Promise<boolean> {
		let accepted = false;
		const operation = this.settingsSaveQueue.then(async () => {
			if (!this.settingsDocument) {
				throw new Error("the invalid settings file must be repaired manually first");
			}
			const document = await this.dependencies.saveSettings(patch, this.settingsDocument, this.settingsPath);
			if (generation !== this.generation || this.closed) return;
			this.settings = { ...this.settings, ...patch };
			this.settingsDocument = document;
			this.settingsSource = "settings file";
			accepted = true;
		});
		this.settingsSaveQueue = operation.catch(() => undefined);
		try {
			await operation;
		} catch (error) {
			if (generation === this.generation && !this.closed) {
				ctx.ui.notify(`WebUI settings save failed: ${formatError(error)}`, "error");
			}
		}
		return accepted;
	}

	private async showMenu(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) return;
		await this.runStandardMenu(ctx, "main");
	}

	private async showSettings(ctx: ExtensionCommandContext): Promise<void> {
		if (this.settingsDocument === undefined) {
			if (ctx.mode === "tui") await this.runStandardMenu(ctx, "repair");
			else if (ctx.hasUI) ctx.ui.notify(this.repairLines().join("\n"), "warning");
			return;
		}
		if (ctx.mode !== "tui") {
			if (ctx.hasUI) ctx.ui.notify(`Edit WebUI settings manually: ${this.settingsPath}`, "info");
			return;
		}
		await this.runStandardMenu(ctx, "settings");
	}

	private async runStandardMenu(
		ctx: ExtensionCommandContext,
		start: "main" | "settings" | "repair",
	): Promise<void> {
		const generation = this.generation;
		const menuSignal = this.sessionAbort.signal;
		const isCurrent = () => generation === this.generation && !this.closed && !menuSignal.aborted;
		const { defineMenu, runMenu } = await import("@narumitw/pi-tui-kit");
		if (!isCurrent()) return;
		type Screen = "main" | "settings" | "hub-port" | "repair" | "status" | "help";
		type Action = "open" | "settings" | "save-startup" | "edit-hub-port" | "save-hub-port";
		const menu = defineMenu<undefined, Screen, Action, ExtensionCommandContext>({
			start,
			screens: {
				main: () => {
					const state = this.menuState();
					return {
						kind: "actions",
						title: "Pi WebUI",
						lines: webUIMenuTitle(state).split("\n").slice(1),
						items: webUIMenuItems(state).map((item) => {
							if (item.value === "open") {
								return { ...item, id: item.value, action: "open" as const };
							}
							if (item.value === "settings") {
								return { ...item, id: item.value, action: "settings" as const };
							}
							return { ...item, id: item.value, to: item.value as "repair" | "status" | "help" };
						}),
						hint: "close",
					};
				},
				settings: () => ({
					kind: "settings",
					title: "Pi WebUI Settings",
					lines: [
						"Changes save immediately. Startup changes apply on the next session initialization or reload.",
						`Advanced settings: ${safeTerminalText(this.settingsPath)}`,
					],
					items: [
						{
							id: "startOnSessionStart",
							label: "Start WebUI automatically",
							description: "Choose whether future Pi session initializations display a WebUI link",
							currentValue: this.settings.startOnSessionStart ? "Every session" : "Manual",
							values: ["Manual", "Every session"],
							action: "save-startup",
						},
						{
							id: "hubPort",
							label: "Hub port",
							description: "The port both the hub service and this extension read from this file",
							currentValue: String(this.settings.hubPort),
							action: "edit-hub-port",
						},
					],
				}),
				"hub-port": () => ({
					kind: "input",
					title: "Hub port",
					lines: [
						"The port the hub service listens on and this extension connects to.",
						`Saved to ${safeTerminalText(this.settingsPath)}; restart the service to apply it: systemctl --user restart pi-webui-hub.service`,
					],
					placeholder: String(this.settings.hubPort),
					initialValue: String(this.settings.hubPort),
					action: "save-hub-port",
					hint: "back",
				}),
				repair: () => ({
					kind: "detail",
					title: "Repair WebUI settings",
					lines: this.repairLines(),
					hint: "back",
				}),
				status: () => ({
					kind: "detail",
					title: "Pi WebUI status",
					lines: this.statusLines(),
					hint: "back",
				}),
				help: () => ({
					kind: "detail",
					title: "Pi WebUI help",
					lines: this.helpLines(),
					hint: "back",
				}),
			},
			actions: {
				open: async () => {
					await this.openWebUI(ctx);
					return { kind: "close" };
				},
				settings: async () => {
					if (this.settingsDocument === undefined) return { kind: "to", screen: "repair" };
					if (ctx.mode !== "tui") {
						ctx.ui.notify(`Edit WebUI settings manually: ${this.settingsPath}`, "info");
						return { kind: "stay" };
					}
					return { kind: "to", screen: "settings" };
				},
				"edit-hub-port": async () => {
					if (this.settingsDocument === undefined) return { kind: "to", screen: "repair" };
					return { kind: "to", screen: "hub-port" };
				},
				"save-hub-port": async ({ value }) => {
					const parsed = Number.parseInt(String(value).trim(), 10);
					if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
						ctx.ui.notify("The hub port must be an integer between 1 and 65535.", "error");
						return { kind: "stay" };
					}
					const accepted = await this.persistSettings({ hubPort: parsed }, ctx, generation);
					if (accepted) {
						ctx.ui.notify(
							`Hub port is now ${parsed}. Restart the service to apply it: systemctl --user restart ${HUB_UNIT_NAME}`,
							"info",
						);
					}
					return accepted ? { kind: "stay" } : { kind: "rejected" };
				},
				"save-startup": async ({ value }) => {
					const requested = value === "Every session";
					const accepted = await this.persistSettings({ startOnSessionStart: requested }, ctx, generation);
					return accepted ? { kind: "stay" } : { kind: "rejected" };
				},
			},
		});
		await runMenu(ctx, menu, {
			getState: () => undefined,
			signal: menuSignal,
			isCurrent,
		});
	}

	private statusLines(): string[] {
		const source =
			this.settingsDocument === undefined ? "Defaults (invalid file ignored)" : this.settingsSource;
		return [
			`Server: ${this.server ? `Running on ${this.server.origin}` : "Stopped"}`,
			`Hub: ${hubStatusLine(this.hubStatus)}`,
			`Hub settings: ${hubSettingsLine()}`,
			...(this.hub?.sessionUrl() ? [`Link: ${this.hub.sessionUrl()}`] : []),
			`Channel: ${safeTerminalText(this.hubStatus.channelUrl)}`,
			`Startup: ${this.settings.startOnSessionStart ? "Every session" : "Manual"} (${source})`,
			`Settings: ${safeTerminalText(this.settingsPath)}`,
		];
	}

	private showStatus(ctx: ExtensionCommandContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.notify(["Pi WebUI status", ...this.statusLines()].join("\n"), "info");
	}

	private helpLines(): string[] {
		return [
			COMMAND_USAGE,
			"/webui: open the current-state menu",
			"open: publish this session through the hub and display its browser link",
			"hub: print the systemd user unit that runs the shared, fixed-port hub",
			"settings: edit WebUI settings in TUI mode",
			"status: show effective settings, source, path, hub state, and current server state",
			"init: create the defaults file without overwriting existing content",
			'Accepted JSON starts with { "startOnSessionStart": false }; the hub port and allowed hosts live under "hub".',
			`Settings path: ${safeTerminalText(this.settingsPath)}`,
			"Image byte/pixel limits stay in Advanced JSON; Pi provider-ready dimension/Base64 limits are fixed.",
			"Settings changes save immediately; startup changes apply on the next session initialization or reload.",
		];
	}

	private repairLines(): string[] {
		return [
			"The settings file is invalid and was preserved without changes.",
			"Safe defaults remain active; settings writes are paused.",
			`File: ${safeTerminalText(this.settingsPath)}`,
			"Repair the JSON file, then run /reload before editing settings again.",
		];
	}

	private showHelp(ctx: ExtensionCommandContext): void {
		if (!ctx.hasUI) return;
		ctx.ui.notify(this.helpLines().join("\n"), "info");
	}

	/** Print the systemd user unit and the install steps; the extension never spawns the hub. */
	private async showHub(ctx: ExtensionCommandContext): Promise<void> {
		if (!ctx.hasUI) return;
		const status = this.hubStatus;
		const lines = [
			"Pi WebUI hub",
			`State: ${hubStatusLine(status)}`,
			`Browser index: ${status.hubUrl}`,
			"",
			`Write this unit to ~/.config/systemd/user/${HUB_UNIT_NAME}:`,
			"",
			renderHubUnit(),
			"Then run:",
			...hubInstallSteps().map((step) => `  ${step}`),
			"",
			"The hub only routes requests to connected Pi sessions; it never reads or writes Pi session state.",
		];
		ctx.ui.notify(lines.join("\n"), status.state === "connected" ? "info" : "warning");
	}

	private async initializeSettings(ctx: ExtensionCommandContext): Promise<void> {
		const generation = this.generation;
		let result: "created" | "exists";
		try {
			result = await this.dependencies.initializeSettings(this.settingsPath);
		} catch (error) {
			if (generation !== this.generation || this.closed) return;
			throw error;
		}
		if (generation !== this.generation || this.closed) return;
		if (ctx.hasUI) {
			ctx.ui.notify(
				result === "created"
					? `Created WebUI settings: ${this.settingsPath}`
					: `WebUI settings already exists and was not overwritten: ${this.settingsPath}`,
				"info",
			);
		}
		const loaded = await this.dependencies.loadSettings(this.settingsPath);
		if (generation !== this.generation || this.closed) return;
		this.applySettingsResult(loaded);
		if (loaded.warning && ctx.hasUI) ctx.ui.notify(loaded.warning, "warning");
		if (ctx.mode === "tui") await this.showSettings(ctx);
	}

	private applySettingsResult(result: SettingsLoadResult): void {
		this.settings = { ...result.settings };
		this.settingsDocument = result.kind === "invalid" ? undefined : { ...(result.document ?? {}) };
		this.settingsPath = result.path;
		this.settingsSource = result.source;
	}

	/**
	 * Build this session's web service. It owns no listener: the hub drives it over the channel, so
	 * the hub is the only port on the machine.
	 */
	private async ensureService(): Promise<ServerControl> {
		if (this.closed) throw new Error("the Pi session is not ready");
		if (this.server) return this.server;
		if (!this.serverStarting) {
			const generation = this.generation;
			const starting = this.dependencies.createService(
				{
					piWeb: {
						sessionId: () => this.context?.sessionManager.getSessionId() ?? "",
						autoName: (id) => this.piWebAutoName(id),
						command: (command) => this.piWebCommand(command),
						state: async () => this.piWebState(),
						isRunning: () => !(this.context?.isIdle() ?? true),
						subscribe: (listener) => this.subscribePiWebEvents(listener),
					},
					controls: {
						models: async () => this.listSessionModels(),
						setModel: (provider, id) => this.setSessionModel(provider, id, generation),
						setThinkingLevel: async (level) => this.setSessionThinkingLevel(level, generation),
						compact: async () => this.compactSession(generation),
					},
				},
				// The browser reaches this session through the hub, so the hub's origin is the one
				// mutations are checked against.
				hubBaseUrl().replace(/\/+$/, ""),
			);
			this.serverStarting = Promise.resolve(starting).then(async (server) => {
				if (generation !== this.generation || this.closed) {
					await server.close();
					throw new Error("the Pi session changed while the server was starting");
				}
				this.server = server;
				return server;
			});
		}
		const starting = this.serverStarting;
		try {
			return await starting;
		} finally {
			if (this.serverStarting === starting) this.serverStarting = undefined;
		}
	}



	/**
	 * Run a slash command the page can run itself, or explain where the terminal-only ones live.
	 * Returns undefined for anything else, which is then sent to Pi exactly as the composer wrote it,
	 * so a registered command, a skill or a prompt template is still Pi's to dispatch.
	 */
	private runBuiltinCommand(text: string, ctx: ExtensionContext): { accepted: true; command?: string } | undefined {
		const command = parseSlashCommand(text);
		if (!command) return undefined;
		if (this.pi.getCommands().some((entry) => entry.name === command.name)) return undefined;
		const builtin = BUILTIN_COMMANDS.find((entry) => entry.name === command.name);
		if (!builtin) return undefined;
		const argument = command.args.trim();
		switch (builtin.support) {
			case "compact":
				ctx.compact();
				return { accepted: true, command: builtin.name };
			case "name":
				if (!argument) throw new Error("Usage: /name <session name>");
				this.pi.setSessionName(argument.slice(0, 120));
				this.publishSessionInfo();
				return { accepted: true, command: builtin.name };
			case "thinking": {
				const requested = argument.toLowerCase();
				if (!(THINKING_LEVELS as readonly string[]).includes(requested)) {
					throw new Error(`Thinking level must be one of ${THINKING_LEVELS.join(", ")}.`);
				}
				this.pi.setThinkingLevel(requested as (typeof THINKING_LEVELS)[number]);
				return { accepted: true, command: builtin.name };
			}
			case "models":
				throw new Error("/model is the model chip in this page's top bar.");
			default:
				throw new Error(`/${builtin.name} runs in the terminal: ${builtin.description.toLowerCase()}.`);
		}
	}



	private settleBrowserInput(nonce: string, error?: Error): void {
		const pending = this.pendingBrowserInputs.get(nonce);
		if (!pending) return;
		this.pendingBrowserInputs.delete(nonce);
		if (error) pending.reject(error);
		else pending.resolve();
	}

	private cancelBrowserInputs(message: string): void {
		for (const nonce of [...this.pendingBrowserInputs.keys()]) {
			this.settleBrowserInput(nonce, new Error(message));
		}
	}


	/**
	 * Publish this session to the hub. The hub only routes requests, so registering cannot affect
	 * the Pi session itself; when no hub is running the session keeps its own loopback server.
	 */
	/** Dial the hub. One WebSocket carries this session; nothing here listens for the browser. */
	private ensureChannel(service: ServerControl): HubChannel {
		if (this.closed) throw new Error("the Pi session is not ready");
		if (this.hub) return this.hub;
		const generation = this.generation;
		const channel = this.dependencies.createChannel({
			session: () => this.hubSessionInfo(),
			serve: (request, response) => service.serve(request, response),
			onChange: (status) => {
				if (generation === this.generation && !this.closed) this.hubStatus = status;
			},
		});
		this.hub = channel;
		// Status arrives through `onChange`; taking `start()`'s return value would race the handshake.
		this.hubStatus = channel.statusSnapshot();
		channel.start();
		return channel;
	}

	private releaseHub(): void {
		const hub = this.hub;
		this.hub = undefined;
		hub?.stop();
		this.hubStatus = idleChannelStatus();
	}

	/**
	 * The live state their `AgentStateResponse` describes.
	 *
	 * Every field is optional on their side but each one drives something visible: `model` names the
	 * top bar's model chip, `contextUsage` its context meter, `systemPrompt` and `queuedMessages` the
	 * panels behind them, and the `is*` flags decide whether their UI shows a run as streaming, as a
	 * command, or as idle. `extensionStatuses`/`extensionWidgets` stay empty because Pi does not let
	 * an extension read another extension's statuses back; theirs arrive with the event stream.
	 */
	/**
	 * Tell the copied routes which session this process is.
	 *
	 * Their `/api/**` handlers were written against a registry of sessions their server spawned. Here
	 * the session is this process, and their `rpc-manager` shim reads this registration instead: it
	 * answers for this id, and every other id falls through to their own disk-reading paths.
	 */
	private registerLiveSession(): void {
		const ctx = this.context;
		if (!ctx || this.closed) {
			setLiveSession(undefined);
			return;
		}
		const session: LiveSession = {
			sessionId: ctx.sessionManager.getSessionId(),
			cwd: ctx.cwd,
			// Optional: the file appears once Pi has written the session, and mocks may omit it.
			sessionFile: ctx.sessionManager.getSessionFile?.() ?? undefined,
			inner: {
				sessionManager: ctx.sessionManager,
				sessionId: ctx.sessionManager.getSessionId(),
				getSessionName: () => this.pi.getSessionName(),
				setSessionName: (name: string) => this.pi.setSessionName(name),
			} as unknown as LiveSession["inner"],
			isAlive: () => !this.closed && this.context === ctx,
			isRunning: () => !ctx.isIdle() || ctx.hasPendingMessages(),
			evictIfDiskAhead: () => false,
			waitUntilReady: async () => undefined,
			send: (command) => this.piWebCommand(command),
			hasSuppressedCompletionNotifications: () => false,
		};
		setLiveSession(session);
	}

	/**
	 * Their "generate title", run through their own generator.
	 *
	 * `generateSessionTitle` wants the live `AgentSession`, which an extension does not hold — but the
	 * only parts of it the title path touches are the transcript, the model and one streaming call,
	 * and the extension has all three (`ctx.sessionManager`, `ctx.model`, `ctx.modelRegistry`). So the
	 * request their server would make is made here with the same prompt, parser and options.
	 *
	 * A model failure falls back to the session's first line, which is what their sidebar shows for an
	 * unnamed session anyway, so the button always names the session.
	 */
	private async piWebAutoName(id: string): Promise<{ title: string; usage?: unknown } | undefined> {
		const ctx = this.context;
		if (!ctx || this.closed) return undefined;
		if (id && id !== ctx.sessionManager.getSessionId()) return undefined;
		const entries = (ctx.sessionManager.getEntries() ?? []) as unknown as SessionEntry[];
		const messages = entries
			.filter((entry) => entry.type === "message")
			.map((entry) => (entry as { message?: unknown }).message)
			.filter((message): message is Record<string, unknown> => isRecord(message));
		const model = ctx.model;
		let title = "";
		let usage: unknown;
		if (model) {
			try {
				const generated = await generateSessionTitle({
					state: { model, messages },
					agent: {
						state: { messages, model },
						getApiKey: (provider: string) => ctx.modelRegistry.getApiKeyForProvider(provider),
						streamFunction: (requestModel: unknown, context: unknown, options: unknown) =>
							ctx.modelRegistry.streamSimple(
								requestModel as Parameters<typeof ctx.modelRegistry.streamSimple>[0],
								context as Parameters<typeof ctx.modelRegistry.streamSimple>[1],
								options as Parameters<typeof ctx.modelRegistry.streamSimple>[2],
							),
					},
				} as unknown as Parameters<typeof generateSessionTitle>[0]);
				title = generated.title;
				usage = generated.usage;
			} catch {
				// Fall back to the first line below.
			}
		}
		if (!title) title = this.firstUserLine(messages) ?? "";
		if (!title) return undefined;
		this.pi.setSessionName(title);
		invalidateSessionListCache();
		this.publishSessionInfo();
		return { title, ...(usage ? { usage } : {}) };
	}

	/** The session's first user line, flattened for a name. */
	private firstUserLine(messages: readonly Record<string, unknown>[]): string | undefined {
		for (const message of messages) {
			if (message.role !== "user") continue;
			const content = message.content;
			const text = typeof content === "string" ? content : textOf(content);
			const line = firstLine(text);
			if (line) return line;
		}
		return undefined;
	}

	private piWebState(): unknown {
		const ctx = this.context;
		if (!ctx || this.closed) return undefined;
		const usage = ctx.getContextUsage();
		return {
			model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
			contextUsage: usage ? { percent: usage.percent, contextWindow: usage.contextWindow, tokens: usage.tokens } : null,
			systemPrompt: ctx.getSystemPrompt(),
			thinkingLevel: this.pi.getThinkingLevel(),
			isStreaming: this.streaming,
			isPromptRunning: !ctx.isIdle() || ctx.hasPendingMessages(),
			isBashRunning: this.bashRunning,
			isCompacting: this.compacting,
			autoCompactionEnabled: this.autoCompactionEnabled(),
			extensionStatuses: [],
			extensionWidgets: [],
			queuedMessages: { steering: [], followUp: [] },
		};
	}

	/** Pi's setting for automatic compaction, which their compact button mirrors. */
	private autoCompactionEnabled(): boolean | undefined {
		try {
			const settings = this.pi.getSettings() as { autoCompaction?: unknown; compaction?: { auto?: unknown } };
			const value = settings.autoCompaction ?? settings.compaction?.auto;
			return typeof value === "boolean" ? value : undefined;
		} catch {
			return undefined;
		}
	}

	/** Their tool list: `get_tools` answers with an array, and `active` is what the picker reads. */
	private piWebTools(): unknown {
		const active = new Set(this.pi.getActiveTools());
		return this.pi.getAllTools().map((tool) => ({
			name: tool.name,
			description: tool.description ?? "",
			active: active.has(tool.name),
			// Their picker shows a tool that is active but kept out of the request's tool list.
			declarationHidden: tool.exposure !== "direct",
			...(tool.parameters ? { parameters: tool.parameters as unknown as Record<string, unknown> } : {}),
			...(tool.promptGuidelines ? { promptGuidelines: [...tool.promptGuidelines] } : {}),
		}));
	}


	/**
	 * Their event stream, from the inside.
	 *
	 * Every listener sees events in exactly the shape their server puts on the wire, because the
	 * mapping is theirs (`lib/agent-event-wire.ts`, vendored): it strips the cumulative snapshot from
	 * a delta, drops the transcript's prompt/tool-loadout system messages, trims nested tool calls
	 * and omits the event types their browser never reads. Doing it in one place keeps us in step
	 * with them as they change it.
	 */
	private subscribePiWebEvents(listener: (event: unknown) => void): () => void {
		const mapped = (event: unknown) => {
			if (!isRecord(event) || typeof event.type !== "string") return;
			const clientEvent = toClientAgentEvent(event as { type: string } & Record<string, unknown>);
			if (clientEvent) listener(clientEvent);
		};
		this.piWebListeners.add(mapped);
		return () => this.piWebListeners.delete(mapped);
	}

	private emitPiWebEvent(event: Record<string, unknown>): void {
		if (this.piWebListeners.size === 0) return;
		for (const listener of [...this.piWebListeners]) {
			try {
				listener(event);
			} catch {
				this.piWebListeners.delete(listener);
			}
		}
	}



	/** Their RPC-shaped commands, mapped onto Pi's own API inside this process. */
	private async piWebCommand(command: Record<string, unknown>): Promise<unknown> {
		const ctx = this.context;
		if (!ctx || this.closed) throw new Error("The Pi session has ended.");
		const type = typeof command.type === "string" ? command.type : "";
		const text = typeof command.message === "string" ? command.message : "";
		// Their composer sends attached images inline as base64; Pi takes the same shapes, so the
		// prompt carries text and images together and nothing has to be staged or uploaded first.
		const images = browserPromptImages(command.images);
		const content: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> =
			images.length === 0
				? text
				: text.trim()
					? [{ type: "text" as const, text }, ...images]
					: images;
		switch (type) {
			case "prompt": {
				const behavior = command.streamingBehavior;
				const handled = images.length === 0 ? this.runBuiltinCommand(text, ctx) : undefined;
				if (handled) return handled;
				this.pi.sendUserMessage(content, {
					expandPromptTemplates: true,
					...(behavior === "steer" ? { deliverAs: "steer" as const } : {}),
					...(behavior === "followUp" ? { deliverAs: "followUp" as const } : {}),
				});
				return { accepted: true };
			}
			case "steer":
			case "follow_up":
				this.pi.sendUserMessage(content, {
					expandPromptTemplates: true,
					deliverAs: type === "steer" ? "steer" : "followUp",
				});
				return { accepted: true };
			case "abort":
				ctx.abort();
				return { aborted: true };
			case "set_model": {
				const provider = String(command.provider ?? "");
				const modelId = String(command.modelId ?? command.model ?? "");
				const model = ctx.modelRegistry.find(provider, modelId);
				if (!model) throw new Error(`Unknown model "${provider}/${modelId}".`);
				if (!(await this.pi.setModel(model))) throw new Error(`No authentication for "${provider}/${modelId}".`);
				return { model: { provider, modelId } };
			}
			case "set_thinking_level": {
				const level = String(command.level ?? "");
				if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
					throw new Error(`Unknown thinking level "${level}".`);
				}
				this.pi.setThinkingLevel(level as (typeof THINKING_LEVELS)[number]);
				return { level };
			}
			case "compact":
				ctx.compact();
				return { started: true };
			case "set_session_name":
				this.pi.setSessionName(String(command.name ?? "").slice(0, 120));
				return { name: command.name };
			case "set_tools": {
				const names = Array.isArray(command.toolNames) ? command.toolNames.map(String) : [];
				this.pi.setActiveTools(names);
				return { tools: names };
			}
			case "get_state":
				// Their state shape, not ours: `{provider, id}` names the model chip, and the rest
				// fills in the meter, the queue and the run flags their top bar reads.
				return this.piWebState();
			case "get_commands":
				return this.commandList();
			case "get_tools":
				// Their `get_tools` answers with the array itself; the picker calls `.filter` on it.
				return this.piWebTools();
			case "get_session_stats": {
				const entries = (ctx.sessionManager.getEntries() ?? []) as unknown as SessionEntry[];
				return { stats: computeSessionStats(entries) };
			}
			case "navigate_tree": {
				// Their "edit from here", their branch list, and the tree picker all arrive as this
				// one command; Pi applies it to the session's own tree.
				const targetId = typeof command.targetId === "string" ? command.targetId : "";
				if (!targetId) throw new Error("navigate_tree needs a targetId");
				if (!this.commandContext) {
					throw new Error("Open the web companion with /webui in this session, then try again.");
				}
				const result = await this.commandContext.navigateTree(targetId);
				this.publishSessionInfo();
				return result ?? {};
			}
			case "clear_queue":
				return { steering: [], followUp: [] };
			case "set_auto_compaction":
				return { enabled: Boolean(command.enabled) };
			case "abort_bash":
			case "abort_compaction":
			case "abort_retry":
				return {};
			default:
				throw new Error(`/${type} runs in the terminal, not in the browser.`);
		}
	}



	/** Everything the composer can offer under `/`: Pi's commands plus the built-ins we implement. */
	private commandList(): Array<{ name: string; description?: string }> {
		const commands: Array<{ name: string; description?: string }> = [];
		try {
			for (const command of this.pi.getCommands()) {
				commands.push({
					name: command.name,
					...(command.description ? { description: command.description } : {}),
				});
			}
		} catch {
			// No command list is better than no page.
		}
		const known = new Set(commands.map((command) => command.name));
		for (const builtin of BUILTIN_COMMANDS) {
			if (known.has(builtin.name)) continue;
			commands.push({ name: builtin.name, description: builtin.description });
		}
		return commands;
	}

	/** Choose the model for this session only; the configured default stays untouched. */
	private async setSessionModel(provider: string, id: string, generation: number): Promise<void> {
		const ctx = this.context;
		if (!ctx || this.closed || generation !== this.generation) throw new Error("The Pi session has ended.");
		const model = ctx.modelRegistry.find(provider, id);
		if (!model) throw new Error(`Unknown model "${provider}/${id}".`);
		if (!(await this.pi.setModel(model))) {
			throw new Error(`"${provider}/${id}" has no configured authentication.`);
		}
		this.publishSessionInfo();
	}

	private setSessionThinkingLevel(level: string, generation: number): void {
		const ctx = this.context;
		if (!ctx || this.closed || generation !== this.generation) throw new Error("The Pi session has ended.");
		if (!(THINKING_LEVELS as readonly string[]).includes(level)) {
			throw new Error(`Unknown thinking level "${level}".`);
		}
		this.pi.setThinkingLevel(level as (typeof THINKING_LEVELS)[number]);
	}

	private compactSession(generation: number): void {
		const ctx = this.context;
		if (!ctx || this.closed || generation !== this.generation) throw new Error("The Pi session has ended.");
		ctx.compact();
	}

	/** Models this session can switch to: the scoped set when configured, else everything usable. */
	private listSessionModels(): Array<{ provider: string; id: string; name?: string }> {
		const ctx = this.context;
		if (!ctx) return [];
		const scoped = ctx.scopedModels;
		const models = scoped.length > 0 ? scoped.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
		const seen = new Set<string>();
		const options: Array<{ provider: string; id: string; name?: string }> = [];
		for (const model of models) {
			const key = `${model.provider}/${model.id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			options.push({ provider: model.provider, id: model.id, ...(model.name ? { name: model.name } : {}) });
		}
		return options.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
	}

	/** Tell the hub what changed: activity, name, or model. */
	private publishSessionInfo(): void {
		if (!this.hub || this.closed) return;
		this.hub.setSession(this.hubSessionInfo());
	}

	private hubSessionInfo(): HubSessionInfo {
		const ctx = this.context;
		const sessionId = ctx?.sessionManager.getSessionId() ?? "unknown";
		const name = ctx?.sessionManager.getSessionName();
		const version = packageVersion();
		return {
			sessionId,
			activity: ctx ? (ctx.isIdle() && !ctx.hasPendingMessages() ? "idle" : "running") : "unknown",
			...(ctx?.cwd ? { cwd: ctx.cwd, projectName: basename(ctx.cwd) || ctx.cwd } : {}),
			...(name ? { name } : {}),
			...(ctx?.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}),
			...(PI_VERSION ? { piVersion: PI_VERSION } : {}),
			...(version ? { extensionVersion: version } : {}),
		};
	}

	private async releaseServer(): Promise<void> {
		// Claim the current server synchronously so a concurrent replacement session never waits on
		// a slow close that belongs to the previous generation.
		const server = this.server;
		const starting = this.serverStarting;
		this.server = undefined;
		this.serverStarting = undefined;
		this.releaseHub();
		if (server) await server.close();
		if (starting) {
			try {
				await (await starting).close();
			} catch {
				// Failed and generation-stale startups have no remaining live server.
			}
		}
	}
}

/** `/<name> [args]`, or undefined when the text merely starts with a slash. */
function parseSlashCommand(text: string): { name: string; args: string } | undefined {
	const match = /^\/([A-Za-z0-9:_-]{1,64})(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!match) return undefined;
	return { name: match[1] as string, args: match[2] ?? "" };
}


function parseBrowserInput(text: string): { nonce: string } | undefined {
	const header = INPUT_HEADER.exec(text);
	if (
		!header?.[1] ||
		!text.endsWith(INPUT_FOOTER) ||
		text.slice(header[0].length, -INPUT_FOOTER.length) !== ""
	) {
		return undefined;
	}
	return { nonce: header[1] };
}


function sanitizeBrowserMessageEvent(
	event: unknown,
	acceptedNonces: Map<string, AcceptedBrowserInput>,
	consume: boolean,
): unknown {
	if (!isRecord(event) || !isRecord(event.message) || event.message.role !== "user") return event;
	const content = event.message.content;
	if (typeof content === "string") {
		const wrapped = parseBrowserInput(content);
		const accepted = wrapped ? acceptedNonces.get(wrapped.nonce) : undefined;
		if (!wrapped || !accepted) return event;
		if (consume) acceptedNonces.delete(wrapped.nonce);
		return {
			...event,
			retainedImageIds: [...accepted.retainedImageIds],
			message: { ...event.message, content: accepted.text },
		};
	}
	if (!Array.isArray(content)) return event;
	let accepted: AcceptedBrowserInput | undefined;
	let acceptedNonce: string | undefined;
	const sanitizedText = content.flatMap((part) => {
		if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return [part];
		const wrapped = parseBrowserInput(part.text);
		const candidate = wrapped ? acceptedNonces.get(wrapped.nonce) : undefined;
		if (!wrapped || !candidate) return [part];
		accepted = candidate;
		acceptedNonce = wrapped.nonce;
		return candidate.text ? [{ ...part, text: candidate.text }] : [];
	});
	if (!accepted) return event;
	if (consume && acceptedNonce) acceptedNonces.delete(acceptedNonce);
	return {
		...event,
		retainedImageIds: [...accepted.retainedImageIds],
		message: { ...event.message, content: sanitizedText },
	};
}



function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function _formatMib(bytes: number): string {
	return `${bytes / (1024 * 1024)} MiB`;
}


function hubSettingsLine(): string {
	const read: HubConfigRead = readHubConfig();
	const port = read.portFromFile ? `${read.config.port} (${CONFIG_FILE_NAME})` : `${read.config.port} (default)`;
	const extras = read.config.allowedHosts.length;
	return `port ${port}, ${extras} allowed host name${extras === 1 ? "" : "s"} from ${safeTerminalText(read.path)}`;
}

function idleChannelStatus(): ChannelStatus {
	const hubUrl = hubBaseUrl();
	return { state: "closed", hubUrl, channelUrl: channelUrl(hubUrl), protocol: HUB_PROTOCOL };
}

function hubStatusLine(status: ChannelStatus): string {
	if (status.state === "connected") return `connected to ${status.hubUrl}`;
	if (status.state === "closed") return `not started (${status.hubUrl})`;
	const detail = status.error ? `: ${status.error}` : "";
	return `${status.state === "connecting" ? "connecting to" : "waiting for"} ${status.hubUrl}${detail}`;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
