import { captureOutlineSource } from "./graph-outline.ts";
import { readData } from "@neuve/records-core";
import { Clock, type Duration, Effect, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  CycleScopeSource,
  ExternalReviewSourceSchema,
  ReviewOriginSchema,
  GitOid,
  Ulid,
  type ExternalReviewPin,
  type ExternalReviewSource,
  type ReviewOrigin,
  RecordEvent,
  type Range,
} from "@neuve/records-schema";
import {
  Blobs,
  Caller,
  Computations,
  Cycles,
  Identity,
  JobQueue,
  Log,
  ReviewOrigins,
  canonicalJson,
  mintUlid,
  sha256Hex,
  type StoreLocation,
} from "@neuve/records-core";
import {
  CompletedRun,
  PIPELINE_VERSION,
  defaultConfig,
  runKeyFor,
  PipelineConfig,
  routeOwnsLoop,
  sectionsConfig,
  type SectionsConfig,
  type StubSettings,
  type ReadingsConfig,
} from "./config.ts";
import { DEFAULT_READING_BOUNDS } from "./reading-groups.ts";
import {
  READING_RECIPE,
  READING_RECIPE_SCOPE_AND_TESTS,
} from "./readings/plan.ts";
import { readIntegrations, type Integrations } from "./integrations.ts";
import { git, resolveCommit } from "./git.ts";
import type { RetrieverConfig } from "./retriever.ts";
import {
  ClaudeRouteConfig,
  OPUS_ROUTE,
  RouteName,
  routeByName,
  type RouteConfig,
} from "./route.ts";
import { stackToolsConfig } from "./stack/frozen-state.ts";
import type { StackToolsConfig } from "./stack/settings.ts";
import {
  resolveSearch,
  type LeadsChoice,
  searchRuntimeFrom,
  type SearchConfig,
} from "./search-config.ts";
import {
  readSettings,
  reviewDeadline,
  reviewEffort,
  reviewReasoningSummaries,
  reviewResponsibilitySections,
  reviewRoute,
  type Settings,
  reviewStepEffort,
} from "./settings.ts";
import { keepExternalFetched } from "./scope-storage.ts";
import { externalScopeText } from "./github-scope.ts";
import {
  AccountName,
  DEFAULT_ACCOUNTS,
  type AccountDirectoryShape,
  type RuntimeRegistryShape,
} from "@neuve/runtime";

/**
 * A review request as `neuve review <range>` makes it (10.13, proposal §1): the range resolved to
 * OIDs, the configuration and route frozen, the run key computed, the cycle joined or opened, and
 * the generation that keeps a request after a failed run from joining the failed job.
 */

export interface ReviewRequest {
  readonly range: Range;
  readonly config: PipelineConfig;
  readonly runKey: string;
  readonly generation: number;
  readonly cycleId: string;
  readonly openedCycle: boolean;
  readonly actor: string;
  readonly events: ReadonlyArray<RecordEvent>;
  /** Set when a complete run of this key exists: the request joins that run's completed job. */
  readonly complete: CompletedRun | undefined;
  /** The job's de-duplication key, which `jobsFor` derives from the request. */
  readonly dedupeKey: string;
  readonly association?: string | undefined;
}

/**
 * A route by its name, at the effort the user's settings name (`review.effort`), else the route's
 * own, with the per-kind step efforts (`review.stepEffort`) and reasoning summaries when they ask
 * for them: what `neuve review --route <name>` freezes.
 */
export const namedRoute = (
  name: RouteName,
  settings = readSettings(),
): RouteConfig =>
  routeByName(
    name,
    reviewEffort(settings),
    reviewReasoningSummaries(settings),
    reviewStepEffort(settings),
  );

