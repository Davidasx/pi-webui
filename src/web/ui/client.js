import {
	acknowledgeDraftText,
	applyAttachments,
	applyConversationEvent,
	applyDraft,
	applyImageLimits,
	applyLease,
	applySentImages,
	applySnapshot,
	busyLabel,
	canSend,
	completeSend,
	deliveryNotice,
	editDraftText,
	failSend,
	followLatest,
	initialState,
	invalidateSendAttempt,
	moveImage,
	moveImageAfter,
	moveImageBefore,
	noteUnseenUpdate,
	prepareSend,
	setNearBottom,
} from "../state.js";
import {
	allowTranscriptAutoScroll,
	createRenderBatcher,
	hasConversationReferenceChange,
	shouldBatchConversationEvent,
	shouldScrollForConversationEvent,
	withPublishedConversation,
} from "./view-helpers.js";

const SUPPORTED_IMAGE_TYPES = new Set([
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
]);

const clientId = crypto.randomUUID();
const listeners = new Set();
const retryFiles = new Map();
const uploadProgress = new Map();
let model = initialState();
let publishedMessages = model.messages;
let publishedTools = model.tools;
let events;
let reconnectTimer;
let reconnectDelay = 500;
let snapshotRefresh;
let snapshotTarget = 0;
let draftSaveTimer;
let draftSaveQueue = Promise.resolve();
let mutatingAttachments = false;
let started = false;
let view = createView();
const scheduleConversationRender = createRenderBatcher(
	(callback) => {
		// Streaming can produce many events per frame. Cap transcript work so input remains responsive.
		setTimeout(() => requestAnimationFrame(callback), 50);
	},
	(extra) => {
		publishConversation(extra);
		emit({
			...extra,
			scrollToLatest: allowTranscriptAutoScroll(model.following, !model.closed),
		});
	},
);

function createView(extra = {}) {
	return {
		model: withPublishedConversation(model, publishedMessages, publishedTools),
		mutatingAttachments,
		uploadProgress: new Map(uploadProgress),
		retryableIds: new Set(retryFiles.keys()),
		transcriptAnnouncement: "",
		focusTarget: "",
		scrollToLatest: false,
		...extra,
	};
}

function emit(extra) {
	view = createView(extra);
	for (const listener of listeners) listener();
}

function publishConversation(extra = {}) {
	for (const key of extra.transcriptUpdateKeys ?? []) {
		model = noteUnseenUpdate(model, key);
	}
	publishedMessages = model.messages;
	publishedTools = model.tools;
}

function drainConversationRender() {
	const pending = scheduleConversationRender.drain();
	publishConversation(pending);
	return pending;
}

export const webClient = {
	subscribe(listener) {
		listeners.add(listener);
		return () => listeners.delete(listener);
	},
	getSnapshot() {
		return view;
	},
	start() {
		if (started) return;
		started = true;
		void initialize();
	},
	editText(text) {
		model = editDraftText(model, text);
		scheduleDraftSave();
		emit();
	},
	send(steer = false) {
		return send(steer);
	},
	addFiles(fileList) {
		return addFiles(fileList);
	},
	retryImage(id) {
		return retryImage(id);
	},
	removeImage(id) {
		return removeImage(id);
	},
	clearAttachments() {
		return clearAttachments();
	},
	reorderImage(id, direction) {
		return reorderImages(moveImage(model.images, id, direction), id);
	},
	dropImage(sourceId, targetId, after) {
		const images = after
			? moveImageAfter(model.images, sourceId, targetId)
			: moveImageBefore(model.images, sourceId, targetId);
		return reorderImages(images, sourceId);
	},
	reattachSentImage(id) {
		return reattachSentImage(id);
	},
	forgetSentImage(id) {
		return forgetSentImage(id);
	},
	setNearBottom(nearBottom) {
		const next = setNearBottom(model, nearBottom);
		if (next === model) return;
		model = next;
		emit();
	},
	followLatest() {
		model = followLatest(model);
		emit({ scrollToLatest: true });
	},
};

async function initialize() {
	try {
		await refreshSnapshot();
		await claimLease();
		connectEvents();
	} catch (error) {
		model = { ...model, connected: false, error: errorMessage(error) };
		emit();
		scheduleReconnect();
	}
}

