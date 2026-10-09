/**
 * Helpers for running the hub as a user service instead of letting the extension spawn it.
 *
 * The extension never starts the hub: a supervised service owns the fixed port, so the port is
 * stable across Pi sessions, crashes, and terminal restarts. These helpers only render the unit
 * file and the install steps for the user.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HUB_PORT, hubBaseUrl } from "./hub-protocol.js";

export const HUB_UNIT_NAME = "pi-webui-hub.service";

export interface HubUnitOptions {
	/** Extension root directory; defaults to this package (the parent of `src/`). */
	root?: string;
	/** Fixed listen port written into the unit. */
	port?: number;
	/** Extra `Host` header names, for a tunnel or reverse proxy in front of the hub. */
	allowedHosts?: readonly string[];
}

/** Absolute path of this package's root directory. */
export function resolveExtensionRoot(): string {
	return fileURLToPath(new URL("..", import.meta.url));
}

/**
 * Render the systemd user unit for this installation.
 *
 * The unit is generated here on purpose: this repository ships no service file, and the unit only
 * lives in `~/.config/systemd/user/` where the user owns it.
 */
export function renderHubUnit(options: HubUnitOptions = {}): string {
	const root = options.root ?? resolveExtensionRoot();
	const port = options.port ?? DEFAULT_HUB_PORT;
	const allowedHosts = (options.allowedHosts ?? []).filter(Boolean).join(",");
	const hostsLine = allowedHosts
		? `# Extra Host header names, needed only when a tunnel or reverse proxy fronts the hub.
Environment=PI_WEBUI_ALLOWED_HOSTS=${allowedHosts}`
		: "# Environment=PI_WEBUI_ALLOWED_HOSTS=pi.example.com";
	return `[Unit]
Description=pi-webui hub — fixed-port router for Pi session browser views
After=default.target

[Service]
Type=simple
ExecStart=/usr/bin/env node ${root}/bin/pi-webui-hub.mjs
Restart=on-failure
RestartSec=2

# Fixed listen port. Every Pi session publishes itself here; the hub only routes requests.
Environment=PI_WEBUI_PORT=${port}
${hostsLine}

NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
`;
}

/** Commands to install and start the hub as a user service. */
export function hubInstallSteps(options: HubUnitOptions = {}): string[] {
	const port = options.port ?? DEFAULT_HUB_PORT;
	return [
		"mkdir -p ~/.config/systemd/user",
		`write the unit below to ~/.config/systemd/user/${HUB_UNIT_NAME}`,
		"systemctl --user daemon-reload",
		`systemctl --user enable --now ${HUB_UNIT_NAME}`,
		`systemctl --user status ${HUB_UNIT_NAME}`,
		`open ${hubBaseUrl({ PI_WEBUI_PORT: String(port) } as NodeJS.ProcessEnv)}`,
	];
}

/** Version of this extension package, read from its own manifest when available. */
export function packageVersion(): string | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(resolveExtensionRoot(), "package.json"), "utf8"));
		if (parsed && typeof parsed === "object" && typeof (parsed as { version?: unknown }).version === "string") {
			return (parsed as { version: string }).version;
		}
	} catch {
		// Version reporting is optional.
	}
	return undefined;
}
