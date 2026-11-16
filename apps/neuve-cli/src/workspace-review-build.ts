import { createHash } from "node:crypto";
import {
  closeSync,
  openSync,
  realpathSync,
  appendFileSync,
  watch,
} from "node:fs";
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { Effect } from "effect";
import { Starter } from "@neuve/records-core";
import {
  SharedWork,
  type SharedWorkTransport,
  type SharedClaim,
  type SharedFloor,
  type PublishedSharedOutcome,
} from "@neuve/records-core/shared-work";
import {
  budgetDirectory,
  storedSharedOutcome,
} from "@neuve/records-core/shared-work-socket";
import {
  budgetSharedWork,
  clientBudget,
} from "../../../packages/harness/src/budget/local.ts";
import { z } from "zod";
import { closeChild } from "./workspace-child.ts";
import { thisBuild } from "./review-worker.ts";

type BuildOptions = {
  source: string;
  repository?: string;
  base: string;
  builds: string;
  cache: string;
  temporary: string;
  executable: string;
  environment: Record<string, string | undefined>;
  log: string;
  signal: AbortSignal;
  processSignal?: AbortSignal;
  lifetime?: AbortSignal;
};

const Manifest = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
});

const PublicationFiles = z
  .array(
    z
      .string()
      .refine(
        (path) =>
          path.startsWith("dist/") &&
          !path.includes("\\") &&
          !path.split("/").some((part) => ["", ".", ".."].includes(part)),
      ),
  )
  .refine((files) => files.includes("dist/server/server.js"));

function within(source: string, path: string): boolean {
  const local = relative(source, path);
  return !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`);
}

function hasCode(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

function installedManifest(name: string, from: string): string {
  // package exports can redirect `name/package.json` to a nested module marker
  // with no dependencies. Read the installed package's own manifest instead.
  for (let directory = from; ; directory = dirname(directory)) {
    try {
      return realpathSync(
        join(directory, "node_modules", name, "package.json"),
      );
    } catch (error) {
      if (!hasCode(error, "ENOENT", "ENOTDIR")) throw error;
    }
    if (dirname(directory) === directory)
      throw new Error(`No installed manifest for ${name} from ${from}`);
  }
}

/** Follow installed dependency resolution, including workspace and build-tool dependencies.
 * Their manifests identify installed versions even if bun.lock is ahead of node_modules.
 */
async function buildInputs(source: string) {
  const roots = new Set(["apps/neuve-web"]);
  const installed = new Map<string, Buffer>();
  const pending = [join(source, "apps/neuve-web/apps/web/package.json")];
  const seen = new Set<string>();
  while (pending.length) {
    const next = pending.pop();
    if (!next) break;
    const path = await realpath(next);
    if (seen.has(path)) continue;
    seen.add(path);
    const bytes = await readFile(path);
    const manifest = Manifest.parse(JSON.parse(bytes.toString()));
    const workspace =
      within(source, path) &&
      !relative(source, path).split(sep).includes("node_modules");
    if (workspace) roots.add(relative(source, dirname(path)));
    else installed.set(path, bytes);
    const required = {
      ...manifest.dependencies,
      ...(workspace ? manifest.devDependencies : {}),
    };
    const dependencies = {
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
      ...required,
    };
    for (const [name, version] of Object.entries(dependencies)) {
      try {
        const resolved = installedManifest(name, dirname(path));
        if (version.startsWith("workspace:") && !within(source, resolved))
          throw new Error(
            `Workspace dependency ${name} resolves outside this checkout`,
          );
        pending.push(resolved);
      } catch (error) {
        if (!(name in required)) continue;
        throw new Error(
          `Cannot resolve review build dependency ${name}. Run bun install --backend=copyfile --frozen-lockfile`,
          { cause: error },
        );
      }
    }
  }
  return { roots, installed };
}

/** Hash working bytes too: a developer's uncommitted edit must invalidate the build. */
export async function reviewSourceKey(
  source: string,
  environment: Record<string, string | undefined> = process.env,
): Promise<string> {
  const { roots, installed } = await buildInputs(source);
  const files = Bun.spawn(
    [
      "git",
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      "bun.lock",
      "package.json",
      "tsconfig.base.json",
      "apps/neuve-cli/src/workspace-review-build.ts",
      ...roots,
    ],
    {
      cwd: source,
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [list, error, code] = await Promise.all([
    new Response(files.stdout).text(),
    new Response(files.stderr).text(),
    files.exited,
  ]);
  if (code !== 0)
    throw new Error(`Cannot identify review build sources: ${error.trim()}`);
  const hash = createHash("sha256").update(
    `review-build-v5\0${source}\0${Bun.version}\0`,
  );
  for (const [path, bytes] of [...installed].sort(([a], [b]) =>
    a.localeCompare(b),
  ))
    hash.update(path).update("\0").update(bytes).update("\0");
  const inspected = new Map<string, ReturnType<typeof lstat>>();
  for (const path of [...new Set(list.split("\0").filter(Boolean))].sort()) {
    // Start regenerates this from the route sources before compiling.
    if (path.endsWith("/routeTree.gen.ts")) continue;
    hash.update(path).update("\0");
    try {
      // Inspect every component: even a tracked directory replaced by a link
      // must never make the key read a file outside the checkout.
      const parts = path.split("/").filter(Boolean);
      let entry = source;
      for (const [index, part] of parts.entries()) {
        entry = join(entry, part);
        let inspection = inspected.get(entry);
        if (!inspection) {
          inspection = lstat(entry);
          inspected.set(entry, inspection);
        }
        const info = await inspection;
        if (info.isSymbolicLink()) {
          hash.update("link\0").update(await readlink(entry));
          break;
        }
        if (index === parts.length - 1) {
          if (info.isDirectory()) hash.update("directory");
          else
            hash.update("file\0").update(
              createHash("sha256")
                .update(await readFile(entry))
                .digest(),
            );
        }
      }
    } catch (error) {
      if (!hasCode(error, "ENOENT", "ENOTDIR")) throw error;
      hash.update("deleted");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function buildReviewWeb(options: BuildOptions): Promise<string> {
  try {
    return await openReviewBuild(options);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}. See ${options.log}`,
      { cause: error },
    );
  }
}

