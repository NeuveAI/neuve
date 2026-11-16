import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  runGraphInspection,
  type GraphCommandReceipt,
  type GraphInspectionEvent,
} from "../src/index.ts";
import {
  removeRoots,
  roots,
  waitForFile,
  pathExists,
  gate,
  fixtureRepository,
  fakeExecutable,
  request,
} from "./graph-client-support.ts";

afterEach(removeRoots);

describe("bounded parallel investigation", () => {
  const starts = async (executable: string): Promise<readonly string[]> =>
    (await Bun.file(join(dirname(executable), "starts")).text())
      .trim()
      .split("\n");

  test.each(["abort", "output_failure", "output_failure_cleanup"])(
    "%s joins workers before Git removal entry",
    async (failure) => {
      const repository = await fixtureRepository();
      const executable = await fakeExecutable(
        failure === "abort" ? "parallel-block-both" : "parallel-hold-neighbor",
      );
      const wrapperRoot = await mkdtemp(
        join(tmpdir(), "neuve-parallel-git-wrapper-"),
      );
      roots.push(wrapperRoot);
      const gitPath = Bun.which("git");
      if (gitPath === null) throw new Error("Git unavailable");
      const removalEntry = join(wrapperRoot, "removal-entry.json");
      const wrapper = join(wrapperRoot, "git");
      await Bun.write(
        wrapper,
        `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.includes("worktree") && args.includes("remove")) {
  const states = ["query", "neighbors"].filter((name) => existsSync(${JSON.stringify(dirname(executable))} + "/" + name + "-started")).map((name) => {
    const pid = Number(readFileSync(${JSON.stringify(dirname(executable))} + "/" + name + "-started", "utf8"));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    return { name, alive };
  });
  writeFileSync(${JSON.stringify(removalEntry)}, JSON.stringify(states));
  if (${JSON.stringify(failure)} === "output_failure_cleanup") {
    console.error("forced worktree removal failure");
    process.exit(91);
  }
}
const result = Bun.spawnSync([${JSON.stringify(gitPath)}, ...args], { stdout: "pipe", stderr: "pipe" });
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.exitCode);
`,
      );
      await chmod(wrapper, 0o755);
      const harness = join(wrapperRoot, "harness.ts");
      const base = request(executable, repository.root, repository.first);
      const first = base.relationships[0];
      if (first === undefined) throw new Error("missing relationship fixture");
      await Bun.write(
        harness,
        `
import { existsSync, readFileSync } from "node:fs";
import { runGraphInspection } from ${JSON.stringify(resolve(import.meta.dir, "../src/index.ts"))};
const controller = new AbortController();
const events = [];
const receipts = [];
let view = "";
const wait = async (name) => {
  const deadline = Date.now() + 2000;
  while (!existsSync(${JSON.stringify(dirname(executable))} + "/" + name + "-started")) {
    if (Date.now() >= deadline) throw new Error("handshake timeout");
    await Bun.sleep(10);
  }
};
const running = runGraphInspection(${JSON.stringify({ ...base, relationships: [first, { ...first, id: "second" }] })}, {
  experimentalScheduling: "parallel",
  ...(${JSON.stringify(failure)} === "abort" ? { signal: controller.signal } : {}),
  onTemporaryView: ({ path }) => { view = path; },
  onCommand: (receipt) => { receipts.push(receipt); },
  emit: async ({ kind }) => {
    events.push(kind);
    if (${JSON.stringify(failure)} !== "abort" && kind === "retrieval") {
      await wait("neighbors");
      throw new Error("output closed");
    }
  },
});
let caught;
const messages = (error) => error instanceof AggregateError ? error.errors.flatMap(messages) : [error.message];
const settled = running.then(() => {}, (error) => { caught = { name: error.name, message: error.message, ...(error instanceof AggregateError ? { messages: messages(error) } : {}) }; });
if (${JSON.stringify(failure)} === "abort") {
  await Promise.all([wait("query"), wait("neighbors")]);
  controller.abort();
}
await settled;
console.log(JSON.stringify({ caught, events, viewExists: existsSync(view), removalEntry: JSON.parse(readFileSync(${JSON.stringify(removalEntry)}, "utf8")), worktrees: Bun.spawnSync([${JSON.stringify(gitPath)}, "-C", ${JSON.stringify(repository.root)}, "worktree", "list", "--porcelain"]).stdout.toString().split("\\n").filter((line) => line.startsWith("worktree ")).length, ...(${JSON.stringify(failure)} === "output_failure_cleanup" ? { removeExitCode: receipts.find(({ stage }) => stage === "worktree_remove")?.exitCode, recoveryPruned: receipts.some(({ stage }) => stage === "worktree_prune") } : {}) }));
`,
      );
      const child = Bun.spawn([process.execPath, harness], {
        env: {
          ...process.env,
          PATH: `${wrapperRoot}:${process.env.PATH ?? ""}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      const observed: unknown = JSON.parse(stdout);
      expect(observed).toEqual({
        caught:
          failure === "abort"
            ? { name: "AbortError", message: "Graph inspection aborted." }
            : failure === "output_failure"
              ? { name: "Error", message: "output closed" }
              : {
                  name: "AggregateError",
                  message:
                    "Graph inspection evidence recording or cleanup failed.",
                  messages: [
                    "output closed",
                    "Git isolated view removal exited with 91. forced worktree removal failure",
                  ],
                },
        events: failure === "abort" ? [] : ["retrieval"],
        viewExists: false,
        removalEntry: [
          { name: "query", alive: false },
          { name: "neighbors", alive: false },
        ],
        worktrees: 1,
        ...(failure === "output_failure_cleanup"
          ? { removeExitCode: 91, recoveryPruned: true }
          : {}),
      });
    },
  );

  test("empty plans preserve ordinary retrieval and command inventory", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("valid");
    const observations: GraphInspectionEvent[][] = [];
    const inventories: string[][] = [];
    for (const policy of [undefined, "serial", "parallel"] as const) {
      const events: GraphInspectionEvent[] = [];
      const receipts: GraphCommandReceipt[] = [];
      await runGraphInspection(
        request(executable, repository.root, repository.first, false),
        {
          ...(policy === undefined ? {} : { experimentalScheduling: policy }),
          onCommand: (receipt) => {
            receipts.push(receipt);
          },
          emit: async (event) => {
            events.push(event);
          },
        },
      );
      observations.push(events);
      inventories.push(receipts.map(({ stage }) => stage));
    }
    expect(
      observations[0]?.map(({ kind, sequence }) => [kind, sequence]),
    ).toEqual([
      ["retrieval", 1],
      ["complete", 2],
    ]);
    expect(observations[0]?.[0]).toMatchObject({
      outcome: { kind: "success", value: { results: [{ symbol: "caller" }] } },
    });
    expect(observations[1]).toEqual(observations[0]);
    expect(observations[2]).toEqual(observations[0]);
    expect(inventories).toEqual(
      Array.from({ length: 3 }, () => [
        "git_revision",
        "git_tree",
        "worktree_add",
        "version",
        "capabilities",
        "query",
        "query:source:source.custom:metadata",
        "query:source:source.custom:content",
        "worktree_remove",
      ]),
    );
  });

  test.each([
    ["legacy-selection", "unavailable", "unsupported_selection"],
    ["ambiguous", "success", "ambiguous"],
    ["frontier-unsupported", "success", "unsupported_provider"],
  ])("%s preserves its typed outcome", async (mode, expectedKind, detail) => {
    const repository = await fixtureRepository();
    const base = request(
      await fakeExecutable(mode),
      repository.root,
      repository.first,
    );
    const events: GraphInspectionEvent[] = [];
    await runGraphInspection(
      {
        ...base,
        relationships: base.relationships.map((relationship) => ({
          ...relationship,
          summary: "frontier",
        })),
      },
      {
        experimentalScheduling: "parallel",
        emit: async (event) => {
          events.push(event);
        },
      },
    );
    expect(events.map(({ kind }) => kind)).toEqual([
      "retrieval",
      "relationship",
      "complete",
    ]);
    expect(events[0]).toMatchObject({
      outcome: { kind: "success", value: { results: [{ symbol: "caller" }] } },
    });
    expect(events[1]).toMatchObject({ outcome: { kind: expectedKind } });
    if (detail === "unsupported_selection")
      expect(events[1]).toMatchObject({
        outcome: { reason: detail, selection: "family", relation: "CALLS" },
      });
    if (detail === "ambiguous")
      expect(events[1]).toMatchObject({
        outcome: {
          value: {
            focus: {
              kind: "ambiguous",
              matches: [{ id: "caller-id" }, { id: "caller-2" }],
            },
            summary: { kind: "unresolved_focus" },
          },
        },
      });
    if (detail === "unsupported_provider")
      expect(events[1]).toMatchObject({
        outcome: {
          value: {
            focus: { kind: "resolved" },
            observations: [{ relation: "CALLS" }],
            summary: { kind: "unavailable", reason: detail },
          },
        },
      });
  });

  test("parallel completes a mutual executable handshake that serial cannot satisfy", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("parallel-handshake");
    const events: GraphInspectionEvent[] = [];
    await runGraphInspection(
      request(executable, repository.root, repository.first),
      {
        experimentalScheduling: "parallel",
        emit: async (event) => {
          events.push(event);
        },
      },
    );
    expect(events.map(({ kind, sequence }) => [kind, sequence])).toEqual([
      ["retrieval", 1],
      ["relationship", 2],
      ["complete", 3],
    ]);
    expect(events[0]).toMatchObject({
      outcome: {
        kind: "success",
        value: {
          results: [
            {
              symbol: "caller",
              source: { path: "source.custom", startLine: 1, endLine: 5 },
            },
          ],
        },
      },
    });
    expect(events[1]).toMatchObject({
      outcome: {
        kind: "success",
        value: {
          focus: { kind: "resolved", symbol: { id: "caller-id" } },
          observations: [{ relation: "CALLS", to: { id: "callee-id" } }],
        },
      },
    });
    const firstEvent = events[0];
    if (firstEvent === undefined) throw new Error("missing retrieval event");
    expect(events.map(({ identity }) => identity)).toEqual([
      firstEvent.identity,
      firstEvent.identity,
      firstEvent.identity,
    ]);

    const serialExecutable = await fakeExecutable("parallel-handshake");
    const controller = new AbortController();
    let view = "";
    const serialEvents: string[] = [];
    const serial = runGraphInspection(
      request(serialExecutable, repository.root, repository.first),
      {
        experimentalScheduling: "serial",
        signal: controller.signal,
        onTemporaryView: ({ path }) => {
          view = path;
        },
        emit: async ({ kind }) => {
          serialEvents.push(kind);
        },
      },
    );
    await waitForFile(join(dirname(serialExecutable), "query-started"));
    controller.abort();
    await expect(serial).rejects.toMatchObject({ name: "AbortError" });
    expect(serialEvents).toEqual([]);
    expect(
      await pathExists(join(dirname(serialExecutable), "neighbors-started")),
    ).toBe(false);
    expect(await pathExists(view)).toBe(false);
  });

  test("an early enrichment cannot accumulate later results behind output backpressure", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("parallel-hold-query");
    const base = request(executable, repository.root, repository.first);
    const first = base.relationships[0];
    if (first === undefined) throw new Error("missing relationship fixture");
    const heldRetrieval = gate();
    const retrievalEntered = gate();
    const heldRelationship = gate();
    const relationshipEntered = gate();
    const events: GraphInspectionEvent[] = [];
    let activeCallbacks = 0;
    let maxCallbacks = 0;
    const running = runGraphInspection(
      {
        ...base,
        relationships: [
          first,
          { ...first, id: "second" },
          { ...first, id: "third" },
        ],
      },
      {
        experimentalScheduling: "parallel",
        emit: async (event) => {
          activeCallbacks += 1;
          maxCallbacks = Math.max(maxCallbacks, activeCallbacks);
          events.push(event);
          if (event.kind === "retrieval") {
            retrievalEntered.release();
            await heldRetrieval.wait;
          }
          if (event.kind === "relationship" && event.requestId === first.id) {
            relationshipEntered.release();
            await heldRelationship.wait;
          }
          activeCallbacks -= 1;
        },
      },
    );
    await waitForFile(
      join(dirname(executable), "neighbors-caller-id-finished"),
    );
    expect(events).toEqual([]);
    await Bun.write(join(dirname(executable), "query-release"), "release");
    await retrievalEntered.wait;
    expect(await starts(executable)).toHaveLength(3);
    heldRetrieval.release();
    await relationshipEntered.wait;
    expect(await starts(executable)).toHaveLength(3);
    heldRelationship.release();
    await running;
    expect(
      events.map((event) =>
        event.kind === "relationship" ? event.requestId : event.kind,
      ),
    ).toEqual(["retrieval", first.id, "second", "third", "complete"]);
    expect(events.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(maxCallbacks).toBe(1);
    expect(await starts(executable)).toHaveLength(7);
  });

  test("retrieval is delivered while enrichment is still blocked", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("parallel-hold-neighbor");
    const entered = gate();
    const events: string[] = [];
    const running = runGraphInspection(
      request(executable, repository.root, repository.first),
      {
        experimentalScheduling: "parallel",
        emit: async ({ kind }) => {
          events.push(kind);
          if (kind === "retrieval") entered.release();
        },
      },
    );
    await entered.wait;
    expect(events).toEqual(["retrieval"]);
    await waitForFile(join(dirname(executable), "neighbors-started"));
    await Bun.write(join(dirname(executable), "neighbors-release"), "release");
    await running;
    expect(events).toEqual(["retrieval", "relationship", "complete"]);
  });

  test.each([
    ["parallel-malformed-query", "error", "success"],
    ["parallel-malformed-neighbor", "success", "error"],
    ["parallel-invalid-query-source", "error", "success"],
    ["parallel-invalid-neighbor-source", "success", "error"],
    ["parallel-command-failure", "success", "error"],
  ])("%s keeps independent outcomes", async (mode, queryKind, relationKind) => {
    const repository = await fixtureRepository();
    const events: GraphInspectionEvent[] = [];
    await runGraphInspection(
      request(await fakeExecutable(mode), repository.root, repository.first),
      {
        experimentalScheduling: "parallel",
        emit: async (event) => {
          events.push(event);
        },
      },
    );
    expect(events.map(({ kind }) => kind)).toEqual([
      "retrieval",
      "relationship",
      "complete",
    ]);
    expect(events[0]).toMatchObject({ outcome: { kind: queryKind } });
    expect(events[1]).toMatchObject({ outcome: { kind: relationKind } });
    if (queryKind === "success")
      expect(events[0]).toMatchObject({
        outcome: {
          value: {
            results: [
              {
                symbol: "caller",
                source: { path: "source.custom", startLine: 1, endLine: 5 },
              },
            ],
          },
        },
      });
    if (relationKind === "success")
      expect(events[1]).toMatchObject({
        outcome: {
          value: {
            observations: [{ relation: "CALLS", to: { id: "callee-id" } }],
          },
        },
      });
  });

  test("a bad shared-source range in one relationship does not poison the next", async () => {
    const repository = await fixtureRepository();
    const base = request(
      await fakeExecutable("parallel-invalid-first-source"),
      repository.root,
      repository.first,
    );
    const first = base.relationships[0];
    if (first === undefined) throw new Error("missing relationship fixture");
    const events: GraphInspectionEvent[] = [];
    await runGraphInspection(
      { ...base, relationships: [first, { ...first, id: "second" }] },
      {
        experimentalScheduling: "parallel",
        emit: async (event) => {
          events.push(event);
        },
      },
    );
    expect(events.map(({ kind }) => kind)).toEqual([
      "retrieval",
      "relationship",
      "relationship",
      "complete",
    ]);
    expect(events[0]).toMatchObject({
      outcome: {
        kind: "success",
        value: {
          results: [
            { symbol: "caller", source: { path: "source.custom", endLine: 5 } },
          ],
        },
      },
    });
    expect(events[1]).toMatchObject({
      requestId: first.id,
      outcome: {
        kind: "error",
        error: { message: "Neuve Graph relationship observation unavailable." },
      },
    });
    expect(events[2]).toMatchObject({
      requestId: "second",
      outcome: {
        kind: "success",
        value: {
          focus: { kind: "resolved", symbol: { id: "caller-id" } },
          observations: [{ relation: "CALLS", to: { id: "callee-id" } }],
        },
      },
    });
  });

  test("parallel evidence names every requesting operation for a shared source", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("valid");
    const base = request(executable, repository.root, repository.first);
    const first = base.relationships[0];
    if (first === undefined) throw new Error("missing relationship fixture");
    const receipts: GraphCommandReceipt[] = [];
    const events: GraphInspectionEvent[] = [];
    await runGraphInspection(
      { ...base, relationships: [first, { ...first, id: "second" }] },
      {
        experimentalScheduling: "parallel",
        onCommand: (receipt) => {
          receipts.push(receipt);
        },
        emit: async (event) => {
          events.push(event);
        },
      },
    );
    expect(
      receipts
        .filter(({ stage }) => stage.endsWith("source:source.custom:metadata"))
        .map(({ stage }) => stage)
        .sort(),
    ).toEqual([
      "query:source:source.custom:metadata",
      "relationship:caller-calls-callee:source:source.custom:metadata",
      "relationship:second:source:source.custom:metadata",
    ]);
    expect(
      receipts
        .filter(({ stage }) => stage.endsWith("source:source.custom:content"))
        .map(({ stage }) => stage)
        .sort(),
    ).toEqual([
      "query:source:source.custom:content",
      "relationship:caller-calls-callee:source:source.custom:content",
      "relationship:second:source:source.custom:content",
    ]);
    expect(events[0]).toMatchObject({ outcome: { kind: "success" } });
    expect(
      events
        .slice(1, 3)
        .map((event) =>
          event.kind === "relationship" ? event.outcome.kind : "wrong event",
        ),
    ).toEqual(["success", "success"]);
  });

  test("aborting both branches joins children before view removal and skips later work", async () => {
    const repository = await fixtureRepository();
    const executable = await fakeExecutable("parallel-block-both");
    const base = request(executable, repository.root, repository.first);
    const first = base.relationships[0];
    if (first === undefined) throw new Error("missing relationship fixture");
    const controller = new AbortController();
    const events: string[] = [];
    let view = "";
    let cleanupSawBothExited = false;
    let pids: number[] = [];
    const running = runGraphInspection(
      { ...base, relationships: [first, { ...first, id: "second" }] },
      {
        experimentalScheduling: "parallel",
        signal: controller.signal,
        onTemporaryView: ({ path }) => {
          view = path;
        },
        onCommand: ({ stage }) => {
          if (stage === "worktree_remove") {
            for (const pid of pids)
              expect(() => process.kill(pid, 0)).toThrow();
            cleanupSawBothExited = true;
          }
        },
        emit: async ({ kind }) => {
          events.push(kind);
        },
      },
    );
    await Promise.all([
      waitForFile(join(dirname(executable), "query-started")),
      waitForFile(join(dirname(executable), "neighbors-started")),
    ]);
    pids = await Promise.all(
      ["query", "neighbors"].map(async (name) =>
        Number(
          await Bun.file(join(dirname(executable), `${name}-started`)).text(),
        ),
      ),
    );
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    expect(cleanupSawBothExited).toBe(true);
    expect(events).toEqual([]);
    expect(await starts(executable)).toHaveLength(2);
    expect(await pathExists(view)).toBe(false);
  });

  test.each(["retrieval", "relationship"])(
    "failed %s delivery cancels work without a caller signal",
    async (failureKind) => {
      const repository = await fixtureRepository();
      const executable = await fakeExecutable(
        failureKind === "retrieval" ? "parallel-hold-neighbor" : "valid",
      );
      let view = "";
      const events: string[] = [];
      await expect(
        runGraphInspection(
          request(executable, repository.root, repository.first),
          {
            experimentalScheduling: "parallel",
            onTemporaryView: ({ path }) => {
              view = path;
            },
            emit: async ({ kind }) => {
              events.push(kind);
              if (kind === failureKind) {
                if (kind === "retrieval")
                  await waitForFile(
                    join(dirname(executable), "neighbors-started"),
                  );
                throw new Error("output closed");
              }
            },
          },
        ),
      ).rejects.toThrow("output closed");
      expect(events).toEqual(
        failureKind === "retrieval"
          ? ["retrieval"]
          : ["retrieval", "relationship"],
      );
      expect(await pathExists(view)).toBe(false);
      if (failureKind === "retrieval") {
        const pid = Number(
          await Bun.file(join(dirname(executable), "neighbors-started")).text(),
        );
        expect(() => process.kill(pid, 0)).toThrow();
      }
    },
  );

  test("receipt callback failure remains fatal after overlapping successful outcomes", async () => {
    const repository = await fixtureRepository();
    let view = "";
    const events: string[] = [];
    await expect(
      runGraphInspection(
        request(
          await fakeExecutable("parallel-handshake"),
          repository.root,
          repository.first,
        ),
        {
          experimentalScheduling: "parallel",
          onTemporaryView: ({ path }) => {
            view = path;
          },
          onCommand: ({ stage }) => {
            if (stage === "relationship:caller-calls-callee:resolution")
              throw new Error("parallel sink failed");
          },
          emit: async ({ kind }) => {
            events.push(kind);
          },
        },
      ),
    ).rejects.toMatchObject({
      message: "Graph inspection evidence recording or cleanup failed.",
      errors: [expect.objectContaining({ message: "parallel sink failed" })],
    });
    expect(events).toEqual(["retrieval", "relationship"]);
    expect(await pathExists(view)).toBe(false);
  });
});
