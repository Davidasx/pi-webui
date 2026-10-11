/**
 * `next/server` for the route handlers we vendored from agegr/pi-web.
 *
 * Their routes are ordinary functions — `(request, { params }) => Response` — that only use three
 * pieces of Next's surface: `NextResponse.json(body, init)`, `NextResponse.redirect(url, status)` and
 * `NextRequest` with a `nextUrl` whose `searchParams` they read. The platform `Request`/`Response`
 * already do the real work, so this is those three things and nothing more.
 */

class NextResponse extends Response {
	static json(body: unknown, init?: ResponseInit): NextResponse {
		const headers = new Headers(init?.headers);
		if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
		return new NextResponse(JSON.stringify(body), { ...init, headers });
	}

	static redirect(url: string | URL, status = 307): NextResponse {
		const headers = new Headers({ location: String(url) });
		return new NextResponse(null, { status, headers });
	}

	static next(init?: ResponseInit): NextResponse {
		return new NextResponse(null, { status: 200, ...init });
	}
}

/** How their routes reach the query string: `request.nextUrl.searchParams`. */
class NextRequest extends Request {
	private readonly parsedUrl: URL;

	constructor(input: string | URL | Request, init?: RequestInit) {
		super(input, init);
		const raw = typeof input === "string" || input instanceof URL ? String(input) : input.url;
		this.parsedUrl = new URL(raw, "http://localhost");
	}

	get nextUrl(): URL {
		return this.parsedUrl;
	}

	get cookies() {
		const header = this.headers.get("cookie") ?? "";
		const entries = header
			.split(";")
			.map((part) => part.trim())
			.filter(Boolean)
			.map((part) => {
				const index = part.indexOf("=");
				return index === -1 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
			});
		const jar = new Map<string, string>(entries as [string, string][]);
		return {
			get: (name: string) => jar.get(name),
			getAll: (name: string) => (jar.has(name) ? [jar.get(name) as string] : []),
			has: (name: string) => jar.has(name),
		};
	}
}

export { NextRequest, NextResponse };
