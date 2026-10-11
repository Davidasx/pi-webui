/**
 * `next/image` in their sources is a file-preview thumbnail. This keeps the call site unchanged
 * without dragging Next.js in.
 */
export default function Image({ src, alt, width, height, fill, priority, loader, placeholder, blurDataURL, sizes, quality, ...rest }) {
	void priority;
	void loader;
	void placeholder;
	void blurDataURL;
	void sizes;
	void quality;
	const source = typeof src === "string" ? src : (src?.src ?? "");
	const style = fill
		? { position: "absolute", inset: 0, width: "100%", height: "100%", ...(rest.style ?? {}) }
		: rest.style;
	return <img alt={alt ?? ""} height={height} src={source} style={style} width={width} {...rest} />;
}