/** Resolve a CLI route choice without probing, starting a child or reading a credential. */
export const resolveNamedRoute = (
  name: string,
  directory: Pick<AccountDirectoryShape, "lookup">,
  settings = readSettings(),
) =>
  Effect.gen(function* () {
    const direct = RouteName.safeParse(name);
    if (direct.success) return namedRoute(direct.data, settings);
    const parsed = AccountName.safeParse(name);
    const account = parsed.success
      ? yield* directory.lookup(parsed.data, "use")
      : undefined;
    if (account?.kind !== "claude-subscription")
      return yield* Effect.fail(
        new Error(
          `Unknown review route ${JSON.stringify(name)}. Choose anthropic, openai or a Claude subscription account name.`,
        ),
      );
    return claudeRoute(account, settings);
  });

/**
 * Claude Opus on a Claude subscription account, through Claude Code (12.59), at the settings'
 * effort and per-kind step efforts: what `--route <account>` and `review.route: "claude"` freeze.
 */
export const claudeRoute = (
  account: { readonly name: AccountName; readonly kind: "claude-subscription" },
  settings: Option.Option<Settings>,
): ClaudeRouteConfig => {
  // The per-kind step efforts only when they name a kind, as `routeByName` freezes them.
  const stepEffort = reviewStepEffort(settings);
  return ClaudeRouteConfig.parse({
    provider: "claude",
    account: { name: account.name, kind: account.kind },
    model: OPUS_ROUTE.model,
    window: OPUS_ROUTE.window,
    maxOutputTokens: OPUS_ROUTE.maxOutputTokens,
    effort: reviewEffort(settings) ?? OPUS_ROUTE.effort,
    price: null,
    ...(stepEffort === undefined || Object.keys(stepEffort).length === 0
      ? {}
      : { stepEffort }),
  });
};

/** The built-in Claude account (Claude Code's own sign-in), as `review.route: "claude"` names it. */
const builtInClaude = (() => {
  const account = DEFAULT_ACCOUNTS.find((entry) => entry.name === "claude");
  if (account?.kind !== "claude-subscription")
    throw new Error(
      "The built-in claude account is missing from the defaults.",
    );
  return account;
})();

/**
 * The route the user's settings name (`review.route`), else the Anthropic route, at the settings'
 * effort: what `neuve review` freezes when no `--route` is given (10.85). `claude` is the built-in
 * account's Claude route, built from the static default with no account-store read, so it is the
 * route `--route claude` resolves to. The web app passes it to `requestReview`, so a request from
 * the desk freezes the same route, configuration and run key as one from the CLI.
 */
export const settingsRoute = (settings = readSettings()): RouteConfig => {
  const named = reviewRoute(settings) ?? "anthropic";
  return named === "claude"
    ? claudeRoute(builtInClaude, settings)
    : namedRoute(RouteName.parse(named), settings);
};

/**
 * The section readings' block a review request freezes (NEU-148): unless the user's settings say
 * `review.sectionReadings: "off"`, which leaves it absent, so the run keeps the key it had before
 * the readings. Absent and `"probe"` freeze the same block. Effort by risk
 * (`review.sectionReadingsEffort: "by-risk"`) is frozen into it only when set. Scope and tests
 * (`review.sectionReadingsScopeAndTests: true`) is frozen only when set, with its own recipe;
 * absent or false, the block is byte for byte the one before it existed. The call-line lift is no
 * switch (round 13): `review.sectionReadingsCallsLiftGap` is ignored and nothing of it is frozen.
 * Rule skips (`review.sectionReadingsRuleSkips: true`) ride on whatever block the readings' mode
 * builds, as `ruleSkips: true`, only when set.
 */
export const readingsConfig = (
  settings: Option.Option<Settings>,
): ReadingsConfig | undefined => {
  const review = Option.getOrUndefined(settings)?.review;
  if (review?.sectionReadings === "off") return undefined;
  const scopeAndTests = review?.sectionReadingsScopeAndTests === true;
  return withRuleSkips(review ?? {}, {
    mode: "probe",
    bounds: { ...DEFAULT_READING_BOUNDS },
    recipe: scopeAndTests ? READING_RECIPE_SCOPE_AND_TESTS : READING_RECIPE,
    ...(review?.sectionReadingsEffort === "by-risk"
      ? { effort: "by-risk" as const }
      : {}),
    ...(scopeAndTests ? { scopeAndTests: true as const } : {}),
  });
};

