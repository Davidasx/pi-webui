export function imagesStackVertically(items) {
	const list = [...items];
	return !list.some((item, index) =>
		list.slice(index + 1).some((candidate) => Math.abs(item.offsetTop - candidate.offsetTop) < 2),
	);
}

export function dropAfterTarget(event, item, vertical) {
	const bounds = item.getBoundingClientRect();
	return vertical
		? event.clientY >= bounds.top + bounds.height / 2
		: event.clientX >= bounds.left + bounds.width / 2;
}
