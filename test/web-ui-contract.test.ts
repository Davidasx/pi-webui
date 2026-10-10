import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";

const root = path.join(process.cwd(), "src/web");
const [html, app, overlays, client, styles, markdown, imageDrag] = await Promise.all([
	readFile(path.join(root, "index.html"), "utf8"),
	readFile(path.join(root, "ui/app.jsx"), "utf8"),
	readFile(path.join(root, "ui/overlays.jsx"), "utf8"),
	readFile(path.join(root, "ui/client.js"), "utf8"),
	readFile(path.join(root, "ui/styles.css"), "utf8"),
	readFile(path.join(root, "markdown.js"), "utf8"),
	readFile(path.join(root, "image-drag.js"), "utf8"),
]);

test("page hierarchy keeps session context, transcript, and composer in reading order", () => {
	assert.match(html, /id="root"/);
	assert.match(app, /<SessionHeader[\s\S]*<Conversation[\s\S]*<Composer/);
	assert.match(app, /id="transcript"/);
	assert.doesNotMatch(app, /id="transcript"[^>]*aria-live/);
	assert.match(app, /id="transcript-status"/);
	assert.match(app, /aria-live="polite"/);
	assert.match(app, /id="message-input"/);
	assert.match(app, /aria-label="Message Pi"/);
	assert.match(app, /id="send-next"/);
	assert.match(app, /id="composer-status"/);
	assert.match(app, /id="blocking-state"/);
	assert.match(app, /id="attachment-summary"/);
	assert.match(app, /id="attachment-announcement"/);
});

test("browser client claims a lease, reconnects, and keeps failed drafts through hub-relative paths", () => {
	assert.match(client, /crypto\.randomUUID\(\)/);
	assert.match(client, /fetch\("api\/lease"/);
	assert.match(client, /new EventSource\(`api\/events\?since=\$\{model\.sequence\}`\)/);
	assert.match(client, /fetch\("api\/messages"/);
	assert.match(client, /fetch\("api\/draft"/);
	assert.match(client, /scheduleDraftSave\(\)/);
	assert.match(client, /flushDraftText\(\)/);
	assert.match(client, /acknowledgeDraftText/);
	assert.match(client, /draftRevision: attempt\.draftRevision/);
	assert.match(client, /prepareSend\(model, crypto\.randomUUID\(\), steer \? "steer" : "next"\)/);
	assert.match(client, /delivery: attempt\.delivery/);
	assert.match(client, /applyConversationEvent/);
	assert.match(client, /applySnapshot/);
	assert.match(client, /completeSend/);
	assert.match(client, /failSend/);
	assert.match(client, /if \(!model\.leaseClaimed\) await claimLease\(\)/);
	// A proxy in front of the page can buffer or cut the event stream without EventSource noticing.
	assert.match(client, /STREAM_STALL_MS/);
	assert.match(client, /void refreshSnapshot\(\).catch\(connectionFailure\)/);
	assert.doesNotMatch(`${app}\n${client}`, /localStorage|sessionStorage|indexedDB/i);
	// The hub serves every session under a path prefix, so the client must use relative URLs.
	assert.doesNotMatch(`${app}\n${client}`, /["'`]\/api\//);
});

test("image input stages uploads with status and recovery", () => {
	assert.match(app, /const ACCEPTED_IMAGES/);
	for (const format of [
		"image/png",
		"image/jpeg",
		"image/webp",
		"image/gif",
		"image/bmp",
		"image/tiff",
		"image/heic",
		"image/heif",
		"image/avif",
	]) {
		assert.match(app, new RegExp(format.replace("/", "\\/")));
	}
	assert.match(client, /model\.imageLimits/);
	assert.match(client, /limits\.maxImages/);
	assert.match(client, /limits\.maxImageBytes/);
	assert.match(client, /limits\.maxBatchBytes/);
	assert.match(client, /new XMLHttpRequest\(\)/);
	assert.match(client, /request\.upload\.addEventListener\("progress"/);
	assert.match(client, /X-Pi-Web-Client/);
	assert.match(client, /"api\/attachments\/reserve"/);
	assert.match(client, /\/upload\?revision=/);
	assert.match(client, /\/retry/);
	assert.match(app, /Paste, drop, or choose images\./);
	assert.match(app, /Sensitive metadata is removed before sending\./);
	assert.match(app, /attachmentItemLabel/);
	assert.match(app, /Retry/);
	assert.match(app, /Remove image/);
	assert.match(overlays, /Dialog\.Root/);
	assert.match(app, /previewReturnFocus\.current = trigger \?\? document\.activeElement/);
	assert.match(app, /previewReturnFocus\.current\?\.focus\(\)/);
	assert.match(
		app,
		/className="attachment-preview"[\s\S]*onClick=\{\(event\) => onPreview\(image, event\.currentTarget\)\}[\s\S]*type="button"/,
	);
	assert.match(app, /Alt\+ArrowUp Alt\+ArrowDown/);
	assert.match(app, /Order \{index \+ 1\} of \{model\.images\.length\}/);
	assert.match(client, /"api\/attachments\/clear"/);
	assert.doesNotMatch(`${app}\n${client}`, /URL\.createObjectURL|URL\.revokeObjectURL/);
});

test("drag ordering gives directional feedback and updates before request settlement", () => {
	assert.match(app, /dropAfterTarget/);
	assert.match(app, /imagesStackVertically/);
	assert.match(client, /moveImageBefore/);
	assert.match(client, /moveImageAfter/);
	assert.match(client, /model = \{ \.\.\.model, images \}/);
	assert.match(styles, /\.image-preview-item\.drag-before/);
	assert.match(styles, /\.image-preview-item\.drag-after/);
	assert.match(imageDrag, /export function dropAfterTarget/);
});

test("sent-image actions stay contextual and distinguish expiration", () => {
	assert.match(client, /events\.addEventListener\("sent-images"/);
	assert.match(client, /"api\/sent-images\/reattach"/);
	assert.match(client, /api\/sent-images\/\$\{encodeURIComponent\(retainedImageId\)\}/);
	assert.match(app, /Attach again/);
	assert.match(app, /Forget/);
	assert.match(app, /Expired/);
	assert.match(app, /retainedImageStatus/);
	assert.doesNotMatch(app, /sent-image-gallery|retained-image-gallery/);
});

test("tool, thinking, and Markdown rendering remain safe", () => {
	assert.match(app, /Collapsible\.Root/);
	assert.match(app, /Thinking/);
	assert.match(app, /parseMarkdown/);
	assert.match(app, /<MarkdownBlock/);
	assert.doesNotMatch(
		`${app}\n${markdown}`,
		/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write/,
	);
});

test("responsive and accessibility styling covers focus, targets, reflow, and motion", () => {
	assert.match(styles, /min-width:\s*280px/);
	assert.match(styles, /min-height:\s*44px/);
	assert.match(styles, /@media \(max-width: 640px\)/);
	assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
	assert.match(styles, /overflow-wrap:\s*anywhere/);
	assert.match(styles, /max-width:\s*100%/);
	assert.match(styles, /grid-template-columns:\s*68px fit-content\(14rem\) auto/);
});