/**
 * A readings block with rule skips frozen in when the settings set them, for any mode's block, so
 * a later mode carries them with no edit here. Not set: the block as given, the same object.
 */
export const withRuleSkips = (
  review: Pick<NonNullable<Settings["review"]>, "sectionReadingsRuleSkips">,
  block: ReadingsConfig,
): ReadingsConfig =>
  review.sectionReadingsRuleSkips === true
    ? { ...block, ruleSkips: true }
    : block;

/** Parses `<base>..<head>`; a single revision means `<revision>^..<revision>`. */
export const parseRange = (text: string) => {
  const at = text.indexOf("..");
  if (at > 0 && text[at + 2] !== ".")
    return { base: text.slice(0, at), head: text.slice(at + 2) || "HEAD" };
  return { base: `${text}^`, head: text };
};

/**
 * Who asks for a review. The request never resolves its caller (ST1): the CLI resolves the agent
 * session it runs in and falls back to the human git names; the web app always passes the human git
 * names (ID1).
 */
export type Requester =
  | {
      readonly _tag: "Agent";
      readonly harness: string;
      readonly sessionId: string;
      readonly subagentId?: string | undefined;
    }
  /** An actor already registered in Records, such as the agent session a CLI call runs in. */
  | {
      readonly _tag: "Actor";
      readonly actorId: string;
      readonly sessionId?: string | undefined;
    }
  /** A person, registered as a human actor by the request (10.5). */
  | {
      readonly _tag: "Human";
      readonly email: string;
      readonly displayName?: string | undefined;
    }
  /** No session and no git email: the request is attributed to the unresolved actor. */
  | { readonly _tag: "Unresolved" };

/** The human git names in the repository (`user.email`, `user.name`); none when no email is set. */
export const gitHuman = (repository: string) =>
  Effect.gen(function* () {
    const email = (yield* git(repository, ["config", "user.email"]).pipe(
      Effect.orElseSucceed(() => ""),
    )).trim();
    if (email === "") return Option.none<Requester>();
    const name = (yield* git(repository, ["config", "user.name"]).pipe(
      Effect.orElseSucceed(() => ""),
    )).trim();
    return Option.some<Requester>({
      _tag: "Human",
      email,
      ...(name === "" ? {} : { displayName: name }),
    });
  });

/** Who asks for a CLI read or review: a linked session, the human Git names, or unresolved. */
export const resolveRequester = (location: StoreLocation, repository: string) =>
  Effect.gen(function* () {
    const caller = yield* Caller.resolveCaller(location).pipe(
      Effect.orElseSucceed(() => ({ _tag: "None" }) as const),
    );
    if (caller._tag === "Linked")
      return {
        _tag: "Actor",
        actorId: caller.actorId,
        sessionId: caller.sessionId,
      } as const;
    return Option.getOrElse(yield* gitHuman(repository), (): Requester => ({
      _tag: "Unresolved",
    }));
  });

/** The requester's actor ID and idempotent registration for a named person or native agent. */
export const requesterAttribution = (requester: Requester) => {
  if (requester._tag === "Agent") {
    const actor = Identity.agentFingerprint(requester);
    const payload = {
      actorKind: "agent",
      harness: requester.harness,
      sessionId: requester.sessionId,
      ...(requester.subagentId ? { subagentId: requester.subagentId } : {}),
    };
    return {
      actor,
      registration: {
        id: mintUlid(),
        kind: "actor.registered@1",
        idempotencyKey: `actor:${actor}:${sha256Hex(canonicalJson(payload)).slice(0, 16)}`,
        actor,
        occurredAt: new Date().toISOString(),
        payload,
      },
    };
  }
  if (requester._tag === "Actor")
    return { actor: requester.actorId, registration: undefined };
  if (requester._tag === "Unresolved")
    return { actor: Identity.UNRESOLVED_ACTOR, registration: undefined };
  const actor = Identity.humanFingerprint(requester.email);
  // Trimmed as Records' human commands trim it, so a person named by either path is one registration.
  const name = requester.displayName?.trim() ?? "";
  const payload = {
    actorKind: "human",
    harness: "git",
    email: Identity.normalizeEmail(requester.email),
    ...(name === "" ? {} : { displayName: name }),
  };
  return {
    actor,
    registration: {
      id: mintUlid(),
      kind: "actor.registered@1",
      idempotencyKey: `actor:${actor}:${sha256Hex(canonicalJson(payload)).slice(0, 16)}`,
      actor,
      occurredAt: new Date().toISOString(),
      payload,
    },
  };
};

