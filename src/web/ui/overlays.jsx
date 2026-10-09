import { ChevronDownIcon, Cross2Icon, EyeOpenIcon, TrashIcon } from "@radix-ui/react-icons";
import { Button, Container, Flex, Heading, IconButton, Separator, Text } from "@radix-ui/themes";
import { AlertDialog, Collapsible, Dialog, Tooltip } from "radix-ui";
import { webClient } from "./client.js";

export function ClearAttachmentsDialog({ count, onOpenChange, open }) {
	return (
		<AlertDialog.Root onOpenChange={onOpenChange} open={open}>
			<AlertDialog.Overlay className="dialog-overlay" />
			<AlertDialog.Content className="dialog-content">
				<AlertDialog.Title asChild>
					<Heading as="h2" size="4">
						Clear attachments?
					</Heading>
				</AlertDialog.Title>
				<AlertDialog.Description asChild>
					<Text as="p" color="gray" size="2">
						Remove all {count} unsent image attachments? Message text will be kept.
					</Text>
				</AlertDialog.Description>
				<Flex gap="3" justify="end">
					<AlertDialog.Cancel asChild>
						<Button color="gray" variant="soft">
							Cancel
						</Button>
					</AlertDialog.Cancel>
					<AlertDialog.Action asChild>
						<Button color="red" onClick={() => void webClient.clearAttachments()} variant="solid">
							<TrashIcon /> Clear attachments
						</Button>
					</AlertDialog.Action>
				</Flex>
			</AlertDialog.Content>
		</AlertDialog.Root>
	);
}

export function ForgetImageDialog({ id, onOpenChange }) {
	return (
		<AlertDialog.Root onOpenChange={onOpenChange} open={Boolean(id)}>
			<AlertDialog.Overlay className="dialog-overlay" />
			<AlertDialog.Content className="dialog-content">
				<AlertDialog.Title asChild>
					<Heading as="h2" size="4">
						Forget retained image?
					</Heading>
				</AlertDialog.Title>
				<AlertDialog.Description asChild>
					<Text as="p" color="gray" size="2">
						This removes the session-only copy. It does not retract provider content.
					</Text>
				</AlertDialog.Description>
				<Flex gap="3" justify="end">
					<AlertDialog.Cancel asChild>
						<Button color="gray" variant="soft">
							Cancel
						</Button>
					</AlertDialog.Cancel>
					<AlertDialog.Action asChild>
						<Button color="red" onClick={() => void webClient.forgetSentImage(id)}>
							<TrashIcon /> Forget
						</Button>
					</AlertDialog.Action>
				</Flex>
			</AlertDialog.Content>
		</AlertDialog.Root>
	);
}

export function ImagePreviewDialog({ image, onOpenChange, revision }) {
	return (
		<Dialog.Root onOpenChange={onOpenChange} open={Boolean(image)}>
			<Dialog.Overlay className="dialog-overlay preview-overlay" />
			<Dialog.Content className="preview-content">
				<Flex align="center" className="preview-header" justify="between">
					<Dialog.Title asChild>
						<Heading className="preview-title" size="3">
							{image?.name ?? "Image preview"}
						</Heading>
					</Dialog.Title>
					<Tooltip.Root>
						<Tooltip.Trigger asChild>
							<Dialog.Close asChild>
								<IconButton aria-label="Close image preview" color="gray" variant="soft">
									<Cross2Icon />
								</IconButton>
							</Dialog.Close>
						</Tooltip.Trigger>
						<Tooltip.Content sideOffset={6}>Close preview</Tooltip.Content>
					</Tooltip.Root>
				</Flex>
				{image && (
					<img
						alt={image.name}
						className="preview-image"
						src={`api/attachments/${encodeURIComponent(image.id)}/preview?v=${revision}`}
					/>
				)}
			</Dialog.Content>
		</Dialog.Root>
	);
}

export function PageFooter() {
	return (
		<footer className="page-footer">
			<Container size="3" px={{ initial: "3", sm: "5" }}>
				<div className="page-footer-content">
					<Separator size="4" />
					<Collapsible.Root>
						<Collapsible.Trigger asChild>
							<Button color="gray" variant="ghost">
								<EyeOpenIcon /> Privacy and limitations{" "}
								<ChevronDownIcon className="disclosure-icon" />
							</Button>
						</Collapsible.Trigger>
						<Collapsible.Content>
							<Text as="p" className="page-footer-copy" color="gray" size="2">
								This loopback page reflects semantic Pi messages, not terminal pixels. Data stays in
								this live Pi process and browser tab. Thinking is collapsed by default.
							</Text>
						</Collapsible.Content>
					</Collapsible.Root>
				</div>
			</Container>
		</footer>
	);
}
