import * as nodeFs from "node:fs";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import {
	DEFAULT_IMAGE_LIMITS,
	IMAGE_HARD_LIMITS,
	type ImageLimits,
	imageLimits,
} from "./image-limits.js";

export const SETTINGS_FILE = "pi-webui.json";

const MIB = 1024 * 1024;

export interface WebUISettings extends ImageLimits {
	startOnSessionStart: boolean;
	retainSentImages: boolean;
	maxRetainedImages: number;
	maxRetainedBytes: number;
}

export const DEFAULT_SETTINGS: Readonly<WebUISettings> = Object.freeze({
	startOnSessionStart: false,
	retainSentImages: false,
	maxRetainedImages: 32,
	maxRetainedBytes: 128 * MIB,
	...DEFAULT_IMAGE_LIMITS,
});

export const RETENTION_HARD_LIMITS = Object.freeze({
	maxRetainedImages: 128,
	maxRetainedBytes: 512 * MIB,
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
	if (
		(Object.hasOwn(value, "startOnSessionStart") &&
			typeof value.startOnSessionStart !== "boolean") ||
		(Object.hasOwn(value, "retainSentImages") && typeof value.retainSentImages !== "boolean")
	) {
		return undefined;
	}
	for (const [key, maximum] of [
		["maxRetainedImages", RETENTION_HARD_LIMITS.maxRetainedImages],
		["maxRetainedBytes", RETENTION_HARD_LIMITS.maxRetainedBytes],
		["maxImages", IMAGE_HARD_LIMITS.maxImages],
		["maxImageBytes", IMAGE_HARD_LIMITS.maxImageBytes],
		["maxBatchBytes", IMAGE_HARD_LIMITS.maxBatchBytes],
		["maxImagePixels", IMAGE_HARD_LIMITS.maxImagePixels],
	] as const) {
		if (!Object.hasOwn(value, key)) continue;
		const candidate = value[key];
		if (
			typeof candidate !== "number" ||
			!Number.isSafeInteger(candidate) ||
			candidate <= 0 ||
			candidate > maximum
		) {
			return undefined;
		}
	}
	const normalized = {
		startOnSessionStart:
			typeof value.startOnSessionStart === "boolean"
				? value.startOnSessionStart
				: DEFAULT_SETTINGS.startOnSessionStart,
		retainSentImages:
			typeof value.retainSentImages === "boolean"
				? value.retainSentImages
				: DEFAULT_SETTINGS.retainSentImages,
		maxRetainedImages:
			typeof value.maxRetainedImages === "number"
				? value.maxRetainedImages
				: DEFAULT_SETTINGS.maxRetainedImages,
		maxRetainedBytes:
			typeof value.maxRetainedBytes === "number"
				? value.maxRetainedBytes
				: DEFAULT_SETTINGS.maxRetainedBytes,
		...imageLimits({
			maxImages: typeof value.maxImages === "number" ? value.maxImages : DEFAULT_SETTINGS.maxImages,
			maxImageBytes:
				typeof value.maxImageBytes === "number"
					? value.maxImageBytes
					: DEFAULT_SETTINGS.maxImageBytes,
			maxBatchBytes:
				typeof value.maxBatchBytes === "number"
					? value.maxBatchBytes
					: DEFAULT_SETTINGS.maxBatchBytes,
			maxImagePixels:
				typeof value.maxImagePixels === "number"
					? value.maxImagePixels
					: DEFAULT_SETTINGS.maxImagePixels,
		}),
	};
	if (normalized.maxImageBytes > normalized.maxBatchBytes) return undefined;
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
		const warning = elevatedLimitWarning(settings);
		return {
			kind: "loaded",
			path,
			settings,
			source: "settings file",
			document,
			...(warning ? { warning } : {}),
		};
	} catch (error) {
		return invalid(path, formatError(error));
	}
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
		const nextDocument = { ...latest.document, ...settings };
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
				`${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`,
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

function elevatedLimitWarning(settings: WebUISettings): string | undefined {
	const elevated = (Object.keys(DEFAULT_IMAGE_LIMITS) as Array<keyof ImageLimits>).filter(
		(key) => settings[key] > DEFAULT_IMAGE_LIMITS[key],
	);
	if (elevated.length === 0) return undefined;
	return `${SETTINGS_FILE} uses image limits above safe defaults: ${elevated.join(", ")}. Higher limits increase Pi-process memory and processing cost.`;
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
