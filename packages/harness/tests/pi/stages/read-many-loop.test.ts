// Why: no agent offers read_many yet, so nothing else runs it through the agent loop's tool
// registration (pi/stages/tools.ts). This runs it there, wrapped as a finder would wrap it (a
// recording read, under a reading budget), and observes what reading the code cannot prove: the
// budget line names this tool's own cap, the cap still holds on the wrapped spec, the `tool.call`
// row measures the larger result without calling it near the cap, and the row and the tool-call
// span carry counts and names only, never the repository's text.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Context, Effect } from "effect";
import type { Blobs, Computations } from "@neuve/records-core";
import {
  READ_MANY_RESULT_TOKENS,
  TOOL_RESULT_BYTES,
  estimateTokens,
} from "../../../src/budget.ts";
import {
  FIND_READING_CHARS,
  readingBudget,
  recordingHeadReads,
} from "../../../src/find.ts";
import { captureOutlineSource } from "../../../src/graph-outline.ts";
import * as L from "../../../src/lookups.ts";
import {
  defaultManifestSettings,
  rangeManifest,
} from "../../../src/manifest.ts";
import { settled, toolResults, world } from "./fixture.ts";

const repository = mkdtempSync(join(tmpdir(), "read-many-loop-"));
afterAll(() => rmSync(repository, { recursive: true, force: true }));
const git = (...args: Array<string>) => {
  const result = Bun.spawnSync(["git", "-C", repository, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
const commit = (message: string) => {
  git("add", ".");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-q",
    "-m",
    message,
  );
  return git("rev-parse", "HEAD");
};

const MARK = "CONTENT-MARK-5d1";

test("read_many through the agent loop: its own cap on the wrapped spec, its budget line, the tool.call row's sizes, and counts-only spans", async () => {
  Bun.spawnSync(["git", "init", "-q", repository]);
  writeFileSync(
    join(repository, "big.ts"),
    Array.from(
      { length: 3_000 },
      (_, i) => `export const ${MARK.replace(/-/g, "_")}${i} = "${MARK}";`,
    ).join("\n") + "\n",
  );
  writeFileSync(join(repository, "a.ts"), "one\ntwo\n");
  const base = commit("base");
  writeFileSync(join(repository, "a.ts"), "one\nthree\n");
  const head = commit("change");

  // The agent's tools are built when its step is prepared, after the range's views below.
  let built: Omit<L.LookupContext, "handles"> | undefined;
  const run = await world(
    "read-many",
    6,
    false,
    false,
    "faux",
    undefined,
    false,
    {
      traced: true,
      tools: (handles) => {
        const ctx: L.LookupContext = { ...built!, handles };
        const recorded = recordingHeadReads(L.readTool(ctx), ctx.handles);
        const budget = readingBudget([
          L.readManyTool(ctx, {
            read: recorded.tool,
            remaining: () => FIND_READING_CHARS - budget.save().used,
          }),
        ]);
        return budget.tools;
      },
    },
  );
  const records: Context.Context<
    Blobs.BlobStore | Computations.ComputationStore
  > = run.ctx.records;
  built = await Effect.runPromise(
    Effect.gen(function* () {
      const manifest = (yield* rangeManifest(
        repository,
        { baseOid: base, headOid: head },
        defaultManifestSettings(1_000_000),
        captureOutlineSource(),
      )).value;
      const views = yield* L.revisionViews(repository, manifest);
      return {
        source: captureOutlineSource(),
        repository,
        location: run.ctx.location,
        cycleId: "cycle",
        manifest,
        head: views.head,
        base: views.base,
        hunks: new Map(manifest.hunks.map((h) => [h.hunkId, h])),
        commits: yield* L.rangeCommits(repository, manifest),
        snapshot: undefined,
        records,
        searchFrequency: new Map(),
      };
    }).pipe(Effect.provide(records)),
  );
  run.script.push(
    () =>
      fauxAssistantMessage(
        [
          fauxToolCall(
            "read_many",
            { entries: [{ path: "big.ts" }, { path: "a.ts", diff: true }] },
            { id: "read-many-1" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
    () =>
      fauxAssistantMessage([fauxToolCall("submit_frame", { answer: 7 })], {
        stopReason: "toolUse",
      }),
  );
  const opened = await run.open();
  try {
    const id = await run.start(opened);
    await opened.harness.resume();
    await settled(opened.harness, id);
  } finally {
    await opened.harness.close(context);
  }
  await run.ctx.log.flush?.();

  const [answer] = toolResults(run.sent[1]!.messages).filter(
    (result) => result.name === "read_many",
  );
  const line =
    "[turn 1 / 6; results are capped at about 3,000 tokens (this one at about 20,000); lookup allowance 0 / 4]";
  expect(answer!.error).toBe(false);
  expect(answer!.text.endsWith(`\n\n${line}`)).toBe(true);
  // Past the 3,000-token cap, whole: the larger cap held on the budget-wrapped spec.
  const bytes = Buffer.byteLength(answer!.text);
  expect(bytes).toBeGreaterThan(TOOL_RESULT_BYTES * 5);
  expect(estimateTokens(bytes)).toBeLessThanOrEqual(READ_MANY_RESULT_TOKENS);
  expect(answer!.text).not.toContain("[result cut at the");
  expect(answer!.text).toContain(
    "[read_many stopped at its cap of about 20,000 tokens; entry 1 on is not read in full.",
  );

  const rows = run.ctx.log
    .read()
    .filter((row) => row.type === "tool.call" && row["tool"] === "read_many");
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  const result = answer!.text.slice(0, -`\n\n${line}`.length);
  expect(row["resultBytes"]).toBe(Buffer.byteLength(result));
  expect(row["resultTokensEstimate"]).toBe(
    estimateTokens(Buffer.byteLength(result)),
  );
  expect(row["paged"]).toBe(true);
  expect(row["empty"]).toBe(false);
  // Measured against its own cap: not near it, so no error.
  expect(row["error"]).toBeUndefined();
  // The log's own time stamp aside, the row holds only these names, counts and sizes.
  expect(
    Object.keys(row)
      .filter((key) => key !== "at")
      .sort(),
  ).toEqual([
    "agent",
    "argsHash",
    "empty",
    "latencyMs",
    "paged",
    "resultBytes",
    "resultTokensEstimate",
    "stage",
    "tool",
    "turn",
    "type",
  ]);

  const spans = run.ctx.log
    .read()
    .filter(
      (row) =>
        row.type === "span" &&
        row["name"] === "harness.tool-call" &&
        (row["attributes"] as Record<string, unknown>)["gen_ai.tool.name"] ===
          "read_many",
    );
  expect(spans).toHaveLength(1);
  const attributes = spans[0]!["attributes"] as Record<string, unknown>;
  expect(attributes).toMatchObject({
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": "read_many",
    "harness.lookup.entries": 2,
    "harness.lookup.entries_answered": 1,
    "harness.lookup.stopped": "cap",
  });
  for (const [key, value] of Object.entries(attributes))
    expect([
      key,
      typeof value === "number" || typeof value === "string",
    ]).toEqual([key, true]);
  // Counts and names only: no line of the repository in the row or the span.
  expect(JSON.stringify([row, spans[0]])).not.toContain(MARK);
}, 240_000);