export type ReviewOptions = {
  readonly runtimes?: Pick<RuntimeRegistryShape, "capabilities"> | undefined;
  readonly requestId?: string | undefined;
  readonly frozenConfig?: PipelineConfig | undefined;
  readonly location: StoreLocation;
  readonly repository: string;
  readonly branchCheckout?: string | undefined;
  readonly branch?: string | undefined;
  readonly range: string;
  readonly scopeSource?: CycleScopeSource | undefined;
  readonly origin?: ReviewOrigin | undefined;
  readonly externalSources?: readonly ExternalReviewSource[] | undefined;
  readonly scopeIntegrations?: Integrations | undefined;
  /** Who asks; the caller resolves it (ST1). */
  readonly requester: Requester;
  readonly stub?: StubSettings | undefined;
  /** The route the run is frozen with (10.85); the Anthropic route when absent. */
  readonly route?: RouteConfig | undefined;
  /**
   * The search tools and leads retriever the run is frozen with (10.89); from the user's settings
   * (`search`) when absent, and BM25 only when those name none.
   */
  readonly search?:
    | {
        readonly tools?: SearchConfig | undefined;
        readonly leads?: RetrieverConfig | undefined;
      }
    | undefined;
  /**
   * The leads retriever this review asks for over the settings' choice (`neuve review --leads`):
   * keyword leads, or hybrid leads read stored (10.119). Ignored when `search` is given.
   */
  readonly leads?: LeadsChoice | undefined;
  /** The stack tools the run is frozen with; from the user's settings (`stack.tools`) when absent. */
  readonly stack?: StackToolsConfig | undefined;
  /**
   * Responsibility sections the run is frozen with; from the user's settings
   * (`review.responsibilitySections`, on unless false or the readings' off switch) when absent.
   */
  readonly sections?: SectionsConfig | undefined;
  /**
   * The run's lifetime; from the user's settings (`review.deadline`) when not given, and 10 minutes
   * when those name none or it is given as undefined. Read here, as the stack settings are, so the
   * CLI and the desk freeze the same one.
   */
  readonly deadline?: Duration.Duration | undefined;
  /** The section readings; from the user's settings (`review.sectionReadings`) when absent. */
  readonly readings?: ReadingsConfig | undefined;
};