const Failure = z.object({ message: z.string(), log: z.string() });
const Published = z.object({
  publication: z.string().uuid(),
  outcome: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("succeeded"), value: z.string() }),
    z.object({ kind: z.literal("failed"), error: Failure }),
  ]),
});
/** Opening work is shared; a running server is a process-local handle until exit. */
export class ReviewWebs<A extends { child: { exited: Promise<number> } }> {
  private readonly opening = new SharedWork<A>();
  private readonly live = new Map<string, A>();
  private readonly pending = new Set<Promise<A>>();

  async open(
    project: string,
    start: (canonical: string) => Promise<A>,
  ): Promise<A> {
    const actual = await realpath(project);
    const known = this.live.get(actual);
    if (known) return known;
    const opening = this.opening
      .run({
        scope: "review-web",
        key: actual,
        run: async () => {
          const web = await start(actual);
          this.live.set(actual, web);
          void web.child.exited.then(() => {
            if (this.live.get(actual) === web) this.live.delete(actual);
          });
          return { kind: "succeeded", value: web };
        },
      })
      .then((result) => {
        if (result.outcome.kind === "failed") throw result.outcome.error;
        return result.outcome.value;
      });
    this.pending.add(opening);
    try {
      return await opening;
    } finally {
      this.pending.delete(opening);
    }
  }

  values() {
    return this.pending.values();
  }

  [Symbol.iterator]() {
    return this.live.entries();
  }
}

class BuildPublicationFailed extends Error {}

type ClaimRequest = Parameters<SharedWorkTransport["claim"]>[0];
type ReviewTransport = SharedWorkTransport & {
  claimOnArrival: SharedWorkTransport["claim"];
};

/** Arm before connecting, then reconnect only on a filesystem push. The deadline
 * bounds startup, never ownership. A final connection covers a missed watch event.
 */
