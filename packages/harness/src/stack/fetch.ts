import { captureOutlineSource } from "../graph-outline.ts";
import { safeRead } from "@neuve/records-schema";
import { Registry } from "@neuve/records-core";
import { readFile, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  ECOSYSTEM_CAPABILITIES,
  type EcosystemCapability,
  type Gap,
  type Pin,
} from "./capability.ts";
import {
  UpstreamFetchStopped,
  checkGitVersion,
  commitFor,
  directoryBytes,
  fetchUpstreamTree,
  initTreeRepository,
  listTree,
  readStoreBlobs,
  writePackageTree,
  type StoreGit,
} from "./git-store.ts";
import {
  buildTreeIndex,
  isIndexed,
  stackIndexRecipeKey,
} from "./index-store.ts";
import { CollisionCheck, bareRepositoryHeads, pathRefusal } from "./paths.ts";
import { defaultHead, detectPins, repositoryGit } from "./pins.ts";
import {
  normaliseRepository,
  repositoryUrl,
  verifyAttestations,
} from "./provenance.ts";
import { rankPins } from "./rank.ts";
import {
  budgetLeft,
  readRepoStack,
  recordRevision,
  writeRepoStack,
  RepoStack,
  repoStackPath,
} from "./repo-state.ts";
import { STACK_LIMITS, type ResolvedStackSettings } from "./settings.ts";
import {
  activeHolds,
  clearDeadQuarantines,
  evict,
  heldBytes,
  quarantineDirectory,
  readCatalog,
  readHolds,
  removeReadOnly,
  sealTree,
  storeLayout,
  storeUsage,
  withStoreLock,
  writeCatalog,
  writeStoreGuard,
  writeReadOnlyFolder,
  type Catalog,
  type EvictionContext,
  type PackageRecord,
  type UpstreamRecord,
} from "./store.ts";
import { ArchiveRefused, gunzipBounded, readTar } from "./tar.ts";
import { STACK_EVENTS, type StackEvent } from "./telemetry.ts";
import { TransportRefused, fetchBounded, fetchJson } from "./transport.ts";

/**
 * The `stack.fetch` job's work (proposal SC1, SC3–SC7), run in a child process of the worker at
 * nice 10, behind the heavy-work gate, in the scrubbed environment. It reads the pins of the asked
 * revisions from git objects, fetches every direct dependency's package contents it lacks (checked
 * against the lockfile's hash, extracted under SC7's rules into a read-only folder and a write-once
 * tree repository), then upstream trees for the most-used entries the default branch pins, within
 * the caps, the head-only budget and the holds of open cycles. Everything it could not do is a gap
 * recorded in `.git/neuve/stack.json`. Nothing fetched is ever run.
 */

export type FetchReason = "setup" | "commit" | "review";

export interface FetchInput {
  /** A working directory of the repository. */
  readonly repository: string;
  /** Its Records store directory, `.git/neuve`. */
  readonly storeDirectory: string;
  /** The user-level stack store. */
  readonly storeRoot: string;
  /** The user-level list of repositories (8.6), whose pins eviction reads. */
  readonly registryPath: string;
  readonly settings: ResolvedStackSettings;
  readonly reason: FetchReason;
  readonly revisions: ReadonlyArray<string>;
  /** The branch a review request is attributed to: the default branch when origin names none. */
  readonly baseRef?: string;
  readonly git: StoreGit;
  readonly signal?: AbortSignal;
  readonly log: (line: string) => void;
  /** Tests only: a fake registry at `http://127.0.0.1:<port>`. */
  readonly registryBaseForTests?: string;
  /** Tests only: git protocols allowed in place of HTTPS, and the URL upstream trees come from. */
  readonly upstreamForTests?: {
    readonly protocols: ReadonlyArray<string>;
    readonly url: (host: string, path: string) => string;
  };
  readonly capabilities?: ReadonlyArray<EcosystemCapability>;
  /** Tests only: a lower byte cap for one upstream tree, so the watchdog's stop can be reached. */
  readonly upstreamCapForTests?: number;
  readonly now?: () => Date;
  /**
   * After this long no new fetch starts, and the report says work remains: the background slot runs
   * one job at a time, so the handler enqueues a continuation rather than hold it.
   */
  readonly sliceMs?: number;
  /** When the job's chain started: entries it already found unavailable are not retried. */
  readonly since?: string;
}

/** A job's share of the background slot before it hands over to its continuation. */
export const FETCH_SLICE_MS = 3 * 60 * 1000;

