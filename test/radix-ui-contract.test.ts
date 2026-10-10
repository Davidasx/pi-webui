import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";

const packageRoot = process.cwd();
const [manifestSource, html, appSource, overlaysSource, stylesSource] = await Promise.all([
	readFile(path.join(packageRoot, "package.json"), "utf8"),
	readFile(path.join(packageRoot, "src/web/index.html"), "utf8"),
	readFile(path.join(packageRoot, "src/web/ui/app.jsx"), "utf8").catch(() => ""),
	readFile(path.join(packageRoot, "src/web/ui/overlays.jsx"), "utf8").catch(() => ""),
	readFile(path.join(packageRoot, "src/web/ui/styles.css"), "utf8").catch(() => ""),
]);
const manifest = JSON.parse(manifestSource);
const browserSource = `${appSource}\n${overlaysSource}`;

test("browser source uses the complete Radix UI stack", () => {
	for (const dependency of [
		"@radix-ui/colors",
		"@radix-ui/react-icons",
		"@radix-ui/themes",
		"radix-ui",
		"react",
		"react-dom",
	]) {
		assert.equal(typeof manifest.dependencies?.[dependency], "string", dependency);
	}
	assert.match(appSource, /from "@radix-ui\/themes"/);
	assert.match(appSource, /from "@radix-ui\/react-icons"/);
	assert.match(appSource, /from "radix-ui"/);
	assert.match(appSource, /@radix-ui\/colors/);
});

test("HTML is a minimal React shell that loads the hub's shared assets", () => {
	assert.match(html, /id="root"/);
	assert.match(html, /href="\/app\.css"/);
	assert.match(html, /src="\/app\.js"/);
	assert.match(html, /__PI_CSP_NONCE__/);
	assert.doesNotMatch(html, /<(?:button|textarea|dialog|details|summary)\b/);
});

test("Radix primitives own overlays and disclosures without unsafe HTML", () => {
	for (const primitive of ["AlertDialog", "Collapsible", "Dialog", "Popover", "Tooltip"]) {
		assert.match(browserSource, new RegExp(`${primitive}\\.`), primitive);
	}
	assert.doesNotMatch(browserSource, /dangerouslySetInnerHTML|innerHTML|document\.write/);
	assert.match(appSource, /parseMarkdown/);
});

test("alert dialogs expose accessible titles and descriptions", () => {
	assert.equal(overlaysSource.match(/<AlertDialog\.Title asChild>/g)?.length, 2);
	assert.equal(overlaysSource.match(/<AlertDialog\.Description asChild>/g)?.length, 2);
});

test("session header keeps its identity and controls in the flex layout", () => {
	assert.doesNotMatch(appSource, /<Container asChild[^>]*>\s*<header className="session-header">/);
	assert.match(
		appSource,
		/<header className="session-header">[\s\S]*<Container[^>]*>[\s\S]*className="session-header-content"/,
	);
});

test("page footer keeps direct-child layout inside the Container wrapper", () => {
	assert.doesNotMatch(
		overlaysSource,
		/<Container asChild[^>]*>\s*<footer className="page-footer">/,
	);
	assert.match(
		overlaysSource,
		/<footer className="page-footer">[\s\S]*<Container[^>]*>[\s\S]*className="page-footer-content"/,
	);
	assert.match(stylesSource, /\.page-footer-content > \.rt-Separator/);
});

test("composer height keeps the jump-to-latest action clear of dynamic content", () => {
	assert.match(appSource, /new ResizeObserver\(updateComposerHeight\)/);
	assert.match(appSource, /--composer-height/);
	assert.match(appSource, /observer\.observe\(composer\)/);
	assert.match(appSource, /observer\.disconnect\(\)/);
	assert.match(stylesSource, /bottom:\s*calc\(var\(--composer-height/);
});

test("custom states use Radix color scales and preserve adaptive accessibility", () => {
	assert.match(appSource, /@radix-ui\/colors\/(?:jade|green)\.css/);
	assert.match(appSource, /@radix-ui\/colors\/(?:jade|green)-dark\.css/);
	assert.match(stylesSource, /var\(--(?:jade|green)-9\)/);
	assert.match(stylesSource, /var\(--red-9\)/);
	assert.match(stylesSource, /@media \(prefers-reduced-motion: reduce\)/);
	assert.match(stylesSource, /@media \(max-width: 640px\)/);
});