async function claimOnArrival(input: {
  transport: SharedWorkTransport;
  directory: string;
  request: ClaimRequest;
  start?: () => Promise<void>;
  deadline?: number;
}) {
  const { request } = input;
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  let notification = Promise.withResolvers<void>();
  let revision = 0;
  let ended = false;
  const wake = () => {
    revision++;
    notification.resolve();
  };
  const abort = () => wake();
  request.signal.addEventListener("abort", abort, { once: true });
  let watcher: ReturnType<typeof watch>;
  try {
    watcher = watch(input.directory, (_event, name) => {
      if (name === null || name.toString() === "budget.sock") wake();
    });
  } catch {
    request.signal.removeEventListener("abort", abort);
    await input.start?.();
    return input.transport.claim(request);
  }
  watcher.on("error", () => {
    ended = true;
    wake();
  });
  const timer =
    input.deadline === undefined
      ? undefined
      : setTimeout(() => {
          ended = true;
          wake();
        }, input.deadline);
  try {
    await input.start?.();
    for (;;) {
      request.signal.throwIfAborted();
      const before = revision;
      const last = ended;
      const opened = await input.transport.claim(request);
      if (opened.kind === "connected" || last) return opened;
      if (revision !== before) continue;
      await notification.promise;
      notification = Promise.withResolvers<void>();
    }
  } finally {
    clearTimeout(timer);
    watcher.close();
    request.signal.removeEventListener("abort", abort);
  }
}

const builds = new SharedWork<string, z.infer<typeof Failure>>();

function record(options: BuildOptions, event: object) {
  appendFileSync(
    options.log,
    `${JSON.stringify({ type: "review-build.shared-work", ...event })}\n`,
    { mode: 0o600 },
  );
}

/** Serializes pin registration with deletion, using the host's claims too.
 * Without this short claim, a new pin could subscribe while a pruner deletes.
 */
async function pinChange(input: {
  transport: SharedWorkTransport;
  store: string;
  directory: string;
  signal: AbortSignal;
  insideGrant: boolean;
}) {
  const opened = await input.transport.claim({
    ...input,
    key: `pin-change:${input.directory}`,
    redeclare: false,
  });
  if (opened.kind === "floor") return opened;
  const claim = opened.claim;
  try {
    for (;;) {
      const event = await claim.next();
      input.signal.throwIfAborted();
      if (event.kind === "claimed")
        return { kind: "connected" as const, claim };
      if (event.kind === "held") {
        claim.close();
        return { kind: "held" as const };
      }
      if (event.kind === "lost") {
        claim.close();
        return { kind: "floor" as const, reason: "host-changed" as const };
      }
    }
  } catch (error) {
    claim.close();
    throw error;
  }
}

/** A pin never settles: every serving launcher holds or waits on this same key.
 * A pruning claimant asks insideGrant and can delete only with an exclusive grant.
 */
async function pinBuild(input: {
  transport: ReviewTransport;
  store: string;
  directory: string;
  signal: AbortSignal;
}) {
  const ready = Promise.withResolvers<void>();
  let claim: SharedClaim | undefined;
  let floor: SharedFloor | undefined;
  let holder = false;
  const close = () => claim?.close();
  input.signal.addEventListener("abort", close, { once: true });
  const watching = (async () => {
    try {
      while (!input.signal.aborted) {
        const change = await pinChange({
          ...input,
          transport: floor
            ? { claim: input.transport.claimOnArrival }
            : input.transport,
          insideGrant: false,
        });
        if (change.kind === "held")
          throw new Error("Review build pin registration was skipped");
        if (change.kind === "floor") {
          floor = change.reason;
          ready.resolve();
          return;
        }
        let opened: Awaited<ReturnType<SharedWorkTransport["claim"]>>;
        try {
          opened = await input.transport.claim({
            store: input.store,
            key: `pin:${input.directory}`,
            insideGrant: false,
            redeclare: holder,
            signal: input.signal,
          });
          if (opened.kind === "connected") {
            claim = opened.claim;
            const registered = await claim.next();
            if (registered.kind === "claimed") holder = true;
            else if (registered.kind !== "waiting")
              throw new Error("Review build pin was not registered");
          }
        } finally {
          change.claim.close();
        }
        if (opened.kind === "floor") {
          floor = opened.reason;
          ready.resolve();
          return;
        }
        claim = opened.claim;
        if (input.signal.aborted) return;
        floor = undefined;
        ready.resolve();
        for (;;) {
          const event = await claim.next();
          if (input.signal.aborted) return;
          if (event.kind === "claimed") holder = true;
          if (event.kind === "claimed" || event.kind === "waiting")
            ready.resolve();
          if (event.kind === "lost") break;
        }
        floor = "host-changed";
        claim.close();
        try {
          await input.transport.recover?.();
        } catch {
          /* Reconnect determines the floor. */
        }
      }
      input.signal.throwIfAborted();
    } catch (error) {
      ready.reject(error);
    } finally {
      close();
      if (input.signal.aborted) ready.reject(input.signal.reason);
      input.signal.removeEventListener("abort", close);
    }
  })();
  await ready.promise;
  input.signal.throwIfAborted();
  return { atFloor: () => floor, ended: watching };
}