/** Shared settings resolution. Preparing intent never writes a review. */
export const prepareReviewConfig = (
  options: Pick<
    ReviewOptions,
    | "location"
    | "search"
    | "leads"
    | "stack"
    | "sections"
    | "deadline"
    | "stub"
    | "route"
    | "runtimes"
  > &
    Partial<Pick<ReviewOptions, "readings">>,
) =>
  Effect.gen(function* () {
    const search =
      options.search ??
      (yield* Effect.suspend(() => {
        const settings = readSettings();
        return Effect.map(
          resolveSearch(
            searchRuntimeFrom(settings, options.location.directory),
            settings,
            options.leads,
          ),
          ({ search: tools, leads }) => ({ tools, leads }),
        );
      }));
    // The stack tools (11.15, ST2): frozen into the config only when the user's settings turn them
    // on, so a run with them off keeps its key.
    const stack =
      "stack" in options
        ? options.stack
        : stackToolsConfig(
            yield* Effect.sync(() => readSettings()),
            captureOutlineSource(),
          );
    const deadline =
      "deadline" in options
        ? options.deadline
        : reviewDeadline(yield* Effect.sync(() => readSettings()));
    // Responsibility sections (10.109): frozen unless the user's settings turn them off, so a run
    // with them off keeps its key.
    const sections =
      "sections" in options
        ? options.sections
        : sectionsConfig(
            reviewResponsibilitySections(
              yield* Effect.sync(() => readSettings()),
            ),
          );
    // The section readings (NEU-148): frozen unless the user's settings turn them off.
    const readings =
      "readings" in options
        ? options.readings
        : readingsConfig(yield* Effect.sync(() => readSettings()));
    const config = PipelineConfig.parse(
      defaultConfig(
        options.stub,
        options.route,
        search,
        stack,
        deadline,
        sections,
        readings,
      ),
    );
    if (options.runtimes !== undefined)
      yield* routeOwnsLoop(config.route, options.runtimes);
    return config;
  });

const localBranches = (repository: string, filter: string) =>
  git(repository, [
    "for-each-ref",
    filter,
    "--format=%(refname:strip=2)",
    "refs/heads/",
  ]).pipe(
    Effect.map((refs) => refs.split("\n").filter(Boolean)),
    Effect.mapError(
      (error) =>
        new Error(
          `Git could not list the local branches: ${error.message || `git for-each-ref exited with code ${error.exitCode}`}`,
          { cause: error },
        ),
    ),
  );

const formatBranchNames = (
  branches: readonly string[],
  type: "conjunction" | "disjunction",
) =>
  new Intl.ListFormat("en", { type }).format(
    branches.map((name) => JSON.stringify(name)),
  );

const localPlanIdentity = (cycleId: string) =>
  Effect.gen(function* () {
    const [entry] = yield* Log.history({
      kind: "cycle.local-scope-selected@1",
      cycleId,
      limit: 1,
    });
    if (entry?.event.kind !== "cycle.local-scope-selected@1") return undefined;
    const { sources, omitted } = entry.event.payload;
    return sha256Hex(
      canonicalJson({
        omitted,
        sources: sources.map((source) => {
          switch (source.kind) {
            case "repository-document":
              return [source.kind, source.blob];
            case "working-file":
              return [source.kind, source.sha256];
            case "gap":
              return [source.kind, source.path];
          }
        }),
      }),
    );
  });

type ReviewBranch = {
  readonly branch: string | undefined;
  readonly ambiguous?: readonly string[];
};

const selectReviewCycle = (range: Range, target: ReviewBranch | undefined) =>
  Effect.gen(function* () {
    const boundCycles = yield* Cycles.boundToRange(range);
    const read =
      target?.branch === undefined
        ? undefined
        : yield* Cycles.branchReadCycle(target.branch);
    if (read !== undefined && boundCycles.includes(read.cycleId))
      return { cycleId: read.cycleId, bound: true };
    const [bound] = boundCycles;
    if (bound !== undefined) {
      if (read?.open) {
        const plan = yield* localPlanIdentity(read.cycleId);
        if (plan !== undefined) {
          for (const cycleId of boundCycles)
            if ((yield* localPlanIdentity(cycleId)) === plan)
              return { cycleId, bound: true, plan };
          return { cycleId: read.cycleId, bound: false, plan };
        }
      }
      return { cycleId: bound, bound: true };
    }
    if (read?.open) return { cycleId: read.cycleId, bound: false };
    if (target?.ambiguous !== undefined)
      return yield* Effect.fail(
        new Error(
          `${formatBranchNames(target.ambiguous, "conjunction")} end at this review's head, so pass --branch <name> with the branch to review.`,
        ),
      );
    return undefined;
  });

