/**
 * Shared hub contract: names, paths, and payload shapes used by both the standalone hub
 * (`src/hub.ts`, run directly by Node) and the in-session extension (`src/hub-client.ts`).
 *
 * `src/hub.ts` imports this file with a `.ts` specifier because Node strips types at runtime;
 * extension files use `.js` specifiers like the rest of this package.
 */

export const HUB_NAME = "pi-webui-hub";
export const HUB_PROTOCOL = 1;
/** Default fixed port. The extension mirrors it as the default hub URL. */
export const DEFAULT_HUB_PORT = 43118;
/** How often the extension re-announces a session; the hub expires entries after a few intervals. */
export const HEARTBEAT_INTERVAL_MS = 3_000;
/** Path prefix used for every session-scoped request. */
export const SESSION_PATH_PREFIX = "/s/";
export const HELLO_PATH = "/_hub/hello";
export const SESSIONS_PATH = "/_hub/sessions";
export const EVENTS_PATH = "/_hub/events";
export const REGISTER_PATH = "/_hub/register";
export const HEARTBEAT_PATH = "/_hub/heartbeat";
export const UNREGISTER_PATH = "/_hub/unregister";

export type HubActivity = "idle" | "running" | "unknown";

export interface HubRegistration {
	sessionId: string;
	port: number;
	activity?: HubActivity;
	cwd?: string;
	projectName?: string;
	name?: string;
	model?: string;
	piVersion?: string;
	extensionVersion?: string;
}

export interface HubHello {
	name: string;
	protocol: number;
	port: number;
	sessionCount: number;
}

export function sessionBasePath(sessionId: string): string {
	return `${SESSION_PATH_PREFIX}${sessionId}/`;
}

export function isHubHello(value: unknown): value is HubHello {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return candidate.name === HUB_NAME && typeof candidate.protocol === "number";
}

/** Base URL of the hub, from `PI_WEBUI_HUB_URL` or `PI_WEBUI_PORT`, else the default port. */
export function hubBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	const explicit = env.PI_WEBUI_HUB_URL?.trim();
	if (explicit) {
		try {
			const url = new URL(explicit);
			return `${url.origin}/`;
		} catch {
			// Fall through to the port-based default.
		}
	}
	const port = Number.parseInt(env.PI_WEBUI_PORT ?? "", 10);
	return `http://127.0.0.1:${Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_HUB_PORT}/`;
}

export function hubSessionUrl(hubUrl: string, sessionId: string): string {
	return new URL(sessionBasePath(sessionId), hubUrl).toString();
}
