/**
 * The page.
 *
 * Everything below `./pi-web/` is agegr/pi-web's own frontend, vendored verbatim (see
 * `./pi-web/PORTING.md`). This file is the mount point their `app/page.tsx` and `app/layout.tsx`
 * would be: it applies their theme decision before the first paint, adds the font variable their
 * layout adds, and renders their `AppShell` — the same top bar, session sidebar, chat surface and
 * panels they serve.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./pi-web/components/AppShell";
import { I18nProvider } from "./pi-web/hooks/useI18n";
import { isDarkTheme, isThemePreference } from "./pi-web/lib/theme";

/**
 * Their layout runs `THEME_INIT_SCRIPT` in a `<script>` tag. Their script is a string evaluated with
 * `new Function`, which our content-security policy refuses, so the same decision is written out here
 * (stored preference, `auto` following the system) using their own predicates.
 */
function applyThemeBeforeFirstPaint() {
	const stored = window.localStorage.getItem("pi-theme");
	const preference = isThemePreference(stored) ? stored : "auto";
	const resolved =
		preference === "auto" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : preference;
	const root = document.documentElement;
	root.dataset.theme = resolved;
	root.classList.toggle("dark", isDarkTheme(resolved));
}

applyThemeBeforeFirstPaint();

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<StrictMode>
			<I18nProvider>
				<AppShell />
			</I18nProvider>
		</StrictMode>,
	);
}
