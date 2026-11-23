// Why: the integration boundary fails silently in every direction that matters (10.51–10.53, 10.24):
// a write tool or a tool whose schema zod cannot keep would still answer, a variable the user did
// not list would still reach the server, and an identifier left in a capture would still be stored.
// This runs the real SDK client against a local stdio MCP server (tests/fixtures/scope-server.ts).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Context, Effect, Exit, Option, Scope } from "effect";
import {
  Computations,
  Cycles,
  Identity,
  Log,
  mintUlid,
} from "@neuve/records-core";
import { IntegrationServer, type Integrations } from "../src/integrations.ts";
import { sourceFreshness } from "../src/freshness.ts";
import {
  precomputeStage,
  PrecomputeOutput,
  storedOutput,
} from "../src/pipeline.ts";
import { requestReview } from "../src/request.ts";
import {
  describeSnapshot,
  fetchCyclePart,
  keyCandidates,
  linkedPaths,
  NO_PR_TEXT,
  readScopeOpening,
  reviewSnapshot,
  snapshotByKey,
  storedSnapshot,
  type ScopeSnapshot,
} from "../src/scope.ts";
import { world } from "./pi/stages/fixture.ts";
import { McpClients, mcpClientsLayer } from "../src/mcp-client.ts";
import { declaredValues, scopeMasker } from "../src/scope-masking.ts";

const fixture = join(import.meta.dir, "fixtures", "scope-server.ts");

const server = (variables: Array<string>, env: Record<string, string> = {}) =>
  IntegrationServer.parse({
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [fixture],
      env,
    },
    variables,
    tools: ["get_issue", "search_issues", "update_issue", "list_projects"],
    fetch: { tool: "get_issue", argument: "id", keyPrefixes: ["NEU"] },
    identifiers: {
      identifier: "key",
      url: "url",
      name: "person",
      email: "email",
    },
  });

const withClient = <A>(
  definition: IntegrationServer,
  use: (clients: McpClients["Service"]) => Effect.Effect<A, unknown>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const clients = yield* McpClients;
      return yield* use(clients);
    }).pipe(
      Effect.provide(
        mcpClientsLayer({
          status: "configured",
          path: "integrations.json",
          file: { version: 1, servers: { tracker: definition } },
        }),
      ),
    ) as Effect.Effect<A, unknown, never>,
  );

test("only allowed tools with lossless schemas are proxied, and only listed variables arrive", async () => {
  process.env["FIXTURE_TOKEN"] = "fixture-token-value";
  const listed = await withClient(
    server(["FIXTURE_TOKEN"], { FIXTURE_TOKEN: "${FIXTURE_TOKEN}" }),
    (clients) =>
      Effect.gen(function* () {
        const connection = yield* clients.get("tracker");
        const issue = yield* connection.call("get_issue", { id: "NEU-13" });
        const write = yield* Effect.result(
          connection.call("update_issue", { id: "NEU-13", title: "x" }),
        );
        const tooLong = yield* Effect.result(
          connection.call("get_issue", { id: "X".repeat(40) }),
        );
        return { connection, issue, write, tooLong };
      }),
  );
  expect(listed.connection.tools.map((tool) => tool.name)).toEqual([
    "get_issue",
  ]);
  expect(listed.connection.refused.map((entry) => entry.tool).sort()).toEqual([
    "list_projects",
    "search_issues",
    "update_issue",
  ]);
  // Listed by the user, but the server marks it as writing: refused anyway.
  expect(
    listed.connection.refused.find((entry) => entry.tool === "update_issue")
      ?.reason,
  ).toContain("readOnlyHint: false");
  expect(
    listed.connection.refused.find((entry) => entry.tool === "search_issues")
      ?.reason,
  ).toContain("lossy schema");
  expect(listed.issue.isError).toBe(false);
  expect(JSON.parse(listed.issue.text).identifier).toBe("NEU-13");
  expect(listed.write._tag).toBe("Failure");
  expect(listed.tooLong._tag).toBe("Failure");

  // The same server without the variable listed: the process starts without it and refuses.
  const unlisted = await withClient(server([]), (clients) =>
    Effect.flatMap(clients.get("tracker"), (connection) =>
      connection.call("get_issue", { id: "NEU-13" }),
    ),
  );
  expect(unlisted.isError).toBe(true);
  expect(unlisted.text).toContain("unauthorised");

  // A `${NAME}` the user did not list refuses the server before anything starts.
  const refused = await withClient(
    server([], { FIXTURE_TOKEN: "${FIXTURE_TOKEN}" }),
    (clients) => Effect.result(clients.get("tracker")),
  );
  expect(refused._tag).toBe("Failure");
}, 30_000);

