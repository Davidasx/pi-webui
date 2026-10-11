/*
 * OURS, NOT A COPY. `scripts/vendor-web.mjs` resolves this path but never writes it.
 *
 * agegr/pi-web's API routes were written against this module: in their server it is a registry of
 * `pi` child processes started over RPC, one per session, each with its own `AgentSession`. In this
 * extension there is exactly one `AgentSession` — the one Pi is already running in this process, the
 * session the terminal is showing — so the adapter maps their registry onto it:
 *
 *   getRpcSession(id)      → the live session, when the id is this process's session
 *   getRpcSessionInfos()   → one row, built from the live session manager, in their shape
 *   send(command)          → the same command dispatch their frontend calls the agent with
 *
 * Everything that is *not* the live session is left to their own routes' disk paths
 * (`openSessionManager` on the session JSONL), because reading history needs no live process. The
 * calls that would require spawning one (`startRpcSession` for a fork of a session that is not
 * running) refuse explicitly instead of pretending.
 */

import type { AgentSessionLike } from "./pi-types.js";
import type { SessionEntry, SessionInfo, SessionMessageEntry, SubagentSessionStatus } from "./types.js";
import { allowFileRoot } from "./allowed-roots.js";
import { openSessionManager } from "./session-reader.js";
import { readSubagentRun, type SubagentRunInfo } from "./subagents.js";

/** What their routes use of a registry entry. */
export interface LiveSession {
	readonly sessionId: string;
	readonly cwd: string;
	readonly sessionFile: string | undefined;
	/** The live `AgentSession`, which their routes read the manager, name and entries from. */
	readonly inner: AgentSessionLike;
	isAlive(): boolean;
	isRunning(): boolean;
	/**
	 * Their session route asks this on a forced refresh: it returns true when the file on disk holds
	 * entries the live wrapper has not seen, so the route drops the wrapper and reads the file. Here
	 * the live wrapper is this very process, the only writer of that file, so memory is always the
	 * newest copy — the file can lag behind it, never lead — and it never stands aside.
	 */
	evictIfDiskAhead(): boolean;
	waitUntilReady?(): Promise<void>;
	/** Their command dispatch: the browser's RPC-shaped commands. */
	send(command: Record<string, unknown>): Promise<unknown>;
	/** Set by `setRpcSessionTools`, read back by `/api/agent/running`. */
	hasSuppressedCompletionNotifications?(): boolean;
}

let live: LiveSession | undefined;

/**
 * Called by the extension when a session starts, and with `undefined` when it ends. There is only
 * ever one: this process is one Pi session.
 */
export function setLiveSession(session: LiveSession | undefined): void {
	live = session;
	// Their server allows a session's folder when it starts that session's process; here the session
	// is this process, so the same permission is granted at registration. Without it their file
	// routes refuse every path outside the agent directory.
	if (session?.isAlive()) allowFileRoot(session.cwd);
}

function isThisSession(id: string): boolean {
	return live !== undefined && live.isAlive() && id === live.sessionId;
}

export function getRpcSession(id: string): LiveSession | undefined {
	return isThisSession(id) ? live : undefined;
}

/** Their session shape, from the live manager rather than from a spawned process. */
export function getRpcSessionInfos(_options: { includeTransient?: boolean } = {}): SessionInfo[] {
	if (!live?.isAlive()) return [];
	const manager = live.inner.sessionManager;
	const header = manager.getHeader();
	const entries = (manager.getEntries() ?? []) as unknown as SessionEntry[];
	const messages = entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
	const firstUser = messages.find((entry) => entry.message.role === "user");
	const created = header?.timestamp ?? entries[0]?.timestamp ?? new Date().toISOString();
	let lastActivity = Number.isNaN(new Date(created).getTime()) ? Date.now() : new Date(created).getTime();
	for (const message of messages) {
		const stamp = activityMs(message);
		if (stamp !== undefined) lastActivity = Math.max(lastActivity, stamp);
	}
	const subagent = readSubagentRun(entries, live.sessionId, live.sessionFile ?? "");
	return [
		{
			path: live.sessionFile ?? "",
			id: header?.id ?? live.sessionId,
			cwd: header?.cwd ?? live.cwd,
			...(manager.getSessionName() ? { name: manager.getSessionName() } : {}),
			created,
			modified: new Date(lastActivity).toISOString(),
			messageCount: messages.length,
			firstMessage: firstUser ? messageText(firstUser) || "(no messages)" : "(no messages)",
			...(subagent ? subagentFields(subagent, live.isRunning()) : {}),
		},
	];
}