export const requestReview = (options: ReviewOptions) =>
  Effect.gen(function* () {
    const origin =
      options.origin === undefined
        ? undefined
        : ReviewOriginSchema.parse(options.origin);
    const externalSources =
      options.externalSources?.map((source) =>
        ExternalReviewSourceSchema.parse(source),
      ) ?? [];
    if (externalSources.length > 16)
      throw new Error("A review accepts at most 16 explicit external sources");
    if (externalSources.length && !origin)
      throw new Error("External review context requires an explicit origin");
    for (const source of externalSources) {
      if (
        !origin?.items.some(
          (item) =>
            item.repo.toLowerCase() === source.item.repo.toLowerCase() &&
            item.kind === source.item.kind &&
            item.number === source.item.number,
        )
      )
        throw new Error(
          "External review context must belong to an explicitly selected item",
        );
    }
    const contextIdentity = externalSources.length
      ? sha256Hex(
          canonicalJson(
            externalSources.map(
              ({ fetchedAt: _at, version: _version, ...source }) => source,
            ),
          ),
        )
      : undefined;
    const selected =
      options.scopeSource === undefined
        ? undefined
        : CycleScopeSource.parse(options.scopeSource);
    const { base, head } = parseRange(options.range);
    if (origin !== undefined) {
      GitOid.parse(base);
      GitOid.parse(head);
    }
    const range: Range = {
      baseRef: base,
      baseOid: yield* resolveCommit(options.repository, base),
      headOid: yield* resolveCommit(options.repository, head),
    };
    const { localPlan: _localPlan, ...preparedConfig } = options.frozenConfig
      ? PipelineConfig.parse(options.frozenConfig)
      : {
          ...(yield* prepareReviewConfig(options)),
          ...(contextIdentity ? { externalContext: contextIdentity } : {}),
        };
    if (options.frozenConfig !== undefined && options.runtimes !== undefined)
      yield* routeOwnsLoop(preparedConfig.route, options.runtimes);
    if (preparedConfig.externalContext !== contextIdentity)
      throw new Error(
        "Frozen review configuration does not match its external context",
      );
    const { actor, registration } = requesterAttribution(options.requester);
    const requestId =
      options.requestId === undefined
        ? mintUlid()
        : Ulid.parse(options.requestId);
    const intent = `neuve-review-intent:${sha256Hex(canonicalJson({ origin: origin ?? null, scope: selected ?? null }))}`;
    const sql = yield* SqlClient;
    const store = yield* Computations.ComputationStore;
    const blobs = yield* Blobs.BlobStore;
    const branchSelection =
      selected === undefined && contextIdentity === undefined
        ? yield* Effect.gen(function* () {
            const tips = yield* localBranches(
              options.repository,
              `--points-at=${range.headOid}`,
            );
            const named = options.branch;
            if (named !== undefined) {
              const accepted =
                tips.length === 0
                  ? yield* localBranches(
                      options.repository,
                      `--contains=${range.headOid}`,
                    )
                  : tips;
              if (accepted.includes(named)) return { branch: named };
              const received = JSON.stringify(named);
              const message =
                tips.length === 0
                  ? `${received} does not hold this review's head. Pass --branch <name> with a local branch that does.`
                  : `${received} does not end at this review's head, so pass --branch with ${formatBranchNames(tips, "disjunction")}${tips.length === 1 ? " or leave it out" : ""}.`;
              return yield* Effect.fail(new Error(message));
            }
            if (tips.length < 2) return { branch: tips[0] };
            const checkout = (yield* git(
              options.branchCheckout ?? options.repository,
              ["symbolic-ref", "--quiet", "HEAD"],
            ).pipe(
              Effect.catchIf(
                (error) => error.exitCode === 1,
                () => Effect.succeed(""),
              ),
            )).trimEnd();
            return {
              branch: tips.find((name) => `refs/heads/${name}` === checkout),
              ambiguous: tips,
            };
          })
        : undefined;
    // The cycle, the generation and the append are one write transaction (`BEGIN IMMEDIATE`), so
    // two first requests for the same range and plan cannot open two cycles or pick different generations.
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const previous = yield* Log.get(requestId);
        if (Option.isSome(previous)) {
          const event = previous.value.event;
          const recordedPlan =
            event.kind === "review.requested@1"
              ? readData(PipelineConfig, event.payload.pipeline.config)
                  .localPlan
              : undefined;
          const config =
            recordedPlan !== undefined
              ? { ...preparedConfig, localPlan: recordedPlan }
              : preparedConfig;
          if (
            event.kind !== "review.requested@1" ||
            event.actor !== actor ||
            canonicalJson(event.attribution.range) !== canonicalJson(range) ||
            event.payload.runKey !== runKeyFor(range, config) ||
            canonicalJson(event.payload.pipeline.config) !==
              canonicalJson(config) ||
            event.causation?.correlationId !== intent
          )
            throw new Error(
              "Review request identity was reused for different source, configuration, actor or provenance",
            );
          const { runKey, generation } = event.payload;
          const cycleId = event.attribution.cycleId;
          const association =
            origin === undefined
              ? undefined
              : (yield* ReviewOrigins.list({
                  identity: sha256Hex(
                    canonicalJson({
                      cycleId,
                      base: range.baseOid,
                      head: range.headOid,
                      origin,
                    }),
                  ),
                }))[0]?.association;
          return {
            range,
            config,
            runKey,
            generation,
            cycleId,
            openedCycle: false,
            actor,
            complete: undefined,
            events: [event],
            dedupeKey: `review.run:${runKey}:${generation}`,
            ...(association ? { association } : {}),
          } satisfies ReviewRequest;
        }
        if (selected) {
          const integrations = options.scopeIntegrations || readIntegrations();
          const server =
            integrations.status === "configured"
              ? integrations.file.servers[selected.server]
              : undefined;
          if (!server?.fetch || !server.tools.includes(server.fetch.tool))
            throw new Error(
              "The selected scope has no configured read-only fetch operation",
            );
          if (
            server.fetch.keyPrefixes &&
            !server.fetch.keyPrefixes.some((prefix) =>
              selected.item.startsWith(`${prefix}-`),
            )
          )
            throw new Error(
              "The selected issue does not belong to this configured scope source",
            );
        }
        const cycle = yield* selectReviewCycle(range, branchSelection);
        const cycleId = cycle?.cycleId ?? mintUlid();
        const joined = cycle?.bound === true;
        const plan =
          branchSelection === undefined || cycle === undefined
            ? undefined
            : (cycle.plan ?? (yield* localPlanIdentity(cycleId)));
        const existingKey =
          joined && plan !== undefined
            ? yield* Cycles.requestedRunKey(
                cycleId,
                runKeyFor(range, preparedConfig),
              )
            : undefined;
        const localPlan = existingKey === undefined ? plan : undefined;
        const config =
          localPlan === undefined
            ? preparedConfig
            : { ...preparedConfig, localPlan };
        const runKey = existingKey ?? runKeyFor(range, config);
        const prefix = `review.run:${runKey}:`;
        // A complete run of this key is the range's review: the request joins its job.
        const stored = yield* store.lookup(runKey);
        const complete = Option.isNone(stored)
          ? undefined
          : yield* Effect.map(blobs.get(stored.value.outputHash), (read) =>
              read._tag === "Present"
                ? readData(
                    CompletedRun,
                    JSON.parse(new TextDecoder().decode(read.bytes)),
                  )
                : undefined,
            );
        // Otherwise every ended job of this key (failed, or completed with gaps after a timeout)
        // is an earlier generation, and the request starts or joins the next one (10.42). A newer
        // build's job of the key (`review.run@2`) counts too, so a request after its run ended
        // starts the next generation instead of joining the ended job (8.19).
        const ended = yield* JobQueue.endedWithPrefix(prefix);
        const generation = complete?.generation ?? ended;
        const selections =
          selected && joined
            ? yield* Log.history({
                kind: "cycle.scope-selected@1",
                cycleId,
                limit: 2,
              })
            : [];
        if (selected && joined) {
          const existing = selections[0]?.event;
          if (
            existing?.kind !== "cycle.scope-selected@1" ||
            canonicalJson(existing.payload) !== canonicalJson(selected)
          )
            throw new Error(
              "This range already belongs to a cycle with different scope. Its selected scope cannot be replaced.",
            );
        }
        const occurredAt = new Date(
          yield* Clock.currentTimeMillis,
        ).toISOString();
        const events: Array<unknown> = [];
        if (registration !== undefined) events.push(registration);
        const externalSelection = (yield* Log.history({
          kind: "cycle.external-context-selected@1",
          cycleId,
          limit: 2,
        }))[0]?.event;
        if (
          contextIdentity !== undefined &&
          joined &&
          (externalSelection?.kind !== "cycle.external-context-selected@1" ||
            externalSelection.payload.identity !== contextIdentity)
        )
          throw new Error(
            "This range already belongs to a cycle with different external context. Its pinned source cannot be replaced.",
          );
        if (!joined && contextIdentity !== undefined) {
          const pins: ExternalReviewPin[] = [];
          for (const [index, source] of externalSources.entries()) {
            const sourceId = `E${index + 1}`;
            const text = externalScopeText(source);
            const capture = yield* keepExternalFetched(
              options.location,
              cycleId,
              sourceId,
              { ...source, text },
            );
            const { text: _text, ...metadata } = source;
            pins.push({
              ...metadata,
              sourceId,
              sha256: sha256Hex(text),
              capture,
            });
          }
          events.push({
            id: mintUlid(),
            kind: "cycle.external-context-selected@1",
            idempotencyKey: `cycle.external-context:${cycleId}`,
            actor,
            occurredAt,
            attribution: { cycleId, range },
            payload: { identity: contextIdentity, sources: pins },
            refs: pins.map((pin) => ({
              ref: `blob:${pin.capture.blob}`,
              role: "external-scope",
            })),
          });
        }
        if (!joined && selected)
          events.push({
            id: mintUlid(),
            kind: "cycle.scope-selected@1",
            idempotencyKey: `cycle.scope-selected:${cycleId}`,
            actor,
            occurredAt,
            attribution: { cycleId, range },
            payload: selected,
          });
        // Bind a read-opened cycle with a second opening event so older readers can see its head.
        if (!joined)
          events.push({
            id: mintUlid(),
            kind: "cycle.opened@1",
            idempotencyKey: `cycle:${cycleId}`,
            actor,
            occurredAt,
            attribution: { cycleId, range },
            payload: {},
          });
        let association: string | undefined;
        if (origin !== undefined) {
          const identity = sha256Hex(
            canonicalJson({
              cycleId,
              base: range.baseOid,
              head: range.headOid,
              origin,
            }),
          );
          association = (yield* ReviewOrigins.list({ identity }))[0]
            ?.association;
          if (association === undefined) {
            association = mintUlid();
            events.push({
              id: association,
              kind: "review.origin-recorded@1",
              idempotencyKey: `review.origin:${identity}`,
              actor,
              occurredAt,
              attribution: { cycleId, range },
              payload: { identity, origin },
            });
          }
        }
        events.push({
          id: requestId,
          kind: "review.requested@1",
          idempotencyKey: `review.requested:${requestId}`,
          causation: { correlationId: intent },
          actor,
          occurredAt,
          attribution: { cycleId, range },
          payload: {
            runKey,
            generation,
            pipeline: { version: PIPELINE_VERSION, config },
          },
        });
        const request: ReviewRequest = {
          range,
          config,
          runKey,
          generation,
          cycleId,
          openedCycle: cycle === undefined,
          actor,
          complete,
          events: events.map((event) => RecordEvent.parse(event)),
          dedupeKey: `${prefix}${generation}`,
          ...(association === undefined ? {} : { association }),
        };
        yield* Log.append(request.events);
        return request;
      }),
    );
  });
