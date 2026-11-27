import { captureAuthority } from "./pi/capture/fixture.ts";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFile, rm, readdir, mkdir } from "node:fs/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Fixture, OWNER, scratch } from "../../channel/tests/helpers";
import { createPlanning } from "../../../apps/neuve-host/src/planning";
import { linearMcpSession } from "../src/linear-planning";
import { IntegrationServer } from "../src/integrations";
import { openCaptureJournal } from "../src/pi/capture/journal";
import { exportSnapshot } from "../src/session-dump";

test("UI and native model planning reads reach journal and restricted export with safe failed outcomes", async () => {
  const directory = await scratch();
  const runId = "planning-capture";
  const source = join(directory, "channel");
  const journal = openCaptureJournal(join(source, "capture"), runId);
  journal.capture({
    type: "run.start",
    scope: { runId },
    runKind: "coding",
    sourceRevision: { status: "not-applicable", reason: "Mutable fixture" },
    route: "faux",
    pricing: "subscription",
  });
  let serial = 0;
  const record = (name: string, value: unknown) =>
    journal.capture({
      type: "artifact",
      scope: { runId },
      name: `${name}/${serial++}.json`,
      mediaType: "application/json",
      bytes: new TextEncoder().encode(JSON.stringify(value)),
    });
  const definition = IntegrationServer.parse({
    transport: {
      type: "stdio",
      command: process.execPath,
      args: [join(import.meta.dir, "fixtures", "linear-planning-server.ts")],
    },
    variables: [],
    tools: ["read_issue"],
    identifiers: {},
  });
  const client = linearMcpSession(
    {
      status: "configured",
      path: "fixture",
      file: { version: 1, servers: { linear: definition } },
    },
    { capture: (call) => record("mcp", call) },
  );
  const planning = createPlanning({
    client,
    mappings: {
      linear: {
        search: { tool: "read_issue", queryArgument: "id" },
        issue: { tool: "read_issue", idArgument: "id" },
        dependencies: { tool: "read_issue", idArgument: "id" },
      },
    },
    capture: (call) => record("planning", call),
  });
  const wrapped: string[] = [];
  const fixture = await Fixture.create({
    planning,
    tool: (tool) => {
      wrapped.push(tool.name);
      return tool;
    },
  });
  try {
    expect(wrapped.filter((name) => name.startsWith("planning_"))).toEqual([
      "planning_search",
      "planning_issue",
      "planning_dependencies",
    ]);
    await fixture.request({
      op: "planning-read",
      request: { op: "issue", connection: "linear", issue: "NEU-59" },
    });
    await fixture.request({
      op: "planning-read",
      request: { op: "issue", connection: "missing", issue: "NEU-59" },
    });
    await fixture.request({
      op: "planning-read",
      request: { op: "issue", connection: "linear", issue: "fail" },
    });
    fixture.script(
      fauxAssistantMessage(
        fauxToolCall(
          "planning_issue",
          { connection: "linear", issue: "NEU-59" },
          { id: "planning-call" },
        ),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    );
    const watch = await fixture.watch();
    await fixture.request({ op: "ask", author: OWNER, text: "Read scope" });
    const result = await watch.until(
      "result",
      (event) => event.call === "planning-call",
    );
    expect(result.error).not.toBe(true);
    await watch.until("reply", (event) => event.text === "done");
    await watch.stop();
    await client.close();
    journal.close();
    await mkdir(join(directory, "exports"));
    using authority = captureAuthority(source);
    const output = await exportSnapshot({
      credentialInspection: authority.inspection,
      runId,
      journal: journal.directory,
      root: join(directory, "exports"),
      retention: { policy: "fixture" },
    });
    expect(
      output.run.artifacts.filter(({ name }) => name.startsWith("planning/")),
    ).toHaveLength(4);
    expect(
      output.run.artifacts.filter(({ name }) => name.startsWith("mcp/")),
    ).toHaveLength(3);
    for (const entry of await readdir(output.directory, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      const text = await readFile(join(entry.parentPath, entry.name), "utf8");
      expect(text).not.toContain("fixture-secret-canary");
      expect(text).not.toContain("code=canary");
    }
    const evidence = process.env["NEUVE_PLANNING_EVIDENCE"];
    if (evidence)
      await (
        await import("node:fs/promises")
      ).cp(output.directory, join(evidence, "restricted-planning-capture"), {
        recursive: true,
      });
  } finally {
    await client.close();
    await fixture.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