test("masking covers declared identifiers and the shapes fetched, and nothing else", () => {
  const response = {
    identifier: "NEU-13",
    url: "https://tracker.example.test/neuve/issue/NEU-13/x",
    assignee: { name: "Dana Reviewer", email: "dana@example.test" },
  };
  const masker = scopeMasker(
    declaredValues(response, {
      identifier: "key",
      url: "url",
      name: "person",
      email: "email",
    }),
  );
  const masked = masker.mask(
    "NEU-13 links NEU-14 at https://tracker.example.test/neuve/issue/NEU-14 for Dana Reviewer (dana@example.test); keep UTF-8, SHA-256 and ABC-12.",
  );
  expect(masked).toBe(
    "[ticket-1] links [ticket-2] at [url-1] for [person-1] ([email-1]); keep UTF-8, SHA-256 and ABC-12.",
  );
  // Ticket candidates are only candidates: the generic shape also finds `UTF-8`.
  expect(keyCandidates("fix NEU-13, keep UTF-8")).toEqual(["NEU-13", "UTF-8"]);
});

// Why: an agent guide is repository text; a link that is not valid percent-encoding must become a
// disclosed gap, never a thrown error that stops the scope fetch (1.8).
test("links that do not decode are returned as undecodable, never thrown", () => {
  expect(
    linkedPaths(
      "docs/AGENTS.md",
      "[a](reports/100%.md) [b](a%20b.md) [c](https://x.test/y) [d](../up.md)",
    ),
  ).toEqual({
    paths: ["docs/a b.md", "up.md"],
    undecodable: ["reports/100%.md"],
  });
});

const scopeFixture = async (name: string, branch: string, message: string) => {
  const w = await world(name);
  const git = (...args: Array<string>) => {
    const child = Bun.spawnSync([
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      w.root,
      ...args,
    ]);
    if (!child.success) throw new Error(child.stderr.toString());
    return child.stdout.toString().trim();
  };
  git("init", "-qb", branch);
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  const commit = (subject: string, ...paths: Array<string>) => {
    git("add", ...paths);
    git("commit", "-qm", subject);
    return git("rev-parse", "HEAD");
  };
  writeFileSync(
    join(w.root, "AGENTS.md"),
    "# Conventions\n\n[Base plan](base.md)\n",
  );
  writeFileSync(join(w.root, "base.md"), "# Base plan\n");
  const base = commit("base", "AGENTS.md", "base.md");
  const open = (branchName = branch) =>
    Cycles.openOrJoinCycle(
      {
        baseOid: base,
        baseRef: base,
        branch: branchName,
        branchTipOid: git("rev-parse", "refs/heads/" + branchName),
      },
      Identity.UNRESOLVED_ACTOR,
    );
  const trace = join(w.root, "mcp-calls");
  process.env["FIXTURE_SCOPE_TRACE"] = trace;
  const integrations = {
    status: "configured",
    path: "integrations.json",
    file: {
      version: 1,
      servers: {
        tracker: server(["FIXTURE_TOKEN", "FIXTURE_SCOPE_TRACE"], {
          FIXTURE_TOKEN: "$" + "{FIXTURE_TOKEN}",
        }),
      },
    },
  } satisfies Integrations;
  type Records =
    typeof w.ctx.records extends Context.Context<infer R> ? R : never;
  const run = <A, E>(effect: Effect.Effect<A, E, Records | McpClients>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(w.ctx.records),
        Effect.provide(mcpClientsLayer(integrations)),
      ),
    );
  const commitRange = () => {
    writeFileSync(join(w.root, "named.md"), "# Named range document\n");
    writeFileSync(join(w.root, "added.md"), "# Added range document\n");
    return commit(message, "named.md", "added.md");
  };
  const request = (head = commitRange()) =>
    run(
      Effect.gen(function* () {
        const review = yield* requestReview({
          repository: w.root,
          location: w.ctx.location,
          range: base + ".." + head,
          requester: { _tag: "Unresolved" },
          frozenConfig: w.ctx.config,
        });
        w.ctx.range = review.range;
        w.ctx.cycleId = review.cycleId;
        return review;
      }),
    );
  const snapshotContext = () => ({ ...w.ctx, integrations });
  const fetchCycle = (cycleId: string) =>
    run(
      Effect.gen(function* () {
        const opening = yield* readScopeOpening(cycleId);
        if (opening === undefined) throw new Error("No read opening");
        const { status } = yield* fetchCyclePart(
          { ...snapshotContext(), cycleId },
          opening,
        );
        return {
          status,
          value: Option.getOrThrow(yield* storedSnapshot(cycleId)),
        };
      }),
    );
  const precompute = () =>
    run(
      Effect.gen(function* () {
        const clients = yield* McpClients;
        const record = yield* precomputeStage(w.ctx, { integrations, clients });
        if (record.key === undefined)
          throw new Error("Precompute did not store output");
        const facts = yield* storedOutput(w.ctx, record.key, PrecomputeOutput);
        if (facts.scope === null)
          throw new Error("Precompute did not store scope");
        const snapshot = yield* snapshotByKey(facts.scope);
        if (snapshot === undefined) throw new Error("Scope could not be read");
        return { record, facts, scopeKey: facts.scope, snapshot };
      }),
    );
  return {
    ...w,
    base,
    git,
    run,
    open,
    commitRange,
    request,
    fetchCycle,
    precompute,
    integrations,
    snapshotContext,
    calls: () =>
      existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n") : [],
  };
};