async function refreshSnapshot(requiredSequence = 0) {
	snapshotTarget = Math.max(snapshotTarget, requiredSequence);
	if (!snapshotRefresh) {
		snapshotRefresh = (async () => {
			do {
				let pendingConversation = {};
				const response = await fetch("api/state", { cache: "no-store" });
				if (!response.ok) throw new Error(await responseError(response));
				const snapshot = await response.json();
				const replacesConversation =
					Number.isSafeInteger(snapshot?.sequence) && snapshot.sequence >= model.sequence;
				model = applySnapshot(model, snapshot);
				if (typeof snapshot.lease?.activeClientId === "string") {
					model = applyLease(model, snapshot.lease, clientId);
				}
				if (replacesConversation) {
					pendingConversation = drainConversationRender();
				}
				emit({ ...pendingConversation, scrollToLatest: model.following });
			} while (model.sequence < snapshotTarget);
		})().finally(() => {
			snapshotRefresh = undefined;
		});
	}
	return snapshotRefresh;
}

async function claimLease() {
	const response = await fetch("api/lease", {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Pi-Web-Client": clientId },
		body: JSON.stringify({ clientId }),
	});
	if (!response.ok) throw new Error(await responseError(response));
	model = applyLease(model, await response.json(), clientId, true);
	if (model.textDirty) scheduleDraftSave();
	emit();
}

function connectEvents() {
	clearTimeout(reconnectTimer);
	events?.close();
	events = new EventSource(`api/events?since=${model.sequence}`);
	events.addEventListener("open", () => {
		reconnectDelay = 500;
		model = { ...model, connected: true, error: "" };
		if (model.textDirty) scheduleDraftSave();
		emit();
	});
	events.addEventListener("conversation", (event) => {
		const conversationEvent = JSON.parse(event.data);
		const previousMessages = model.messages;
		const previousTools = model.tools;
		model = applyConversationEvent(model, conversationEvent);
		if (model.needsSnapshot) {
			void refreshSnapshot(conversationEvent.sequence).catch(connectionFailure);
			return;
		}
		if (shouldBatchConversationEvent(conversationEvent.type)) {
			scheduleConversationRender({
				transcriptAnnouncement: conversationAnnouncement(conversationEvent),
				transcriptUpdateKeys: [conversationUpdateKey(conversationEvent)],
			});
			return;
		}
		let pendingConversation = {};
		if (conversationEvent.type === "snapshot" || conversationEvent.type === "session-ended") {
			pendingConversation = drainConversationRender();
			if (
				conversationEvent.type === "snapshot" &&
				hasConversationReferenceChange(previousMessages, previousTools, model)
			) {
				model = noteUnseenUpdate(model, conversationUpdateKey(conversationEvent));
			}
			publishConversation();
		}
		emit({
			...pendingConversation,
			scrollToLatest: shouldScrollForConversationEvent(
				conversationEvent.type,
				model.following && !model.closed,
			),
		});
	});
	events.addEventListener("snapshot", (event) => {
		const snapshot = JSON.parse(event.data);
		const replacesConversation =
			Number.isSafeInteger(snapshot?.sequence) && snapshot.sequence >= model.sequence;
		model = applySnapshot(model, snapshot);
		const pendingConversation = replacesConversation ? drainConversationRender() : {};
		emit({ ...pendingConversation, scrollToLatest: model.following });
	});
	events.addEventListener("lease", (event) => {
		model = applyLease(model, JSON.parse(event.data), clientId);
		emit();
	});
	events.addEventListener("draft", (event) => {
		model = applyDraft(model, JSON.parse(event.data));
		emit();
	});
	events.addEventListener("attachments", (event) => {
		model = applyAttachments(model, JSON.parse(event.data));
		emit();
	});
	events.addEventListener("image-limits", (event) => {
		model = applyImageLimits(model, JSON.parse(event.data));
		emit();
	});
	events.addEventListener("sent-images", (event) => {
		model = applySentImages(model, JSON.parse(event.data));
		emit();
	});
	events.addEventListener("session-ended", () => {
		model = { ...model, closed: true, activity: "ended", connected: false };
		events?.close();
		const pendingConversation = drainConversationRender();
		emit({
			...pendingConversation,
			transcriptAnnouncement: [pendingConversation.transcriptAnnouncement, "Pi session ended."]
				.filter(Boolean)
				.join(" "),
		});
	});
	events.addEventListener("error", () => {
		events?.close();
		if (model.closed) return;
		model = { ...model, connected: false };
		const pendingConversation = drainConversationRender();
		emit(pendingConversation);
		scheduleReconnect();
	});
}

function scheduleReconnect() {
	if (model.closed || reconnectTimer) return;
	reconnectTimer = setTimeout(async () => {
		reconnectTimer = undefined;
		try {
			await refreshSnapshot();
			if (!model.leaseClaimed) await claimLease();
			connectEvents();
		} catch (error) {
			connectionFailure(error);
		}
	}, reconnectDelay);
	reconnectDelay = Math.min(reconnectDelay * 2, 5_000);
}

