import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import type { PreparedAttachment } from "./attachments.js";
import { ConversationProjection, projectBranchMessages } from "./conversation.js";
import { HubClient, type HubClientOptions, type HubClientStatus } from "./hub-client.js";
import { HUB_UNIT_NAME, hubInstallSteps, packageVersion, renderHubUnit } from "./hub-install.js";
import { type HubRegistration, hubBaseUrl } from "./hub-protocol.js";
import { DEFAULT_IMAGE_LIMITS, type ImageLimits, imageLimits } from "./image-limits.js";
import {
	type BrowserImageInput,
	type ProcessBrowserImageOptions,
	type ProcessedBrowserImage,
	processBrowserImages,
	processStagedImage,
	validateStagedBrowserImages,
} from "./images.js";
import { safeTerminalText, type WebUIMenuState, webUIMenuItems, webUIMenuTitle } from "./menu.js";
import { type EffectivePiImageSettings, readEffectivePiImageSettings } from "./pi-settings.js";
import {
	type WebSendRequest,
	type WebSendResult,
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

const WIDGET_KEY = "webui";
const ACTIVITY_STATUS_KEY = "webui:activity";
const EXPERIMENTAL_WARNING =
	"pi-webui is experimental; its browser workflow and package API may change.";
const INPUT_HEADER = /^<pi-webui-input nonce="([0-9a-f-]+)">\n/;
const INPUT_FOOTER = "\n</pi-webui-input>";
const COMMAND_USAGE = "Usage: /webui [open|hub|settings|status|help|init]";
const COMMAND_COMPLETIONS = [
	{ value: "open", label: "open", description: "Open this session in the browser" },
	{ value: "hub", label: "hub", description: "Show the systemd unit for the shared hub" },
	{ value: "settings", label: "settings", description: "Open WebUI settings" },
	{ value: "status", label: "status", description: "Show effective WebUI settings and state" },
	{ value: "help", label: "help", description: "Show WebUI command help" },
	{ value: "init", label: "init", description: "Create the default WebUI settings file" },
];

type ServerControl = Pick<WebUIServer, "directUrl" | "close" | "port" | "origin">;
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
	startServer(options: WebUIServerOptions): Promise<ServerControl>;
	readPiSettings(cwd: string, projectTrusted: boolean): Promise<EffectivePiImageSettings>;
	processImages(
		inputs: BrowserImageInput[],
		options?: ProcessBrowserImageOptions,
	): Promise<ImageContent[]>;
	processAttachment(
		source: Uint8Array,
		options?: ProcessBrowserImageOptions,
	): Promise<ProcessedBrowserImage>;
	createHubClient(options: HubClientOptions): HubClient;
}

const DEFAULT_DEPENDENCIES: RuntimeDependencies = {
	loadSettings,
	saveSettings,
	initializeSettings,
	startServer: (options) => WebUIServer.start(options),
	readPiSettings: readEffectivePiImageSettings,
	processImages: processBrowserImages,
	processAttachment: processStagedImage,
	createHubClient: (options) => new HubClient(options),
};

