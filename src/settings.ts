import * as nodeFs from "node:fs";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { CONFIG_FILE_NAME, DEFAULT_HUB_PORT } from "./hub-protocol.js";


/** The configuration file name is owned by the shared contract; both readers resolve it the same way. */
export const SETTINGS_FILE = CONFIG_FILE_NAME;

const _MIB = 1024 * 1024;

export interface WebUISettings {
	startOnSessionStart: boolean;
	/** Hub listen port, written to the `hub` object of the same file. */
	hubPort: number;
	/** Extra allowed `Host` names (a tunnel or reverse proxy in front of the hub). */
	hubAllowedHosts: string[];
}

export const DEFAULT_SETTINGS: Readonly<WebUISettings> = Object.freeze({
	startOnSessionStart: false,
	hubPort: DEFAULT_HUB_PORT,
	hubAllowedHosts: [],
});

export interface SettingsLoadResult {
	kind: "missing" | "loaded" | "invalid";
	path: string;
	settings: WebUISettings;
	source: "defaults" | "settings file";
	document?: Record<string, unknown>;
	warning?: string;
}

export interface SettingsFileOperations {
	write(path: string, data: string): Promise<void>;
	rename(source: string, destination: string): Promise<void>;
	lock(path: string, onCompromised: (error: Error) => void): Promise<() => Promise<void>>;
}

const DEFAULT_FILE_OPERATIONS: SettingsFileOperations = {
	write: (path, data) =>
		writeFile(path, data, { encoding: "utf8", flag: "wx", mode: 0o600 }).then(() => undefined),
	rename,
	lock: acquireSettingsMutationLock,
};

const LOCKFILE_FS_ADAPTER = {
	mkdir: nodeFs.mkdir,
	mkdirSync: nodeFs.mkdirSync,
	realpath: nodeFs.realpath,
	realpathSync: nodeFs.realpathSync,
	rmdir: nodeFs.rmdir,
	rmdirSync: nodeFs.rmdirSync,
	stat: nodeFs.stat,
	statSync: nodeFs.statSync,
	utimes: nodeFs.utimes,
	utimesSync: nodeFs.utimesSync,
};

export function settingsFilePath(): string {
	return join(getAgentDir(), SETTINGS_FILE);
}

export function normalizeSettings(value: unknown): WebUISettings | undefined {
	if (!isRecord(value)) return undefined;
	if (Object.hasOwn(value, "startOnSessionStart") && typeof value.startOnSessionStart !== "boolean") {
		return undefined;
	}
	const hub = value.hub;
	if (hub !== undefined && !isRecord(hub)) return undefined;
	const hubPort = isRecord(hub) && Object.hasOwn(hub, "port") ? hub.port : undefined;
	if (
		hubPort !== undefined &&
		(typeof hubPort !== "number" || !Number.isSafeInteger(hubPort) || hubPort < 1 || hubPort > 65_535)
	) {
		return undefined;
	}
	const hubAllowedHosts = isRecord(hub) && Object.hasOwn(hub, "allowedHosts") ? hub.allowedHosts : undefined;
	if (
		hubAllowedHosts !== undefined &&
		(!Array.isArray(hubAllowedHosts) || hubAllowedHosts.some((host) => typeof host !== "string" || !host.trim()))
	) {
		return undefined;
	}
	const normalized = {
		startOnSessionStart:
			typeof value.startOnSessionStart === "boolean"
				? value.startOnSessionStart
				: DEFAULT_SETTINGS.startOnSessionStart,
		hubPort: typeof hubPort === "number" ? hubPort : DEFAULT_SETTINGS.hubPort,
		hubAllowedHosts: Array.isArray(hubAllowedHosts)
			? hubAllowedHosts.map((host) => (host as string).trim().toLowerCase())
			: [...DEFAULT_SETTINGS.hubAllowedHosts],
	};
	return normalized;
}

export async function loadSettings(path = settingsFilePath()): Promise<SettingsLoadResult> {
	let text: string;
	try {
		const stats = await lstat(path);
		if (stats.isSymbolicLink()) return invalid(path, "symbolic links are not accepted");
		if (!stats.isFile()) return invalid(path, "settings path is not a regular file");
		text = await readFile(path, "utf8");
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return {
				kind: "missing",
				path,
				settings: { ...DEFAULT_SETTINGS },
				source: "defaults",
				document: {},
			};
		}
		return invalid(path, formatError(error));
	}

	try {
		const document = JSON.parse(text) as unknown;
		if (!isRecord(document)) return invalid(path, "the top level must be a JSON object");
		const settings = normalizeSettings(document);
		if (!settings) return invalid(path, "recognized settings have an invalid type or limit");
		return {
			kind: "loaded",
			path,
			settings,
			source: "settings file",
			document,
		};
	} catch (error) {
		return invalid(path, formatError(error));
	}
}

/** Normalized settings as they are stored: hub fields live under a nested `hub` object. */
export function settingsDocument(settings: WebUISettings): Record<string, unknown> {
	const { hubPort, hubAllowedHosts, ...rest } = settings;
	return {
		...rest,
		hub: { port: hubPort, ...(hubAllowedHosts.length > 0 ? { allowedHosts: hubAllowedHosts } : {}) },
	};
}