function connectionFailure(error) {
	model = { ...model, connected: false, error: errorMessage(error) };
	const pendingConversation = drainConversationRender();
	emit(pendingConversation);
	scheduleReconnect();
}

async function send(steer) {
	if (composerLocked() || !canSend(model)) return;
	try {
		await flushDraftText();
	} catch (error) {
		model = { ...model, error: errorMessage(error) };
		emit();
		return;
	}
	if (composerLocked() || !canSend(model) || model.textDirty) return;
	const prepared = prepareSend(model, crypto.randomUUID(), steer ? "steer" : "next");
	const attempt = prepared.attempt;
	model = prepared.state;
	emit();
	try {
		const response = await fetch("api/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Pi-Web-Client": clientId },
			body: JSON.stringify({
				requestId: attempt.requestId,
				draftRevision: attempt.draftRevision,
				delivery: attempt.delivery,
			}),
		});
		if (!response.ok) {
			const message = await responseError(response);
			model = invalidateSendAttempt(model);
			throw new Error(message);
		}
		const accepted = await response.json();
		if (accepted.draft) model = applyDraft(model, accepted.draft);
		if (accepted.attachments) model = applyAttachments(model, accepted.attachments);
		if (accepted.sentImages) model = applySentImages(model, accepted.sentImages);
		for (const id of attempt.attachmentIds) retryFiles.delete(id);
		model = completeSend(model, attempt, accepted.delivery);
		emit({ focusTarget: "input" });
	} catch (error) {
		model = failSend(model, attempt, errorMessage(error));
		emit();
	}
}

async function addFiles(fileList) {
	if (composerLocked() || model.readingImages > 0) return;
	const files = [...(fileList ?? [])];
	if (files.length === 0) return;
	const limits = model.imageLimits;
	if (!limits) return setError("Effective image limits are still loading.");
	if (model.images.length + files.length > limits.maxImages) {
		return setError(`You can attach at most ${limits.maxImages} images.`);
	}
	for (const file of files) {
		if (!isSupportedImageFile(file)) return setError(`${file.name || "Image"} is not supported.`);
		if (file.size > limits.maxImageBytes) {
			return setError(`${file.name || "Image"} is larger than ${formatMib(limits.maxImageBytes)}.`);
		}
	}
	const batchBytes =
		model.images.reduce((total, image) => total + (image.size ?? 0), 0) +
		files.reduce((total, file) => total + file.size, 0);
	if (batchBytes > limits.maxBatchBytes) {
		return setError(`Combined image input is larger than ${formatMib(limits.maxBatchBytes)}.`);
	}
	const pending = files.map((file) => ({ id: crypto.randomUUID(), file }));
	try {
		mutatingAttachments = true;
		emit();
		const response = await attachmentMutation("api/attachments/reserve", {
			method: "POST",
			body: JSON.stringify({
				revision: model.attachmentRevision,
				items: pending.map(({ id, file }) => ({
					id,
					name: file.name || "Pasted image",
					size: file.size,
					mimeType: file.type,
				})),
			}),
		});
		model = applyAttachments(model, response);
		for (const { id, file } of pending) retryFiles.set(id, file);
		emit();
		for (const { id, file } of pending) await uploadFile(id, file);
	} catch (error) {
		setError(errorMessage(error));
	} finally {
		mutatingAttachments = false;
		emit();
	}
}

async function uploadFile(id, file) {
	uploadProgress.set(id, { loaded: 0, total: file.size });
	emit();
	try {
		const state = await uploadAttachment(
			`api/attachments/${encodeURIComponent(id)}/upload?revision=${model.attachmentRevision}`,
			file,
			(progress) => {
				uploadProgress.set(id, progress);
				emit();
			},
		);
		retryFiles.delete(id);
		model = applyAttachments(model, state);
		emit();
	} finally {
		uploadProgress.delete(id);
		emit();
	}
}

function uploadAttachment(path, file, onProgress) {
	return new Promise((resolve, reject) => {
		const request = new XMLHttpRequest();
		request.open("POST", path);
		request.responseType = "json";
		request.setRequestHeader("Content-Type", "application/octet-stream");
		request.setRequestHeader("X-Pi-Web-Client", clientId);
		request.upload.addEventListener("progress", (event) => {
			if (event.lengthComputable) onProgress({ loaded: event.loaded, total: event.total });
		});
		request.addEventListener("load", () => {
			if (request.status >= 200 && request.status < 300) resolve(request.response);
			else reject(new Error(request.response?.error || `Request failed (${request.status}).`));
		});
		request.addEventListener("error", () => reject(new Error("Image upload failed.")));
		request.addEventListener("abort", () => reject(new Error("Image upload was cancelled.")));
		request.send(file);
	});
}

