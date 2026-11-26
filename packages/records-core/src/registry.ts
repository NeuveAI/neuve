import { preserveUnknown, safeRead } from "@neuve/records-schema";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { z } from "zod";
import type { StoreLocation } from "./location.ts";
import { withFileLock } from "./file-lock.ts";
import { xdgPath } from "./xdg-path.ts";

/**
 * The user-level list of repositories with a Records store (8.6), read by the launchd sweep. Each
 * worker adds its repository when it starts; setup's upgrade drops those whose folder is gone. Writers
 * share a lock through read, merge and rename.
 * It holds paths only.
 */
export const registryPath = (home = homedir()) =>
  process.platform === "darwin"
    ? join(home, "Library", "Application Support", "Neuve", "repositories.json")
    : join(
        xdgPath("XDG_STATE_HOME") ?? join(home, ".local", "state"),
        "neuve",
        "repositories.json",
      );

export const Registry = z.strictObject({
  version: z.literal(1),
  repositories: z.array(
    z.strictObject({
      /** The store directory, `<git common directory>/neuve`; one entry per repository. */
      store: z.string().min(1),
      /** A working directory of the repository, passed to `neuve worker run --repo`. */
      repository: z.string().min(1),
    }),
  ),
});
export type Registry = z.infer<typeof Registry>;

const empty: Registry = { version: 1, repositories: [] };

export const readRegistry = (path = registryPath()) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    if (!(yield* fs.exists(path))) return empty;
    const text = yield* fs.readFileString(path);
    try {
      const parsed = safeRead(Registry, JSON.parse(text), { source: path });
      return parsed.success ? parsed.data : empty;
    } catch {
      return empty;
    }
  });

/**
 * Changes the list under its lock: `change` gets the list as read and returns the next one, or
 * undefined to leave the file as it is. Written to a temporary file, then renamed.
 */
const updateRegistry = (
  path: string,
  change: (registry: Registry) => Registry | undefined,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    return yield* Effect.tryPromise((signal) =>
      withFileLock(
        `${path}.lock`,
        () =>
          Effect.runPromise(
            Effect.gen(function* () {
              const next = change(yield* readRegistry(path));
              if (next === undefined) return false;
              const stored = (yield* fs.exists(path))
                ? yield* fs.readFileString(path)
                : undefined;
              const output =
                stored === undefined
                  ? next
                  : yield* Effect.try(() =>
                      preserveUnknown(Registry, JSON.parse(stored), next, {
                        source: path,
                        arrayKeys: { repositories: ["store"] },
                      }),
                    );
              yield* fs.makeDirectory(dirname(path), { recursive: true });
              const temporary = `${path}.${process.pid}.tmp`;
              yield* fs
                .writeFileString(
                  temporary,
                  `${JSON.stringify(output, null, 2)}\n`,
                )
                .pipe(
                  Effect.andThen(fs.rename(temporary, path)),
                  Effect.ensuring(
                    Effect.ignore(fs.remove(temporary, { force: true })),
                  ),
                );
              return true;
            }).pipe(Effect.provideService(FileSystem, fs)),
            { signal },
          ),
        120_000,
        signal,
      ),
    );
  });

/**
 * Where a worker adds its repository. A test process keeps its own list beside its own budget, so
 * no test's scratch checkout reaches the person's list.
 */
const workerRegistryPath = () => {
  if (process.env.NEUVE_TEST_PROCESS !== "1")
    return process.env.NEUVE_RECORDS_REGISTRY ?? registryPath();
  if (!process.env.NEUVE_BUDGET_DIRECTORY)
    throw new Error("Test processes require NEUVE_BUDGET_DIRECTORY");
  return join(process.env.NEUVE_BUDGET_DIRECTORY, "repositories.json");
};

/** Adds the repository unless its store is listed. */
export const registerRepository = (
  location: StoreLocation,
  repository: string,
  path?: string,
) =>
  Effect.try(() => path ?? workerRegistryPath()).pipe(
    Effect.flatMap((list) =>
      updateRegistry(list, (registry) =>
        registry.repositories.some(
          (entry) => entry.store === location.directory,
        )
          ? undefined
          : {
              version: 1,
              repositories: [
                ...registry.repositories,
                { store: location.directory, repository },
              ],
            },
      ),
    ),
  );

/** Drops the entries whose working directory is one of `gone`; the file is left alone when none is. */
export const forgetRepositories = (
  gone: ReadonlySet<string>,
  path = registryPath(),
) =>
  updateRegistry(path, (registry) => {
    const kept = registry.repositories.filter(
      (entry) => !gone.has(entry.repository),
    );
    return kept.length === registry.repositories.length
      ? undefined
      : { version: 1, repositories: kept };
  });
