/**
 * Copy agegr/pi-web's frontend files into `src/web/pi-web/`, following imports from the entry points.
 *
 * Their tree is copied byte for byte, with exactly two mechanical rewrites (both documented in
 * `src/web/pi-web/PORTING.md`):
 *
 *  1. the `@/…` path alias becomes a relative path, because we bundle with esbuild rather than Next;
 *  2. extensionless relative imports get a `.js` suffix, which is the convention the copied files
 *     already use and what our Node/bundler resolution expects.
 *
 * Nothing else is touched, so a refresh stays a copy.
 *
 *   node scripts/vendor-web.mjs --from /path/to/agegr-pi-web [--entry components/AppShell.tsx …]
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const targetRoot = path.join(packageRoot, "src", "web", "pi-web");

const DEFAULT_ENTRIES = [
	"components/AppShell.tsx",
	"components/ChatWindow.tsx",
	"lib/initial-navigation.ts",
	// Imported by their `app/layout.tsx` rather than by a component, so following imports alone
	// would leave them behind — and they carry the settings panel, sidebar and sidebar-menu look.
	"app/globals.css",
	"app/settings.css",
	"app/sidebar.css",
	"app/sidebar-menu.css",
	"lib/theme.ts",
];

/**
 * Their API routes are copied too, because they already implement the contract their frontend calls
 * (files, git, skills, models, MCP, session reads) against this machine's own file system. The four
 * below stay ours: they are the ones that talk to the agent, which here is this very process rather
 * than a `pi` child their `rpc-manager` would spawn.
 */
const OWN_ROUTES = [
	"app/api/agent/[id]/route.ts",
	"app/api/agent/[id]/events/route.ts",
	"app/api/agent/new/route.ts",
];

/**
 * Files that are ours rather than a copy: resolved and rewritten like the rest, never overwritten.
 * `lib/rpc-manager.ts` is the adapter between their routes and this process's live session.
 */
const HAND_WRITTEN = new Set(["lib/rpc-manager.ts"]);

/** Every route file their frontend can call, minus the ones we serve ourselves. */
async function routeEntries() {
	const { readdir } = await import("node:fs/promises");
	const found = [];
	const walk = async (dir) => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) await walk(full);
			else if (entry.name === "route.ts") found.push(path.relative(path.join(sourceRoot, "app"), path.dirname(full)).split(path.sep).join("/"));
		}
	};
	await walk(path.join(sourceRoot, "app", "api"));
	return found.map((route) => `app/${route}/route.ts`)
		.filter((route) => !OWN_ROUTES.includes(route))
		.sort();
}

/**
 * Their Next.js imports, mapped to the shims beside the vendored tree. The browser bundle aliases
 * these too, but the extension loads these files through Node, where an alias does not exist — so the
 * copy points at the shim directly and needs no bundler to resolve it.
 */
const PACKAGE_SHIMS = new Map([
	// A step above the copied tree, which is where our shims live: `src/web/shims/`.
	["next/server", "../shims/next-server.ts"],
	["next/image", "../shims/next-image.jsx"],
	["next/navigation", "../shims/next-navigation.tsx"],
]);

/** Import specifiers we resolve inside their repository. Everything else is a package or ours. */
function isInternal(specifier) {
	return (
		specifier.startsWith("@/")
		|| specifier.startsWith("./")
		|| specifier.startsWith("../")
		|| PACKAGE_SHIMS.has(specifier)
	);
}

/** Their Next.js test routes and build config are not part of the browser app. */
function isSkipped(specifier) {
	return specifier.startsWith("@earendil-works/");
}

const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"];

async function resolveFile(fromDir, specifier) {
	// A shim sits beside the vendored tree, so it has no counterpart in their checkout: the mirrored
	// path is all the rewrite needs, and the file itself is never copied or written.
	const shim = PACKAGE_SHIMS.get(specifier);
	if (shim) return path.join(sourceRoot, shim);
	const base = specifier.startsWith("@/")
		? path.join(sourceRoot, specifier.slice(2))
		: path.resolve(fromDir, specifier);
	for (const suffix of CANDIDATE_SUFFIXES) {
		const candidate = base + suffix;
		if (candidate.startsWith(sourceRoot) && (await exists(candidate)) && !(await isDirectory(candidate))) {
			return candidate;
		}
	}
	return null;
}

async function exists(file) {
	try {
		await readFile(file);
		return true;
	} catch {
		return false;
	}
}

async function isDirectory(target) {
	const { stat } = await import("node:fs/promises");
	try {
		return (await stat(target)).isDirectory();
	} catch {
		return false;
	}
}

