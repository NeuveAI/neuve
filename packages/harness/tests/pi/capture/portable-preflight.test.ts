import { sdkContextSnapshot } from "../../../src/pi/capture/retained-context.ts";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SourceOwnership } from "../../../src/pi/source-ownership.ts";
import { createPrivateInspection } from "../../../src/pi/capture/private-inspection.ts";
import {
  CredentialEpochId,
  InspectionBudget,
} from "../../../src/pi/capture/credential-detectors.ts";
import {
  openCaptureJournal,
  sha256Of,
} from "../../../src/pi/capture/journal.ts";
import { Json } from "../../../src/pi/capture/types.ts";
import { DumpManifest, ExportRecord } from "../../../src/pi/capture/archive.ts";
import {
  exportSnapshot,
  exportPortableSnapshot,
  readSessionDump,
} from "../../../src/session-dump.ts";
type Frame = readonly [string, unknown];
const fixture = async (
  frames: readonly Frame[],
  check: (input: {
    source: string;
    root: string;
    journal: string;
    authority: ReturnType<typeof createPrivateInspection>;
  }) => Promise<void>,
  requestTools: readonly Json[] = [],
) => {
  const root = mkdtempSync(join(tmpdir(), "portable-preflight-")),
    source = join(root, "source"),
    journal = join(source, "capture");
  mkdirSync(source);
  mkdirSync(join(root, "datasets"));
  const owner = SourceOwnership.acquire(source),
    authority = createPrivateInspection({
      ownership: owner,
      source,
      directory: join(root, "private"),
      excludedRoots: [source, join(root, "datasets")],
    });
  const storage = await openNodeSqliteStorage(join(source, "pi.sqlite"));
  try {
    const registration = await authority.register({
      epoch: CredentialEpochId.parse("old"),
      headers: new Headers({ "x-api-key": "synthetic-final-secret" }),
      budget: new InspectionBudget(),
    });
    expect(registration.status).toBe("registered");
    let capture = openCaptureJournal(journal, "synthetic");
    const scope = { runId: "synthetic" };
    capture.capture({
      type: "run.start",
      scope,
      runKind: "coding",
      sourceRevision: { status: "not-applicable", reason: "synthetic" },
      route: "chatgpt",
      pricing: "subscription",
    });
    capture.capture({
      type: "credential.registration",
      scope,
      callId: "old",
      epochId: "old",
      policy: "whole-source-credential-epochs-v1",
    });
    capture.capture({
      type: "model.request",
      scope,
      callId: "old",
      route: "chatgpt",
      provider: "openai",
      model: "synthetic",
      headerNames: ["authorization"],
      credentialCoverage: "required",
      body: {
        status: "sent",
        json: { model: "synthetic", stream: true, tools: requestTools },
      },
      ...(requestTools.length === 0
        ? {
            sdkContext: sdkContextSnapshot(
              "old",
              {
                id: "synthetic",
                name: "synthetic",
                api: "openai-responses",
                provider: "openai",
                baseUrl: "https://capture.invalid",
                reasoning: true,
                input: ["text"],
                contextWindow: 1000,
                maxTokens: 100,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
              normalizeContext({ messages: [] }),
              {
                version: 1,
                api: "openai-responses",
                options: { cacheRetention: "none" },
              },
            ),
          }
        : {}),
    });
    capture.capture({
      type: "model.event",
      scope,
      callId: "old",
      name: "credential_guard",
      data: { status: "pending" },
    });
    capture.capture({
      type: "model.response",
      scope,
      callId: "old",
      status: 200,
    });
    for (const [name, data] of frames)
      capture.capture({
        type: "model.event",
        scope,
        callId: "old",
        name,
        data: Json.parse(data),
      });
    capture = openCaptureJournal(journal, "synthetic");
    capture.close();
    await check({ source, root, journal, authority });
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
    authority.close();
    owner.release();
    rmSync(root, { recursive: true, force: true });
  }
};

const frames: readonly Frame[] = [
  [
    "response.created",
    {
      type: "response.created",
      response: { id: "synthetic-response", status: "in_progress" },
    },
  ],
  [
    "response.output_item.done",
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message",
        id: "message",
        content: [
          { type: "output_text", text: "safe one" },
          { type: "output_text", text: "safe two" },
        ],
      },
    },
  ],
];

