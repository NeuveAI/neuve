import { LazyMotion } from "motion/react";

import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from "react";

type Theme = "light" | "dark" | "system";
/** The theme the document shows: `system` resolved against the OS preference. */
type ResolvedTheme = "light" | "dark";

type ThemeContextValue = {
	theme: Theme;
	resolved: ResolvedTheme;
	set: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);
const useClientEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;
const features = () => import("../lib/motion-features").then(module => module.default);
const STORAGE_KEY = "ace-theme";

/** Returns the current theme state and setter. */
function useTheme() {
	let ctx = useContext(ThemeContext);
	if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
	return ctx;
}

/** Returns the resolved theme, falling back to the document class when no provider exists. */
function useResolvedTheme(fallback: ResolvedTheme = "light"): ResolvedTheme {
	let ctx = useContext(ThemeContext);
	if (ctx) return ctx.resolved;
	if (typeof document === "undefined") return fallback;
	return documentTheme();
}

function documentTheme(): ResolvedTheme {
	return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/**
 * Calls `listener` with the document's resolved theme now and on every change, and returns the
 * unsubscribe. This is the one theme setting the embedded review app follows: the Review tab
 * forwards each value to it (contract section 5), so both always show the same theme.
 */
function onResolvedTheme(listener: (theme: ResolvedTheme) => void) {
	if (typeof document === "undefined") return () => {};
	let last = documentTheme();
	listener(last);
	let observer = new MutationObserver(() => {
		let next = documentTheme();
		if (next === last) return;
		last = next;
		listener(next);
	});
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
	return () => observer.disconnect();
}

let mq: MediaQueryList | null = null;
function query() {
	if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
	return mq || (mq = window.matchMedia("(prefers-color-scheme: dark)"));
}

function subscribe(cb: () => void) {
	let media = query();
	if (!media) return () => {};
	media.addEventListener("change", cb);
	return () => media.removeEventListener("change", cb);
}

function snapshot() {
	return query()?.matches || false;
}

function key(storageKey: string) {
	if (storageKey !== STORAGE_KEY || typeof document === "undefined") return storageKey;
	return document.documentElement.dataset.themeKey || storageKey;
}

type Props = {
	children: ReactNode;
	/** Initial theme. Defaults to `"system"`. */
	defaultTheme?: Theme;
	/** localStorage key. Defaults to `"ace-theme"`. */
	storageKey?: string;
};

/**
 * Provides theme state, syncs with system preference, persists to localStorage,
 * and toggles the `dark` class on `<html>`.
 */
function ThemeProvider({ children, defaultTheme = "system", storageKey = STORAGE_KEY }: Props) {
	let name = key(storageKey);
	let [theme, setTheme] = useState<Theme>(
		() => (typeof window === "undefined"
			? defaultTheme
			: (localStorage.getItem(name) as Theme) || defaultTheme),
	);

	let dark = useSyncExternalStore(subscribe, snapshot, () => false);
	let resolved: ResolvedTheme = theme === "system" ? (dark ? "dark" : "light") : theme;

	useClientEffect(() => {
		document.documentElement.classList.toggle("dark", resolved === "dark");
	}, [resolved]);

	let value = useMemo<ThemeContextValue>(() => ({
		theme,
		resolved,
		set(value) {
			setTheme(value);
			if (typeof window !== "undefined") localStorage.setItem(name, value);
		},
	}), [name, theme, resolved]);

	return (
		<LazyMotion features={features} strict>
			<ThemeContext value={value}>{children}</ThemeContext>
		</LazyMotion>
	);
}

export { onResolvedTheme, type ResolvedTheme, type Theme, ThemeProvider, useResolvedTheme, useTheme };