async function reviewTransport(
  options: BuildOptions,
): Promise<ReviewTransport> {
  const directory =
    options.environment.NEUVE_BUDGET_DIRECTORY ?? budgetDirectory();
  const transport = budgetSharedWork(await clientBudget(directory), directory);
  let starting: Promise<void> | undefined;
  const recover = async () => {
    if (options.repository) {
      try {
        const started = await Effect.runPromise(
          Starter.ensureWorker({
            repository: options.repository,
            command: thisBuild(),
          }),
        );
        record(options, { worker: started.status });
      } catch {
        record(options, { worker: "unavailable" });
      }
    }
  };
  return {
    recover,
    claimOnArrival: (request) =>
      claimOnArrival({ transport, directory, request }),
    claim: async (request) => {
      let opened = await transport.claim(request);
      if (opened.kind === "floor" && opened.reason === "unreachable") {
        if (options.repository && !starting) {
          opened = await claimOnArrival({
            transport,
            directory,
            request,
            deadline: 5000,
            start: () => (starting ??= recover()),
          });
        }
      }
      return opened;
    },
  };
}

async function openReviewBuild(options: BuildOptions): Promise<string> {
  options.signal.throwIfAborted();
  const sourceKey = await reviewSourceKey(options.source, options.environment);
  const key = createHash("sha256")
    .update(sourceKey)
    .update(options.base)
    .digest("hex");
  await mkdir(options.builds, { recursive: true });
  // This is a user-level artifact store, not a Git/Records store.
  const store = await realpath(options.builds);
  const project = join(
    store,
    // Older floor servers use v4's shared directories without a host pin.
    "workspace-web-v5",
    createHash("sha256").update(options.base).digest("hex"),
  );
  const directory = join(project, key);
  const published = join(directory, "ready");
  const transport = await reviewTransport(options);
  const pinLifetime = new AbortController();
  const cancelPin = () => pinLifetime.abort(options.signal.reason);
  options.signal.addEventListener("abort", cancelPin, { once: true });
  if (options.signal.aborted) cancelPin();
  const pinSignal = AbortSignal.any([
    pinLifetime.signal,
    ...(options.lifetime ? [options.lifetime] : []),
    ...(options.processSignal ? [options.processSignal] : []),
  ]);
  const pin = await pinBuild({
    transport,
    store,
    directory,
    signal: pinSignal,
  }).catch((error: unknown) => {
    options.signal.removeEventListener("abort", cancelPin);
    throw error;
  });
  if (pin.atFloor())
    record(options, { role: "floor", floor: pin.atFloor(), operation: "pin" });
  let serving = false;
  let execution:
    | Promise<PublishedSharedOutcome<string, z.infer<typeof Failure>>>
    | undefined;
  try {
    if (pin.atFloor()) {
      const path = await openFloorBuild(
        options,
        sourceKey,
        key,
        store,
        published,
      );
      serving = true;
      return path;
    }
    const stored = storedSharedOutcome<string, z.infer<typeof Failure>>({
      read: async (publication) => {
        if (publication === "ready" || publication === undefined) {
          if (await Bun.file(join(published, "complete")).exists())
            return {
              publication: "ready",
              outcome: { kind: "succeeded", value: join(published, "dist") },
            };
          return undefined;
        }
        const id = z.string().uuid().parse(publication);
        try {
          return Published.parse(
            JSON.parse(
              await readFile(join(directory, `outcome-${id}.json`), "utf8"),
            ),
          );
        } catch (error) {
          if (hasCode(error, "ENOENT")) return undefined;
          throw error;
        }
      },
      publish: async (outcome) => {
        const temporary = join(directory, `outcome-${outcome.publication}.tmp`);
        await writeFile(temporary, JSON.stringify(outcome));
        await rename(
          temporary,
          join(directory, `outcome-${outcome.publication}.json`),
        );
      },
    });
    const result = await builds.run({
      scope: store,
      key: `review-build:${key}`,
      signal: options.signal,
      onEvent: (event) => record(options, { key, ...event }),
      onTakeover: async () => {
        // The claim protects this key. Immutable outcomes remain for pushed readers.
        for (const name of await readdir(directory).catch((error: unknown) => {
          if (hasCode(error, "ENOENT")) return [];
          throw error;
        }))
          if (name.startsWith("attempt-") || name.endsWith(".tmp"))
            await rm(join(directory, name), { recursive: true, force: true });
      },
      crossProcess: {
        store,
        transport: {
          ...(transport.recover ? { recover: transport.recover } : {}),
          claim: async (request) => {
            options.processSignal?.throwIfAborted();
            const opened = await transport.claim({
              ...request,
              signal: AbortSignal.any([
                request.signal,
                ...(options.processSignal ? [options.processSignal] : []),
              ]),
            });
            if (opened.kind === "floor") return opened;
            // A departing process stops its compiler before releasing ownership.
            // withdraw only removes local demand and can retain a remote build.
            const leave = async () => {
              await execution?.catch(() => undefined);
              opened.claim.close();
            };
            options.processSignal?.addEventListener("abort", leave, {
              once: true,
            });
            if (options.processSignal?.aborted) void leave();
            return {
              kind: "connected",
              claim: {
                ...opened.claim,
                next: async () => {
                  const event = await opened.claim.next();
                  options.processSignal?.throwIfAborted();
                  return event;
                },
                settle: async (outcome, publication) => {
                  options.processSignal?.throwIfAborted();
                  await opened.claim.settle(outcome, publication);
                },
                close: () => {
                  options.processSignal?.removeEventListener("abort", leave);
                  opened.claim.close();
                },
              },
            };
          },
        },
        read: stored.read,
      },
      run: async (
        signal,
      ): Promise<PublishedSharedOutcome<string, z.infer<typeof Failure>>> => {
        const stopped = AbortSignal.any([
          signal,
          ...(options.processSignal ? [options.processSignal] : []),
        ]);
        stopped.throwIfAborted();
        await mkdir(directory, { recursive: true });
        // Publication errors reject instead of settling, so the first waiter takes over.
        const run = stored.run(async () => {
          try {
            const path = await compileReviewWeb(
              { ...options, signal: stopped },
              sourceKey,
              key,
              directory,
              published,
            );
            return { kind: "succeeded", value: path };
          } catch (error) {
            stopped.throwIfAborted();
            if (error instanceof BuildPublicationFailed) throw error;
            return {
              kind: "failed",
              error: {
                message: error instanceof Error ? error.message : String(error),
                log: options.log,
              },
            };
          }
        });
        return (execution = run(stopped));
      },
    });
    options.signal.throwIfAborted();
    if (result.outcome.kind === "failed")
      throw new Error(
        `${result.outcome.error.message}. See ${result.outcome.error.log}`,
      );
    const path =
      result.floor || pin.atFloor()
        ? await openFloorBuild(options, sourceKey, key, store, published)
        : result.outcome.value;
    if (!result.floor && !pin.atFloor())
      await pruneBuilds(project, directory, store, transport, options);
    serving = true;
    return path;
  } finally {
    // A serving pin follows the server's exit, including its shutdown grace period.
    options.signal.removeEventListener("abort", cancelPin);
    if (!serving || !options.lifetime) {
      await execution?.catch(() => undefined);
      pinLifetime.abort();
      await pin.ended;
    }
  }
}

