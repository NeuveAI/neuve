import { THEME_STORAGE_KEY } from "../theme-init";
import { onTheme } from "./motion";
import { UI } from "../content";

/** The theme toggle: pins light or dark; until pinned, the page follows the system. */
export function initTheme() {
  const root = document.documentElement;
  const btn = document.getElementById("theme");
  const media = matchMedia("(prefers-color-scheme: dark)");
  const pinned = () => {
    try {
      return localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      return null;
    }
  };
  const sync = () => {
    const dark = root.classList.contains("dark");
    btn?.setAttribute("aria-pressed", String(dark));
    btn?.setAttribute("aria-label", dark ? UI.themeToLight : UI.themeToDark);
    onTheme.forEach((f) => f());
  };
  btn?.addEventListener("click", () => {
    const dark = !root.classList.contains("dark");
    root.classList.toggle("dark", dark);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, dark ? "dark" : "light");
    } catch {
      // Storage can be unavailable; the class still applies for this visit.
    }
    sync();
  });
  const follow = () => {
    if (pinned()) return;
    root.classList.toggle("dark", media.matches);
    sync();
  };
  // Safari before 14 only has the older addListener.
  if (typeof media.addEventListener === "function")
    media.addEventListener("change", follow);
  else media.addListener(follow);
  sync();
}
