/**
 * Shared hub contract: names, paths, payload shapes, and the single configuration file.
 *
 * Both readers load this module: the standalone hub (`src/hub.ts`, run directly by Node with type
 * stripping) and the in-session extension. `src/hub.ts` imports it with a `.ts` specifier because
 * Node resolves the literal path; extension files use `.js` specifiers like the rest of the package.
 * It therefore imports nothing but Node built-ins.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HUB_NAME = "pi-webui-hub";
export const HUB_PROTOCOL = 2;
/** Port used when the configuration file has no `hub.port`. */
export const DEFAULT_HUB_PORT = 43118;
/** Path prefix used for every session-scoped request. */
export const SESSION_PATH_PREFIX = "/s/";
/** Where the browser asks for one session's data, mirroring `/api/agent/<id>/` in agegr/pi-web. */
export const SESSION_API_PREFIX = "/api/session/";
/** Assets owned by the hub and shared by every session page. */
export const ASSET_PATHS = ["/app.js", "/app.css"] as const;
/** WebSocket upgrade endpoint an extension dials to join the hub. */
export const CHANNEL_PATH = "/_hub/channel";
export const HELLO_PATH = "/_hub/hello";
export const SESSIONS_PATH = "/_hub/sessions";
export const EVENTS_PATH = "/_hub/events";

/** Host names the hub answers for when the configuration file lists no extra ones. */
export const DEFAULT_ALLOWED_HOSTS = ["127.0.0.1", "localhost", "[::1]", "::1"] as const;

export type HubActivity = "idle" | "running" | "unknown";

export interface HubSessionInfo {
	sessionId: string;
	activity?: HubActivity;
	cwd?: string;
	projectName?: string;
	name?: string;
	model?: string;
	piVersion?: string;
	extensionVersion?: string;
}

/**
 * Channel messages. A connection carries one session: the extension dials the hub, announces
 * itself, then serves the browser requests the hub routes to it.
 *
 * Every message is a JSON string, except payload bodies (`hasBody`), which are the single binary
 * message that follows; WebSocket preserves ordering, so the pairing is unambiguous.
 */
export type HubToExtensionMessage =
	| { t: "hello-ok"; protocol: number }
	| { t: "error"; message: string }
	| {
			t: "request";
			id: number;
			method: string;
			path: string;
			headers: Record<string, string>;
			hasBody?: boolean;
	  }
	| { t: "cancel"; id: number }
	| { t: "pong"; id: number };


export type ExtensionToHubMessage =
	| { t: "hello"; protocol: number; session: HubSessionInfo }
	| { t: "state"; session: HubSessionInfo }
	| { t: "response"; id: number; status: number; headers: Record<string, string>; hasBody?: boolean }
	| { t: "chunk"; id: number }
	| { t: "end"; id: number }
	| { t: "ping"; id: number }
	| { t: "error"; message: string };

/** How the extension reports its channel to `/webui status`. */
export type ChannelState = "connected" | "connecting" | "waiting" | "closed";

export interface ChannelStatus {
	state: ChannelState;
	/** Loopback URL of the hub the extension dials. */
	hubUrl: string;
	channelUrl: string;
	protocol: number;
	/** Populated after a failure, cleared on the next successful connection. */
	error?: string;
	connectedAt?: number;
}

export interface HubHello {
	name: string;
	protocol: number;
	port: number;
	sessionCount: number;
}

/** The one configuration file, `pi-webui.json`, shared by the hub and the extension. */
export const CONFIG_FILE_NAME = "pi-webui.json";

/**
 * Pi's agent directory: `PI_CODING_AGENT_DIR` when set, else `~/.pi/agent`. This mirrors Pi's own
 * convention so the hub and the extension always agree on one path, with no project or per-process
 * override of our own.
 */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_CODING_AGENT_DIR?.trim();
	if (configured) return configured.replace(/^~(?=\/|$)/, env.HOME?.trim() || homedir());
	return join(env.HOME?.trim() || homedir(), ".pi", "agent");
}

export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
	return join(agentDir(env), CONFIG_FILE_NAME);
}

/** Hub-owned settings, read from the `hub` object of the configuration file. */
export interface HubConfig {
	port: number;
	allowedHosts: readonly string[];
}