async function publicationFiles(
  directory: string,
  path = "dist",
): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(directory, path), {
    withFileTypes: true,
  })) {
    const local = join(path, entry.name);
    if (entry.isDirectory())
      files.push(...(await publicationFiles(directory, local)));
    else files.push(local);
  }
  return files.sort();
}

/** Copy the published inventory, never a possibly half-pruned directory listing.
 * Recreate runtime resolution as in compilation, then link completion last.
 */
async function linkPublication(
  published: string,
  destination: string,
  webRoot: string,
) {
  const files = PublicationFiles.parse(
    JSON.parse(await readFile(join(published, "files.json"), "utf8")),
  );
  for (const file of files) {
    await mkdir(dirname(join(destination, file)), { recursive: true });
    await link(join(published, file), join(destination, file));
  }
  await symlink(
    join(webRoot, "node_modules"),
    join(destination, "node_modules"),
    "dir",
  );
  await link(join(published, "files.json"), join(destination, "files.json"));
  await link(join(published, "complete"), join(destination, "complete"));
}

async function openFloorBuild(
  options: BuildOptions,
  sourceKey: string,
  key: string,
  store: string,
  published: string,
): Promise<string> {
  const floor = join(store, "workspace-web-v5", "floor");
  await mkdir(floor, { recursive: true });
  const directory = await mkdtemp(join(floor, "launcher-"));
  const ready = join(directory, "ready");
  const signal = AbortSignal.any([
    options.signal,
    ...(options.processSignal ? [options.processSignal] : []),
    ...(options.lifetime ? [options.lifetime] : []),
  ]);
  let serving = false;
  record(options, {
    role: "floor",
    pruning: "skipped",
    reason: "floor",
    directory,
    crash: "may-retain-directory",
  });
  try {
    try {
      await linkPublication(
        published,
        ready,
        join(options.source, "apps/neuve-web/apps/web"),
      );
      record(options, { floorOutput: "linked", directory });
    } catch (error) {
      if (
        !(error instanceof z.ZodError) &&
        !(error instanceof SyntaxError) &&
        !hasCode(
          error,
          "ENOENT",
          "EXDEV",
          "EPERM",
          "EACCES",
          "ENOTSUP",
          "EOPNOTSUPP",
          "ENOSYS",
          "EMLINK",
        )
      )
        throw error;
      await rm(ready, { recursive: true, force: true });
      record(options, { floorOutput: "build", directory });
      await compileReviewWeb(
        { ...options, signal },
        sourceKey,
        key,
        directory,
        ready,
      );
    }
    signal.throwIfAborted();
    const cleanup = () => {
      void rm(directory, { recursive: true, force: true }).catch(() => {
        record(options, { floorOutput: "cleanup-failed", directory });
      });
    };
    options.lifetime?.addEventListener("abort", cleanup, { once: true });
    serving = true;
    return join(ready, "dist");
  } finally {
    if (!serving) await rm(directory, { recursive: true, force: true });
  }
}

