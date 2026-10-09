export function isCollapsibleMessageRole(role) {
	return role === "toolResult";
}

export function toolPhaseLabel(tool) {
	if (tool?.isError) return "Failed";
	if (tool?.phase === "end") return "Completed";
	if (tool?.phase === "start" || tool?.phase === "update") return "Running";
	return "Requested";
}

export function retainedImageStatus(block, retainedImageIds) {
	if (!block?.retainedImageId) return "none";
	return retainedImageIds?.has(block.retainedImageId) ? "eligible" : "expired";
}

export function toolCommandPreview(tool) {
	const command = tool?.args?.command;
	if (typeof command !== "string") return "";
	return command.length > 120 ? `${command.slice(0, 120)}…` : command;
}