/** Apply a settings patch to an existing document without flattening or dropping the `hub` object. */
function mergeSettingsDocument(
	document: Record<string, unknown>,
	patch: Partial<WebUISettings>,
): Record<string, unknown> {
	const { hubPort, hubAllowedHosts, ...rest } = patch;
	const hub = isRecord(document.hub) ? document.hub : {};
	const hubPatch = {
		...(hubPort !== undefined ? { port: hubPort } : {}),
		...(hubAllowedHosts !== undefined ? { allowedHosts: hubAllowedHosts } : {}),
	};
	return {
		...document,
		...rest,
		...(Object.keys(hubPatch).length > 0 ? { hub: { ...hub, ...hubPatch } } : {}),
	};
}
export async function saveSettings(
	settings: Partial<WebUISettings>,
	_document: Record<string, unknown>,
	path = settingsFilePath(),
	operations: Partial<SettingsFileOperations> = {},
): Promise<Record<string, unknown>> {
	await mkdir(dirname(path), { recursive: true });
	return withSettingsMutationLock(path, operations, async (throwIfCompromised) => {
		const latest = await loadSettings(path);
		throwIfCompromised();
		if (latest.kind === "invalid") {
			throw new Error(`Cannot save pi-webui settings until the existing file is repaired.`);
		}
		const nextDocument = mergeSettingsDocument(latest.document ?? {}, settings);
		if (!normalizeSettings(nextDocument)) {
			throw new Error("Cannot save invalid pi-webui settings.");
		}
		const temporaryPath = temporaryFilePath(path);
		try {
			await (operations.write ?? DEFAULT_FILE_OPERATIONS.write)(
				temporaryPath,
				`${JSON.stringify(nextDocument, null, 2)}\n`,
			);
			throwIfCompromised();
			if (latest.kind === "missing" && (await pathEntryExists(path))) {
				throw new Error(`${SETTINGS_FILE} was created concurrently; reopen settings and retry.`);
			}
			throwIfCompromised();
			await (operations.rename ?? DEFAULT_FILE_OPERATIONS.rename)(temporaryPath, path);
			throwIfCompromised();
			return nextDocument;
		} finally {
			await unlink(temporaryPath).catch(() => undefined);
		}
	});
}

export async function initializeSettings(
	path = settingsFilePath(),
	operations: Partial<SettingsFileOperations> = {},
): Promise<"created" | "exists"> {
	if (await pathEntryExists(path)) return "exists";

	await mkdir(dirname(path), { recursive: true });
	return withSettingsMutationLock(path, operations, async (throwIfCompromised) => {
		if (await pathEntryExists(path)) return "exists";
		throwIfCompromised();
		const temporaryPath = temporaryFilePath(path);
		try {
			await (operations.write ?? DEFAULT_FILE_OPERATIONS.write)(
				temporaryPath,
				`${JSON.stringify(settingsDocument(DEFAULT_SETTINGS), null, 2)}\n`,
			);
			throwIfCompromised();
			if (await pathEntryExists(path)) return "exists";
			throwIfCompromised();
			await (operations.rename ?? DEFAULT_FILE_OPERATIONS.rename)(temporaryPath, path);
			throwIfCompromised();
			return "created";
		} finally {
			await unlink(temporaryPath).catch(() => undefined);
		}
	});
}

async function withSettingsMutationLock<T>(
	path: string,
	operations: Partial<SettingsFileOperations>,
	mutate: (throwIfCompromised: () => void) => Promise<T>,
): Promise<T> {
	let compromisedError: Error | undefined;
	const release = await (operations.lock ?? DEFAULT_FILE_OPERATIONS.lock)(path, (error) => {
		compromisedError ??= error;
	});
	const throwIfCompromised = () => {
		if (compromisedError) throw compromisedError;
	};
	let result: T | undefined;
	let completed = false;
	let operationFailed = false;
	let operationError: unknown;
	try {
		throwIfCompromised();
		result = await mutate(throwIfCompromised);
		throwIfCompromised();
		completed = true;
	} catch (error) {
		operationFailed = true;
		operationError = error;
	}
	try {
		await release();
	} catch (error) {
		if (!compromisedError && !operationFailed) {
			operationFailed = true;
			operationError = error;
		}
	}
	if (compromisedError) throw compromisedError;
	if (operationFailed) throw operationError;
	if (!completed) throw new Error("Settings mutation completed without a result.");
	return result as T;
}

function acquireSettingsMutationLock(
	path: string,
	onCompromised: (error: Error) => void,
): Promise<() => Promise<void>> {
	return lockfile.lock(path, {
		fs: LOCKFILE_FS_ADAPTER,
		lockfilePath: `${path}.mutation-lock`,
		realpath: false,
		retries: { retries: 20, factor: 1.2, minTimeout: 5, maxTimeout: 50 },
		onCompromised,
	});
}

async function pathEntryExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return false;
		throw error;
	}
}

function invalid(path: string, reason: string): SettingsLoadResult {
	return {
		kind: "invalid",
		path,
		settings: { ...DEFAULT_SETTINGS },
		source: "defaults",
		warning: `${SETTINGS_FILE} ignored (${path}: ${reason}); using defaults without overwriting it.`,
	};
}

function temporaryFilePath(path: string): string {
	return `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