export interface HubConfigRead {
	config: HubConfig;
	path: string;
	/** True when the file existed and parsed as a JSON object. */
	exists: boolean;
	/** Human-readable problems found while reading, for logs and `/webui status`. */
	issues: string[];
	/** True when `hub.port` came from the file rather than the default. */
	portFromFile: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validPort(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value < 65_536
		? value
		: undefined;
}

/**
 * Read the hub section of the configuration file.
 *
 * Tolerant by design: the hub has no repair UI, so an unusable value is reported and the default is
 * used instead of refusing to start. The extension validates the same fields strictly before writing.
 */
export function readHubConfig(
	options: { agentDir?: string; env?: NodeJS.ProcessEnv } = {},
): HubConfigRead {
	const path = options.agentDir
		? join(options.agentDir, CONFIG_FILE_NAME)
		: configFilePath(options.env);
	const issues: string[] = [];
	let exists = false;
	let document: Record<string, unknown> | undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (isRecord(parsed)) {
			exists = true;
			document = parsed;
		} else {
			issues.push(`${path} ignored: the top level must be a JSON object; using defaults.`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			issues.push(`${path} ignored (${error instanceof Error ? error.message : String(error)}); using defaults.`);
		}
	}

	const hub = document ? document.hub : undefined;
	if (hub !== undefined && !isRecord(hub)) {
		issues.push(`${CONFIG_FILE_NAME} "hub" must be an object; using defaults.`);
	}
	const hubRecord = isRecord(hub) ? hub : {};

	const port = validPort(hubRecord.port);
	if (hubRecord.port !== undefined && port === undefined) {
		issues.push(`${CONFIG_FILE_NAME} "hub.port" must be an integer between 1 and 65535; using ${DEFAULT_HUB_PORT}.`);
	}

	const allowedHosts: string[] = [...DEFAULT_ALLOWED_HOSTS];
	const extra = hubRecord.allowedHosts;
	if (extra !== undefined) {
		if (Array.isArray(extra)) {
			for (const value of extra) {
				if (typeof value !== "string") {
					issues.push(`${CONFIG_FILE_NAME} "hub.allowedHosts" entries must be strings; ignoring invalid ones.`);
					continue;
				}
				const host = value.trim().toLowerCase();
				if (!host) continue;
				if (!allowedHosts.includes(host)) allowedHosts.push(host);
			}
		} else {
			issues.push(`${CONFIG_FILE_NAME} "hub.allowedHosts" must be an array of host names; ignoring it.`);
		}
	}

	return {
		config: { port: port ?? DEFAULT_HUB_PORT, allowedHosts },
		path,
		exists,
		issues,
		portFromFile: port !== undefined,
	};
}

/** Loopback URL the extension uses to reach the hub on this machine. */
export function hubUrlForPort(port: number): string {
	return `http://127.0.0.1:${port}/`;
}

/** The hub address implied by the configuration file. */
export function hubBaseUrl(options: { agentDir?: string; env?: NodeJS.ProcessEnv } = {}): string {
	return hubUrlForPort(readHubConfig(options).config.port);
}


/** WebSocket URL an extension dials: the hub's one port, upgraded at the channel path. */
export function channelUrl(hubUrl: string): string {
	const url = new URL(CHANNEL_PATH, hubUrl);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	return url.toString();
}
export function sessionBasePath(sessionId: string): string {
	return `${SESSION_PATH_PREFIX}${sessionId}/`;
}

/** The data prefix for one session: `/api/session/<id>/`. */
export function sessionApiPath(sessionId: string): string {
	return `${SESSION_API_PREFIX}${sessionId}/`;
}

/** `/api/session/<id>/<rest>`, or undefined when the path is not a session data request. */
export function sessionApiTarget(pathname: string): { sessionId: string; rest: string } | undefined {
	if (!pathname.startsWith(SESSION_API_PREFIX)) return undefined;
	const remainder = pathname.slice(SESSION_API_PREFIX.length);
	const slash = remainder.indexOf("/");
	const sessionId = slash === -1 ? remainder : remainder.slice(0, slash);
	if (!/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) return undefined;
	return { sessionId, rest: slash === -1 ? "/" : remainder.slice(slash) };
}

export function isHubHello(value: unknown): value is HubHello {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return candidate.name === HUB_NAME && typeof candidate.protocol === "number";
}

/**
 * The address a browser opens for one session. The page lives at the hub root and the session is
 * selected with `?session=`, the same shape agegr/pi-web uses, so a link stays short and the bundle
 * is shared by every session.
 */
export function hubSessionUrl(hubUrl: string, sessionId: string): string {
	return `${hubUrl.replace(/\/+$/, "")}/?session=${encodeURIComponent(sessionId)}`;
}