const alteredSource = (
  directory: string,
  root: string,
  policy: "missing" | "wrong",
) => {
  const manifest = DumpManifest.parse(
    JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")),
  );
  const { retainedAssemblyPolicy: _, ...withoutPolicy } = manifest;
  const bytes = new TextEncoder().encode(
    JSON.stringify(
      policy === "missing"
        ? withoutPolicy
        : { ...manifest, retainedAssemblyPolicy: "obsolete-policy" },
    ) + "\n",
  );
  const snapshotId = sha256Of(bytes);
  const target = join(root, "altered", snapshotId);
  cpSync(directory, target, { recursive: true });
  writeFileSync(join(target, "manifest.json"), bytes);
  const record = ExportRecord.parse(
    JSON.parse(readFileSync(join(directory, "export.json"), "utf8")),
  );
  writeFileSync(
    join(target, "export.json"),
    JSON.stringify({ ...record, snapshotId, manifest: snapshotId }),
  );
  return { target, snapshotId };
};

for (const policy of ["missing", "wrong"] as const)
  test(`portable export refuses ${policy} original policy before publishing`, async () => {
    await fixture(frames, async ({ source, root, journal, authority }) => {
      const dump = await exportSnapshot({
        runId: "synthetic",
        journal,
        nativeDatabase: join(source, "pi.sqlite"),
        credentialInspection: authority,
        root: join(root, "datasets"),
        retention: { policy: "synthetic" },
      });
      const original = readFileSync(join(dump.directory, "manifest.json"));
      const altered = alteredSource(dump.directory, root, policy);
      const output = join(root, "publication");
      mkdirSync(output);
      if (policy === "missing")
        await Effect.runPromise(readSessionDump(altered.target));
      await expect(
        exportPortableSnapshot({
          directory: altered.target,
          root: output,
          retention: { policy: "synthetic" },
        }),
      ).rejects.toThrow(
        policy === "missing"
          ? "portable original source lacks current retained SDK assembly policy"
          : "manifest does not match its schema",
      );
      expect(
        existsSync(
          join(output, "portable", "coding", "synthetic", altered.snapshotId),
        ),
      ).toBe(false);
      expect(readdirSync(output)).toEqual([]);
      expect(readFileSync(join(dump.directory, "manifest.json"))).toEqual(
        original,
      );
      await Effect.runPromise(readSessionDump(dump.directory));
    });
  });

test("active current credential source publishes and reuses a readable portable snapshot", async () => {
  await fixture(frames, async ({ source, root, journal, authority }) => {
    const dump = await exportSnapshot({
      runId: "synthetic",
      journal,
      nativeDatabase: join(source, "pi.sqlite"),
      credentialInspection: authority,
      root: join(root, "datasets"),
      retention: { policy: "synthetic" },
    });
    const input = {
      directory: dump.directory,
      root: join(root, "datasets"),
      retention: { policy: "synthetic" },
    };
    const portable = await exportPortableSnapshot(input);
    const restored = await Effect.runPromise(
      readSessionDump(portable.directory),
    );
    expect(restored.run.execution).toBe("open");
    expect(restored.unjoined[0]?.credentialCoverage).toBe("required");
    expect(existsSync(join(portable.directory, "manifest.json"))).toBe(true);
    expect(portable.reused).toBe(false);
    expect((await exportPortableSnapshot(input)).reused).toBe(true);
    expect(
      readdirSync(join(root, "datasets", "portable", "coding", "synthetic")),
    ).toEqual([dump.snapshotId]);
  });
});
