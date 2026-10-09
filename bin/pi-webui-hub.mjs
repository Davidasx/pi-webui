#!/usr/bin/env node
// Entry point for the pi-webui hub (systemd user service or manual run).
//
// Node runs the TypeScript source directly via type stripping, so the service needs no build step.

import { HUB_USAGE, runHubCli } from "../src/hub.ts";

const code = await runHubCli(process.argv.slice(2)).catch((error) => {
	process.stderr.write(`pi-webui-hub failed: ${error instanceof Error ? error.message : String(error)}\n`);
	return 1;
});

if (code !== 0 && code !== undefined) process.stderr.write(`\n${HUB_USAGE}`);
process.exitCode = code ?? 0;