async function retryImage(id) {
	if (composerLocked()) return;
	mutatingAttachments = true;
	emit();
	try {
		const file = retryFiles.get(id);
		if (file) await uploadFile(id, file);
		else {
			const response = await attachmentMutation(
				`api/attachments/${encodeURIComponent(id)}/retry`,
				{
					method: "POST",
					body: JSON.stringify({ revision: model.attachmentRevision }),
				},
			);
			model = applyAttachments(model, response);
		}
		emit();
	} catch (error) {
		setError(errorMessage(error));
	} finally {
		mutatingAttachments = false;
		emit();
	}
}

function scheduleDraftSave() {
	clearTimeout(draftSaveTimer);
	if (!model.textDirty || model.closed || model.stale || !model.connected) return;
	draftSaveTimer = setTimeout(() => {
		draftSaveTimer = undefined;
		void flushDraftText().catch((error) => setError(errorMessage(error)));
	}, 180);
}

function flushDraftText() {
	clearTimeout(draftSaveTimer);
	draftSaveTimer = undefined;
	draftSaveQueue = draftSaveQueue
		.catch(() => undefined)
		.then(async () => {
			while (model.textDirty) {
				if (model.closed || model.stale || !model.connected) {
					throw new Error("Reconnect the active tab to save this draft.");
				}
				const submittedText = model.text;
				const response = await fetch("api/draft", {
					method: "POST",
					headers: { "Content-Type": "application/json", "X-Pi-Web-Client": clientId },
					body: JSON.stringify({
						requestId: crypto.randomUUID(),
						revision: model.draftRevision,
						text: submittedText,
					}),
				});
				if (response.status === 409) {
					await refreshSnapshot();
					continue;
				}
				if (!response.ok) throw new Error(await responseError(response));
				model = acknowledgeDraftText(model, await response.json(), submittedText);
				emit();
			}
		});
	return draftSaveQueue;
}

async function reattachSentImage(retainedImageId) {
	if (composerLocked() || !retainedImageId) return;
	if (model.attachmentPhase !== "empty" && model.attachmentPhase !== "ready") {
		return setError("Wait for current images to finish before attaching again.");
	}
	mutatingAttachments = true;
	emit();
	try {
		const response = await attachmentMutation("api/sent-images/reattach", {
			method: "POST",
			body: JSON.stringify({
				revision: model.attachmentRevision,
				items: [{ retainedId: retainedImageId, id: crypto.randomUUID() }],
			}),
		});
		model = applyDraft(model, response.draft);
		model = applyAttachments(model, response.attachments);
		model = applySentImages(model, response.sentImages);
		model = { ...model, error: "" };
		emit();
	} catch (error) {
		setError(errorMessage(error));
	} finally {
		mutatingAttachments = false;
		emit();
	}
}

async function forgetSentImage(retainedImageId) {
	if (composerLocked() || !retainedImageId) return;
	try {
		const response = await attachmentMutation(
			`api/sent-images/${encodeURIComponent(retainedImageId)}?revision=${model.sentImages.revision}`,
			{ method: "DELETE" },
		);
		model = applySentImages(model, response);
		emit();
	} catch (error) {
		setError(errorMessage(error));
	}
}

async function clearAttachments() {
	if (composerLocked() || model.images.length < 2) return;
	const clearedIds = model.images.map((image) => image.id);
	const state = await mutateAttachmentState("api/attachments/clear", {
		method: "POST",
		body: JSON.stringify({ revision: model.attachmentRevision }),
	});
	if (!state) return;
	for (const id of clearedIds) retryFiles.delete(id);
	emit({ focusTarget: "input" });
}

async function reorderImages(images, focusId) {
	if (composerLocked()) return;
	if (images.every((image, index) => image.id === model.images[index]?.id)) {
		emit({ focusTarget: focusId });
		return;
	}
	const previousImages = model.images;
	const previousRevision = model.attachmentRevision;
	model = { ...model, images };
	mutatingAttachments = true;
	emit({ focusTarget: focusId });
	try {
		const state = await attachmentMutation("api/attachments/reorder", {
			method: "POST",
			body: JSON.stringify({ revision: previousRevision, ids: images.map((image) => image.id) }),
		});
		model = applyAttachments(model, state);
		model = { ...model, error: "" };
	} catch (error) {
		if (model.attachmentRevision === previousRevision) model = { ...model, images: previousImages };
		model = { ...model, error: errorMessage(error) };
	} finally {
		mutatingAttachments = false;
		emit({ focusTarget: focusId });
	}
}

