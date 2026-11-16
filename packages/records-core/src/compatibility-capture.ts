import { Context, Effect, Fiber, Logger } from "effect";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  registerCompatibilityRefusals,
  refusalRecord,
  sayOnce,
  type CompatibilityContext,
} from "@neuve/records-schema";

export const CompatibilitySource = Context.Reference<string | undefined>(
  "@neuve/records-core/CompatibilitySource",
  { defaultValue: () => undefined },
);
let build: string | undefined;
/** Resolve lazily on the first exception. Never consult the repository being reviewed. */
export const readingBuild = () => {
  if (build) return build;
  if (Bun.main.startsWith("/$bunfs/"))
    return (build = `sha256:${createHash("sha256").update(readFileSync(process.execPath)).digest("hex")}`);
  const root = resolve(import.meta.dir, "../../..");
  const head = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"], {
    stderr: "ignore",
  });
  const dirty = Bun.spawnSync(["git", "-C", root, "diff", "--quiet"], {
    stderr: "ignore",
  });
  return (build =
    head.exitCode === 0
      ? `${head.stdout.toString().trim()}${dirty.exitCode === 1 ? "+dirty" : ""}`
      : "unknown");
};
export const compatibilityContext = (
  context: Partial<CompatibilityContext>,
) => ({
  ...context,
  source:
    context.source ??
    Fiber.getCurrent()?.getRef(CompatibilitySource) ??
    "unknown",
  readingBuild: context.readingBuild ?? readingBuild(),
});

// Registration point for Records readers. The harness registers its run sink after this one.
registerCompatibilityRefusals((shape, context) => {
  const record = refusalRecord(shape, compatibilityContext(context));
  const line = `neuve: compatibility mode; ${JSON.stringify(record)}; record is corrupt to this build`;
  sayOnce(JSON.stringify(record), line, (value) => {
    const fiber = Fiber.getCurrent();
    if (fiber)
      Effect.runSync(
        Effect.logWarning(value).pipe(
          Effect.provide(fiber.context),
          Effect.provideService(Logger.LogToStderr, true),
        ),
      );
    else process.stderr.write(`${value}\n`);
  });
  return true;
});