/** Every import/export specifier in a source file. Dynamic imports are included. */
function specifiersOf(source) {
	const found = new Set();
	const patterns = [
		// `from "…"` covers a multi-line import list, a re-export and a type import alike.
		/\bfrom\s*["']([^"']+)["']/g,
		/(?:^|\n)\s*import\s*["']([^"']+)["']/g,
		/\bimport\(\s*["']([^"']+)["']\s*\)/g,
	];
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) found.add(match[1]);
	}
	return [...found];
}

/** The two rewrites, applied to one file's text. Relative paths are computed against its own folder. */
function rewrite(source, fromFile, resolvedBySpecifier) {
	return source.replace(
		/(\bfrom\s*|\bimport\(\s*|\bimport\s*)["']([^"']+)["']/g,
		(match, prefix, specifier) => {
			if (!isInternal(specifier)) return match;
			const target = resolvedBySpecifier.get(specifier);
			if (!target) return match;
			// Both trees mirror each other, so the relative path is computed in their coordinates:
			// using the absolute paths would produce a path that only works inside their checkout.
			const fromRelative = path.relative(sourceRoot, fromFile);
			const targetRelative = path.relative(sourceRoot, target);
			let relative = path
				.relative(path.dirname(fromRelative), targetRelative)
				.split(path.sep)
				.join("/");
			if (!relative.startsWith(".")) relative = `./${relative}`;
			// Only code imports take the `.js` convention; a stylesheet keeps its own extension.
			if (path.extname(relative) === "" || /\.(ts|tsx|js|jsx)$/.test(relative)) {
				relative = `${relative.replace(/\.(ts|tsx|js|jsx)$/, "")}.js`;
			}
			return `${prefix}"${relative}"`;
		},
	);
}

let sourceRoot = "";

async function main() {
	const args = process.argv.slice(2);
	const fromIndex = args.indexOf("--from");
	if (fromIndex === -1 || !args[fromIndex + 1]) {
		console.error("usage: node scripts/vendor-web.mjs --from <agegr-pi-web checkout> [--entry <file> …]");
		process.exit(2);
	}
	sourceRoot = path.resolve(args[fromIndex + 1]);
	const entryIndex = args.indexOf("--entry");
	const entries = entryIndex === -1 ? [...DEFAULT_ENTRIES, ...(await routeEntries())] : args.slice(entryIndex + 1);

	const queue = entries.map((entry) => path.resolve(sourceRoot, entry));
	const seen = new Set();
	const missing = new Set();
	const skipped = new Set();
	const kept = new Set();
	let written = 0;
	let unchanged = 0;
	let rewritten = 0;

	while (queue.length > 0) {
		const file = queue.shift();
		if (seen.has(file)) continue;
		seen.add(file);
		const ours = path.join(targetRoot, path.relative(sourceRoot, file));
		const handWritten = HAND_WRITTEN.has(path.relative(sourceRoot, file).split(path.sep).join("/"));
		const source = await readFile(file, "utf8");

		// Resolve this file's internal imports first, so the rewrite knows the targets.
		const resolvedBySpecifier = new Map();
		for (const specifier of specifiersOf(source)) {
			if (isSkipped(specifier)) {
				skipped.add(specifier);
				continue;
			}
			if (!isInternal(specifier)) continue;
			const resolved = await resolveFile(path.dirname(file), specifier);
			if (!resolved) {
				missing.add(`${specifier}  (from ${path.relative(sourceRoot, file)})`);
				continue;
			}
			resolvedBySpecifier.set(specifier, resolved);
			// A shim and a hand-written file are never walked: they are ours, not part of the copy.
			const isShim = PACKAGE_SHIMS.has(specifier);
			if (!handWritten && !isShim) queue.push(resolved);
		}

		const text = rewrite(source, file, resolvedBySpecifier);
		if (text !== source) rewritten += 1;
		if (handWritten) {
			kept.add(path.relative(sourceRoot, file).split(path.sep).join("/"));
			continue;
		}
		let previous = null;
		try {
			previous = await readFile(ours, "utf8");
		} catch {
			// New file.
		}
		if (previous === text) {
			unchanged += 1;
			continue;
		}
		await mkdir(path.dirname(ours), { recursive: true });
		await writeFile(ours, text, "utf8");
		written += 1;
	}

	console.log(`files visited: ${seen.size}`);
	if (kept.size > 0) console.log(`left to us (not copied): ${[...kept].sort().join(", ")}`);
	console.log(`written: ${written}   already identical: ${unchanged}   needed a rewrite: ${rewritten}`);
	if (missing.size > 0) {
		console.log(`\nunresolved imports (${missing.size}):`);
		for (const item of [...missing].sort()) console.log(`  ${item}`);
	}
	if (skipped.size > 0) {
		console.log(`\nleft to their toolchain (${skipped.size}): ${[...skipped].sort().join(", ")}`);
	}
}

await main();
