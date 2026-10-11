import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";

/**
 * What the page is made of.
 *
 * The behaviour its endpoints owe the browser is in `browser-contract.test.ts`; this file only checks
 * the pieces that cannot be exercised over HTTP — that the page is their frontend mounted rather than
 * re-drawn, and that the copy, its licence and its shims are all present.
 */

const root = process.cwd();
const read = (relative: string) => readFile(path.join(root, relative), "utf8");

const [html, session, _server, _hub, build, porting, vendor] = await Promise.all([
	read("src/web/index.html"),
	read("src/web/session.jsx"),
	read("src/server.ts"),
	read("src/hub.ts"),
	read("scripts/build-web.mjs"),
	read("src/web/pi-web/PORTING.md"),
	read("scripts/vendor-web.mjs"),
]);

test("the page is agegr/pi-web's own frontend, mounted rather than re-drawn", async () => {
	// Their own application shell is the page: sidebar, top bar, panels and chat surface.
	assert.match(session, /from "\.\/pi-web\/components\/AppShell"/);
	assert.match(session, /<AppShell \/>/);
	assert.match(html, /id="root"/);
	assert.match(html, /src="\/app\.js"/);
	assert.match(html, /href="\/app\.css"/);

	// The copy is present, licensed, and documented.
	await stat(path.join(root, "src/web/pi-web/LICENSE.agegr-pi-web"));
	await stat(path.join(root, "src/web/pi-web/components/AppShell.tsx"));
	await stat(path.join(root, "src/web/pi-web/components/MessageView.tsx"));
	await stat(path.join(root, "src/web/pi-web/components/ChatInput.tsx"));
	assert.match(porting, /byte-identical copy/);
});

test("their Next.js imports are shimmed where a bundler is not in the way", async () => {
	// The browser bundle aliases them, and the copy points at the shims directly so the extension can
	// load the same files through Node.
	assert.ok(build.includes("/^next\\/image$/"), "the bundle aliases next/image");
	assert.ok(build.includes("/^next\\/navigation$/"), "the bundle aliases next/navigation");
	// `next/server` appears only in the copied route handlers, which Node loads directly: the
	// vendoring script points those imports at the shim instead of relying on a bundler alias.
	assert.ok(vendor.includes('["next/server", "../shims/next-server.ts"]'), "server imports point at the shim");
	await stat(path.join(root, "src/web/shims/next-image.jsx"));
	await stat(path.join(root, "src/web/shims/next-navigation.tsx"));
	await stat(path.join(root, "src/web/shims/next-server.ts"));
	assert.match(vendor, /PACKAGE_SHIMS/);

	// Their routes come in through the copy too, and the ones that talk to the agent stay ours.
	assert.match(vendor, /OWN_ROUTES/);
	await stat(path.join(root, "src/web/pi-web/app/api/files/[...path]/route.ts"));
	assert.match(vendor, /lib\/rpc-manager\.ts/);
});

test("the front page is their app, not a session picker", async () => {
	// A session list page used to live here; the list belongs to the app's own sidebar.
	const landing = await read("src/hub.ts");
	assert.doesNotMatch(landing, /function landingPage/);
	assert.match(landing, /302/, "the root names a session instead of listing them");
	assert.match(landing, /The app itself is the front page/);
});
