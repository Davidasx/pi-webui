/**
 * Their API routes, mounted on our server.
 *
 * `scripts/vendor-web.mjs` copies agegr/pi-web's `app/api/**` handlers. Each one is an ordinary
 * function — `(request, { params }) => Response` — so the only work left is ours: pick the handler
 * for a path, build a platform `Request` from the transport our server speaks, and write the
 * returned `Response` back. Their routes keep their own shape, security checks and error bodies.
 *
 * A route is loaded the first time it is called, so a page load only compiles the endpoints the page
 * actually uses.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { WebServerRequest, WebServerResponse } from "./server.js";
// Their routes type the request as `NextRequest` and read `request.nextUrl`; a plain `Request` would
// leave that undefined, so the bridge hands them the same shim the copied files import.
import { NextRequest } from "./web/shims/next-server.js";

const routesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "web", "pi-web", "app", "api");

/** Their handlers take `params` as a promise; these are the methods one can be called with. */
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

type RouteHandler = (
	request: Request,
	context: { params: Promise<Record<string, string | string[]>> },
) => Promise<Response> | Response;

interface Route {
	/** The path pattern that reaches it, e.g. `sessions/[id]/entries/[entryId]/thinking`. */
	pattern: string;
	/** Its segments, with `[name]` and `[...name]` markers kept for matching. */
	segments: string[];
	/** A literal-first index key: the pattern without any dynamic markers. */
	file: string;
	module?: Promise<Record<string, unknown>>;
}

/**
 * The route table, discovered once. Their `route.ts` files are the authority on which paths exist, so
 * the table is read from disk instead of being written out by hand (where it would drift).
 */
let table: Promise<Route[]> | undefined;

async function loadTable(): Promise<Route[]> {
	const { readdir } = await import("node:fs/promises");
	const routes: Route[] = [];
	const walk = async (dir: string, prefix: string[]) => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(full, [...prefix, entry.name]);
				continue;
			}
			if (entry.name !== "route.ts") continue;
			const segments = prefix;
			routes.push({
				pattern: segments.join("/"),
				segments,
				file: full,
			});
		}
	};
	await walk(routesRoot, []);
	// A literal segment beats a dynamic one, so `/api/files/list` never matches `[...path]` by accident.
	return routes.sort((a, b) => depth(b.segments) - depth(a.segments));
}

function depth(segments: string[]): number {
	return segments.filter((segment) => !segment.startsWith("[")).length;
}

/** `[id]` captures one segment, `[...path]` captures the rest as an array. */
function match(segments: string[], pathname: string): Record<string, string | string[]> | undefined {
	const parts = pathname.split("/").filter(Boolean);
	const params: Record<string, string | string[]> = {};
	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index];
		if (segment.startsWith("[...") && segment.endsWith("]")) {
			// Next hands their routes decoded segments; ours arrive percent-encoded, and a file path
			// left encoded points at a name that does not exist.
			params[segment.slice(4, -1)] = parts.slice(index).map((part) => decodeURIComponent(part));
			return params;
		}
		if (index >= parts.length) return undefined;
		if (segment.startsWith("[") && segment.endsWith("]")) {
			params[segment.slice(1, -1)] = decodeURIComponent(parts[index]);
			continue;
		}
		if (segment !== parts[index]) return undefined;
	}
	return parts.length === segments.length ? params : undefined;
}

async function handlerFor(route: Route): Promise<RouteHandler | undefined> {
	route.module ??= import(pathToFileURL(route.file).href) as Promise<Record<string, unknown>>;
	const loaded = await route.module;
	for (const method of METHODS) {
		const candidate = loaded[method];
		if (typeof candidate === "function") return candidate as RouteHandler;
	}
	return undefined;
}

/** Whether a route handler exists for this request, so the caller can fall through to a 404. */
export async function hasVendoredRoute(pathname: string): Promise<boolean> {
	table ??= loadTable();
	return (await table).some((route) => match(route.segments, pathname.replace(/^\/api\/?/, "")) !== undefined);
}

/** Their body limit, so a huge upload cannot be buffered without bound before their route checks it. */
const MAX_BODY_BYTES = 100 * 1024 * 1024 + 1024 * 1024;

async function readBody(request: WebServerRequest, method: string): Promise<Uint8Array | undefined> {
	if (method === "GET" || method === "HEAD") return undefined;
	const chunks: Uint8Array[] = [];
	let total = 0;
	for await (const chunk of request) {
		total += chunk.byteLength;
		if (total > MAX_BODY_BYTES) throw new Error("Request body is too large");
		chunks.push(chunk);
	}
	return chunks.length === 0 ? new Uint8Array() : Buffer.concat(chunks);
}

function headerRecord(request: WebServerRequest): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(request.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) for (const item of value) headers.append(name, item);
		else headers.set(name, value);
	}
	return headers;
}

/**
 * Serve one of their routes. Returns false when no route matches, so the caller keeps its own 404.
 */
export async function serveVendoredRoute(
	request: WebServerRequest,
	response: WebServerResponse,
	origin: string,
): Promise<boolean> {
	const raw = request.url ?? "/";
	const url = new URL(raw, origin);
	const pathname = url.pathname.replace(/^\/api\/?/, "");
	table ??= loadTable();
	const route = (await table).find((candidate) => match(candidate.segments, pathname) !== undefined);
	if (!route) return false;
	const params = match(route.segments, pathname);
	if (!params) return false;

	const method = (request.method ?? "GET").toUpperCase();
	const handler = await handlerFor(route);
	if (!handler) {
		response.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
		response.end(JSON.stringify({ error: `Method ${method} is not supported here` }));
		return true;
	}

	const body = await readBody(request, method);
	const webRequest = new NextRequest(new URL(raw, origin), {
		method,
		headers: headerRecord(request),
		...(body && body.byteLength > 0 ? { body, duplex: "half" } : {}),
	} as RequestInit);
	const result = await handler(webRequest, { params: Promise.resolve(params) });

	// Their headers are copied as they are: their JSON helper gzips when the browser accepts it, and
	// dropping `content-encoding` while keeping the compressed bytes made the browser parse gzip data
	// as JSON.
	const headers: Record<string, string> = {};
	result.headers.forEach((value, name) => {
		headers[name] = value;
	});
	response.writeHead(result.status, headers);
	if (result.body) {
		for await (const chunk of result.body) response.write(Buffer.from(chunk));
	}
	response.end();
	return true;
}

/** Exposed for tests: the routes their frontend can reach through this bridge. */
export async function vendoredRoutePatterns(): Promise<string[]> {
	table ??= loadTable();
	return (await table).map((route) => route.pattern);
}

/** Their own copy of this file is read to keep the two in step; see the port notes. */
export async function readVendoredFile(relative: string): Promise<string> {
	return readFile(path.join(routesRoot, relative), "utf8");
}
