import { useResolvedTheme } from "@ace/ui";

// Neuve's mark from neuve-web's favicon on an ink disc; dark inverts it as Neuve's ink does.
const LIGHT = new URL("./assets/neuve-avatar.svg", import.meta.url).href;
const DARK = new URL("./assets/neuve-avatar-dark.svg", import.meta.url).href;

/** The agent's avatar in replies and its mention chip, in the app's current theme. */
export function useAgentAvatar(): string {
	return useResolvedTheme() === "dark" ? DARK : LIGHT;
}