const sourcesOf = (snapshot: ScopeSnapshot) =>
  snapshot.sources.map((source) => [
    source.id,
    source.kind,
    source.stratum,
    source.ref.item ?? source.ref.path ?? source.ref.commits,
  ]);

// Opening scope must fetch keys already in branch commits and record which tip supplied them.
test("the first read fetches a ticket named by a branch commit", async () => {
  process.env["FIXTURE_TOKEN"] = "fixture-token-value";
  const f = await scopeFixture(
    "branch-commit-scope",
    "work",
    "Implement NEU-13 with OTHER-7",
  );
  try {
    const tip = f.commitRange();
    const { cycleId } = await f.run(f.open());
    f.git("switch", "--detach", f.base);
    const { value } = await f.fetchCycle(cycleId);
    expect(value.branchTipOid).toBe(tip);
    expect(value.sources.filter(({ kind }) => kind === "ticket")).toMatchObject(
      [
        {
          status: "fetched",
          ref: { item: "NEU-13", found: "commit " + tip.slice(0, 12) },
        },
      ],
    );
    expect(f.calls()).toEqual(["start", "NEU-13"]);
  } finally {
    await Effect.runPromise(Scope.close(f.scope, Exit.void));
  }
}, 30_000);

// A ticket committed after scope was read must be disclosed and cause no integration call.
test("a joined review adds range sources without starting or calling the integration", async () => {
  process.env["FIXTURE_TOKEN"] = "fixture-token-value";
  const f = await scopeFixture(
    "joined-scope",
    "work/NEU-13",
    "Read named.md for NEU-14",
  );
  try {
    const { cycleId } = await f.run(f.open());
    const first = await f.fetchCycle(cycleId);
    expect(f.calls()).toEqual(["start", "NEU-13"]);
    const review = await f.request();
    expect(review.cycleId).toBe(cycleId);
    const { snapshot, scopeKey, facts } = await f.precompute();
    expect(sourcesOf(snapshot)).toEqual([
      ["S1", "ticket", "plan-or-ticket-at-base", "NEU-13"],
      ["S2", "repository-document", "plan-or-ticket-at-base", "AGENTS.md"],
      ["S3", "repository-document", "plan-or-ticket-at-base", "base.md"],
      ["S4", "repository-document", "plan-inside-range", "named.md"],
      ["S5", "repository-document", "plan-inside-range", "added.md"],
      ["S6", "commit-text", "commit-or-pr-text", [review.range.headOid]],
    ]);
    expect(snapshot.sources[0]).toEqual(first.value.sources[0]);
    expect(snapshot.branchTipOid).toBe(f.base);
    expect(
      snapshot.sources[5]?.sections.map(({ id, title }) => [id, title]),
    ).toEqual([["S6.1", "Read named.md for NEU-14"]]);
    expect(facts.scopeGaps).toEqual([
      NO_PR_TEXT,
      "Ticket NEU-14 was named after this cycle's scope was read. The next cycle will read it.",
    ]);
    expect(
      describeSnapshot(snapshot).find((line) => line.includes("commit-text")),
    ).toContain("S6");
    const scopeLog = f.ctx.log
      .read()
      .findLast((row) => row.type === "precompute.scope");
    expect(scopeLog?.["key"]).toBe(scopeKey);
    expect(
      (scopeLog?.["sources"] as Array<{ id: string }>).map(({ id }) => id),
    ).toEqual(["S1", "S2", "S3", "S4", "S5", "S6"]);
    const logged = readFileSync(
      join(f.ctx.location.directory, "scope-logs", cycleId + ".jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .findLast((row) => row.type === "scope.snapshot");
    expect(logged).toMatchObject({
      key: scopeKey,
      range: snapshot.range,
      gaps: facts.scopeGaps,
      sources: scopeLog?.["sources"],
    });
    expect(
      Option.getOrUndefined(await f.run(storedSnapshot(cycleId, review.range))),
    ).toEqual(snapshot);
    const fresh = await f.run(
      sourceFreshness({
        snapshot,
        snapshotKey: scopeKey,
        integrations: f.integrations,
        location: f.ctx.location,
        cycleId,
        readSince: Date.parse(first.value.fetchedAt) + 1,
        log: f.ctx.log,
      }),
    );
    expect(fresh.snapshot).toEqual(snapshot);
    expect(fresh.pins.map(({ source, status }) => [source, status])).toEqual([
      ["S1", "current"],
    ]);
    expect(f.calls()).toEqual(["start", "NEU-13"]);
  } finally {
    await Effect.runPromise(Scope.close(f.scope, Exit.void));
  }
}, 30_000);

// A commit between the first read and the scope fetch belongs to the next cycle.
test("pins commits at the first read and fetches the deferred ticket next cycle", async () => {
  process.env["FIXTURE_TOKEN"] = "fixture-token-value";
  const f = await scopeFixture(
    "next-cycle-scope",
    "work",
    "Read named.md for NEU-13",
  );
  try {
    const first = await f.run(f.open());
    const head = f.commitRange();
    expect(await f.run(f.open())).toEqual({
      cycleId: first.cycleId,
      opened: false,
    });
    const firstScope = await f.fetchCycle(first.cycleId);
    expect(f.calls()).toEqual(["start"]);
    expect(firstScope.value.branchTipOid).toBe(f.base);
    expect(firstScope.value.named).toEqual([]);

    const review = await f.request(head);
    expect(review.cycleId).toBe(first.cycleId);
    expect((await f.precompute()).facts.scopeGaps).toContain(
      "Ticket NEU-13 was named after this cycle's scope was read. The next cycle will read it.",
    );
    expect(f.calls()).toEqual(["start"]);
    const request = review.events.find(
      (event) => event.kind === "review.requested@1",
    );
    if (request === undefined) throw new Error("No review request to publish");
    const id = mintUlid();
    await f.run(
      Log.append([
        {
          id,
          kind: "packet.published@1",
          idempotencyKey: "packet:" + id,
          actor: review.actor,
          occurredAt: new Date().toISOString(),
          attribution: {
            cycleId: review.cycleId,
            range: review.range,
            runId: request.id,
          },
          refs: [{ ref: "blob:" + "a".repeat(64), role: "manifest" }],
          payload: {
            complete: true,
            counts: {
              batches: 0,
              units: 0,
              contextReferences: 0,
              assessments: 0,
              deliveries: 0,
              dispositions: 0,
              comments: 0,
              gaps: 0,
            },
          },
        },
      ]),
    );

    const second = await f.run(f.open());
    expect(second.opened).toBe(true);
    expect(second.cycleId).not.toBe(first.cycleId);
    const { value } = await f.fetchCycle(second.cycleId);
    expect(value.branchTipOid).toBe(review.range.headOid);
    expect(value.sources.find(({ kind }) => kind === "ticket")).toMatchObject({
      status: "fetched",
      ref: {
        item: "NEU-13",
        found: "commit " + review.range.headOid.slice(0, 12),
      },
    });
    expect(f.calls()).toEqual(["start", "start", "NEU-13"]);
  } finally {
    await Effect.runPromise(Scope.close(f.scope, Exit.void));
  }
}, 30_000);

// A review with no first read must still fetch commit-named tickets and keep its existing scope order.
test("a review-opened cycle keeps its ticket, documents, commit text, and gaps", async () => {
  process.env["FIXTURE_TOKEN"] = "fixture-token-value";
  const f = await scopeFixture(
    "standalone-scope",
    "work",
    "Implement NEU-13 using named.md",
  );
  try {
    const review = await f.request();
    const { scopeKey, snapshot } = await f.precompute();
    expect(f.calls()).toEqual(["start", "NEU-13"]);
    expect(sourcesOf(snapshot)).toEqual([
      ["S1", "ticket", "plan-or-ticket-at-base", "NEU-13"],
      ["S2", "repository-document", "plan-or-ticket-at-base", "AGENTS.md"],
      ["S3", "repository-document", "plan-or-ticket-at-base", "base.md"],
      ["S4", "repository-document", "plan-inside-range", "named.md"],
      ["S5", "commit-text", "commit-or-pr-text", [review.range.headOid]],
    ]);
    expect(snapshot.strata).toEqual({
      strongest: "plan-or-ticket-at-base",
      present: [
        "plan-or-ticket-at-base",
        "plan-inside-range",
        "commit-or-pr-text",
      ],
    });
    expect(snapshot.gaps).toEqual([NO_PR_TEXT]);
    expect(
      Option.getOrUndefined(await f.run(storedSnapshot(review.cycleId))),
    ).toEqual(snapshot);
    expect(
      Option.getOrUndefined(
        await f.run(storedSnapshot(review.cycleId, review.range, scopeKey)),
      ),
    ).toEqual(snapshot);
  } finally {
    await Effect.runPromise(Scope.close(f.scope, Exit.void));
  }
}, 30_000);

// The first review must fetch queued scope and later reviews must use the same snapshot.
test("fetches queued cycle scope once and reuses it on the next review", async () => {
  process.env["FIXTURE_TOKEN"] = "fixture-token-value";
  const f = await scopeFixture(
    "queued-scope",
    "work/NEU-13",
    "Read named.md for NEU-13",
  );
  try {
    const { cycleId } = await f.run(f.open());
    const review = await f.request();
    expect(review.cycleId).toBe(cycleId);
    expect(f.calls()).toEqual([]);

    const first = await f.precompute();
    expect(sourcesOf(first.snapshot)).toEqual([
      ["S1", "ticket", "plan-or-ticket-at-base", "NEU-13"],
      ["S2", "repository-document", "plan-or-ticket-at-base", "AGENTS.md"],
      ["S3", "repository-document", "plan-or-ticket-at-base", "base.md"],
      ["S4", "repository-document", "plan-inside-range", "named.md"],
      ["S5", "repository-document", "plan-inside-range", "added.md"],
      ["S6", "commit-text", "commit-or-pr-text", [review.range.headOid]],
    ]);
    expect(first.snapshot.gaps).toEqual([NO_PR_TEXT]);
    expect(f.calls()).toEqual(["start", "NEU-13"]);

    f.ctx.runId = mintUlid();
    const second = await f.precompute();
    expect(second.record.status).toBe("reused");
    expect(second.scopeKey).toBe(first.scopeKey);
    expect(second.snapshot).toEqual(first.snapshot);
    expect(f.calls()).toEqual(["start", "NEU-13"]);
    expect((await f.fetchCycle(cycleId)).status).toBe("reused");

    f.git("branch", "other");
    const other = await f.run(f.open("other"));
    expect(other.cycleId).not.toBe(cycleId);
    const shared = await f.run(
      Effect.gen(function* () {
        const opening = yield* readScopeOpening(other.cycleId);
        return yield* reviewSnapshot(
          {
            ...f.snapshotContext(),
            cycleId: other.cycleId,
            integrations: { status: "absent", path: "integrations.json" },
          },
          opening,
        );
      }),
    );
    expect(shared.value.sources.slice(-3).map(({ ref }) => ref)).toEqual(
      first.snapshot.sources.slice(-3).map(({ ref }) => ref),
    );
    const ranges = await f.run(
      Computations.matchingInputs([
        {
          op: "harness.range-scope",
          inputs: {
            base: "git-commit:" + f.base,
            head: "git-commit:" + review.range.headOid,
          },
        },
      ]),
    );
    expect(ranges).toHaveLength(1);
    expect(f.calls()).toEqual(["start", "NEU-13"]);
  } finally {
    await Effect.runPromise(Scope.close(f.scope, Exit.void));
  }
}, 30_000);