async function compileReviewWeb(
  options: BuildOptions,
  sourceKey: string,
  key: string,
  directory: string,
  published: string,
): Promise<string> {
  const attempt = await mkdtemp(join(directory, "attempt-"));
  const webRoot = join(options.source, "apps/neuve-web/apps/web");
  const configFile = join(attempt, "vite.config.ts");
  try {
    await symlink(
      join(webRoot, "node_modules"),
      join(attempt, "node_modules"),
      "dir",
    );
    await writeFile(
      configFile,
      `import config from ${JSON.stringify(join(webRoot, "vite.config.ts"))};\nexport default {...config, base: ${JSON.stringify(options.base)}, cacheDir: ${JSON.stringify(join(options.cache, "workspace-web", key))}, build: {...config.build, outDir: ${JSON.stringify(join(attempt, "dist"))}, emptyOutDir: true}};\n`,
    );
    await writeFile(
      join(attempt, "owner.ts"),
      `import {writeFileSync} from "node:fs"; process.on("disconnect", () => process.exit(1)); process.channel?.unref(); writeFileSync(${JSON.stringify(join(attempt, "compiler"))}, String(process.pid));`,
    );
    const output = openSync(options.log, "a", 0o600);
    let child: Bun.Subprocess;
    try {
      // Run Vite's JS entry directly, so cancellation owns the compiler itself,
      // rather than a Bun package-bin launcher with a surviving descendant.
      const vite = join(
        dirname(Bun.resolveSync("vite/package.json", webRoot)),
        "bin/vite.js",
      );
      child = Bun.spawn(
        [
          options.executable,
          "--no-env-file",
          "--preload",
          join(attempt, "owner.ts"),
          vite,
          "build",
          "--config",
          configFile,
          "--configLoader",
          "native",
        ],
        {
          cwd: webRoot,
          env: {
            ...options.environment,
            NODE_ENV: "production",
            TSR_TMP_DIR: join(options.temporary, "workspace-router", key),
          },
          ipc() {},
          stdin: "ignore",
          stdout: output,
          stderr: output,
        },
      );
    } finally {
      closeSync(output);
    }
    const cancel = () => {
      void closeChild(child);
    };
    options.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (options.signal.aborted) cancel();
      const code = await child.exited;
      options.signal.throwIfAborted();
      if (code !== 0) throw new Error(`Review app build exited ${code}`);
    } finally {
      options.signal.removeEventListener("abort", cancel);
    }
    if (
      (await reviewSourceKey(options.source, options.environment)) !== sourceKey
    )
      throw new Error(
        "Review sources changed during the build; open the project again",
      );
    if (!(await Bun.file(join(attempt, "dist/server/server.js")).exists()))
      throw new Error("Review build did not emit its server entry");
    options.signal.throwIfAborted();
    try {
      await writeFile(
        join(attempt, "files.json"),
        JSON.stringify(await publicationFiles(attempt)),
      );
      await writeFile(join(attempt, "complete"), sourceKey);
      await rename(attempt, published);
    } catch (cause) {
      // The floor, or a holder missed by a replacement host, may publish beside us.
      // A complete destination is immutable; discard this attempt and serve it.
      if (
        hasCode(cause, "ENOTEMPTY", "EEXIST") &&
        (await Bun.file(join(published, "complete")).exists()) &&
        (await Bun.file(join(published, "dist/server/server.js")).exists())
      )
        return join(published, "dist");
      throw new BuildPublicationFailed("Cannot publish review build", {
        cause,
      });
    }
    return join(published, "dist");
  } finally {
    await rm(attempt, { recursive: true, force: true });
  }
}

