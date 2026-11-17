import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import {
  type ReviewRouteName,
  Settings,
  settingsPath,
} from "../../../packages/harness/src/settings.ts";

/**
 * `neuve setup --route`: the review route in the user's settings file, the one place reviews read
 * it from (`settingsPath`). Only `review.route` changes: every other byte of the file stays as it
 * was. The result must pass the harness's own settings schema, so setup never writes a route a
 * review would refuse. A file that exists but can't be read is never overwritten.
 */
export type RouteName = ReviewRouteName;

export class SettingsUnreadable extends Error {}
export class RouteRefused extends Error {}

/** One JSON value's span in `text`, from `start` to `end` (exclusive). */
type Span = { start: number; end: number };

/** A minimal JSON reader that records where each top-level and `review` member's value is. */
const spans = (text: string) => {
  let at = 0;
  const space = () => {
    while (at < text.length && " \t\r\n".includes(text[at]!)) at++;
  };
  const string = () => {
    const start = at;
    at++;
    while (text[at] !== '"') {
      if (at >= text.length) throw new Error("unterminated string");
      at += text[at] === "\\" ? 2 : 1;
    }
    at++;
    return JSON.parse(text.slice(start, at)) as string;
  };
  const members = new Map<string, Map<string, Span> | Span>();
  const value = (path: string[]): Span => {
    space();
    const start = at;
    const char = text[at];
    if (char === "{") {
      at++;
      const own = new Map<string, Span>();
      space();
      if (text[at] === "}") at++;
      else
        for (;;) {
          space();
          const key = string();
          space();
          at++; // ':'
          const span = value([...path, key]);
          own.set(key, span);
          space();
          if (text[at] === ",") {
            at++;
            continue;
          }
          at++; // '}'
          break;
        }
      if (path.length === 0) members.set("", own);
      if (path.length === 1 && path[0] === "review") members.set("review", own);
      return { start, end: at };
    }
    if (char === "[") {
      at++;
      space();
      if (text[at] === "]") at++;
      else
        for (;;) {
          value([...path, "[]"]);
          space();
          if (text[at] === ",") {
            at++;
            continue;
          }
          at++;
          break;
        }
      return { start, end: at };
    }
    if (char === '"') {
      string();
      return { start, end: at };
    }
    while (at < text.length && !",}] \t\r\n".includes(text[at]!)) at++;
    return { start, end: at };
  };
  const root = value([]);
  return {
    root,
    top: members.get("") as Map<string, Span> | undefined,
    review: members.get("review") as Map<string, Span> | undefined,
  };
};

/** The text with `review.route` set, every other byte as it was. */
const withRoute = (text: string, route: RouteName) => {
  const { root, top, review } = spans(text);
  const quoted = JSON.stringify(route);
  const routeSpan = review?.get("route");
  if (routeSpan !== undefined)
    return text.slice(0, routeSpan.start) + quoted + text.slice(routeSpan.end);
  const reviewSpan = top?.get("review");
  if (reviewSpan !== undefined && review !== undefined) {
    const open = reviewSpan.start + 1;
    return `${text.slice(0, open)}"route": ${quoted}${review.size > 0 ? ", " : ""}${text.slice(open)}`;
  }
  // A new last member, after the last value and before the whitespace that closes the object.
  const close = root.end - 1;
  const head = text.slice(0, close);
  const trimmed = head.trimEnd();
  return `${trimmed}${(top?.size ?? 0) > 0 ? "," : ""} "review": {"route": ${quoted}}${head.slice(trimmed.length)}${text.slice(close)}`;
};

/** The route the settings name, or undefined; throws `SettingsUnreadable` for a file it can't read. */
export const settingsRoute = async (home = homedir()) => {
  const path = settingsPath(home);
  const text = await readFile(path, "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw new SettingsUnreadable(`Neuve can't read ${path}.`);
  });
  if (text === undefined) return undefined;
  try {
    return Settings.parse(JSON.parse(text)).review?.route;
  } catch {
    throw new SettingsUnreadable(
      `Neuve can't read ${path}: it isn't valid settings.`,
    );
  }
};

/**
 * The file a write lands in: the settings path itself, or, when that is a link (settings kept in a
 * dotfiles folder), the regular file of this user's it leads to, so the link stays. A link to
 * anything else is refused and left as it is. Undefined when there is no file yet.
 */
const settingsFile = async (path: string) => {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined) return undefined;
  if (!info.isSymbolicLink()) return { file: path, mode: info.mode & 0o777 };
  const file = await realpath(path).catch(() => undefined);
  const target = file === undefined ? undefined : await lstat(file);
  if (
    file === undefined ||
    target === undefined ||
    !target.isFile() ||
    target.uid !== (process.getuid?.() ?? target.uid)
  )
    throw new SettingsUnreadable(
      `${path} is a link that doesn't lead to a file of yours, so Neuve changed nothing. Point it at your settings file, or remove it, then run this again.`,
    );
  return { file, mode: target.mode & 0o777 };
};

/**
 * Sets `review.route` in the settings file: in place when the file exists and reads as valid
 * settings, a new file holding only the route when it doesn't exist. Written to a temporary file in
 * the same folder as the file (a linked file's own folder, keeping the link), then renamed over it,
 * with the file's own permissions.
 */
export const writeRoute = async (route: string, home = homedir()) => {
  const path = settingsPath(home);
  const existing = await settingsFile(path);
  const text = await readFile(existing?.file ?? path, "utf8").catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return undefined;
      throw new SettingsUnreadable(
        `Neuve can't read ${path}, so it changed nothing.`,
      );
    },
  );
  if (text !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SettingsUnreadable(
        `${path} isn't valid JSON, so Neuve changed nothing. Fix it or remove it, then run this again.`,
      );
    }
    if (!Settings.safeParse(parsed).success)
      throw new SettingsUnreadable(
        `${path} isn't valid Neuve settings, so Neuve changed nothing. Fix it or remove it, then run this again.`,
      );
  }
  const candidate =
    text === undefined
      ? `${JSON.stringify({ version: 1, review: { route } }, null, 2)}\n`
      : withRoute(text, route as RouteName);
  // The harness's schema decides what a review accepts; nothing it would refuse is written.
  const checked = Settings.safeParse(JSON.parse(candidate));
  if (!checked.success || checked.data.review?.route !== route)
    throw new RouteRefused(
      `neuve setup --route takes openai (ChatGPT), anthropic (an Anthropic API key) or claude (your Claude subscription, through Claude Code), not ${JSON.stringify(route)}.`,
    );
  const file = existing?.file ?? path;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, candidate, { mode: 0o600, flag: "wx" });
    await chmod(temporary, existing?.mode ?? 0o600);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return path;
};