export class WebUIRuntime {
	private readonly dependencies: RuntimeDependencies;
	private context?: ExtensionContext;
	private conversation?: ConversationProjection;
	private server?: ServerControl;
	private serverStarting?: Promise<ServerControl>;
	private hub?: HubClient;
	private hubStatus: HubClientStatus = { state: "disabled", hubUrl: hubBaseUrl() };
	private sessionAbort = new AbortController();
	private generation = 0;
	private closed = true;
	private lastSettingsWarning = "";
	private nextLiveMessageId = 0;
	private readonly activeMessageIds = new Map<string, string>();
	private readonly finalMessageTimers = new Set<ReturnType<typeof setTimeout>>();
	private readonly pendingBrowserInputs = new Map<string, PendingBrowserInput>();
	private readonly acceptedBrowserInputs = new Map<string, AcceptedBrowserInput>();
	private settings: WebUISettings = { ...DEFAULT_SETTINGS };
	private effectiveImageLimits: Readonly<ImageLimits> = DEFAULT_IMAGE_LIMITS;
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
			this.conversation?.replaceBranch(projectBranchMessages(ctx.sessionManager.getBranch()));
		});
		this.pi.on("session_info_changed", async (event, ctx) => {
			this.captureContext(ctx);
			this.conversation?.updateSession({ name: event.name });
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
			this.recordMessage(
				"start",
				sanitizeBrowserMessageEvent(event, this.acceptedBrowserInputs, false),
			);
		});
		this.pi.on("message_update", async (event, ctx) => {
			this.captureContext(ctx);
			this.recordMessage("update", event);
		});
		this.pi.on("message_end", async (event, ctx) => {
			this.captureContext(ctx);
			const sanitized = sanitizeBrowserMessageEvent(event, this.acceptedBrowserInputs, true);
			this.recordMessage("end", sanitized);
			// Pi applies this replacement before persistence and before the prompt reaches the model.
			if (sanitized !== event && isRecord(sanitized) && isRecord(sanitized.message)) {
				return { message: sanitized.message as unknown as typeof event.message };
			}
		});
		this.pi.on("tool_execution_start", async (event, ctx) => {
			this.captureContext(ctx);
			this.recordTool("start", event);
		});
		this.pi.on("tool_execution_update", async (event, ctx) => {
			this.captureContext(ctx);
			this.recordTool("update", event);
		});
		this.pi.on("tool_execution_end", async (event, ctx) => {
			this.captureContext(ctx);
			this.recordTool("end", event);
		});
		this.pi.on("agent_start", async (_event, ctx) => {
			this.captureContext(ctx);
			this.conversation?.setActivity("running");
		});
		(this.pi as LatestExtensionAPI).on("agent_settled", async (_event, ctx) => {
			this.captureContext(ctx);
			if (ctx.isIdle() && !ctx.hasPendingMessages()) {
				this.acceptedBrowserInputs.clear();
				this.conversation?.setActivity("idle");
			}
		});
	}

	async start(ctx: ExtensionContext): Promise<void> {
		const generation = ++this.generation;
		const previousConversation = this.conversation;
		this.closed = true;
		this.sessionAbort.abort();
		this.cancelPendingMessages();
		this.cancelBrowserInputs("The Pi session changed before the browser prompt was accepted.");
		this.acceptedBrowserInputs.clear();
		previousConversation?.close();
		await this.releaseServer();
		if (generation !== this.generation) return;
		await this.settingsSaveQueue;
		if (generation !== this.generation) return;
		const settingsResult = await this.dependencies.loadSettings();
		if (generation !== this.generation) return;
		this.applySettingsResult(settingsResult);
		this.sessionAbort = new AbortController();
		this.context = ctx;
		this.conversation = new ConversationProjection(
			{
				id: ctx.sessionManager.getSessionId(),
				cwd: ctx.cwd,
				projectName: basename(ctx.cwd) || ctx.cwd,
				...(ctx.sessionManager.getSessionName()
					? { name: ctx.sessionManager.getSessionName() }
					: {}),
			},
			projectBranchMessages(ctx.sessionManager.getBranch()),
		);
		this.closed = false;
		this.lastSettingsWarning = "";
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
		this.sessionAbort.abort();
		this.cancelPendingMessages();
		this.cancelBrowserInputs("The Pi session ended before the browser prompt was accepted.");
		this.acceptedBrowserInputs.clear();
		this.conversation?.close();
		await this.settingsSaveQueue;
		if (generation !== this.generation) return;
		await this.releaseServer();
		if (generation !== this.generation) return;
		this.context = undefined;
		this.conversation = undefined;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		this.activityId += 1;
		ctx.ui.setStatus(ACTIVITY_STATUS_KEY, undefined);
	}

	private captureContext(ctx: ExtensionContext): void {
		if (!this.closed) this.context = ctx;
	}

	private recordMessage(phase: "start" | "update" | "end", event: unknown): void {
		if (!isRecord(event) || !isRecord(event.message) || typeof event.message.role !== "string") {
			return;
		}
		const key = messageLifecycleKey(event.message);
		let id = this.activeMessageIds.get(key);
		if (phase === "start" || !id) {
			id = `web-live:${++this.nextLiveMessageId}`;
			this.activeMessageIds.set(key, id);
		}
		const retainedImageIds = Array.isArray(event.retainedImageIds)
			? event.retainedImageIds.filter((value): value is string => typeof value === "string")
			: [];
		if (phase !== "end") {
			this.recordProjectedMessage(event.message, false, id, retainedImageIds);
			return;
		}
		this.activeMessageIds.delete(key);
		const generation = this.generation;
		const timer = setTimeout(() => {
			this.finalMessageTimers.delete(timer);
			if (generation !== this.generation || this.closed) return;
			this.recordProjectedMessage(event.message, true, id, retainedImageIds);
		}, 0);
		this.finalMessageTimers.add(timer);
	}

	private recordProjectedMessage(
		message: unknown,
		final: boolean,
		id: string,
		retainedImageIds: readonly string[] = [],
	): void {
		try {
			this.conversation?.recordMessage(message, final, id, retainedImageIds);
		} catch {
			// Unknown custom message shapes do not block the supported transcript.
		}
	}

	private cancelPendingMessages(): void {
		this.activeMessageIds.clear();
		for (const timer of this.finalMessageTimers) clearTimeout(timer);
		this.finalMessageTimers.clear();
	}

	private recordTool(phase: "start" | "update" | "end", event: unknown): void {
		if (
			!isRecord(event) ||
			typeof event.toolCallId !== "string" ||
			typeof event.toolName !== "string"
		)
			return;
		const result =
			phase === "update" ? event.partialResult : phase === "end" ? event.result : undefined;
		this.conversation?.recordTool(
			phase,
			event.toolCallId,
			event.toolName,
			event.args,
			result,
			typeof event.isError === "boolean" ? event.isError : undefined,
		);
	}

	private async presentLink(ctx: ExtensionContext): Promise<void> {
		const server = await this.ensureServer();
		const hub = await this.ensureHub(server);
		const status = await hub.refresh();
		if (status.state === "registered" && status.sessionUrl) {
			ctx.ui.setWidget(WIDGET_KEY, [`🌐 Pi WebUI: ${status.sessionUrl}`]);
			ctx.ui.notify(`Pi WebUI: ${status.sessionUrl}`, "info");
			return;
		}
		const direct = server.directUrl();
		const reason = status.lastError ?? "not running";
		ctx.ui.setWidget(WIDGET_KEY, [`🌐 Pi WebUI (hub offline): ${direct}`]);
		ctx.ui.notify(
			`Pi WebUI: the hub at ${status.hubUrl} is unavailable (${reason}).\nUsing a session-only link: ${direct}\nInstall the hub as a user service with /webui hub.`,
			"warning",
		);
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
			...(this.hubStatus.sessionUrl ? { sessionUrl: this.hubStatus.sessionUrl } : {}),
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
		type Screen = "main" | "settings" | "repair" | "status" | "help";
		type Action = "open" | "settings" | "save-startup";
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
					],
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
				"save-startup": async ({ value }) => {
					const requested = value === "Every session";
					let accepted = false;
					const operation = this.settingsSaveQueue.then(async () => {
						if (!this.settingsDocument) {
							throw new Error("the invalid settings file must be repaired manually first");
						}
						const document = await this.dependencies.saveSettings(
							{ startOnSessionStart: requested },
							this.settingsDocument,
							this.settingsPath,
						);
						if (generation !== this.generation || this.closed) return;
						this.settings = { ...this.settings, startOnSessionStart: requested };
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
			...(this.hubStatus.sessionUrl ? [`Link: ${this.hubStatus.sessionUrl}`] : []),
			`Startup: ${this.settings.startOnSessionStart ? "Every session" : "Manual"} (${source})`,
			`Image limits (${source}): ${this.effectiveImageLimits.maxImages} images, ${formatMib(this.effectiveImageLimits.maxImageBytes)}/image, ${formatMib(this.effectiveImageLimits.maxBatchBytes)}/batch, ${this.effectiveImageLimits.maxImagePixels.toLocaleString("en-US")} pixels/image`,
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
			'Accepted JSON starts with { "startOnSessionStart": false } and may include advanced maxImages, maxImageBytes, maxBatchBytes, and maxImagePixels fields.',
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
		const status = this.hub ? await this.hub.refresh() : this.hubStatus;
		const lines = [
			"Pi WebUI hub",
			`State: ${hubStatusLine(status)}`,
			`Browser index: ${status.hubUrl}`,
			"",
			`Write this unit to ~/.config/systemd/user/${HUB_UNIT_NAME}:`,
			"",
			renderHubUnit({ allowedHosts: allowedHostsFromEnv() }),
			"Then run:",
			...hubInstallSteps().map((step) => `  ${step}`),
			"",
			"The hub only routes requests to registered Pi sessions; it never reads or writes Pi session state.",
		];
		ctx.ui.notify(lines.join("\n"), status.state === "registered" ? "info" : "warning");
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
		this.effectiveImageLimits = imageLimits(result.settings);
		this.settingsDocument = result.kind === "invalid" ? undefined : { ...(result.document ?? {}) };
		this.settingsPath = result.path;
		this.settingsSource = result.source;
	}

	private async ensureServer(): Promise<ServerControl> {
		if (this.closed || !this.conversation) throw new Error("the Pi session is not ready");
		if (this.server) return this.server;
		if (!this.serverStarting) {
			const generation = this.generation;
			const conversation = this.conversation;
			const starting = this.dependencies.startServer({
				conversation,
				send: (request) => this.sendBrowserMessage(request, generation),
				imageLimits: this.effectiveImageLimits,
				sentImageSettings: {
					enabled: this.settings.retainSentImages,
					maxImages: this.settings.maxRetainedImages,
					maxBytes: this.settings.maxRetainedBytes,
				},
				processAttachment: (source, signal) =>
					this.processStagedAttachment(source, generation, signal),
			});
			this.serverStarting = starting.then(async (server) => {
				if (generation !== this.generation || this.closed || conversation !== this.conversation) {
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

	private async processStagedAttachment(
		source: Uint8Array,
		generation: number,
		signal?: AbortSignal,
	): Promise<PreparedAttachment> {
		const ctx = this.context;
		if (!ctx || this.closed || generation !== this.generation) {
			throw new Error("The Pi session has ended.");
		}
		const combinedSignal = signal
			? AbortSignal.any([this.sessionAbort.signal, signal])
			: this.sessionAbort.signal;
		const settings = await this.dependencies.readPiSettings(ctx.cwd, ctx.isProjectTrusted());
		this.notifySettingsWarnings(ctx, settings.warnings);
		const image = await this.dependencies.processAttachment(source, {
			maxImageBytes: this.effectiveImageLimits.maxImageBytes,
			maxPixels: this.effectiveImageLimits.maxImagePixels,
			autoResize: settings.autoResize,
			blockImages: settings.blockImages,
			supportsImages: ctx.model?.input.includes("image") ?? false,
			signal: combinedSignal,
		});
		if (combinedSignal.aborted || generation !== this.generation || this.closed) {
			throw new Error("Image processing was cancelled.");
		}
		return {
			...image,
			notes: attachmentNotes(image),
		};
	}

	private async sendBrowserMessage(
		request: WebSendRequest,
		generation: number,
	): Promise<WebSendResult> {
		const ctx = this.context;
		if (!ctx || this.closed || generation !== this.generation) {
			throw new Error("The Pi session has ended.");
		}

		const signal = request.signal
			? AbortSignal.any([this.sessionAbort.signal, request.signal])
			: this.sessionAbort.signal;
		if (signal.aborted) throw new Error("The browser message was cancelled.");
		await this.preflightIdlePrompt(ctx, request, generation, signal);
		let images: ImageContent[] = [];
		if (request.images.length > 0) {
			validateStagedBrowserImages(request.images, this.effectiveImageLimits);
			const settings = await this.dependencies.readPiSettings(ctx.cwd, ctx.isProjectTrusted());
			this.notifySettingsWarnings(ctx, settings.warnings);
			if (settings.blockImages) throw new Error("Pi image sending is disabled.");
			await this.validateCurrentModel(ctx, generation, signal, true);
			images = request.images.map((image) => ({
				type: "image" as const,
				data: image.data,
				mimeType: image.mimeType ?? "image/png",
			}));
		}
		if (signal.aborted) throw new Error("The browser message was cancelled.");
		if (!this.context || this.closed || generation !== this.generation) {
			throw new Error("The Pi session changed while the message was being prepared.");
		}

		const text = request.text;
		const content: string | Array<TextContent | ImageContent> =
			images.length === 0
				? text
				: [...(text.trim() ? ([{ type: "text", text }] satisfies TextContent[]) : []), ...images];
		const wrapped = this.createBrowserInput(content, request.retainedImageIds ?? []);
		const delivery =
			request.delivery === "steer"
				? "steer"
				: !ctx.isIdle() || ctx.hasPendingMessages()
					? "followUp"
					: "immediate";
		try {
			this.pi.sendUserMessage(wrapped.content, {
				deliverAs: delivery === "steer" ? "steer" : "followUp",
			});
			await wrapped.accepted;
		} catch (error) {
			this.settleBrowserInput(
				wrapped.nonce,
				error instanceof Error ? error : new Error(String(error)),
			);
			await wrapped.accepted.catch(() => undefined);
			throw error;
		}
		return { delivery };
	}

	private async preflightIdlePrompt(
		ctx: ExtensionContext,
		request: WebSendRequest,
		generation: number,
		signal: AbortSignal,
	): Promise<void> {
		if (request.delivery === "steer" || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		await this.validateCurrentModel(ctx, generation, signal, false);
	}

	private async validateCurrentModel(
		ctx: ExtensionContext,
		generation: number,
		signal: AbortSignal,
		requireImages: boolean,
	): Promise<void> {
		const model = ctx.model;
		if (!model) throw new Error("No model is selected in Pi.");
		if (requireImages && !model.input.includes("image")) {
			throw new Error("The selected Pi model does not support images.");
		}
		if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
			const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
			if (!apiKey) throw new Error(`No authentication is available for "${model.provider}".`);
		}
		if (signal.aborted) throw new Error("The browser message was cancelled.");
		if (!this.context || this.closed || generation !== this.generation) {
			throw new Error("The Pi session changed while the message was being prepared.");
		}
		if (ctx.model !== model) throw new Error("The Pi model changed; retry the browser message.");
	}

	private createBrowserInput(
		content: string | Array<TextContent | ImageContent>,
		retainedImageIds: readonly string[],
	): {
		nonce: string;
		content: string | Array<TextContent | ImageContent>;
		accepted: Promise<void>;
	} {
		const nonce = randomUUID();
		const text = typeof content === "string" ? content : contentText(content);
		const envelope = `<pi-webui-input nonce="${nonce}">\n${INPUT_FOOTER}`;
		const wrappedContent =
			typeof content === "string"
				? envelope
				: [
						{ type: "text" as const, text: envelope },
						...content.filter((part): part is ImageContent => part.type === "image"),
					];
		const accepted = new Promise<void>((resolve, reject) => {
			this.pendingBrowserInputs.set(nonce, {
				resolve,
				reject,
				text,
				retainedImageIds: [...retainedImageIds],
			});
		});
		return { nonce, content: wrappedContent, accepted };
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

	private notifySettingsWarnings(ctx: ExtensionContext, warnings: string[]): void {
		const message = warnings.join("\n");
		if (!message || message === this.lastSettingsWarning) return;
		this.lastSettingsWarning = message;
		ctx.ui.notify(message, "warning");
	}

	/**
	 * Publish this session to the hub. The hub only routes requests, so registering cannot affect
	 * the Pi session itself; when no hub is running the session keeps its own loopback server.
	 */
	private async ensureHub(server: ServerControl): Promise<HubClient> {
		if (this.closed || !this.conversation) throw new Error("the Pi session is not ready");
		if (this.hub) return this.hub;
		const generation = this.generation;
		const client = this.dependencies.createHubClient({
			metadata: () => this.hubMetadata(server.port),
			onChange: (status) => {
				if (generation === this.generation && !this.closed) this.hubStatus = status;
			},
		});
		this.hub = client;
		this.hubStatus = await client.start();
		if (generation !== this.generation || this.closed) {
			await client.stop();
			if (this.hub === client) this.hub = undefined;
		}
		return client;
	}

	private async releaseHub(): Promise<void> {
		const hub = this.hub;
		this.hub = undefined;
		if (hub) await hub.stop();
	}

	private hubMetadata(port: number): HubRegistration {
		const ctx = this.context;
		const snapshot = this.conversation?.snapshot();
		const activity = snapshot?.activity === "running" ? "running" : snapshot ? "idle" : "unknown";
		const version = packageVersion();
		return {
			sessionId: snapshot?.session.id ?? ctx?.sessionManager.getSessionId() ?? "unknown",
			port,
			activity,
			...(snapshot?.session.cwd ? { cwd: snapshot.session.cwd } : {}),
			...(snapshot?.session.projectName ? { projectName: snapshot.session.projectName } : {}),
			...(snapshot?.session.name ? { name: snapshot.session.name } : {}),
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
		await this.releaseHub();
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

function contentText(content: Array<TextContent | ImageContent>): string {
	return content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
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

function attachmentNotes(image: ProcessedBrowserImage): string[] {
	const notes: string[] = [];
	if (image.sourceFormat !== image.outputFormat) {
		notes.push(
			`Converted ${image.sourceFormat.toUpperCase()} to ${image.outputFormat.toUpperCase()}`,
		);
	}
	if (image.resized) {
		notes.push(
			`Resized ${image.originalWidth}×${image.originalHeight} to ${image.width}×${image.height}`,
		);
	}
	return notes;
}

function messageLifecycleKey(message: Record<string, unknown>): string {
	return `${message.role}:${typeof message.timestamp === "number" ? message.timestamp : "untimed"}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatMib(bytes: number): string {
	return `${bytes / (1024 * 1024)} MiB`;
}

/** Extra `Host` names this machine already trusts, so the printed unit matches the environment. */
function allowedHostsFromEnv(): string[] {
	return (process.env.PI_WEBUI_ALLOWED_HOSTS ?? "")
		.split(",")
		.map((host) => host.trim())
		.filter(Boolean);
}

function hubStatusLine(status: HubClientStatus): string {
	if (status.state === "registered") return `registered at ${status.hubUrl}`;
	if (status.state === "unreachable") return `unreachable at ${status.hubUrl} (${status.lastError ?? "no response"})`;
	return `disabled at ${status.hubUrl}`;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
