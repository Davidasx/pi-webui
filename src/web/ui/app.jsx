import "@radix-ui/themes/styles.css";
import "@radix-ui/colors/jade.css";
import "@radix-ui/colors/jade-dark.css";
import "@radix-ui/colors/red.css";
import "@radix-ui/colors/red-dark.css";
import {
	ArrowDownIcon,
	CheckCircledIcon,
	ChevronDownIcon,
	CodeIcon,
	ExclamationTriangleIcon,
	FileTextIcon,
	ImageIcon,
	InfoCircledIcon,
	PaperPlaneIcon,
	ReloadIcon,
	StopwatchIcon,
	TrashIcon,
} from "@radix-ui/react-icons";
import {
	Badge,
	Box,
	Button,
	Callout,
	Card,
	Code,
	Container,
	Flex,
	Heading,
	IconButton,
	Link,
	Spinner,
	Text,
	TextArea,
	Theme,
} from "@radix-ui/themes";
import { Collapsible, Popover, Tooltip } from "radix-ui";
import {
	memo,
	StrictMode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import { dropAfterTarget, imagesStackVertically } from "../image-drag.js";
import { parseMarkdown } from "../markdown.js";
import {
	isCollapsibleMessageRole,
	retainedImageStatus,
	toolCommandPreview,
	toolPhaseLabel,
} from "../transcript.js";
import {
	attachmentItemLabel,
	attachmentPhaseLabel,
	canSubmit,
	composerLocked,
	composerStatus,
	connectionLabel,
	primaryActionLabel,
	webClient,
} from "./client.js";
import {
	ClearAttachmentsDialog,
	ForgetImageDialog,
	ImagePreviewDialog,
	PageFooter,
} from "./overlays.jsx";
import "./styles.css";
import {
	connectionColor,
	hasDraggedFile,
	isNearBottom,
	isSupportedImageFile,
	knownRole,
	resizeInput,
	roleLabel,
	safeJson,
	withStableKeys,
} from "./view-helpers.js";

const ACCEPTED_IMAGES =
	"image/png,image/jpeg,image/webp,image/gif,image/bmp,image/tiff,image/heic,image/heif,image/avif,.bmp,.tif,.tiff,.heic,.heif,.avif";
const DRAG_TYPE = "application/x-pi-webui-image";

function useAppearance() {
	const query = "(prefers-color-scheme: dark)";
	const [appearance, setAppearance] = useState(() =>
		window.matchMedia(query).matches ? "dark" : "light",
	);
	useEffect(() => {
		const media = window.matchMedia(query);
		const update = () => setAppearance(media.matches ? "dark" : "light");
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);
	return appearance;
}

function App() {
	const view = useSyncExternalStore(webClient.subscribe, webClient.getSnapshot);
	const appearance = useAppearance();
	const [clearOpen, setClearOpen] = useState(false);
	const [forgetId, setForgetId] = useState("");
	const [previewImage, setPreviewImage] = useState();
	const [dragActive, setDragActive] = useState(false);
	const dragDepth = useRef(0);
	const clearReturnFocus = useRef();
	const forgetReturnFocus = useRef();
	const previewReturnFocus = useRef();
	const model = view.model;

	useEffect(() => webClient.start(), []);
	useEffect(() => {
		const update = () => webClient.setNearBottom(isNearBottom());
		window.addEventListener("scroll", update, { passive: true });
		return () => window.removeEventListener("scroll", update);
	}, []);
	useEffect(() => {
		if (!view.scrollToLatest) return;
		requestAnimationFrame(() =>
			window.scrollTo({
				top: document.body.scrollHeight,
				behavior: model.following ? "auto" : "smooth",
			}),
		);
	}, [view, model.following]);
	useEffect(() => {
		if (!view.focusTarget) return;
		requestAnimationFrame(() => {
			if (view.focusTarget === "input") document.querySelector("#message-input")?.focus();
			else {
				const id = CSS.escape(view.focusTarget);
				document.querySelector(`[data-image-id="${id}"]`)?.focus();
			}
		});
	}, [view]);
	useEffect(() => {
		if (previewImage && !model.images.some((image) => image.id === previewImage.id)) {
			closeImagePreview();
		}
	});
	useEffect(() => {
		const paste = (event) => {
			const files = [...(event.clipboardData?.files ?? [])].filter(isSupportedImageFile);
			if (files.length === 0 || composerLocked(view)) return;
			event.preventDefault();
			void webClient.addFiles(files);
		};
		document.addEventListener("paste", paste);
		return () => document.removeEventListener("paste", paste);
	}, [view]);

	function openClearDialog(trigger) {
		clearReturnFocus.current = trigger;
		setClearOpen(true);
	}

	function setClearDialogOpen(open) {
		setClearOpen(open);
		if (!open) requestAnimationFrame(() => clearReturnFocus.current?.focus());
	}

	const openForgetDialog = useCallback((id, trigger) => {
		forgetReturnFocus.current = trigger;
		setForgetId(id);
	}, []);

	function closeForgetDialog() {
		setForgetId("");
		requestAnimationFrame(() => forgetReturnFocus.current?.focus());
	}

	function openImagePreview(image, trigger) {
		previewReturnFocus.current = trigger ?? document.activeElement;
		setPreviewImage(image);
	}

	function closeImagePreview() {
		setPreviewImage(undefined);
		requestAnimationFrame(() => previewReturnFocus.current?.focus());
	}

	const fileDropProps = {
		onDragEnter(event) {
			if (!hasDraggedFile(event.nativeEvent) || composerLocked(view)) return;
			event.preventDefault();
			dragDepth.current += 1;
			setDragActive(true);
		},
		onDragOver(event) {
			if (!hasDraggedFile(event.nativeEvent) || composerLocked(view)) return;
			event.preventDefault();
		},
		onDragLeave() {
			dragDepth.current = Math.max(0, dragDepth.current - 1);
			if (dragDepth.current === 0) setDragActive(false);
		},
		onDrop(event) {
			dragDepth.current = 0;
			setDragActive(false);
			const files = [...(event.dataTransfer?.files ?? [])].filter(isSupportedImageFile);
			if (files.length === 0 || composerLocked(view)) return;
			event.preventDefault();
			void webClient.addFiles(files);
		},
	};

	return (
		<Theme
			appearance={appearance}
			accentColor="jade"
			grayColor="sand"
			panelBackground="translucent"
			radius="large"
			scaling="100%"
		>
			<Tooltip.Provider delayDuration={350}>
				<Link className="skip-link" href="#message-input" highContrast>
					Skip to message
				</Link>
				<SessionHeader model={model} />
				<Container asChild size="3" px={{ initial: "3", sm: "5" }}>
					<main>
						<Conversation model={model} onForget={openForgetDialog} view={view} />
						{model.unseenUpdateIds.length > 0 && (
							<Button
								className="jump-latest"
								highContrast
								id="jump-latest"
								onClick={() => webClient.followLatest()}
								variant="surface"
							>
								<ArrowDownIcon />
								{model.unseenUpdateIds.length > 1
									? `${model.unseenUpdateIds.length} new updates`
									: "Jump to latest"}
							</Button>
						)}
						<BlockingState model={model} />
						<Composer
							dragActive={dragActive}
							onClear={(event) => openClearDialog(event.currentTarget)}
							onPreview={openImagePreview}
							view={view}
							{...fileDropProps}
						/>
					</main>
				</Container>
				<PageFooter />
				<ClearAttachmentsDialog
					count={model.images.length}
					onOpenChange={setClearDialogOpen}
					open={clearOpen}
				/>
				<ForgetImageDialog id={forgetId} onOpenChange={(open) => !open && closeForgetDialog()} />
				<ImagePreviewDialog
					image={previewImage}
					onOpenChange={(open) => !open && closeImagePreview()}
					revision={model.attachmentRevision}
				/>
			</Tooltip.Provider>
		</Theme>
	);
}

function SessionHeader({ model }) {
	return (
		<header className="session-header">
			<Container size="3" px={{ initial: "3", sm: "5" }}>
				<Flex className="session-header-content">
					<Box className="session-identity">
						<Text as="p" className="eyebrow" color="jade" size="1" weight="bold">
							Pi WebUI
						</Text>
						<Heading as="h1" id="project-name" size="6">
							{model.session?.projectName ?? "Connecting…"}
						</Heading>
						<Text as="p" color="gray" id="session-name" size="2">
							{model.session?.name ?? "Current session"}
						</Text>
					</Box>
					<Flex align="center" className="session-controls" gap="2">
						<Badge color={connectionColor(model)} id="connection-status" role="status" size="2">
							{model.activity === "running" && !model.stale && !model.closed ? (
								<Spinner size="1" />
							) : (
								<CheckCircledIcon />
							)}
							{connectionLabel(model)}
						</Badge>
						<Popover.Root>
							<Popover.Trigger asChild>
								<Button color="gray" highContrast variant="ghost">
									<InfoCircledIcon /> Session details <ChevronDownIcon />
								</Button>
							</Popover.Trigger>
							<Popover.Content align="end" className="session-popover" sideOffset={6}>
								<Text as="div" color="gray" size="1" weight="bold">
									Working directory
								</Text>
								<Code id="cwd" size="1" variant="ghost">
									{model.session?.cwd ?? "—"}
								</Code>
								<Popover.Arrow className="popover-arrow" />
							</Popover.Content>
						</Popover.Root>
					</Flex>
				</Flex>
			</Container>
		</header>
	);
}

function Conversation({ model, onForget, view }) {
	const tools = useMemo(() => new Map(model.tools.map((tool) => [tool.id, tool])), [model.tools]);
	const retained = useMemo(
		() => new Set((model.sentImages.items ?? []).map((image) => image.id)),
		[model.sentImages.items],
	);
	return (
		<section className="conversation" aria-labelledby="conversation-title">
			<Heading as="h2" className="visually-hidden" id="conversation-title">
				Current Pi conversation
			</Heading>
			{model.messages.length === 0 && (
				<Flex align="center" className="empty-state" direction="column" justify="center">
					<FileTextIcon className="empty-icon" />
					<Heading as="h3" size="3">
						No messages yet
					</Heading>
					<Text color="gray" size="2">
						Messages from this Pi session will appear here.
					</Text>
				</Flex>
			)}
			<Box asChild>
				<ol id="transcript">
					{model.messages.map((message) => (
						<Message
							key={message.id}
							message={message}
							onForget={onForget}
							retained={retained}
							tools={tools}
						/>
					))}
				</ol>
			</Box>
			<Text
				as="p"
				className="visually-hidden"
				id="transcript-status"
				role="status"
				aria-live="polite"
			>
				{view.transcriptAnnouncement}
			</Text>
		</section>
	);
}

const Message = memo(function Message({ message, onForget, retained, tools }) {
	const role = knownRole(message.role);
	const body = (
		<Box className="message-body">
			{withStableKeys(message.content ?? []).map(({ key, value: block }) => (
				<MessageBlock
					key={key}
					block={block}
					onForget={onForget}
					retained={retained}
					tool={tools.get(block.id)}
				/>
			))}
			{message.errorMessage && (
				<Callout.Root color="red" role="alert" size="1" variant="soft">
					<Callout.Icon>
						<ExclamationTriangleIcon />
					</Callout.Icon>
					<Callout.Text>{message.errorMessage}</Callout.Text>
				</Callout.Root>
			)}
		</Box>
	);
	return (
		<Box asChild className={`message ${role}`}>
			<li>
				{isCollapsibleMessageRole(message.role) ? (
					<Collapsible.Root className="message-disclosure">
						<Collapsible.Trigger asChild>
							<Button className="message-heading" color="gray" variant="ghost">
								<CodeIcon /> {roleLabel(message)} <ChevronDownIcon className="disclosure-icon" />
							</Button>
						</Collapsible.Trigger>
						<Collapsible.Content>{body}</Collapsible.Content>
					</Collapsible.Root>
				) : (
					<>
						<Text as="div" className="message-heading" color="gray" size="1" weight="bold">
							{roleLabel(message)}
						</Text>
						{body}
					</>
				)}
			</li>
		</Box>
	);
}, messagePropsEqual);

function messagePropsEqual(previous, next) {
	if (
		previous.message !== next.message ||
		previous.onForget !== next.onForget ||
		previous.retained !== next.retained
	) {
		return false;
	}
	if (previous.tools === next.tools) return true;
	for (const block of previous.message.content ?? []) {
		if (block.type === "toolCall" && previous.tools.get(block.id) !== next.tools.get(block.id)) {
			return false;
		}
	}
	return true;
}

function MessageBlock({ block, onForget, retained, tool }) {
	if (block.type === "text") return <Markdown text={block.text} />;
	if (block.type === "thinking") {
		return (
			<Collapsible.Root className="thinking">
				<Collapsible.Trigger asChild>
					<Button color="gray" variant="ghost">
						<StopwatchIcon /> Thinking <ChevronDownIcon className="disclosure-icon" />
					</Button>
				</Collapsible.Trigger>
				<Collapsible.Content>
					<pre>{block.text}</pre>
				</Collapsible.Content>
			</Collapsible.Root>
		);
	}
	if (block.type === "toolCall") return <ToolCall call={block} tool={tool} />;
	if (block.type === "image") {
		return <SentImageChip block={block} onForget={onForget} retained={retained} />;
	}
	return null;
}

const Markdown = memo(function Markdown({ text }) {
	return (
		<Box className="message-markdown">
			{withStableKeys(parseMarkdown(text)).map(({ key, value: block }) => (
				<MarkdownBlock block={block} key={key} />
			))}
		</Box>
	);
});

function MarkdownBlock({ block }) {
	if (block.type === "heading") {
		const level = Math.min(6, block.level + 2);
		return (
			<Heading as={`h${level}`} className="markdown-heading" size="3">
				<MarkdownInline nodes={block.children} />
			</Heading>
		);
	}
	if (block.type === "list") {
		const List = block.ordered ? "ol" : "ul";
		return (
			<List className="markdown-list">
				{withStableKeys(block.items).map(({ key, value: item }) => (
					<li key={key}>
						<MarkdownInline nodes={item} />
					</li>
				))}
			</List>
		);
	}
	if (block.type === "blockquote") {
		return (
			<blockquote>
				{withStableKeys(block.children).map(({ key, value: child }) => (
					<MarkdownBlock block={child} key={key} />
				))}
			</blockquote>
		);
	}
	if (block.type === "codeBlock") {
		return (
			<pre className="markdown-code">
				<code data-language={block.language || undefined}>{block.text}</code>
			</pre>
		);
	}
	return (
		<Text as="p" className="message-text">
			<MarkdownInline nodes={block.children} />
		</Text>
	);
}

function MarkdownInline({ nodes }) {
	return withStableKeys(nodes).map(({ key, value: node }) => {
		if (node.type === "text") return node.text;
		if (node.type === "code") return <Code key={key}>{node.text}</Code>;
		if (node.type === "strong") {
			return (
				<strong key={key}>
					<MarkdownInline nodes={node.children} />
				</strong>
			);
		}
		if (node.type === "emphasis") {
			return (
				<em key={key}>
					<MarkdownInline nodes={node.children} />
				</em>
			);
		}
		return (
			<Link href={node.href} key={key} rel="noopener noreferrer" target="_blank">
				<MarkdownInline nodes={node.children} />
			</Link>
		);
	});
}

function ToolCall({ call, tool }) {
	const phase = toolPhaseLabel(tool);
	const command = toolCommandPreview(tool);
	const args = safeJson(tool?.args ?? call.arguments);
	const result = tool?.result === undefined ? "" : safeJson(tool.result);
	return (
		<Collapsible.Root className={`tool ${tool?.isError ? "failed" : ""}`}>
			<Card asChild size="1">
				<Box>
					<Collapsible.Trigger asChild>
						<Button className="tool-trigger" color={tool?.isError ? "red" : "gray"} variant="ghost">
							<CodeIcon />
							<span>{`${call.name} · ${phase}`}</span>
							{command && <Code className="tool-command">{command}</Code>}
							<ChevronDownIcon className="disclosure-icon" />
						</Button>
					</Collapsible.Trigger>
					<Collapsible.Content className="tool-content">
						<pre>{args}</pre>
						{result && <pre>{result}</pre>}
					</Collapsible.Content>
				</Box>
			</Card>
		</Collapsible.Root>
	);
}

function SentImageChip({ block, onForget, retained }) {
	const status = retainedImageStatus(block, retained);
	const label = `Image${block.mimeType ? ` · ${block.mimeType}` : ""}`;
	return (
		<Flex align="center" className="image-chip" gap="2" wrap="wrap">
			<ImageIcon />
			<Text color="gray" size="1">
				{label}
			</Text>
			{status === "eligible" && (
				<>
					<Button
						onClick={() => void webClient.reattachSentImage(block.retainedImageId)}
						size="1"
						variant="soft"
						aria-label={`Attach image again: ${label}`}
					>
						<ImageIcon /> Attach again
					</Button>
					<Button
						color="gray"
						onClick={(event) => onForget(block.retainedImageId, event.currentTarget)}
						size="1"
						variant="ghost"
						aria-label={`Forget retained image: ${label}`}
					>
						<TrashIcon /> Forget
					</Button>
				</>
			)}
			{status === "expired" && (
				<Badge color="gray" variant="soft">
					Expired
				</Badge>
			)}
		</Flex>
	);
}

function BlockingState({ model }) {
	if (!model.closed && !model.stale) return null;
	return (
		<Callout.Root className="blocking-state" color="red" id="blocking-state" role="alert">
			<Callout.Icon>
				<ExclamationTriangleIcon />
			</Callout.Icon>
			<Callout.Text>
				<strong>{model.closed ? "Pi session ended" : "Another tab is active"}</strong>
				<br />
				{model.closed
					? "Return to the terminal and run /webui for the active session."
					: "This tab remains readable. Refresh it to take control."}
			</Callout.Text>
		</Callout.Root>
	);
}

function Composer({ dragActive, onClear, onPreview, view, ...dropProps }) {
	const inputRef = useRef();
	const fileRef = useRef();
	const composerRef = useRef();
	const model = view.model;
	const locked = composerLocked(view);
	const admissionLocked = locked || model.readingImages > 0;
	useEffect(() => resizeInput(inputRef.current));
	useEffect(() => {
		const composer = composerRef.current;
		if (!composer) return;
		const root = document.documentElement;
		const updateComposerHeight = () =>
			root.style.setProperty("--composer-height", `${composer.offsetHeight}px`);
		updateComposerHeight();
		const observer = new ResizeObserver(updateComposerHeight);
		observer.observe(composer);
		return () => {
			observer.disconnect();
			root.style.removeProperty("--composer-height");
		};
	}, []);
	return (
		<Card asChild className={`composer ${dragActive ? "drag-active" : ""}`} id="composer" size="2">
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void webClient.send(false);
				}}
				ref={composerRef}
				{...dropProps}
			>
				<Flex direction="column" gap="3">
					<Text as="label" htmlFor="message-input" size="2" weight="bold">
						Message Pi
					</Text>
					<TextArea
						aria-label="Message Pi"
						disabled={model.closed || model.stale}
						id="message-input"
						onChange={(event) => webClient.editText(event.target.value)}
						onKeyDown={(event) => {
							if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
								event.preventDefault();
								void webClient.send(false);
							}
						}}
						placeholder="Ask Pi to do something…"
						ref={inputRef}
						resize="none"
						rows={1}
						size="3"
						value={model.text}
					/>
					{model.images.length > 0 && (
						<Text
							as="p"
							className="attachment-summary"
							color="gray"
							id="attachment-summary"
							size="1"
						>
							{`${model.images.length}/${model.imageLimits?.maxImages ?? model.images.length} images attached · Sensitive metadata is removed before sending.`}
						</Text>
					)}
					<AttachmentList onPreview={onPreview} view={view} />
					<Text
						as="p"
						aria-atomic="true"
						aria-live="polite"
						className="visually-hidden"
						id="attachment-announcement"
						role="status"
					>
						{model.images.length
							? `Attachment state: ${attachmentPhaseLabel(model.attachmentPhase)}.`
							: ""}
					</Text>
					{model.error && (
						<Callout.Root color="red" id="composer-error" role="alert" size="1">
							<Callout.Icon>
								<ExclamationTriangleIcon />
							</Callout.Icon>
							<Callout.Text>{model.error}</Callout.Text>
						</Callout.Root>
					)}
					<Flex align="center" className="composer-bottom" gap="2" justify="between" wrap="wrap">
						<Flex align="center" className="composer-support" gap="2" wrap="wrap">
							<Button asChild disabled={admissionLocked} variant="soft">
								<label htmlFor="image-input">
									<ImageIcon /> Add images
								</label>
							</Button>
							<input
								accept={ACCEPTED_IMAGES}
								disabled={admissionLocked}
								hidden
								id="image-input"
								multiple
								onChange={(event) => {
									void webClient.addFiles(event.target.files);
									event.target.value = "";
								}}
								ref={fileRef}
								type="file"
							/>
							<Text className="image-hint" color="gray" size="1">
								Paste, drop, or choose images.
							</Text>
							{model.images.length >= 2 && (
								<Button
									color="gray"
									disabled={locked}
									onClick={onClear}
									type="button"
									variant="ghost"
								>
									<TrashIcon /> Clear attachments
								</Button>
							)}
						</Flex>
						<Flex className="send-actions" gap="2">
							{model.activity === "running" && (
								<Button
									disabled={!canSubmit(view)}
									onClick={() => void webClient.send(true)}
									type="button"
									variant="soft"
								>
									<ReloadIcon /> Steer
								</Button>
							)}
							<Button disabled={!canSubmit(view)} id="send-next" type="submit">
								<PaperPlaneIcon /> {primaryActionLabel(view)}
							</Button>
						</Flex>
					</Flex>
					<Text as="p" color="gray" id="composer-status" role="status" size="1">
						{composerStatus(view)}
					</Text>
				</Flex>
			</form>
		</Card>
	);
}