export interface FetchReport {
  readonly skipped?: string;
  /** The slice ended with entries left; a continuation picks them up. */
  readonly remaining: boolean;
  readonly fetched: ReadonlyArray<string>;
  readonly reused: ReadonlyArray<string>;
  readonly upstream: ReadonlyArray<string>;
  readonly gaps: ReadonlyArray<Gap>;
  readonly evicted: ReadonlyArray<string>;
  /** Trees without a current index; the handler enqueues `stack.index` for them. */
  readonly unindexed: ReadonlyArray<string>;
  readonly usage: ReturnType<typeof storeUsage>;
  /** What happened, when: span events on the job's span in the worker (10.97, telemetry.ts). */
  readonly events: ReadonlyArray<StackEvent>;
}

/** A recorder of span events, kept as data for the worker's span. */
const eventLog = () => {
  const events: Array<StackEvent> = [];
  return {
    events,
    emit: (name: string, attributes: StackEvent["attributes"]) => {
      events.push({ name, at: Date.now(), attributes });
    },
  };
};

const capabilityOf = (
  capabilities: ReadonlyArray<EcosystemCapability>,
  pin: Pin,
) => capabilities.find((entry) => entry.ecosystem === pin.ecosystem);

/** Reads the pin data of every registered repository: when each entry was last pinned. */
export const pinnedAcrossRepositories = async (
  registryPath: string,
  own?: { readonly state: RepoStack; readonly store: string },
) => {
  const pinnedAt = new Map<string, number>();
  let pinsKnown = true;
  const add = (state: RepoStack) => {
    for (const [key, at] of Object.entries(state.seen))
      pinnedAt.set(key, Math.max(pinnedAt.get(key) ?? 0, Date.parse(at)));
  };
  const read = async (store: string) => {
    try {
      const parsed = safeRead(
        RepoStack,
        JSON.parse(await readFile(repoStackPath(store), "utf8")),
      );
      if (!parsed.success) {
        pinsKnown = false;
        return;
      }
      if (parsed.droppedKeys.length > 0) pinsKnown = false;
      add(parsed.data);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        pinsKnown = false;
    }
  };
  if (own !== undefined) {
    await read(own.store);
    add(own.state);
  }
  try {
    const registry = safeRead(
      Registry.Registry,
      JSON.parse(await readFile(registryPath, "utf8")),
    );
    if (!registry.success) pinsKnown = false;
    else {
      if (registry.droppedKeys.length > 0) pinsKnown = false;
      for (const entry of registry.data.repositories) await read(entry.store);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      pinsKnown = false;
  }
  return { pinnedAt, pinsKnown };
};

const exists = async (path: string) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/** Moves a finished quarantine item into place; an item already there (same tree) wins. */
const install = async (from: string, to: string) => {
  if (await exists(to)) {
    await removeReadOnly(from);
    return false;
  }
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
  return true;
};

const integrityHex = (integrity: string) =>
  Buffer.from(integrity.slice(integrity.indexOf("-") + 1), "base64").toString(
    "hex",
  );

export const runStackFetch = async (
  input: FetchInput,
): Promise<FetchReport> => {
  const now = input.now ?? (() => new Date());
  const capabilities = input.capabilities ?? ECOSYSTEM_CAPABILITIES;
  const root = input.storeRoot;
  const source = captureOutlineSource();
  const layout = storeLayout(root);
  const sliceEnd = Date.now() + (input.sliceMs ?? FETCH_SLICE_MS);
  let remaining = false;
  const since = input.since === undefined ? undefined : Date.parse(input.since);
  const triedInChain = (at: string | undefined) =>
    since !== undefined && at !== undefined && Date.parse(at) >= since;
  const empty = (skipped: string): FetchReport => ({
    skipped,
    remaining: false,
    fetched: [],
    reused: [],
    upstream: [],
    gaps: [],
    evicted: [],
    unindexed: [],
    usage: { packages: 0, upstream: 0, indexes: 0, total: 0 },
    events: [],
  });
  const { events, emit } = eventLog();
  if (!input.settings.enabled)
    return empty("stack sources are off in the user's settings");
  const state = await readRepoStack(input.storeDirectory);
  if (state === undefined)
    return empty("neuve setup stack has not run in this repository");
  if (!state.enabled)
    return empty(`stack sources are off here (${state.disabledBy ?? "off"})`);
  const refusal = await checkGitVersion(input.git);
  if (refusal !== undefined) return empty(refusal);
  await writeStoreGuard(root);
  const cleared = await clearDeadQuarantines(root);
  if (cleared > 0)
    input.log(`cleared ${cleared} quarantine(s) a dead fetch left`);

  const repoGit = repositoryGit(
    input.repository,
    input.git.env,
    input.git.gitPath,
    input.signal,
  );
  const detectOptions = {
    privateDefaultRegistry: input.settings.privateDefaultRegistry,
    capabilities,
  };
  const gaps: Array<Gap> = [];
  const wanted = new Map<string, Pin>();
  const revisionPins = new Map<string, ReadonlyArray<Pin>>();
  for (const commit of input.revisions) {
    const read = await detectPins(repoGit, commit, detectOptions);
    recordRevision(state, commit, read.pins, read.gaps, now());
    revisionPins.set(commit, read.pins);
    gaps.push(...read.gaps);
    for (const pin of read.pins) wanted.set(pin.key, pin);
  }
  const head = await defaultHead(repoGit, input.baseRef);
  const vetted = new Set<string>();
  if (head !== undefined)
    for (const pin of revisionPins.get(head) ??
      (await detectPins(repoGit, head, detectOptions)).pins)
      vetted.add(pin.key);
  input.log(
    `${wanted.size} entr${wanted.size === 1 ? "y" : "ies"} pinned at ${input.revisions.map((c) => c.slice(0, 12)).join(", ")}; default head ${head?.slice(0, 12) ?? "unknown (every entry is unvetted)"}`,
  );

  const context = async (): Promise<EvictionContext> => ({
    now: now().getTime(),
    cap: input.settings.totalBytes,
    ...(await pinnedAcrossRepositories(input.registryPath, {
      state,
      store: input.storeDirectory,
    })),
    holds: await readHolds(root),
    log: input.log,
  });
  const evictedKeys: Array<string> = [];
  // Housekeeping first: what no repository pinned for 30 days goes, holds permitting.
  await withStoreLock(root, async () => {
    const catalog = await readCatalog(root);
    const result = await evict(root, catalog, 0, await context());
    evictedKeys.push(...result.evicted);
    await writeCatalog(root, catalog);
  });

  const outcome = (key: string, gap?: Gap) => {
    state.outcomes[key] =
      gap === undefined
        ? { state: "ready", at: now().toISOString() }
        : { state: "gap", at: now().toISOString(), gap };
    if (gap !== undefined) {
      gaps.push(gap);
      emit(STACK_EVENTS.gap, {
        "harness.stack.entry": key,
        "harness.stack.kind": "package",
        "harness.stack.reason": gap.reason,
      });
    }
  };

  /** Puts a finished quarantine item in the store, evicting first; false when it does not fit. */
  const admit = async (
    need: number,
    place: (catalog: Catalog) => Promise<void>,
  ): Promise<{ fits: true } | { fits: false; heldFull: boolean }> =>
    withStoreLock(root, async () => {
      const catalog = await readCatalog(root);
      const result = await evict(root, catalog, need, await context());
      evictedKeys.push(...result.evicted);
      if (!result.fits) {
        await writeCatalog(root, catalog);
        return { fits: false, heldFull: result.heldFull };
      }
      await place(catalog);
      await writeCatalog(root, catalog);
      return { fits: true };
    });

  const holdsFull = async () => {
    const catalog = await readCatalog(root);
    const holds = activeHolds(await readHolds(root), now().getTime());
    return heldBytes(catalog, holds) > input.settings.totalBytes;
  };

  const fetched: Array<string> = [];
  const reused: Array<string> = [];
  const registryBase = input.registryBaseForTests ?? undefined;
  for (const pin of wanted.values()) {
    if (input.signal?.aborted) break;
    const capability = capabilityOf(capabilities, pin);
    if (capability === undefined) continue;
    const disclose = (reason: Gap["reason"], detail: string) =>
      outcome(pin.key, { reason, detail, key: pin.key, path: pin.lockfile });
    const catalog = await readCatalog(root);
    const held = catalog.packages[pin.key];
    if (held !== undefined) {
      if (held.integrity === pin.integrity) {
        reused.push(pin.key);
        outcome(pin.key);
        emit(STACK_EVENTS.packageReused, { "harness.stack.entry": pin.key });
      } else
        disclose(
          "hash-mismatch",
          `${pin.lockfile} pins ${pin.name}@${pin.version} with a hash other than the registry's archive the store holds; refused`,
        );
      continue;
    }
    const earlier = state.outcomes[pin.key];
    if (earlier?.state === "gap" && triedInChain(earlier.at)) {
      if (earlier.gap !== undefined) gaps.push(earlier.gap);
      continue;
    }
    if (Date.now() > sliceEnd) {
      remaining = true;
      break;
    }
    if (await holdsFull()) {
      disclose(
        "store-full-held",
        "stack store full: held by open cycles; new fetches wait until a cycle releases its hold",
      );
      continue;
    }
    const isVetted = vetted.has(pin.key);
    const left = budgetLeft(state, now().getTime());
    if (!isVetted && (left.entries <= 0 || left.bytes <= 0)) {
      disclose(
        "over-budget",
        `${pin.name}@${pin.version} is not pinned by the default branch's head, and the day's budget for such entries (${STACK_LIMITS.unvettedEntries} entries, ${STACK_LIMITS.unvettedBytes / 1024 ** 2} MiB) is spent`,
      );
      continue;
    }
    const cap = isVetted
      ? STACK_LIMITS.packageBytes
      : Math.min(STACK_LIMITS.packageBytes, left.bytes);
    // The head-only budget charges every download attempt of an unvetted entry, whatever its
    // outcome: one entry, and the bytes received (SC7). It is written before the download, so a
    // crash or a kill cannot leave an attempt uncharged.
    const charge = isVetted
      ? undefined
      : { key: pin.key, bytes: 0, at: now().toISOString() };
    if (charge !== undefined) {
      state.budget.push(charge);
      await withStoreLock(root, () =>
        writeRepoStack(input.storeDirectory, state),
      );
    }
    const quarantine = await quarantineDirectory(root);
    const startedAt = Date.now();
    try {
      const base = registryBase ?? `https://${capability.registry.host}`;
      const policy = {
        hosts: [capability.registry.host],
        ...(registryBase === undefined ? {} : { loopbackForTests: true }),
      };
      const archive = await fetchBounded(
        capability.registry.archiveUrl(base, pin.name, pin.version),
        policy,
        { maxBytes: cap, timeoutMs: STACK_LIMITS.downloadTimeoutMs },
      );
      if (archive === undefined) {
        disclose(
          catalog.evicted[pin.key] === undefined
            ? "not-found"
            : "no-longer-available",
          `${capability.registry.host} has no archive for ${pin.name}@${pin.version}${catalog.evicted[pin.key] === undefined ? "" : "; it was evicted and is no longer available"}`,
        );
        continue;
      }
      if (charge !== undefined) charge.bytes = archive.byteLength;
      if (
        capability.registry.integrityOf(archive, pin.integrity) !==
        pin.integrity
      ) {
        disclose(
          "hash-mismatch",
          `the registry's archive for ${pin.name}@${pin.version} does not match the hash ${pin.lockfile} pins; refused (a lockfile that disagrees with the registry is worth a reviewer's look)`,
        );
        continue;
      }
      const limits = { maxBytes: cap, maxEntries: STACK_LIMITS.maxEntries };
      const read = readTar(await gunzipBounded(archive, limits), limits);
      // A folder git would take for a bare repository loses its HEAD (see `paths.ts`).
      const heads = bareRepositoryHeads(read.map((file) => file.path));
      const files = read.filter((file) => !heads.has(file.path));
      const folder = join(quarantine, "files");
      const gitDir = join(quarantine, "tree.git");
      const written = await writeReadOnlyFolder(folder, files);
      await initTreeRepository(input.git, gitDir);
      const { tree, commit } = await writePackageTree(
        input.git,
        gitDir,
        folder,
        written.paths,
        pin.key,
      );
      const objectBytes = await directoryBytes(gitDir);
      const at = now().toISOString();
      const target = layout.packageFolder(pin.ecosystem, pin.name, pin.version);
      const fileBytes = await directoryBytes(folder);
      const placed = await admit(fileBytes + objectBytes, async (current) => {
        await install(gitDir, layout.treeRepository(tree));
        await removeReadOnly(join(root, target));
        await install(folder, join(root, target));
        await sealTree(join(root, target));
        const record: PackageRecord = {
          key: pin.key,
          ecosystem: pin.ecosystem,
          name: pin.name,
          version: pin.version,
          integrity: pin.integrity,
          tree,
          commit,
          folder: target,
          files: written.files,
          fileBytes,
          objectBytes,
          fetchedAt: at,
          lastUsedAt: at,
          ...(heads.size === 0 ? {} : { omitted: heads.size }),
        };
        current.packages[pin.key] = record;
        delete current.evicted[pin.key];
      });
      if (!placed.fits) {
        disclose(
          placed.heldFull ? "store-full-held" : "over-cap",
          placed.heldFull
            ? "stack store full: held by open cycles"
            : `${pin.name}@${pin.version} (${fileBytes + objectBytes} bytes on disk) does not fit under the store's ${input.settings.totalBytes}-byte cap`,
        );
        continue;
      }
      if (charge !== undefined)
        charge.bytes = Math.max(charge.bytes, written.bytes);
      fetched.push(pin.key);
      outcome(pin.key);
      emit(STACK_EVENTS.packageFetched, {
        "harness.stack.entry": pin.key,
        "harness.stack.files": written.files,
        "harness.stack.bytes": fileBytes + objectBytes,
        "harness.stack.vetted": isVetted,
        "harness.stack.duration_ms": Date.now() - startedAt,
      });
      input.log(
        `fetched ${pin.key}: ${written.files} files, ${written.bytes} bytes, tree ${tree.slice(0, 12)}${heads.size === 0 ? "" : `; left out ${[...heads].join(", ")}, which would make a folder a git repository`}${isVetted ? "" : " (unvetted, charged to the budget)"}`,
      );
    } catch (error) {
      if (error instanceof ArchiveRefused)
        disclose(
          error.reason === "over-cap" || error.reason === "too-many-entries"
            ? "over-cap"
            : "refused-archive",
          `${pin.name}@${pin.version}: ${error.message}`,
        );
      else if (error instanceof TransportRefused) {
        // A download stopped at its cap received the cap.
        if (charge !== undefined && error.reason === "over-cap")
          charge.bytes = Math.max(charge.bytes, cap);
        disclose(
          error.reason === "over-cap" ? "over-cap" : "fetch-failed",
          `${pin.name}@${pin.version}: ${error.message}`,
        );
      } else
        disclose(
          catalog.evicted[pin.key] === undefined
            ? "fetch-failed"
            : "no-longer-available",
          `${pin.name}@${pin.version}: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            400,
          ),
        );
    } finally {
      await removeReadOnly(quarantine);
      if (charge !== undefined)
        await withStoreLock(root, () =>
          writeRepoStack(input.storeDirectory, state),
        );
    }
  }

  // Upstream trees: the most-used entries the default branch pins (SC3, SC5).
  const upstream: Array<string> = [];
  const rankAt = input.revisions[input.revisions.length - 1];
  if (rankAt !== undefined && !input.signal?.aborted && !remaining) {
    const pins = revisionPins.get(rankAt) ?? [];
    const { ranks, truncated, referencedBy } = await rankPins(
      input.repository,
      rankAt,
      pins,
      capabilities,
      {
        gitPath: input.git.gitPath,
        env: input.git.env,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
    if (truncated)
      input.log(
        "the ranking grep's output passed its cap; ranks count what was read",
      );
    // A review's changed files: the entries they reference come first, from the same grep.
    let referenced: ReadonlySet<string> = new Set<string>();
    if (input.reason === "review" && input.revisions.length >= 2) {
      const changed = new TextDecoder()
        .decode(
          await repoGit.run([
            "diff",
            "--name-only",
            "-z",
            "--no-renames",
            input.revisions[0] ?? "",
            rankAt,
          ]),
        )
        .split("\0")
        .filter((path) => path !== "");
      referenced = referencedBy(changed);
    }
    for (const [key, rank] of ranks) {
      const previous = state.upstream[key];
      state.upstream[key] =
        previous === undefined
          ? { rank, at: now().toISOString() }
          : { ...previous, rank };
    }
    const order = pins
      .filter(
        (pin) =>
          vetted.has(pin.key) &&
          ((ranks.get(pin.key) ?? 0) > 0 || referenced.has(pin.key)),
      )
      .sort(
        (a, b) =>
          Number(referenced.has(b.key)) - Number(referenced.has(a.key)) ||
          (ranks.get(b.key) ?? 0) - (ranks.get(a.key) ?? 0) ||
          (a.key < b.key ? -1 : 1),
      );
    const chosen = new Set<string>();
    const upstreamGap = (pin: Pin, reason: Gap["reason"], detail: string) => {
      const gap: Gap = { reason, detail, key: pin.key };
      emit(STACK_EVENTS.gap, {
        "harness.stack.entry": pin.key,
        "harness.stack.kind": "upstream",
        "harness.stack.reason": reason,
      });
      state.upstream[pin.key] = {
        rank: ranks.get(pin.key) ?? 0,
        at: now().toISOString(),
        gap,
      };
      gaps.push(gap);
    };
    for (const pin of order) {
      if (input.signal?.aborted) break;
      const capability = capabilityOf(capabilities, pin);
      const catalog = await readCatalog(root);
      const record = catalog.packages[pin.key];
      if (capability === undefined || record === undefined) continue;
      const linked =
        record.upstream === undefined
          ? undefined
          : catalog.upstream[record.upstream];
      if (linked !== undefined) {
        chosen.add(linked.key);
        const previous = state.upstream[pin.key];
        state.upstream[pin.key] = {
          rank: ranks.get(pin.key) ?? 0,
          at: now().toISOString(),
          tree: linked.key,
          ...(previous?.directory === undefined
            ? {}
            : { directory: previous.directory }),
        };
        continue;
      }
      if (chosen.size >= STACK_LIMITS.upstreamTrees) break;
      const earlier = state.upstream[pin.key];
      if (earlier?.gap !== undefined && triedInChain(earlier.at)) continue;
      if (Date.now() > sliceEnd) {
        remaining = true;
        break;
      }
      const base = registryBase ?? `https://${capability.registry.host}`;
      const policy = {
        hosts: [capability.registry.host],
        ...(registryBase === undefined ? {} : { loopbackForTests: true }),
      };
      let metadata: unknown;
      try {
        metadata = await fetchJson(
          capability.registry.metadataUrl(base, pin.name, pin.version),
          policy,
          STACK_LIMITS.metadataBytes,
          STACK_LIMITS.metadataTimeoutMs,
        );
      } catch (error) {
        upstreamGap(
          pin,
          "upstream-failed",
          `registry metadata: ${String(error).slice(0, 200)}`,
        );
        continue;
      }
      const source = capability.registry.sourceOf(metadata);
      const repository = normaliseRepository(source.repository);
      if (repository === undefined) {
        upstreamGap(
          pin,
          "no-commit",
          `${pin.name}@${pin.version}: the registry names no usable repository`,
        );
        continue;
      }
      if (!input.settings.gitHosts.includes(repository.host)) {
        upstreamGap(
          pin,
          "host-not-allowed",
          `${pin.name}'s repository is on ${repository.host}, which the user's settings do not list`,
        );
        continue;
      }
      let commit: string | undefined;
      let level: UpstreamRecord["level"] = "registry-stated";
      let refusedBecause: string | undefined;
      if (source.attested) {
        try {
          const attestations = await fetchJson(
            capability.registry.attestationsUrl(base, pin.name, pin.version),
            policy,
            STACK_LIMITS.metadataBytes,
            STACK_LIMITS.metadataTimeoutMs,
          );
          const verified = verifyAttestations(attestations, {
            subject: capability.registry.attestationSubject(
              pin.name,
              pin.version,
            ),
            sha512Hex: integrityHex(pin.integrity),
            repository,
          });
          if ("commit" in verified) {
            commit = verified.commit;
            level = "attested";
          } else refusedBecause = verified.refused;
        } catch (error) {
          refusedBecause = `attestations: ${String(error).slice(0, 200)}`;
        }
      }
      if (commit === undefined && source.statedCommit !== undefined)
        commit = source.statedCommit;
      if (commit === undefined) {
        upstreamGap(
          pin,
          "no-commit",
          `${pin.name}@${pin.version}: no verified attestation and no registry-stated commit${refusedBecause === undefined ? "" : ` (${refusedBecause})`}; tags are never guessed`,
        );
        continue;
      }
      if (refusedBecause !== undefined)
        input.log(
          `${pin.key}: not attested (${refusedBecause}); registry-stated commit used`,
        );
      const treeKey = `${repository.host}/${repository.path}@${commit}`;
      const known = catalog.upstream[treeKey];
      const link = async (key: string) =>
        withStoreLock(root, async () => {
          const current = await readCatalog(root);
          const owner = current.packages[pin.key];
          if (owner !== undefined && current.upstream[key] !== undefined) {
            owner.upstream = key;
            await writeCatalog(root, current);
          }
        });
      const directory =
        repository.directory === undefined
          ? {}
          : { directory: repository.directory };
      if (known !== undefined) {
        await link(treeKey);
        chosen.add(treeKey);
        state.upstream[pin.key] = {
          rank: ranks.get(pin.key) ?? 0,
          at: now().toISOString(),
          tree: treeKey,
          ...directory,
        };
        continue;
      }
      const used = storeUsage(catalog).upstream;
      if (used >= STACK_LIMITS.upstreamBytes) {
        upstreamGap(
          pin,
          "upstream-over-cap",
          `the store's upstream share (${STACK_LIMITS.upstreamBytes} bytes) is full`,
        );
        break;
      }
      const quarantine = await quarantineDirectory(root);
      const startedAt = Date.now();
      try {
        const gitDir = join(quarantine, "tree.git");
        const url =
          input.upstreamForTests?.url(repository.host, repository.path) ??
          repositoryUrl(repository);
        const { tree, objectBytes } = await fetchUpstreamTree(
          input.git,
          gitDir,
          url,
          commit,
          {
            capBytes: Math.min(
              input.upstreamCapForTests ?? STACK_LIMITS.upstreamTreeBytes,
              STACK_LIMITS.upstreamBytes - used,
            ),
            timeoutMs: STACK_LIMITS.fetchTimeoutMs,
            killGraceMs: STACK_LIMITS.killGraceMs,
            hosts: input.settings.gitHosts,
            blobLimit: STACK_LIMITS.upstreamBlobLimit,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            ...(input.upstreamForTests === undefined
              ? {}
              : { protocolsForTests: input.upstreamForTests.protocols }),
          },
        );
        const entries = await listTree(input.git, gitDir, tree);
        if (entries.length > STACK_LIMITS.maxEntries)
          throw new ArchiveRefused({
            message: `${entries.length} entries`,
            reason: "too-many-entries",
          });
        const collisions = new CollisionCheck();
        let omitted = 0;
        const blobs = new Map<string, Array<string>>();
        for (const entry of entries) {
          const why = pathRefusal(entry.path);
          if (why !== undefined)
            throw new ArchiveRefused({
              message: `${entry.path}: refused (${why})`,
              reason: "path",
            });
          if (entry.type !== "blob" || entry.mode === "120000") {
            omitted++;
            continue;
          }
          const collision = collisions.add(entry.path);
          if (collision !== undefined)
            throw new ArchiveRefused({
              message: collision,
              reason: "collision",
            });
          blobs.set(entry.oid, [...(blobs.get(entry.oid) ?? []), entry.path]);
        }
        // Repositories often ship `*.git` test fixtures: each loses its HEAD (see `paths.ts`).
        const heads = bareRepositoryHeads([...blobs.values()].flat());
        omitted += heads.size;
        // Written as read, so a large tree is never held in memory at once.
        const files = async function* () {
          for await (const { oid, bytes } of readStoreBlobs(input.git, gitDir, [
            ...blobs.keys(),
          ]))
            for (const path of blobs.get(oid) ?? []) {
              if (heads.has(path)) continue;
              if (bytes === null) omitted++;
              else yield { path, bytes };
            }
        };
        const folder = join(quarantine, "files");
        const written = await writeReadOnlyFolder(folder, files());
        await commitFor(input.git, gitDir, tree, treeKey);
        const at = now().toISOString();
        const target = layout.upstreamFolder(
          repository.host,
          repository.path,
          commit,
        );
        const totalObjects = await directoryBytes(gitDir);
        const fileBytes = await directoryBytes(folder);
        if (used + totalObjects + fileBytes > STACK_LIMITS.upstreamBytes) {
          upstreamGap(
            pin,
            "upstream-over-cap",
            `${treeKey} takes ${totalObjects + fileBytes} bytes, past what is left of the store's ${STACK_LIMITS.upstreamBytes}-byte upstream share`,
          );
          break;
        }
        const placed = await admit(
          fileBytes + totalObjects,
          async (current) => {
            await install(gitDir, layout.treeRepository(tree));
            await removeReadOnly(join(root, target));
            await install(folder, join(root, target));
            await sealTree(join(root, target));
            current.upstream[treeKey] = {
              key: treeKey,
              host: repository.host,
              path: repository.path,
              commit,
              url: repositoryUrl(repository),
              level,
              tree,
              folder: target,
              files: written.files,
              omitted,
              fileBytes,
              objectBytes: totalObjects,
              fetchedAt: at,
              lastUsedAt: at,
            };
            const owner = current.packages[pin.key];
            if (owner !== undefined) owner.upstream = treeKey;
            delete current.evicted[treeKey];
          },
        );
        if (!placed.fits) {
          upstreamGap(
            pin,
            placed.heldFull ? "store-full-held" : "upstream-over-cap",
            placed.heldFull
              ? "stack store full: held by open cycles"
              : `${treeKey} does not fit under the store's cap`,
          );
          continue;
        }
        chosen.add(treeKey);
        upstream.push(treeKey);
        emit(STACK_EVENTS.upstreamFetched, {
          "harness.stack.entry": pin.key,
          "harness.stack.tree": treeKey,
          "harness.stack.level": level,
          "harness.stack.files": written.files,
          "harness.stack.omitted": omitted,
          "harness.stack.bytes": fileBytes + totalObjects,
          "harness.stack.duration_ms": Date.now() - startedAt,
        });
        state.upstream[pin.key] = {
          rank: ranks.get(pin.key) ?? 0,
          at,
          tree: treeKey,
          ...directory,
        };
        input.log(
          `fetched upstream ${treeKey} (${level}): ${written.files} files, ${omitted} left out, ${objectBytes} bytes of objects`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // The watchdog's stops are their own events: the cap, the time limit or the job's end.
        if (error instanceof UpstreamFetchStopped && error.reason !== "failed")
          emit(STACK_EVENTS.upstreamStopped, {
            "harness.stack.entry": pin.key,
            "harness.stack.tree": treeKey,
            "harness.stack.reason": error.reason,
            "harness.stack.duration_ms": Date.now() - startedAt,
          });
        upstreamGap(
          pin,
          error instanceof ArchiveRefused
            ? "upstream-refused"
            : (error as { reason?: string }).reason === "over-cap"
              ? "upstream-over-cap"
              : "upstream-failed",
          `${treeKey}: ${message}`.slice(0, 400),
        );
      } finally {
        await removeReadOnly(quarantine);
      }
    }
  }

  // Every entry and tree this run used is recently used, for the store's LRU.
  const final = await withStoreLock(root, async () => {
    const catalog = await readCatalog(root);
    const at = now().toISOString();
    for (const key of wanted.keys()) {
      const record = catalog.packages[key];
      if (record === undefined) continue;
      record.lastUsedAt = at;
      const linked =
        record.upstream === undefined
          ? undefined
          : catalog.upstream[record.upstream];
      if (linked !== undefined) linked.lastUsedAt = at;
    }
    await writeCatalog(root, catalog);
    return catalog;
  });
  const trees = new Set<string>();
  for (const key of wanted.keys()) {
    const record = final.packages[key];
    if (record === undefined) continue;
    trees.add(record.tree);
    const linked =
      record.upstream === undefined
        ? undefined
        : final.upstream[record.upstream];
    if (linked !== undefined) trees.add(linked.tree);
  }
  const unindexed: Array<string> = [];
  for (const tree of trees)
    if (!(await isIndexed(root, tree, source))) unindexed.push(tree);
  state.updatedAt = now().toISOString();
  state.budget = budgetLeft(state, now().getTime()).window;
  await withStoreLock(root, () => writeRepoStack(input.storeDirectory, state));
  for (const key of evictedKeys)
    emit(STACK_EVENTS.evicted, { "harness.stack.entry": key });
  return {
    remaining,
    fetched,
    reused,
    upstream,
    gaps,
    evicted: evictedKeys,
    unindexed,
    usage: storeUsage(final),
    events,
  };
};

/**
 * The `stack.index` job's work: a persisted index for each tree that lacks a current one, then the
 * catalog's record of its size. Admission evicts before publishing; a capacity gap completes this
 * job without requeuing it, as a fetch gap does. A later fetch can ask again.
 */
export const runStackIndex = async (input: {
  readonly storeRoot: string;
  readonly registryPath: string;
  readonly settings: ResolvedStackSettings;
  readonly trees: ReadonlyArray<string>;
  readonly git: StoreGit;
  readonly signal?: AbortSignal;
  readonly log: (line: string) => void;
}) => {
  const root = input.storeRoot;
  const source = captureOutlineSource();
  const built: Array<string> = [];
  const evicted: Array<string> = [];
  const deferred: Array<{
    tree: string;
    reason: string;
    deferredIndexes: ReadonlyArray<string>;
  }> = [];
  const { events, emit } = eventLog();
  for (const tree of input.trees) {
    if (input.signal?.aborted) break;
    if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(tree)) continue;
    if (await isIndexed(root, tree, source)) continue;
    if (!(await exists(storeLayout(root).treeRepository(tree)))) continue;
    const started = Date.now();
    let reason = "newer-build";
    let deferredIndexes: ReadonlyArray<string> = [];
    const result = await buildTreeIndex(
      input.signal === undefined
        ? input.git
        : {
            ...input.git,
            signal: AbortSignal.any([
              input.signal,
              ...(input.git.signal === undefined ? [] : [input.git.signal]),
            ]),
          },
      root,
      tree,
      source,
      async (build, install) => {
        const catalog = await readCatalog(root);
        const ownsTree = () =>
          Object.values(catalog.packages).some(
            (record) => record.tree === tree,
          ) ||
          Object.values(catalog.upstream).some(
            (record) => record.tree === tree,
          );
        if (!ownsTree()) {
          reason = "evicted";
          return false;
        }
        const capacity = await evict(
          root,
          catalog,
          Math.max(0, build.bytes - (catalog.indexes[tree]?.bytes ?? 0)),
          {
            now: Date.now(),
            cap: input.settings.totalBytes,
            ...(await pinnedAcrossRepositories(input.registryPath)),
            holds: await readHolds(root),
            log: input.log,
          },
        );
        evicted.push(...capacity.evicted);
        deferredIndexes = capacity.deferredIndexes;
        if (!capacity.fits || !ownsTree()) {
          reason = !capacity.fits
            ? capacity.heldFull
              ? "store-full-held"
              : "over-cap"
            : "evicted";
          await writeCatalog(root, catalog);
          return false;
        }
        await install();
        catalog.indexes[tree] = {
          tree,
          recipe: stackIndexRecipeKey(),
          bytes: build.bytes,
          docs: build.docs,
          builtAt: new Date().toISOString(),
        };
        await writeCatalog(root, catalog);
        return true;
      },
    );
    if (result.status === "deferred") {
      if (result.reason === "newer-build") reason = "newer-build";
      deferred.push({ tree, reason, deferredIndexes });
      emit(STACK_EVENTS.gap, {
        "harness.stack.tree": tree,
        "harness.stack.kind": "index",
        "harness.stack.reason": reason,
        "harness.stack.deferred_indexes": deferredIndexes.length,
      });
      input.log(
        `stack index deferred for ${tree.slice(0, 12)}: ${reason}; discarded staged build${reason === "newer-build" ? "; leaving the index to its newer writer" : ""}`,
      );
      continue;
    }
    built.push(tree);
    emit(STACK_EVENTS.indexBuilt, {
      "harness.stack.tree": tree,
      "harness.stack.docs": result.docs,
      "harness.stack.bytes": result.bytes,
      "harness.stack.duration_ms": Date.now() - started,
    });
    input.log(
      `indexed tree ${tree.slice(0, 12)}: ${result.docs} chunks, ${result.bytes} bytes, ${Date.now() - started} ms; left out ${JSON.stringify(result.excluded)}`,
    );
  }
  for (const key of evicted)
    emit(STACK_EVENTS.evicted, { "harness.stack.entry": key });
  const usage = storeUsage(await readCatalog(root));
  return { built, deferred, evicted, events, usage };
};
