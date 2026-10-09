/**
 * Extension side of the hub protocol: announce this Pi session to the fixed-port hub and keep
 * the registration alive.
 *
 * The client only publishes metadata and a loopback port. It never sends conversation content,
 * drafts, or session files, and it keeps working (as a plain session-local server) when no hub is
 * running, so the browser companion never depends on the hub being installed.
 */

import { randomBytes } from "node:crypto";
import {
	HEARTBEAT_INTERVAL_MS,
	HEARTBEAT_PATH,
	HELLO_PATH,
	HUB_NAME,
	type HubRegistration,
	hubBaseUrl,
	isHubHello,
	REGISTER_PATH,
	sessionBasePath,
	UNREGISTER_PATH,
} from "./hub-protocol.js";

export type HubConnectionState = "disabled" | "registered" | "unreachable";

export interface HubClientStatus {
	state: HubConnectionState;
	hubUrl: string;
	basePath?: string;
	sessionUrl?: string;
	lastError?: string;
	lastContactAt?: number;
}

export interface HubClientOptions {
	metadata: () => HubRegistration;
	hubUrl?: string;
	token?: string;
	fetchImpl?: typeof fetch;
	heartbeatIntervalMs?: number;
	timeoutMs?: number;
	onChange?: (status: HubClientStatus) => void;
}

const DEFAULT_TIMEOUT_MS = 2_000;

export class HubClient {
	private readonly hubUrl: string;
	private readonly token: string;
	private readonly fetchImpl: typeof fetch;
	private readonly heartbeatIntervalMs: number;
	private readonly timeoutMs: number;
	private readonly onChange?: (status: HubClientStatus) => void;
	private readonly metadata: () => HubRegistration;
	private timer?: ReturnType<typeof setInterval>;
	private running = false;
	private status: HubClientStatus;

	constructor(options: HubClientOptions, env: NodeJS.ProcessEnv = process.env) {
		this.metadata = options.metadata;
		this.hubUrl = options.hubUrl ?? hubBaseUrl(env);
		this.token = options.token ?? randomBytes(24).toString("hex");
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.onChange = options.onChange;
		this.status = { state: "disabled", hubUrl: this.hubUrl };
	}

	statusSnapshot(): HubClientStatus {
		return { ...this.status };
	}

	sessionUrl(): string | undefined {
		return this.status.sessionUrl;
	}

	/** Register now and keep the registration alive until `stop()`. */
	async start(): Promise<HubClientStatus> {
		this.running = true;
		await this.register();
		if (this.running && !this.timer) {
			this.timer = setInterval(() => {
				void this.heartbeat();
			}, this.heartbeatIntervalMs);
			// Never keep the Pi process alive for a heartbeat.
			this.timer.unref?.();
		}
		return this.statusSnapshot();
	}

	/** Force an immediate heartbeat (used by `/webui open` and `/webui status`). */
	async refresh(): Promise<HubClientStatus> {
		if (!this.running) return this.start();
		await this.heartbeat();
		return this.statusSnapshot();
	}

	async stop(): Promise<void> {
		this.running = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		const leaving = this.status.state === "registered";
		const sessionId = leaving ? this.metadata().sessionId : undefined;
		this.update({ state: "disabled", hubUrl: this.hubUrl });
		if (!leaving || !sessionId) return;
		// Goodbye is best effort and must not delay Pi's session shutdown: the hub expires a
		// registration on its own if this request never arrives.
		void this.post(UNREGISTER_PATH, { sessionId, token: this.token })
			.then((response) => response.body?.cancel().catch(() => undefined))
			.catch(() => undefined);
	}

	private async register(): Promise<void> {
		const hello = await this.checkHello();
		if (!hello.ok) {
			this.update({ state: "unreachable", hubUrl: this.hubUrl, lastError: hello.error });
			return;
		}
		try {
			const response = await this.post(REGISTER_PATH, { ...this.metadata(), token: this.token });
			if (!response.ok) {
				this.update({
					state: "unreachable",
					hubUrl: this.hubUrl,
					lastError: `hub rejected the registration (HTTP ${response.status})`,
				});
				return;
			}
			this.markRegistered(response);
		} catch (error) {
			this.update({ state: "unreachable", hubUrl: this.hubUrl, lastError: describeError(error) });
		}
	}

	private async heartbeat(): Promise<void> {
		const registration = this.metadata();
		try {
			const response = await this.post(HEARTBEAT_PATH, { ...registration, token: this.token });
			if (response.status === 404) {
				// The hub restarted (or expired us): register again instead of staying invisible.
				await this.register();
				return;
			}
			if (!response.ok) {
				this.update({
					state: "unreachable",
					hubUrl: this.hubUrl,
					lastError: `hub rejected the heartbeat (HTTP ${response.status})`,
				});
				return;
			}
			this.markRegistered(response);
		} catch (error) {
			this.update({ state: "unreachable", hubUrl: this.hubUrl, lastError: describeError(error) });
		}
	}

	private async checkHello(): Promise<{ ok: true } | { ok: false; error: string }> {
		try {
			const response = await this.fetchImpl(new URL(HELLO_PATH.slice(1), this.hubUrl), {
				method: "GET",
				signal: AbortSignal.timeout(this.timeoutMs),
			});
			if (!response.ok) return { ok: false, error: `hub health check failed (HTTP ${response.status})` };
			const payload: unknown = await response.json();
			if (!isHubHello(payload)) {
				return { ok: false, error: `another service is listening on ${this.hubUrl} (expected ${HUB_NAME})` };
			}
			return { ok: true };
		} catch (error) {
			return { ok: false, error: describeError(error) };
		}
	}

	private async post(path: string, body: Record<string, unknown>): Promise<Response> {
		return await this.fetchImpl(new URL(path.slice(1), this.hubUrl), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(this.timeoutMs),
		});
	}

	private markRegistered(response: Response): void {
		const sessionId = this.metadata().sessionId;
		const basePath = sessionBasePath(sessionId);
		void response.body?.cancel().catch(() => undefined);
		this.update({
			state: "registered",
			hubUrl: this.hubUrl,
			basePath,
			sessionUrl: new URL(basePath, this.hubUrl).toString(),
			lastContactAt: Date.now(),
		});
	}

	private update(next: HubClientStatus): void {
		this.status = next;
		try {
			this.onChange?.(this.statusSnapshot());
		} catch {
			// Status observers must never break the client.
		}
	}
}

function describeError(error: unknown): string {
	if (error instanceof Error) {
		const cause = (error as { cause?: unknown }).cause;
		if (cause instanceof Error && cause.message) return `${error.message} (${cause.message})`;
		return error.message;
	}
	return String(error);
}