async function removeImage(id) {
	if (composerLocked()) return;
	const state = await mutateAttachmentState(
		`api/attachments/${encodeURIComponent(id)}?revision=${model.attachmentRevision}`,
		{ method: "DELETE", headers: { "Content-Type": "application/json" } },
	);
	if (state) {
		retryFiles.delete(id);
		uploadProgress.delete(id);
	}
}

async function mutateAttachmentState(path, options) {
	if (composerLocked()) return;
	mutatingAttachments = true;
	emit();
	try {
		const state = await attachmentMutation(path, options);
		model = applyAttachments(model, state);
		model = { ...model, error: "" };
		emit();
		return state;
	} catch (error) {
		setError(errorMessage(error));
	} finally {
		mutatingAttachments = false;
		emit();
	}
}

async function attachmentMutation(path, options) {
	const response = await fetch(path, {
		...options,
		headers: {
			"Content-Type": "application/json",
			"X-Pi-Web-Client": clientId,
			...options.headers,
		},
	});
	if (!response.ok) throw new Error(await responseError(response));
	return response.json();
}

export function composerLocked(state = view) {
	return (
		state.model.closed ||
		state.model.stale ||
		state.model.pending ||
		state.mutatingAttachments ||
		state.model.attachmentPhase === "reserved"
	);
}

export function composerStatus(state = view) {
	const current = state.model;
	if (current.readingImages > 0) return "Staging images on this Pi session…";
	if (current.pending) return "Submitting message…";
	const notice = deliveryNotice(current);
	if (notice) return notice;
	if (!current.connected) return "Connection unavailable · Draft is preserved.";
	if (current.closed) return "This Pi session has ended.";
	if (current.stale) return "Another tab controls this session.";
	if (current.activity === "running") {
		return "Pi is working · Queue waits; Steer redirects the active turn.";
	}
	return "Pi is idle · Messages send immediately.";
}

export function connectionLabel(current = model) {
	if (current.closed) return "Session ended";
	if (!current.connected) return "Reconnecting…";
	if (current.stale) return "Read-only tab";
	return current.activity === "running" ? "Pi is working" : "Connected";
}

export function attachmentPhaseLabel(phase) {
	if (phase === "uploading") return "Uploading";
	if (phase === "processing") return "Processing";
	if (phase === "blocked") return "Needs attention";
	if (phase === "reserved") return "Submitting";
	return "Ready";
}

export function attachmentItemLabel(image, progress) {
	if (image.status === "uploading" && progress?.total > 0) {
		const percent = Math.min(100, Math.round((progress.loaded / progress.total) * 100));
		return `Uploading · ${percent}%`;
	}
	if (image.status === "uploading") return "Uploading…";
	if (image.status === "processing") return "Processing…";
	if (image.status === "error") return image.error || "Needs attention";
	const dimensions =
		Number.isSafeInteger(image.width) && Number.isSafeInteger(image.height)
			? ` · ${image.width}×${image.height}`
			: "";
	return `Ready${dimensions}`;
}

export function canSubmit(state = view) {
	return !composerLocked(state) && canSend(state.model);
}

export function primaryActionLabel(state = view) {
	return busyLabel(state.model);
}

function isSupportedImageFile(file) {
	return (
		SUPPORTED_IMAGE_TYPES.has(file.type) ||
		/\.(?:bmp|tif|tiff|heic|heif|avif)$/i.test(file.name || "")
	);
}

function conversationUpdateKey(event) {
	if (event.type === "message" && event.payload?.id) return `message:${event.payload.id}`;
	if (event.type === "tool" && event.payload?.id) return `tool:${event.payload.id}`;
	return event.type;
}

function conversationAnnouncement(event) {
	if (event.type === "message" && event.payload?.final && event.payload.role === "assistant") {
		return "New completed message from Pi.";
	}
	if (event.type === "tool" && event.payload?.phase === "end") {
		return event.payload.isError ? "Tool failed." : "Tool completed.";
	}
	return "";
}

function setError(message) {
	model = { ...model, error: message };
	emit();
}

async function responseError(response) {
	try {
		const body = await response.json();
		return body.error || `${response.status} ${response.statusText}`;
	} catch {
		return `${response.status} ${response.statusText}`;
	}
}

function formatMib(bytes) {
	return `${bytes / (1024 * 1024)} MiB`;
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
