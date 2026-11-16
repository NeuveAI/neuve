// Why (11.17, 11.18): a ticket can change while the range stays the same, and a run that reused the
// cycle's snapshot would then judge checkpoints against text the ticket no longer holds, with every
// check passing. These run the freshness check against a provider whose answers move between runs:
// an unchanged ticket stays current without recomputing anything, a changed one is refreshed into a
// snapshot of its own that the next stages are keyed on, and one that can't be asked (an error, or a
// snapshot that kept no pin) is never taken as current. The reader's lines carry no internal IDs.
import { withFileLock } from "@neuve/records-core/file-lock";
import { afterAll, expect, test } from "bun:test";
import {
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import {
  changedRegion,
  refreshedId,
  sourceFreshness,
  type ChangeToJudge,
  type Freshness,
  type JudgeChange,
} from "../src/freshness.ts";
import { IntegrationServer, type Integrations } from "../src/integrations.ts";
import { McpCallFailed, McpClients } from "../src/mcp-client.ts";
import {
  scopeFolder,
  sectionsOf,
  textHash,
  type ScopeSnapshot,
} from "../src/scope.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-freshness-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const location = storeLocationIn(directory);

const integrations: Integrations = {
  status: "configured",
  path: "integrations.json",
  file: {
    version: 1,
    servers: {
      tracker: IntegrationServer.parse({
        transport: { type: "stdio", command: process.execPath, args: [] },
        variables: [],
        tools: ["get_issue"],
        fetch: { tool: "get_issue", argument: "id", keyPrefixes: ["NEU"] },
        identifiers: {},
      }),
    },
  },
};

/** What the provider holds now, by ticket key; a key it does not hold answers with an error. */
const provider = new Map<string, string>();
/** Fields the provider's answer carries beside the title, by ticket key; an update time by default. */
const fields = new Map<string, Record<string, string>>();
let calls = 0;
const clients = Layer.succeed(McpClients, {
  integrations,
  get: () =>
    Effect.succeed({
      server: "tracker",
      tools: [],
      refused: [],
      call: (_tool: string, input: unknown) => {
        calls++;
        const key = (input as { id: string }).id;
        const text = provider.get(key);
        return text === undefined
          ? Effect.fail(
              new McpCallFailed({
                server: "tracker",
                tool: "get_issue",
                message: "unreachable",
              }),
            )
          : Effect.succeed({
              text,
              structured: {
                title: `Ticket ${key}`,
                ...(fields.get(key) ?? { updatedAt: "2026-10-23T12:00:00Z" }),
              },
              isError: false,
            });
      },
    } as never),
} as never);

const ticket = (
  id: string,
  key: string,
  text: string | undefined,
  version: string | null = null,
) => ({
  id,
  kind: "ticket" as const,
  stratum: "plan-or-ticket-at-base" as const,
  fetchedAt: "2026-10-22T09:00:00.000Z",
  ms: 10,
  status: "fetched" as const,
  ref: { server: "tracker", tool: "get_issue", item: key, found: "branch" },
  title: `Ticket ${key}`,
  sections: sectionsOf(id, text ?? "# Done when\n- something"),
  ...(text === undefined ? {} : { sha256: textHash(text), version }),
  capture: null,
  gap: null,
});

const snapshot: ScopeSnapshot = {
  cycleId: "01JCYCLE0000000000000000000",
  fetchedAt: "2026-10-22T09:00:00.000Z",
  ms: 40,
  range: {
    baseOid: "a".repeat(40),
    headOid: "b".repeat(40),
    mergeBase: "a".repeat(40),
  },
  integrations: { file: "configured", detail: null, servers: [] },
  named: [],
  sources: [
    ticket("S1", "NEU-1", "# Done when\n- links expire"),
    ticket("S2", "NEU-2", "# Done when\n- revoked links stop working"),
    ticket("S3", "NEU-3", "# Done when\n- audit entries"),
    // Fetched before pins, and its unmasked copy is gone: what was read is not known.
    ticket("S4", "NEU-4", undefined),
    {
      id: "S5",
      kind: "repository-document",
      stratum: "plan-or-ticket-at-base",
      fetchedAt: "2026-10-22T09:00:00.000Z",
      ms: 0,
      status: "fetched",
      ref: {
        path: "AGENTS.md",
        blob: "c".repeat(40),
        revision: "a".repeat(40),
        found: "agent guide",
      },
      title: "AGENTS.md",
      sections: [],
      capture: null,
      gap: null,
    },
  ],
  strata: {
    strongest: "plan-or-ticket-at-base",
    present: ["plan-or-ticket-at-base"],
  },
  gaps: [],
};

const run = <A, E>(program: Effect.Effect<A, E, never>) =>
  Effect.runPromise(program);

const freshness = (
  snapshotKey: string,
  of: ScopeSnapshot = snapshot,
  judge?: JudgeChange<never>,
) =>
  run(
    Effect.andThen(
      Store.prepareForWrite,
      sourceFreshness({
        snapshot: of,
        snapshotKey,
        integrations,
        location,
        cycleId: of.cycleId,
        readSince: Date.parse("2026-10-23T00:00:00.000Z"),
        log: { write: () => {} },
        judge,
      }),
    ).pipe(
      Effect.provide(
        Computations.layer.pipe(
          Layer.provideMerge(Blobs.layer(location)),
          Layer.provideMerge(Store.layer(location, { create: true })),
        ),
      ),
      Effect.provide(clients),
      Effect.provide(BunFileSystem.layer),
    ) as Effect.Effect<Freshness, unknown, never>,
  );

test("a later run checks every pinned ticket: unchanged stays current, a change is refreshed, an unreachable or unpinned one is out of date", async () => {
  const snapshotKey = "d".repeat(64);
  provider.set("NEU-1", "# Done when\n- links expire");
  provider.set(
    "NEU-2",
    "# Done when\n- revoked links stop working\n- and say so",
  );
  provider.set("NEU-4", "# Done when\n- anything");
  const first = await freshness(snapshotKey);
  expect(first.checks.map((check) => [check.source, check.status])).toEqual([
    ["S1", "current"],
    ["S2", "changed"],
    ["S3", "unchecked"],
    ["S4", "unchecked"],
  ]);
  // Only pinned tickets are asked again, never a repository document; the unpinned one is not asked.
  expect(calls).toBe(3);
  const changed = refreshedId(
    "S2",
    textHash("# Done when\n- revoked links stop working\n- and say so"),
  );
  expect([...first.refreshed]).toEqual([["S2", changed]]);
  expect(first.refreshKey).toBeDefined();
  expect(first.scopeKey).toBe(first.refreshKey!);
  // The changed ticket's new text takes its place, with its own sections, pin and version.
  const refreshed = first.snapshot!.sources.map((s) => s.id);
  expect(refreshed).toEqual(["S1", changed, "S3", "S4", "S5"]);
  const source = first.snapshot!.sources[1]!;
  expect(source.sections[0]!.id).toBe(`${changed}.1`);
  expect(source.version).toBe("2026-10-23T12:00:00Z");
  expect(
    first.pins.map((pin) => [pin.source, pin.status, pin.checkedAt === null]),
  ).toEqual([
    ["S1", "current", false],
    [changed, "current", true],
    ["S3", "unchecked", false],
  ]);
  expect(first.disclosures.map((d) => d.kind)).toEqual([
    "source-changed",
    "source-unchecked",
    "source-unchecked",
  ]);
  for (const disclosure of first.disclosures)
    expect(disclosure.detail).not.toMatch(/\bS\d+\b|\bR[0-9a-f]{8}\b|\d+\.\d+/);

  // A second run that finds the same change shares the same refresh; nothing new is computed.
  const second = await freshness(snapshotKey);
  expect(second.refreshKey).toBe(first.refreshKey);

  // When nothing moved, the run reads the cycle's snapshot under its own key: no stage reruns.
  provider.set("NEU-2", "# Done when\n- revoked links stop working");
  provider.set("NEU-3", "# Done when\n- audit entries");
  const still = await freshness(snapshotKey);
  expect(still.refreshKey).toBeUndefined();
  expect(still.scopeKey).toBe(snapshotKey);
  expect(still.pins.map((pin) => pin.status)).toEqual([
    "current",
    "current",
    "current",
  ]);
});

// Why (the owner, 23 October 2026): whether a ticket's change matters can't be assumed from its
// hash or its update time; a comment or a rephrasing needs no new work, a new acceptance item does.
// The harness judges it in context. These pin what follows from each judgement: a change that
// doesn't matter keeps the text the review stands on and reruns nothing, but is disclosed; one that
// matters, or one that couldn't be judged, is taken in and reruns what read it; the judge is shown
// only the changed part, as the review read it and as it is now.
test("a moved ticket is judged in context: what doesn't matter keeps the review's text, what matters or can't be judged is taken in", async () => {
  const read = (key: string) =>
    `# ${key}\n\n## Done when\n- links expire\n- audit\n\n## Notes\nnone`;
  const tickets = ["NEU-30", "NEU-31", "NEU-32", "NEU-33"];
  const of: ScopeSnapshot = {
    ...snapshot,
    cycleId: "01JCYCLE0000000000000000002",
    sources: tickets.map((key, i) => ticket(`S${i + 1}`, key, read(key))),
  };
  // The cycle's unmasked copies, as the snapshot's fetch keeps them; S4's was swept.
  mkdirSync(scopeFolder(location, of.cycleId), { recursive: true });
  for (const [i, key] of tickets.slice(0, 3).entries())
    writeFileSync(
      join(scopeFolder(location, of.cycleId), `S${i + 1}.txt`),
      read(key),
    );
  provider.set("NEU-30", `${read("NEU-30")}\n\nA comment: looks fine to me.`);
  provider.set(
    "NEU-31",
    read("NEU-31").replace("- audit", "- audit\n- export as CSV"),
  );
  provider.set("NEU-32", read("NEU-32").replace("none", "see the design"));
  provider.set("NEU-33", read("NEU-33").replace("none", "anything"));
  const shown: Array<ChangeToJudge> = [];
  const judge: JudgeChange<never> = (change) =>
    Effect.sync(() => {
      shown.push(change);
      if (change.source === "S1")
        return { matters: false, reason: "Only a comment was added." };
      if (change.source === "S2")
        return {
          matters: true,
          reason: "A new acceptance item asks for a CSV export.",
        };
      return undefined;
    });
  const result = await freshness("9".repeat(64), of, judge);
  shown.sort((a, b) => a.source.localeCompare(b.source));
  // S4 has no text left to judge against, so it is taken in unjudged.
  expect(shown.map((change) => change.source)).toEqual(["S1", "S2", "S3"]);
  expect(shown[1]!.region.before).not.toContain("export as CSV");
  expect(shown[1]!.region.after).toContain("- export as CSV");
  // The heading above the change comes with it, then only the lines around the change.
  expect(shown[1]!.region.after).toMatch(/^# NEU-31\n…\n## Done when/);
  expect(shown[1]!.fromSha).toBe(textHash(read("NEU-31")));
  expect(
    result.checks.map((check) => [
      check.source,
      check.status,
      check.judged?.matters,
    ]),
  ).toEqual([
    ["S1", "current", false],
    ["S2", "changed", true],
    ["S3", "changed", undefined],
    ["S4", "changed", undefined],
  ]);
  expect([...result.refreshed.keys()]).toEqual(["S2", "S3", "S4"]);
  expect(result.pins.find((pin) => pin.source === "S1")).toMatchObject({
    status: "current",
    sha256: textHash(read("NEU-30")),
  });
  const said = result.disclosures.map((d) => d.detail);
  expect(said[0]).toContain(
    "judged that the change doesn't bear on what this change must do (Only a comment was added)",
  );
  expect(said[1]).toContain("bears on what this change must do");
  for (const line of said)
    expect(line).not.toMatch(/\bS\d+\b|\bR[0-9a-f]{8}\b/);
});

// Why: after a change that mattered is taken in, the next change must be judged against that text,
// not the cycle's first read, or a comment added later would rerun the review every time; and a
// change that doesn't matter must keep the existing refresh, so no stage after it reruns.
test("after a refresh, a later change is judged against it, and one that doesn't matter keeps it", async () => {
  const first = "# NEU-40\n\n## Done when\n- links expire";
  const edited = `${first}\n- revoked links stop working`;
  const of: ScopeSnapshot = {
    ...snapshot,
    cycleId: "01JCYCLE0000000000000000003",
    sources: [ticket("S1", "NEU-40", first)],
  };
  mkdirSync(scopeFolder(location, of.cycleId), { recursive: true });
  writeFileSync(join(scopeFolder(location, of.cycleId), "S1.txt"), first);
  const matters: JudgeChange<never> = () =>
    Effect.succeed({ matters: true, reason: "A new done-when item." });
  provider.set("NEU-40", edited);
  const taken = await freshness("8".repeat(64), of, matters);
  expect(taken.refreshed.get("S1")).toBe(refreshedId("S1", textHash(edited)));

  const shown: Array<ChangeToJudge> = [];
  const quiet: JudgeChange<never> = (change) =>
    Effect.sync(() => {
      shown.push(change);
      return { matters: false, reason: "A comment that asks for nothing." };
    });
  // The same text as the refresh: kept, and nothing to judge.
  const again = await freshness("8".repeat(64), of, quiet);
  expect(again.refreshKey).toBe(taken.refreshKey!);
  expect(shown).toEqual([]);
  // A comment on top of it: judged against the refresh, and the refresh is kept.
  provider.set("NEU-40", `${edited}\n\nComment: thanks`);
  const commented = await freshness("8".repeat(64), of, quiet);
  expect(shown.map((change) => change.fromSha)).toEqual([textHash(edited)]);
  expect(commented.refreshKey).toBe(taken.refreshKey!);
  expect(commented.disclosures[0]!.detail).toContain(
    "keeps the text it already uses",
  );
});

test("the changed region keeps a few lines of context and is never cut: too large a change is not judged on part of it", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
  const after = [...lines];
  after[9] = "line ten, edited";
  const region = changedRegion(lines.join("\n"), after.join("\n"))!;
  expect(region.line).toBe(10);
  expect(region.before.split("\n")).toEqual(lines.slice(6, 13));
  expect(region.after.split("\n")).toEqual([
    ...lines.slice(6, 9),
    "line ten, edited",
    ...lines.slice(10, 13),
  ]);
  expect(changedRegion("a", `a\n${"x".repeat(30_000)}`)).toBeUndefined();
});

// A cycle can be refreshed by overlapping runs; the advisory file must not erase newer metadata.
test("scope refresh waits for a concurrent publication and leaves its newer fields unchanged", async () => {
  const first = "# Done when\n- links expire";
  const edited = `${first}\n- revoked links stop working`;
  const of: ScopeSnapshot = {
    ...snapshot,
    cycleId: "01JCYCLE0000000000000000099",
    sources: [ticket("S1", "NEU-99", first)],
  };
  const folder = scopeFolder(location, of.cycleId);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "S1.txt"), first);
  provider.set("NEU-99", edited);
  const path = join(folder, "refreshes.json");
  const newer = JSON.stringify({
    S1: {
      sha256: "newer",
      version: null,
      readAt: "now",
      future: { revision: 2 },
    },
  });
  let judged!: () => void;
  const reached = new Promise<void>((resolve) => {
    judged = resolve;
  });
  let pending: Promise<Freshness> | undefined;
  try {
    await withFileLock(`${path}.lock`, async () => {
      pending = freshness("9".repeat(64), of, () =>
        Effect.sync(() => {
          judged();
          return { matters: true, reason: "A new done-when item." };
        }),
      );
      await reached;
      expect(
        await Promise.race([
          pending.then(() => true),
          Bun.sleep(200).then(() => false),
        ]),
      ).toBe(false);
      writeFileSync(path, newer);
    });
    const result = await pending;
    expect(result?.refreshed.get("S1")).toBe(
      refreshedId("S1", textHash(edited)),
    );
    expect(readFileSync(path, "utf8")).toBe(newer);
  } finally {
    await pending;
  }
});
