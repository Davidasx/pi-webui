/**
 * `next/navigation` for a page that is not served by Next.
 *
 * Their `AppShell` is the only file that reads the router: it takes the query string once at mount
 * (`getInitialNavigation(useSearchParams())`) and afterwards mirrors state into the URL with
 * `router.replace("?session=<id>")`. So the shim keeps the URL and React in sync — `replace`/`push`
 * write history and notify subscribers, and a `popstate` (back/forward) notifies them too.
 */

import { useCallback, useEffect, useState } from "react";

const NAVIGATION_EVENT = "pi-webui:navigation";

function currentSearch(): string {
	return typeof window === "undefined" ? "" : window.location.search;
}

/** Their `searchParams.get(...)` reads; a fresh object per render is what Next returns too. */
export function useSearchParams(): URLSearchParams {
	const [search, setSearch] = useState(currentSearch);
	useEffect(() => {
		const sync = () => setSearch(currentSearch());
		window.addEventListener(NAVIGATION_EVENT, sync);
		window.addEventListener("popstate", sync);
		return () => {
			window.removeEventListener(NAVIGATION_EVENT, sync);
			window.removeEventListener("popstate", sync);
		};
	}, []);
	return new URLSearchParams(search);
}

export function usePathname(): string {
	const [pathname, setPathname] = useState(() =>
		typeof window === "undefined" ? "/" : window.location.pathname,
	);
	useEffect(() => {
		const sync = () => setPathname(window.location.pathname);
		window.addEventListener(NAVIGATION_EVENT, sync);
		window.addEventListener("popstate", sync);
		return () => {
			window.removeEventListener(NAVIGATION_EVENT, sync);
			window.removeEventListener("popstate", sync);
		};
	}, []);
	return pathname;
}

export function useRouter() {
	const navigate = useCallback((href: string, mode: "replace" | "push") => {
		if (typeof window === "undefined") return;
		const url = new URL(href, window.location.href);
		// Their calls pass a bare `?session=…`, which must keep the current pathname.
		const target = `${url.pathname}${url.search}${url.hash}`;
		const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
		if (target !== current) {
			if (mode === "replace") window.history.replaceState(null, "", target);
			else window.history.pushState(null, "", target);
		}
		window.dispatchEvent(new Event(NAVIGATION_EVENT));
	}, []);
	return {
		replace: (href: string) => navigate(href, "replace"),
		push: (href: string) => navigate(href, "push"),
		back: () => window.history.back(),
		forward: () => window.history.forward(),
		refresh: () => window.dispatchEvent(new Event(NAVIGATION_EVENT)),
		prefetch: () => {},
	};
}
