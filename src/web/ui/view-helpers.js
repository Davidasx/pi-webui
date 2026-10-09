export function shouldBatchConversationEvent(type) {
	return type === "message" || type === "tool";
}

export function shouldScrollForConversationEvent(type, following) {
	return type === "snapshot" && following;
}

export function hasConversationReferenceChange(previousMessages, previousTools, current) {
	return current.messages !== previousMessages || current.tools !== previousTools;
}

export function withPublishedConversation(model, messages, tools) {
	if (model.messages === messages && model.tools === tools) return model;
	return { ...model, messages, tools };
}

export function allowTranscriptAutoScroll(following, active = true) {
	return Boolean(following && active);
}

export function createRenderBatcher(schedule, render) {
	let generation = 0;
	let scheduled = false;
	let pending = {};
	const batch = (extra = {}) => {
		const transcriptAnnouncement = [pending.transcriptAnnouncement, extra.transcriptAnnouncement]
			.filter(Boolean)
			.join(" ");
		const transcriptUpdateKeys = [
			...new Set([...(pending.transcriptUpdateKeys ?? []), ...(extra.transcriptUpdateKeys ?? [])]),
		];
		pending = {
			...pending,
			...extra,
			transcriptAnnouncement,
			scrollToLatest: Boolean(pending.scrollToLatest || extra.scrollToLatest),
			...(transcriptUpdateKeys.length > 0 ? { transcriptUpdateKeys } : {}),
		};
		if (scheduled) return;
		scheduled = true;
		const scheduledGeneration = generation;
		schedule(() => {
			if (scheduledGeneration !== generation) return;
			scheduled = false;
			const next = pending;
			pending = {};
			render(next);
		});
	};
	batch.drain = () => {
		generation += 1;
		scheduled = false;
		const next = pending;
		pending = {};
		return next;
	};
	batch.cancel = () => {
		batch.drain();
	};
	return batch;
}

export function withStableKeys(values) {
	return values.map((value, index) => {
		const type =
			value && typeof value === "object" && typeof value.type === "string" ? value.type : "item";
		const id =
			value &&
			typeof value === "object" &&
			(typeof value.id === "string" || typeof value.id === "number")
				? value.id
				: undefined;
		return { key: id === undefined ? `${type}:index:${index}` : `${type}:id:${id}`, value };
	});
}

export function connectionColor(model) {
	if (model.closed || model.stale) return "red";
	if (!model.connected) return "amber";
	return model.activity === "running" ? "blue" : "jade";
}

export function roleLabel(message) {
	if (message.role === "user") return "You";
	if (message.role === "assistant") return message.final ? "Pi" : "Pi · Streaming";
	if (message.role === "toolResult") {
		return message.toolName ? `Tool · ${message.toolName}` : "Tool";
	}
	return message.role;
}

export function knownRole(role) {
	if (role === "user" || role === "assistant" || role === "toolResult") return role;
	return "other";
}

export function safeJson(value) {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return "Details unavailable";
	}
}

export function resizeInput(input) {
	if (!input) return;
	input.style.height = "auto";
	input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.32)}px`;
}

export function isSupportedImageFile(file) {
	return (
		[
			"image/png",
			"image/jpeg",
			"image/webp",
			"image/gif",
			"image/bmp",
			"image/x-ms-bmp",
			"image/tiff",
			"image/heic",
			"image/heif",
			"image/avif",
		].includes(file.type) || /\.(?:bmp|tif|tiff|heic|heif|avif)$/i.test(file.name || "")
	);
}

export function hasDraggedFile(event) {
	return [...(event.dataTransfer?.items ?? [])].some((item) => item.kind === "file");
}

export function isNearBottom() {
	return document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 160;
}