function AttachmentList({ onPreview, view }) {
	const listRef = useRef();
	const [draggedId, setDraggedId] = useState("");
	const [dropTarget, setDropTarget] = useState();
	const model = view.model;
	if (model.images.length === 0) return null;
	return (
		<Flex asChild gap="2" ref={listRef} wrap="wrap">
			<ul
				aria-busy={view.mutatingAttachments || undefined}
				aria-label="Attached images"
				id="image-previews"
			>
				{model.images.map((image, index) => {
					const orderingLocked = composerLocked(view) || model.attachmentPhase !== "ready";
					const reorderable = model.images.length > 1 && image.status === "ready";
					const draggable = reorderable && !orderingLocked;
					const retryable =
						image.status === "error" && (image.retryable || view.retryableIds.has(image.id));
					return (
						<Card
							asChild
							className={`image-preview-item ${draggedId === image.id ? "dragging" : ""} ${dropTarget?.id === image.id ? `drag-${dropTarget.after ? "after" : "before"}` : ""}`}
							key={image.id}
							size="1"
						>
							<li
								aria-keyshortcuts={reorderable ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
								aria-label={
									reorderable
										? `${image.name}, image ${index + 1} of ${model.images.length}. Drag to reorder or press Alt plus Up or Down Arrow.`
										: undefined
								}
								data-image-id={image.id}
								draggable={draggable}
								onDragEnd={() => {
									setDraggedId("");
									setDropTarget(undefined);
								}}
								onDragLeave={(event) => {
									if (!event.currentTarget.contains(event.relatedTarget)) setDropTarget(undefined);
								}}
								onDragOver={(event) => {
									const sourceId = draggedId || event.dataTransfer?.getData(DRAG_TYPE);
									if (orderingLocked || !sourceId || sourceId === image.id) return;
									event.preventDefault();
									const vertical = imagesStackVertically(listRef.current?.children ?? []);
									setDropTarget({
										id: image.id,
										after: dropAfterTarget(event, event.currentTarget, vertical),
									});
								}}
								onDragStart={(event) => {
									if (!draggable) return;
									setDraggedId(image.id);
									event.dataTransfer.effectAllowed = "move";
									event.dataTransfer.setData(DRAG_TYPE, image.id);
								}}
								onDrop={(event) => {
									const sourceId = draggedId || event.dataTransfer?.getData(DRAG_TYPE);
									if (orderingLocked || !sourceId || sourceId === image.id) return;
									event.preventDefault();
									const vertical = imagesStackVertically(listRef.current?.children ?? []);
									void webClient.dropImage(
										sourceId,
										image.id,
										dropAfterTarget(event, event.currentTarget, vertical),
									);
									setDraggedId("");
									setDropTarget(undefined);
								}}
								onKeyDown={(event) => {
									if (event.target !== event.currentTarget || orderingLocked || !event.altKey)
										return;
									const direction =
										event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
									if (
										!direction ||
										index + direction < 0 ||
										index + direction >= model.images.length
									)
										return;
									event.preventDefault();
									void webClient.reorderImage(image.id, direction);
								}}
								tabIndex={reorderable ? 0 : undefined}
							>
								<Tooltip.Root>
									<Tooltip.Trigger asChild>
										<IconButton
											aria-label={`Preview image ${image.name}`}
											className="attachment-preview"
											disabled={composerLocked(view) || image.status !== "ready"}
											onClick={(event) => onPreview(image, event.currentTarget)}
											type="button"
											variant="soft"
										>
											{image.status === "ready" ? (
												<img
													alt=""
													draggable={false}
													src={`api/attachments/${encodeURIComponent(image.id)}/preview?v=${model.attachmentRevision}`}
												/>
											) : (
												<Spinner />
											)}
										</IconButton>
									</Tooltip.Trigger>
									<Tooltip.Content sideOffset={6}>Preview {image.name}</Tooltip.Content>
								</Tooltip.Root>
								<Box className="attachment-details">
									<Text className="attachment-name" size="2" weight="medium">
										{image.name}
									</Text>
									<Text color={image.status === "error" ? "red" : "gray"} size="1">
										{attachmentItemLabel(image, view.uploadProgress.get(image.id))}
									</Text>
									{image.notes?.length > 0 && (
										<Text color="gray" size="1">
											{image.notes.join(" · ")}
										</Text>
									)}
									{model.images.length > 1 && (
										<Text color="gray" size="1" weight="bold">
											Order {index + 1} of {model.images.length}
										</Text>
									)}
								</Box>
								<Flex align="center" className="image-actions" gap="1">
									{retryable && (
										<Button
											disabled={composerLocked(view)}
											onClick={() => void webClient.retryImage(image.id)}
											size="1"
											type="button"
											variant="soft"
										>
											<ReloadIcon /> Retry
										</Button>
									)}
									<Tooltip.Root>
										<Tooltip.Trigger asChild>
											<IconButton
												aria-label={`Remove image ${image.name}`}
												color="red"
												disabled={composerLocked(view)}
												onClick={() => void webClient.removeImage(image.id)}
												type="button"
												variant="ghost"
											>
												<TrashIcon />
											</IconButton>
										</Tooltip.Trigger>
										<Tooltip.Content sideOffset={6}>Remove {image.name}</Tooltip.Content>
									</Tooltip.Root>
								</Flex>
							</li>
						</Card>
					);
				})}
			</ul>
		</Flex>
	);
}

const root = document.querySelector("#root");
if (!root) throw new Error("Pi WebUI root is unavailable.");
createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