async function pruneBuilds(
  project: string,
  current: string,
  store: string,
  transport: SharedWorkTransport,
  options: BuildOptions,
) {
  const entries = await readdir(project, { withFileTypes: true }).catch(
    (error: unknown) => {
      console.error("Cannot prune review build", project, error);
      return [];
    },
  );
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(project, entry.name);
    if (directory === current) continue;
    let claim: SharedClaim | undefined;
    let change: SharedClaim | undefined;
    try {
      const changing = await pinChange({
        transport,
        store,
        directory,
        signal: options.signal,
        insideGrant: true,
      });
      if (changing.kind === "held") continue;
      if (changing.kind === "floor") {
        record(options, {
          pruning: "skipped",
          reason: "floor",
          floor: changing.reason,
        });
        return;
      }
      change = changing.claim;
      const opened = await transport.claim({
        store,
        key: `pin:${directory}`,
        insideGrant: true,
        redeclare: false,
        signal: options.signal,
      });
      if (opened.kind === "floor") {
        record(options, {
          pruning: "skipped",
          reason: "floor",
          floor: opened.reason,
        });
        return;
      }
      claim = opened.claim;
      const event = await claim.next();
      if (event.kind === "claimed") {
        await rm(directory, { recursive: true, force: true });
      }
    } catch (error) {
      console.error("Cannot prune review build", directory, error);
    } finally {
      claim?.close();
      change?.close();
    }
  }
}
