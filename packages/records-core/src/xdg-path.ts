import { isAbsolute } from "node:path";

type XdgVariable =
  | "XDG_STATE_HOME"
  | "XDG_CONFIG_HOME"
  | "XDG_DATA_HOME"
  | "XDG_CACHE_HOME"
  | "XDG_RUNTIME_DIR";

/** Invalid XDG values are unset; callers keep their own defaults. */
export const xdgPath = (
  variable: XdgVariable,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined => {
  const value = env[variable];
  return value !== undefined && value !== "" && isAbsolute(value)
    ? value
    : undefined;
};