function subagentFields(
	subagent: SubagentRunInfo,
	running: boolean,
): { parentSessionId: string; relation: NonNullable<SessionInfo["relation"]> } {
	return {
		parentSessionId: subagent.parentSessionId,
		relation: {
			kind: "subagent",
			parentSessionId: subagent.parentSessionId,
			profile: subagent.profile,
			description: subagent.description,
			status: (running ? "running" : subagent.status) as SubagentSessionStatus,
		},
	};
}

function messageText(entry: SessionMessageEntry): string {
	const content = (entry.message as { content?: unknown }).content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function activityMs(entry: SessionMessageEntry): number | undefined {
	const message = entry.message as unknown as { timestamp?: number; usage?: { timestamp?: number } };
	const candidate = message.timestamp ?? message.usage?.timestamp;
	return typeof candidate === "number" ? candidate : undefined;
}

/**
 * Their routes reach for this when the session is not in the registry: in their server it starts a
 * `pi` child for it. Here a session that is not running is read from disk, which their routes already
 * do before calling this, so the only honest answer is that this session cannot be started for them.
 */
export async function startRpcSession(id: string, filePath: string, _options?: unknown): Promise<LiveSession> {
	if (isThisSession(id)) return live as LiveSession;
	const opened = openSessionManager(filePath);
	if (!opened) throw new Error("Session not found");
	throw new Error(
		"This session is not running in this Pi process. Start it in a terminal (pi --resume) and reload it here.",
	);
}

/** Their tool pinning: ours is Pi's own active tool set. */
export async function setRpcSessionTools(
	id: string,
	_filePath: string | undefined,
	toolNames: string[] | undefined,
): Promise<{ sessionId: string; recreated: boolean }> {
	if (!isThisSession(id)) throw new Error("Session not found");
	return { sessionId: id, recreated: false };
}

/** A session in this cwd is busy exactly when the one live session is running. */
export function hasBusyRpcSessionForCwd(cwd: string): boolean {
	if (!live?.isAlive()) return false;
	return live.cwd === cwd && live.isRunning();
}

/** Their project-trust route stops sessions of a cwd it is about to untrust. */
export async function destroyRpcSessionsForCwd(_cwd: string): Promise<number> {
	return 0;
}

/** Their subagent runs are Pi's own subagent entries; the sidebar reads them through the route. */
export function getSubagentRun(_id: string, _cwd?: string): SubagentRunInfo | null {
	return null;
}

export async function abortSubagent(_id: string): Promise<boolean> {
	return false;
}

export async function steerSubagent(_id: string, _message: string): Promise<boolean> {
	return false;
}

/** Their `/api/agent/running` reports the sessions whose completion notices are muted. */
export function getCompletionNotificationSuppressedRpcSessionIds(): string[] {
	if (!live?.isAlive()) return [];
	return live.hasSuppressedCompletionNotifications?.() ? [live.sessionId] : [];
}

/** Their `/api/agent/running` and session list report which sessions have a run in flight. */
export function getRunningRpcSessionIds(): string[] {
	if (!live?.isAlive() || !live.isRunning()) return [];
	return [live.sessionId];
}

/** Their `/api/agent/running` reports sessions parked on a blocking dialog. */
export function getAwaitingInputRpcSessionIds(): string[] {
	return [];
}
